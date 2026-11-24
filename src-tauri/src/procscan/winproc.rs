//! Windows glue for the process table: only the API calls. Every decision — the command-line
//! rules, the PEB walk, the SID → uid hash, the fd shapes — is in [`super::winparse`], pure and
//! tested on every OS. Its own tests run on Windows alone, against real processes.
//!
//! | need | call | access |
//! |---|---|---|
//! | pids, ppids, image names | `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` | none |
//! | owner ("uid") | `OpenProcessToken(TOKEN_QUERY)` + `GetTokenInformation(TokenUser)` → [`super::winparse::uid_of_sid`] | `PROCESS_QUERY_LIMITED_INFORMATION` |
//! | exe | `QueryFullProcessImageNameW` | limited |
//! | start time, liveness | `GetProcessTimes`, `GetExitCodeProcess` | limited |
//! | command line | `NtQueryInformationProcess(ProcessCommandLineInformation)` (Windows 8.1+) | limited |
//! | cwd, env, console, std handle values | `NtQueryInformationProcess(ProcessBasicInformation)` → PEB → `ReadProcessMemory` | `PROCESS_QUERY_INFORMATION \| PROCESS_VM_READ` |
//! | open files, fd 1/2 targets | `NtQueryInformationProcess(ProcessHandleInformation)` (Windows 8+) → `DuplicateHandle` → `NtQueryVolumeInformationFile(FileFsDeviceInformation)` → disk files only: `GetFinalPathNameByHandleW` on a helper thread under a deadline | `PROCESS_QUERY_INFORMATION \| PROCESS_DUP_HANDLE` |
//! | listening ports | `GetExtendedTcpTable` ([`crate::netmachine::windows::tcp_rows`]) | none |
//! | stop | `TerminateProcess` | `PROCESS_TERMINATE` |
//!
//! **No administrator rights and no prompt, ever** (zero-install, no OS permission): every
//! access right above is one a user holds on their own, non-elevated processes. A process
//! the call is refused for — another user's, a service, an elevated one when the IDE is
//! not — is simply not listed (or its cwd/env/files are unknown). **Never**
//! `SeDebugPrivilege`, and never the system-wide handle table
//! (`NtQuerySystemInformation(SystemExtendedHandleInformation)`): only the table of a
//! process we already opened as its own user.
//!
//! # Open files without hanging (measured on Windows 11 ARM64)
//!
//! A name query on another process's file handle (`GetFinalPathNameByHandleW`,
//! `NtQueryObject(ObjectNameInformation)`) waits for the file object's lock, which a synchronous
//! handle holds for as long as an I/O on it is pending. Measured: it **hung** on a pipe with a
//! pending `ReadFile` AND on a disk file whose handle waited in `LockFileEx` (a JVM's
//! `FileChannel.lock()` is exactly that). The device query (`FileFsDeviceInformation`, what
//! `GetFileType` asks) answered in under a millisecond in every one of those cases, a console
//! with a pending read included. So, per handle: the table entry's `GrantedAccess` first (only
//! files opened for writing, [`super::winparse::access_writes`]), then the device
//! ([`super::winparse::device_of`]), and a name **only for a disk file, on a helper thread**
//! that is abandoned after [`NAME_BUDGET`] (it returns, and closes its duplicate, when the I/O it
//! waits behind completes). An abandoned handle is not asked again while its process lives, at
//! most [`MAX_STUCK`] helpers may be waiting at once, and one process's walk stops asking after
//! [`WALK_BUDGET`].
//!
//! **This module only reads**, except [`terminate`], which Restart calls after its explicit
//! confirm. A duplicated handle is used for the queries above and closed; nothing is read
//! through it.

use super::os::RawProc;
use super::winparse::{
    access_writes, console_at, cwd_at, device_of, duplicable, env_at, fds_of, filetime_to_epoch_ms,
    params_of, parse_handle_snapshot, sanitize_ppids, sid_len, sid_string, split_command_line,
    std_handles_at, terminate_refusal, uid_of_sid, unicode_in_buffer, Device, HandleEntry,
    OpenHandles, StdTarget,
};
use std::collections::HashSet;
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows_sys::Wdk::Storage::FileSystem::{
    FileFsDeviceInformation, NtQueryVolumeInformationFile,
};
use windows_sys::Wdk::System::Threading::{
    NtQueryInformationProcess, ProcessBasicInformation, ProcessCommandLineInformation,
    ProcessHandleInformation,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, FILETIME, HANDLE, INVALID_HANDLE_VALUE,
    STATUS_INFO_LENGTH_MISMATCH, STILL_ACTIVE,
};
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
    FILE_ATTRIBUTE_DIRECTORY, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::SystemInformation::IMAGE_FILE_MACHINE_UNKNOWN;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, IsWow64Process2, OpenProcess,
    OpenProcessToken, QueryFullProcessImageNameW, TerminateProcess, PROCESS_ACCESS_RIGHTS,
    PROCESS_BASIC_INFORMATION, PROCESS_DUP_HANDLE, PROCESS_NAME_WIN32, PROCESS_QUERY_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, PROCESS_VM_READ,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

/// The rights a PEB read needs.
const PEB_ACCESS: PROCESS_ACCESS_RIGHTS = PROCESS_QUERY_INFORMATION | PROCESS_VM_READ;
/// A PEB read plus copying its handles (the open-files walk).
const WALK_ACCESS: PROCESS_ACCESS_RIGHTS = PEB_ACCESS | PROCESS_DUP_HANDLE;
/// The handle-table buffer grows to at most this (≈ 400 000 handles).
const SNAPSHOT_MAX_BYTES: usize = 16 << 20;
/// Entries of one process's handle table looked at, at most.
pub const MAX_HANDLES: usize = 65_536;
/// Files open for writing examined per process, at most (a log shipper's hundreds are not what
/// the card lists — [`super::logfiles::MAX_LOG_FILES`]).
pub const MAX_WRITABLE_FILES: usize = 64;
/// One name query gets this long before its helper thread is abandoned (module doc).
pub const NAME_BUDGET: Duration = Duration::from_millis(250);
/// One process's walk stops asking names after this.
pub const WALK_BUDGET: Duration = Duration::from_secs(1);
/// Abandoned name helpers alive at once, app-wide; past it no name is asked until one returns.
pub const MAX_STUCK: usize = 8;
/// Remembered abandoned handles, at most (then forgotten all at once and re-learned).
const STUCK_MEMORY: usize = 1024;
/// The longest command line Windows allows is 32 767 UTF-16 units; the header and slack on top.
const CMDLINE_START: usize = 4096;
const CMDLINE_MAX: usize = 70_000;

/// An owned kernel handle, closed on drop. A pseudo-handle (`GetCurrentProcess`) is never
/// wrapped.
pub struct Handle(HANDLE);

impl Handle {
    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a live handle this value owns, and it is not used again.
        unsafe { CloseHandle(self.0) };
    }
}

// SAFETY: a kernel handle is not tied to the thread that opened it; `Handle` owns its value
// exclusively (no `Clone`, no shared access), so moving it to another thread — a name helper,
// which uses and then closes it — is sound.
unsafe impl Send for Handle {}

/// `OpenProcess(access)`; `None` when refused or the pid is gone.
pub fn open(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> Option<Handle> {
    // SAFETY: a plain call; a null handle is handled.
    let h = unsafe { OpenProcess(access, 0, pid) };
    (!h.is_null()).then_some(Handle(h))
}

/// One Toolhelp entry.
#[derive(Debug, Clone)]
pub struct Entry {
    pub pid: u32,
    pub ppid: u32,
    /// The image name (`node.exe`).
    pub name: String,
}

/// Every process on the machine (pid, ppid, image name). Needs no rights. Empty on failure.
pub fn snapshot() -> Vec<Entry> {
    let mut out = Vec::new();
    // SAFETY: a plain call; the handle is checked before use and closed below.
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE || snap.is_null() {
        return out;
    }
    let snap = Handle(snap);
    // SAFETY: `PROCESSENTRY32W` is plain data, for which all-zero is a valid value.
    let mut e: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: a live snapshot handle and a writable entry whose `dwSize` is set.
    let mut more = unsafe { Process32FirstW(snap.raw(), &mut e) };
    while more != 0 {
        let len = e
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(e.szExeFile.len());
        out.push(Entry {
            pid: e.th32ProcessID,
            ppid: e.th32ParentProcessID,
            name: String::from_utf16_lossy(&e.szExeFile[..len]),
        });
        // SAFETY: as above.
        more = unsafe { Process32NextW(snap.raw(), &mut e) };
    }
    out
}

/// The user SID of a process token, as bytes.
fn token_sid(process: HANDLE) -> Option<Vec<u8>> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `process` is a live process handle (or the current-process pseudo-handle);
    // `token` is a writable out-parameter.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 || token.is_null() {
        return None;
    }
    let token = Handle(token);
    // `u64` words: aligned for the `TOKEN_USER` (a pointer) the API writes at the start.
    let mut words = vec![0u64; 16];
    let mut need: u32 = 0;
    for _ in 0..2 {
        let len = (words.len() * 8) as u32;
        // SAFETY: `words` is writable for `len` bytes; the API writes at most that and stores
        // the size it needs in `need`.
        let ok = unsafe {
            GetTokenInformation(
                token.raw(),
                TokenUser,
                words.as_mut_ptr().cast(),
                len,
                &mut need,
            )
        };
        if ok != 0 {
            let base = words.as_ptr() as usize;
            let bytes_len = words.len() * 8;
            // SAFETY: the API wrote a `TOKEN_USER` at the start of the aligned buffer.
            let sid = unsafe { (*words.as_ptr().cast::<TOKEN_USER>()).User.Sid } as usize;
            // The SID lives inside the same buffer; read it only from there.
            let off = sid.checked_sub(base)?;
            // SAFETY: a byte view of the initialised `u64` buffer.
            let bytes: &[u8] =
                unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), bytes_len) };
            let rest = bytes.get(off..)?;
            return rest.get(..sid_len(rest)?).map(<[u8]>::to_vec);
        }
        if (need as usize) <= words.len() * 8 {
            return None;
        }
        words = vec![0u64; (need as usize).div_ceil(8)];
    }
    None
}

fn uid_of_handle(process: HANDLE) -> Option<u32> {
    Some(uid_of_sid(&sid_string(&token_sid(process)?)?))
}

/// This process's user, as a uid ([`uid_of_sid`]); asked once.
pub fn my_uid() -> Option<u32> {
    static ME: OnceLock<Option<u32>> = OnceLock::new();
    // SAFETY: the current-process pseudo-handle needs no closing.
    *ME.get_or_init(|| uid_of_handle(unsafe { GetCurrentProcess() }))
}

/// The binary SID of this process's user (the Windows tests cross-check its rendering).
pub fn my_sid_bytes() -> Option<Vec<u8>> {
    // SAFETY: as in `my_uid`.
    token_sid(unsafe { GetCurrentProcess() })
}

pub fn uid_of(pid: u32) -> Option<u32> {
    let h = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    uid_of_handle(h.raw())
}

fn image_path(h: &Handle) -> Option<String> {
    let mut buf = vec![0u16; 32_768];
    let mut len = buf.len() as u32;
    // SAFETY: a live process handle; `buf` is writable for `len` units; the API stores the
    // units written (without the NUL) back into `len`.
    let ok = unsafe {
        QueryFullProcessImageNameW(h.raw(), PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
    };
    (ok != 0 && len > 0 && (len as usize) <= buf.len())
        .then(|| String::from_utf16_lossy(&buf[..len as usize]))
}

fn alive(h: &Handle) -> bool {
    let mut code: u32 = 0;
    // SAFETY: a live process handle and a writable `u32`.
    let ok = unsafe { GetExitCodeProcess(h.raw(), &mut code) };
    ok != 0 && code == STILL_ACTIVE as u32
}

fn creation_ms(h: &Handle) -> Option<i64> {
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: a live process handle and four writable `FILETIME`s.
    let ok = unsafe { GetProcessTimes(h.raw(), &mut created, &mut exited, &mut kernel, &mut user) };
    if ok == 0 {
        return None;
    }
    filetime_to_epoch_ms(
        (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime),
    )
}

/// The command line as the process was started with it (limited access suffices).
fn command_line(h: &Handle) -> Option<String> {
    let mut size = CMDLINE_START;
    for _ in 0..3 {
        let mut words = vec![0u64; size.div_ceil(8)];
        let len = (words.len() * 8) as u32;
        let mut need: u32 = 0;
        // SAFETY: `words` is writable for `len` bytes; the API writes a `UNICODE_STRING` whose
        // buffer follows it inside ours, and stores the size it needs in `need`.
        let status = unsafe {
            NtQueryInformationProcess(
                h.raw(),
                ProcessCommandLineInformation,
                words.as_mut_ptr().cast(),
                len,
                &mut need,
            )
        };
        if status == 0 {
            // SAFETY: a byte view of the initialised `u64` buffer.
            let bytes: &[u8] =
                unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), words.len() * 8) };
            return unicode_in_buffer(bytes, words.as_ptr() as u64);
        }
        if status != STATUS_INFO_LENGTH_MISMATCH || need as usize > CMDLINE_MAX {
            return None;
        }
        size = need as usize + 16;
    }
    None
}

/// The PEB address and the parent pid, from `ProcessBasicInformation`.
fn basic_info(h: &Handle) -> Option<(u64, u32)> {
    // SAFETY: plain data; all-zero is valid.
    let mut pbi: PROCESS_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
    let mut need: u32 = 0;
    // SAFETY: `pbi` is writable for exactly the size passed.
    let status = unsafe {
        NtQueryInformationProcess(
            h.raw(),
            ProcessBasicInformation,
            (&mut pbi as *mut PROCESS_BASIC_INFORMATION).cast(),
            std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
            &mut need,
        )
    };
    (status == 0).then(|| {
        (
            pbi.PebBaseAddress as u64,
            u32::try_from(pbi.InheritedFromUniqueProcessId).unwrap_or(0),
        )
    })
}

/// Is this a 32-bit (WOW64) process? Its 64-bit PEB parameters may be stale, so its cwd and env
/// are not read (module doc of [`super::winparse`]). `None` when the call fails.
fn is_wow64(h: &Handle) -> Option<bool> {
    let (mut process, mut native) = (0u16, 0u16);
    // SAFETY: a live process handle and two writable `u16`s.
    let ok = unsafe { IsWow64Process2(h.raw(), &mut process, &mut native) };
    (ok != 0).then_some(process != IMAGE_FILE_MACHINE_UNKNOWN)
}

/// `len` bytes of the target's memory at `addr`, whole or nothing.
fn read_mem(h: &Handle, addr: u64, len: usize) -> Option<Vec<u8>> {
    if addr == 0 || len == 0 {
        return (len == 0).then(Vec::new);
    }
    let mut buf = vec![0u8; len];
    let mut got: usize = 0;
    // SAFETY: `buf` is writable for `len` bytes; the API copies at most that from the target
    // (a separate address space — `addr` is never dereferenced here) and reports the count.
    let ok = unsafe {
        ReadProcessMemory(
            h.raw(),
            addr as *const c_void,
            buf.as_mut_ptr().cast(),
            len,
            &mut got,
        )
    };
    (ok != 0 && got == len).then_some(buf)
}

/// What the PEB says: `(cwd, console handle)`, read through one handle.
pub struct PebView {
    pub cwd: Option<String>,
    pub console: Option<u64>,
}

/// Open `pid` for a PEB read and hand its parameters' address to `f`. `None` when access is
/// refused, the process is 32-bit (WOW64), or the PEB cannot be read.
fn with_params<T>(
    pid: u32,
    f: impl FnOnce(u64, &dyn Fn(u64, usize) -> Option<Vec<u8>>) -> T,
) -> Option<T> {
    let h = open(pid, PEB_ACCESS)?;
    if is_wow64(&h) != Some(false) {
        return None;
    }
    let (peb, _) = basic_info(&h)?;
    let read = |addr: u64, len: usize| read_mem(&h, addr, len);
    let params = params_of(peb, &read)?;
    Some(f(params, &read))
}

/// `pid`'s cwd and console handle (`PebView` fields `None` when unreadable).
pub fn peb_view(pid: u32) -> PebView {
    with_params(pid, |params, read| PebView {
        cwd: cwd_at(params, read),
        console: console_at(params, read),
    })
    .unwrap_or(PebView {
        cwd: None,
        console: None,
    })
}

/// `pid`'s current directory — the one implementation behind `pty::cwd::process_cwd` and
/// procscan. Note: Windows PowerShell's `Set-Location` moves only PowerShell's own location,
/// not the process cwd (`cmd.exe`'s `cd` moves both); the IDE's terminal prompt hook syncs the
/// two, and this reads the process cwd.
pub fn process_cwd(pid: u32) -> Option<String> {
    with_params(pid, |params, read| cwd_at(params, read)).flatten()
}

/// `pid`'s environment (Restart and `captured` only; the env never leaves Rust).
pub fn read_env(pid: u32) -> Option<Vec<(String, String)>> {
    with_params(pid, |params, read| env_at(params, read)).flatten()
}

/// Every live process of `uid` ([`uid_of_sid`]), with pid/ppid/exe/argv/start (no fds, no cwd
/// yet — [`inspect`]). A parent pid reused by a younger process is cut
/// ([`sanitize_ppids`]).
pub fn list(uid: u32) -> Vec<RawProc> {
    let mut out: Vec<RawProc> = snapshot()
        .into_iter()
        .filter(|e| e.pid != 0 && e.pid != 4)
        .filter_map(|e| {
            let h = open(e.pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
            if uid_of_handle(h.raw())? != uid || !alive(&h) {
                return None;
            }
            Some(RawProc {
                pid: e.pid,
                ppid: e.ppid,
                exe: image_path(&h),
                argv: command_line(&h)
                    .map(|c| split_command_line(&c))
                    .unwrap_or_default(),
                cwd: None,
                started_ms: creation_ms(&h),
                fds: Vec::new(),
            })
        })
        .collect();
    sanitize_ppids(&mut out);
    out
}

// ── open files (module doc: "Open files without hanging") ───────────────────────

/// `process`'s handle table (`ProcessHandleInformation`, Windows 8+), at most [`MAX_HANDLES`]
/// entries. `None` when refused or past [`SNAPSHOT_MAX_BYTES`]. `process` may be the
/// current-process pseudo-handle.
fn handle_table(process: HANDLE) -> Option<Vec<HandleEntry>> {
    let mut size = 64 * 1024usize;
    for _ in 0..6 {
        let mut words = vec![0u64; size / 8];
        let len = (words.len() * 8) as u32;
        let mut need: u32 = 0;
        // SAFETY: `words` is writable for `len` bytes; the API writes at most that and stores
        // the size it needs in `need`.
        let status = unsafe {
            NtQueryInformationProcess(
                process,
                ProcessHandleInformation,
                words.as_mut_ptr().cast(),
                len,
                &mut need,
            )
        };
        if status == 0 {
            // SAFETY: a byte view of the initialised `u64` buffer.
            let bytes: &[u8] =
                unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), words.len() * 8) };
            return Some(parse_handle_snapshot(bytes, MAX_HANDLES));
        }
        if status != STATUS_INFO_LENGTH_MISMATCH {
            return None;
        }
        // The table can grow between the two calls: ask for more than was needed.
        let want = (need as usize).max(size * 2) + 4096;
        if want > SNAPSHOT_MAX_BYTES {
            return None;
        }
        size = want;
    }
    None
}

/// The `ObjectTypeIndex` of `File` objects on this boot, learned once from a file handle of our
/// own (open this executable, find that handle in our own table). `None` if that fails, and
/// then only stdout/stderr are examined.
fn file_type_index() -> Option<u32> {
    static INDEX: OnceLock<Option<u32>> = OnceLock::new();
    *INDEX.get_or_init(|| {
        use std::os::windows::io::AsRawHandle;
        let probe = std::fs::File::open(std::env::current_exe().ok()?).ok()?;
        let mine = probe.as_raw_handle() as u64;
        // SAFETY: the current-process pseudo-handle needs no closing.
        let table = handle_table(unsafe { GetCurrentProcess() })?;
        table.iter().find(|e| e.value == mine).map(|e| e.type_index)
    })
}

/// `value` from `process`'s table, duplicated into ours with the same access (`None` for a
/// pseudo-handle value, a closed one, or a refusal).
fn duplicate(process: &Handle, value: u64) -> Option<Handle> {
    if !duplicable(value) {
        return None;
    }
    let mut dup: HANDLE = std::ptr::null_mut();
    // SAFETY: `process` is a live handle with `PROCESS_DUP_HANDLE`; `value` is a handle value in
    // that process (checked not to be a pseudo-handle); `dup` is a writable out-parameter.
    let ok = unsafe {
        DuplicateHandle(
            process.raw(),
            value as HANDLE,
            GetCurrentProcess(),
            &mut dup,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    };
    (ok != 0 && !dup.is_null()).then_some(Handle(dup))
}

/// `FILE_FS_DEVICE_INFORMATION.DeviceType` of a file handle — answered without waiting for I/O
/// pending on it (module doc). `None` for a handle that is not a file object.
fn device_type(h: &Handle) -> Option<u32> {
    // SAFETY: plain data; all-zero is valid.
    let mut iosb: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    // `FILE_FS_DEVICE_INFORMATION`: `DeviceType`, `Characteristics` (two ULONGs).
    let mut info = [0u32; 2];
    // SAFETY: a live handle; `info` is writable for the 8 bytes passed; `iosb` is writable.
    let status = unsafe {
        NtQueryVolumeInformationFile(
            h.raw(),
            &mut iosb,
            info.as_mut_ptr().cast(),
            std::mem::size_of_val(&info) as u32,
            FileFsDeviceInformation,
        )
    };
    (status == 0).then_some(info[0])
}

/// The final path of a disk file handle (`\\?\` stripped), or `None` for a directory or a name
/// the system will not give. **Can block** (module doc) — only ever called on a name helper.
fn disk_file_path(h: &Handle) -> Option<String> {
    // SAFETY: plain data; all-zero is valid.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: a live handle and a writable struct.
    if unsafe { GetFileInformationByHandle(h.raw(), &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
    {
        return None;
    }
    let mut buf = vec![0u16; 512];
    for _ in 0..2 {
        // SAFETY: `buf` is writable for `buf.len()` units; the API writes at most that, or
        // returns the size it needs (with the NUL) when it does not fit.
        let n = unsafe {
            GetFinalPathNameByHandleW(
                h.raw(),
                buf.as_mut_ptr(),
                buf.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if n == 0 {
            return None;
        }
        if n < buf.len() {
            let raw = String::from_utf16_lossy(&buf[..n]);
            let path = crate::paths::strip_verbatim(std::path::Path::new(&raw));
            return Some(path.to_string_lossy().into_owned());
        }
        buf = vec![0u16; n + 1];
    }
    None
}

/// Name helpers alive right now (the ones that answered in time are gone in microseconds).
static HELPERS: AtomicUsize = AtomicUsize::new(0);

/// How many name helpers are alive (≈ how many are stuck behind someone else's I/O).
pub fn stuck_helpers() -> usize {
    HELPERS.load(Ordering::SeqCst)
}

/// `(pid, start ms, handle value)` of handles whose name query was abandoned.
fn stuck() -> std::sync::MutexGuard<'static, HashSet<(u32, i64, u64)>> {
    static STUCK: OnceLock<Mutex<HashSet<(u32, i64, u64)>>> = OnceLock::new();
    STUCK
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// What a name helper found.
#[derive(Debug, PartialEq, Eq)]
enum Named {
    File(String),
    /// A directory, or a name the system refused.
    NotAFile,
    /// No answer within [`NAME_BUDGET`], a handle that was abandoned before, or too many
    /// helpers already waiting.
    NoAnswer,
}

/// Ask a disk handle's name on a helper thread, waiting at most [`NAME_BUDGET`]. The helper
/// owns `h` and closes it when the query returns — immediately, or (abandoned) when the I/O it
/// waits behind completes. `key` remembers an abandoned handle so it is not asked again.
fn ask_name(h: Handle, key: (u32, i64, u64)) -> Named {
    if stuck().contains(&key) || HELPERS.load(Ordering::SeqCst) >= MAX_STUCK {
        return Named::NoAnswer;
    }
    HELPERS.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::sync_channel(1);
    let spawned = std::thread::Builder::new()
        .name("procscan-name".into())
        .spawn(move || {
            let answer = disk_file_path(&h);
            drop(h);
            HELPERS.fetch_sub(1, Ordering::SeqCst);
            let _ = tx.send(answer);
        });
    if spawned.is_err() {
        // The closure (and with it the handle) was dropped without running.
        HELPERS.fetch_sub(1, Ordering::SeqCst);
        return Named::NoAnswer;
    }
    match rx.recv_timeout(NAME_BUDGET) {
        Ok(Some(path)) => Named::File(path),
        Ok(None) => Named::NotAFile,
        Err(_) => {
            let mut set = stuck();
            if set.len() >= STUCK_MEMORY {
                set.clear();
            }
            set.insert(key);
            Named::NoAnswer
        }
    }
}

/// What one of `process`'s handles is, as fd 1/2 sees it.
fn std_target(process: &Handle, value: u64, key: (u32, i64)) -> Option<StdTarget> {
    let dup = duplicate(process, value)?;
    let device = device_of(device_type(&dup)?);
    if device != Device::Disk {
        return Some(StdTarget::Device(device));
    }
    Some(match ask_name(dup, (key.0, key.1, value)) {
        Named::File(path) => StdTarget::File(path),
        Named::NotAFile | Named::NoAnswer => StdTarget::Device(Device::Disk),
    })
}

/// The regular files `process` holds open for writing (module doc), by path, once each.
fn writable_files(process: &Handle, key: (u32, i64), deadline: Instant) -> Vec<String> {
    let Some(file_type) = file_type_index() else {
        return Vec::new();
    };
    let Some(table) = handle_table(process.raw()) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    let candidates = table
        .iter()
        .filter(|e| e.type_index == file_type && access_writes(e.access))
        .take(MAX_WRITABLE_FILES);
    for e in candidates {
        if Instant::now() >= deadline {
            break;
        }
        let Some(dup) = duplicate(process, e.value) else {
            continue;
        };
        if device_type(&dup).map(device_of) != Some(Device::Disk) {
            continue;
        }
        if let Named::File(path) = ask_name(dup, (key.0, key.1, e.value)) {
            if !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

/// `pid`'s cwd and open handles, through one process handle. Without `PROCESS_DUP_HANDLE` the
/// handles are not examined (`std: None` → the console rule); a 32-bit process has its files
/// read but not its cwd or std handles (its 64-bit parameters may be stale — [`with_params`]).
fn examine(pid: u32, started_ms: Option<i64>) -> (Option<String>, OpenHandles) {
    let (process, can_dup) = match open(pid, WALK_ACCESS) {
        Some(h) => (h, true),
        None => match open(pid, PEB_ACCESS) {
            Some(h) => (h, false),
            None => return (None, OpenHandles::default()),
        },
    };
    let native = is_wow64(&process) == Some(false);
    let params = native
        .then(|| basic_info(&process))
        .flatten()
        .and_then(|(peb, _)| {
            let read = |addr: u64, len: usize| read_mem(&process, addr, len);
            params_of(peb, &read)
        });
    let read = |addr: u64, len: usize| read_mem(&process, addr, len);
    let cwd = params.and_then(|p| cwd_at(p, &read));
    let console = params.and_then(|p| console_at(p, &read));
    if !can_dup {
        return (
            cwd,
            OpenHandles {
                console,
                ..OpenHandles::default()
            },
        );
    }
    let key = (pid, started_ms.unwrap_or(0));
    let deadline = Instant::now() + WALK_BUDGET;
    let std = params
        .and_then(|p| std_handles_at(p, &read))
        .map(|[out, err]| {
            [
                std_target(&process, out, key),
                std_target(&process, err, key),
            ]
        });
    let files = writable_files(&process, key, deadline);
    (
        cwd,
        OpenHandles {
            console,
            std,
            files,
        },
    )
}

/// Fill `cwd` and `fds` for one candidate: fds 1/2 from what its std handles are, the files it
/// holds open for writing, and its listening TCP ports ([`fds_of`]).
pub fn inspect(p: &mut RawProc) {
    let (cwd, handles) = examine(p.pid, p.started_ms);
    p.cwd = cwd;
    let rows = crate::netmachine::windows::tcp_rows().unwrap_or_default();
    p.fds = fds_of(&handles, &rows, p.pid);
}

/// The regular files `pid` has open that the tail guard may admit: its stdout/stderr file and
/// every file it holds open for writing — what `logFiles` can offer. (Unlike unix, files it only
/// reads are not listed: each name costs a helper thread, and none of them is ever offered.)
pub fn open_paths(pid: u32) -> Vec<String> {
    let (_, handles) = examine(pid, proc_start(pid));
    let mut out: Vec<String> = handles
        .std
        .iter()
        .flatten()
        .flatten()
        .filter_map(|t| match t {
            StdTarget::File(p) => Some(p.clone()),
            StdTarget::Device(_) => None,
        })
        .collect();
    for f in handles.files {
        if !out.contains(&f) {
            out.push(f);
        }
    }
    out
}

/// The start time of a live `pid` (`None` once it has exited).
pub fn proc_start(pid: u32) -> Option<i64> {
    let h = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    if !alive(&h) {
        return None;
    }
    creation_ms(&h)
}

/// `(ppid, exe)` of any live process: the ppid from the snapshot (which needs no rights), the
/// exe when limited access allows it.
pub fn parent_and_exe(pid: u32) -> Option<(u32, Option<String>)> {
    let e = snapshot().into_iter().find(|e| e.pid == pid)?;
    let exe = open(pid, PROCESS_QUERY_LIMITED_INFORMATION).and_then(|h| image_path(&h));
    Some((e.ppid, exe))
}

/// The parent pid of a process we may open, from `ProcessBasicInformation` (tests cross-check
/// it against the snapshot).
pub fn ppid_of(pid: u32) -> Option<u32> {
    let h = open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    basic_info(&h).map(|(_, ppid)| ppid)
}

/// **Windows has no SIGTERM.** A console program could only be sent Ctrl+Break by a process
/// sharing its console, and `WM_CLOSE` reaches only a window — neither is something the IDE can
/// deliver to a program another terminal started. So Restart's stop is `TerminateProcess` (exit
/// code 1): immediate, with no chance for the program to clean up. It runs only after the
/// explicit confirm that names the pid and command, only for the same user
/// ([`super::restart::stop`] checks the uid and the start time first), and never for pid 0, pid 4
/// or the IDE itself ([`terminate_refusal`]). It stops that one process, not its children — as
/// SIGTERM to one pid would.
pub fn terminate(pid: u32) -> Result<(), String> {
    if let Some(why) = terminate_refusal(pid, std::process::id()) {
        return Err(why);
    }
    let h =
        open(pid, PROCESS_TERMINATE).ok_or_else(|| std::io::Error::last_os_error().to_string())?;
    // SAFETY: a live handle opened with `PROCESS_TERMINATE`.
    if unsafe { TerminateProcess(h.raw(), 1) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spawn::NoWindow;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

    /// A child killed on drop, so a failing assertion never leaks it.
    struct Reaped(Child);

    impl Drop for Reaped {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A fresh temp dir, spelled long and non-verbatim (`temp_dir` may be an 8.3 short path,
    /// `canonicalize` adds `\\?\`) — the form a process's cwd takes.
    fn temp_dir(tag: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("agentstudio-winproc-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let long = d.canonicalize().unwrap().to_string_lossy().into_owned();
        PathBuf::from(long.strip_prefix(r"\\?\").unwrap_or(&long))
    }

    /// `\\?\C:\x` (what `canonicalize` returns on Windows) → `C:\x`, compared case-insensitively.
    fn same_dir(a: &str, b: &Path) -> bool {
        let strip = |s: String| s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s);
        strip(a.to_string()).eq_ignore_ascii_case(&strip(b.to_string_lossy().into_owned()))
    }

    fn wait_for<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(v) = f() {
                return v;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn my_sid_renders_like_the_os() {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
        let os_string = |sid: &[u8]| -> String {
            let mut out: *mut u16 = std::ptr::null_mut();
            // SAFETY: `sid` is a valid binary SID for the duration of the call; the API
            // allocates the string, which is freed with LocalFree below.
            let ok = unsafe { ConvertSidToStringSidW(sid.as_ptr() as *mut c_void, &mut out) };
            assert_ne!(ok, 0, "ConvertSidToStringSidW");
            // SAFETY: a NUL-terminated wide string the API allocated.
            let len = (0..).take_while(|i| unsafe { *out.add(*i) } != 0).count();
            let s = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(out, len) });
            // SAFETY: allocated by the API with LocalAlloc.
            unsafe { LocalFree(out.cast()) };
            s
        };
        let me = my_sid_bytes().expect("our own token is readable");
        let mine = sid_string(&me).unwrap();
        assert_eq!(mine, os_string(&me));
        assert!(mine.starts_with("S-1-5-"), "{mine}");
        // The hex form, for an authority past 32 bits.
        let wide = [1u8, 1, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 7, 0, 0, 0];
        assert_eq!(sid_string(&wide).unwrap(), os_string(&wide));
        assert_eq!(my_uid(), Some(uid_of_sid(&mine)));
        assert_eq!(uid_of(std::process::id()), my_uid());
    }

    #[test]
    fn the_command_line_splitter_agrees_with_the_os() {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::UI::Shell::CommandLineToArgvW;
        let os_split = |line: &str| -> Vec<String> {
            let wide: Vec<u16> = line.encode_utf16().chain([0]).collect();
            let mut n: i32 = 0;
            // SAFETY: a NUL-terminated wide string; the API allocates the array, freed below.
            let argv = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut n) };
            assert!(!argv.is_null());
            let out = (0..n as usize)
                .map(|i| {
                    // SAFETY: `n` NUL-terminated strings, as the API reported.
                    let p = unsafe { *argv.add(i) };
                    let len = (0..).take_while(|j| unsafe { *p.add(*j) } != 0).count();
                    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, len) })
                })
                .collect();
            // SAFETY: allocated by the API with LocalAlloc.
            unsafe { LocalFree(argv.cast()) };
            out
        };
        for line in [
            r#""C:\Program Files\nodejs\node.exe" server.js --port 3000"#,
            r#""C:\dir\" x"#,
            r#"a "b c" d"#,
            r#"a "c:\dir\\" b"#,
            r#"a \"x\" b"#,
            r#"a \\\"x b"#,
            r"a C:\w\x\\y z",
            r#"a "x""y z" w"#,
            r#"a """" b"#,
            r#"a """ b"#,
            r#"a """"" b"#,
            r#"a "" b"#,
            "a   b\t\tc  ",
            "prog",
            "prog   ",
            r#"a "unterminated arg"#,
            r#"a b"c d"e f"#,
            r#"a \\\\"b c" d"#,
            r#"x "a\"b" "c\\" d"#,
            r#"node.exe C:\w\web\node_modules\.bin\\..\vite\bin\vite.js"#,
            "  leading",
            "naïve \"日本 語\" 🦀",
        ] {
            assert_eq!(split_command_line(line), os_split(line), "{line:?}");
        }
    }

    #[test]
    fn this_process_is_listed_with_its_exe_argv_start_and_cwd() {
        let uid = my_uid().expect("a uid");
        let me = std::process::id();
        let procs = list(uid);
        let mine = procs
            .iter()
            .find(|p| p.pid == me)
            .expect("we are in our own list");
        let this = std::env::current_exe().unwrap();
        assert!(
            same_dir(mine.exe.as_deref().unwrap_or(""), &this),
            "{:?} vs {}",
            mine.exe,
            this.display()
        );
        let args: Vec<String> = std::env::args().collect();
        assert_eq!(mine.argv[1..], args[1..], "argv past the program name");
        assert_eq!(
            Path::new(&mine.argv[0]).file_stem(),
            this.file_stem(),
            "{:?}",
            mine.argv
        );
        let now = filetime_now_ms();
        let started = mine.started_ms.expect("a start time");
        assert!(
            started <= now && now - started < 24 * 3_600_000,
            "{started} vs {now}"
        );
        assert_eq!(
            Some(mine.ppid),
            ppid_of(me),
            "the snapshot and the PEB agree on our parent"
        );
        assert!(procs.iter().all(|p| p.pid != 0 && p.pid != 4));
        // inspect fills the cwd.
        let mut p = mine.clone();
        inspect(&mut p);
        let cwd = std::env::current_dir().unwrap();
        assert!(
            same_dir(p.cwd.as_deref().unwrap_or(""), &cwd),
            "{:?}",
            p.cwd
        );
        assert_eq!(proc_start(me), Some(started));
        let (ppid, exe) = parent_and_exe(me).expect("ourselves");
        assert_eq!(ppid, mine.ppid);
        assert_eq!(exe, mine.exe);
    }

    fn filetime_now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[test]
    fn the_peb_offsets_match_the_public_headers() {
        use super::super::winparse::{
            PARAMS_COMMAND_LINE, PEB_PROCESS_PARAMETERS, UNICODE_STRING_SIZE,
        };
        use windows_sys::Win32::Foundation::UNICODE_STRING;
        use windows_sys::Win32::System::Threading::{PEB, RTL_USER_PROCESS_PARAMETERS};
        assert_eq!(
            std::mem::offset_of!(PEB, ProcessParameters) as u64,
            PEB_PROCESS_PARAMETERS
        );
        assert_eq!(
            std::mem::offset_of!(RTL_USER_PROCESS_PARAMETERS, CommandLine) as u64,
            PARAMS_COMMAND_LINE
        );
        assert_eq!(std::mem::size_of::<UNICODE_STRING>(), UNICODE_STRING_SIZE);
        // And the walk reads, from our own PEB, the command line the kernel reports.
        let me = std::process::id();
        let via_peb = with_params(me, |params, read| {
            super::super::winparse::remote_unicode(read, params + PARAMS_COMMAND_LINE)
        })
        .flatten()
        .expect("our own PEB is readable");
        let h = open(me, PROCESS_QUERY_LIMITED_INFORMATION).unwrap();
        assert_eq!(Some(via_peb), command_line(&h));
    }

    #[test]
    fn a_real_child_reads_back_argv_cwd_env_parent_and_owner() {
        let dir = temp_dir("child");
        let marker = format!("agentstudio-{}", std::process::id());
        let child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep 30",
            ])
            .current_dir(&dir)
            .env("AGENTSTUDIO_WINPROC_MARKER", &marker)
            .no_window()
            .spawn()
            .expect("powershell starts");
        let mut child = Reaped(child);
        let pid = child.0.id();
        let uid = my_uid().unwrap();
        let p = wait_for("the child in the list", || {
            list(uid).into_iter().find(|p| p.pid == pid)
        });
        assert_eq!(p.ppid, std::process::id());
        assert_eq!(uid_of(pid), my_uid());
        assert!(p
            .exe
            .as_deref()
            .is_some_and(|e| e.to_ascii_lowercase().ends_with("\\powershell.exe")));
        assert_eq!(
            p.argv[1..],
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep 30"
            ],
            "{:?}",
            p.argv
        );
        let cwd = wait_for("the child's cwd", || process_cwd(pid));
        assert!(same_dir(&cwd, &dir), "{cwd} vs {}", dir.display());
        assert_eq!(
            crate::pty::cwd::process_cwd(pid).map(|c| same_dir(&c.to_string_lossy(), &dir)),
            Some(true),
            "pty::cwd reads the same PEB"
        );
        let env = read_env(pid).expect("the child's env is readable");
        // Assert on the one variable, never print the env (a failure message would leak it).
        let found = env
            .iter()
            .find(|(k, _)| k == "AGENTSTUDIO_WINPROC_MARKER")
            .map(|(_, v)| v == &marker);
        assert_eq!(
            found,
            Some(true),
            "the marker is in the child's env ({} vars)",
            env.len()
        );
        assert!(env.iter().any(|(k, _)| k.eq_ignore_ascii_case("PATH")));
        // A child started with CREATE_NO_WINDOW still has a console.
        assert!(peb_view(pid).console.is_some_and(|h| h != 0));
        let started = p.started_ms.unwrap();
        assert_eq!(proc_start(pid), Some(started));
        // Stop it the way Restart does, and see it gone.
        terminate(pid).expect("our own child can be terminated");
        let _ = child.0.wait();
        assert_eq!(
            proc_start(pid),
            None,
            "a terminated process has no start time"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_32_bit_child_has_argv_but_no_cwd_or_env() {
        let cmd32 = Path::new(r"C:\Windows\SysWOW64\cmd.exe");
        if !cmd32.exists() {
            eprintln!("no SysWOW64 on this machine — the WOW64 path is not exercised");
            return;
        }
        let dir = temp_dir("wow64");
        let child = Command::new(cmd32)
            .args(["/d", "/c", "ping -n 30 127.0.0.1 >NUL"])
            .current_dir(&dir)
            .no_window()
            .spawn()
            .expect("the 32-bit cmd starts");
        let child = Reaped(child);
        let pid = child.0.id();
        let p = wait_for("the 32-bit child", || {
            list(my_uid().unwrap()).into_iter().find(|p| p.pid == pid)
        });
        assert!(p.argv.iter().any(|a| a == "/d"), "{:?}", p.argv);
        let h = open(pid, PROCESS_QUERY_LIMITED_INFORMATION).unwrap();
        assert_eq!(is_wow64(&h), Some(true));
        assert_eq!(process_cwd(pid), None, "never read from the 64-bit copy");
        assert_eq!(read_env(pid), None);
        drop(child);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The PE header's machine field of an executable (`0x8664` x64, `0xAA64` ARM64).
    fn pe_machine(path: &Path) -> Option<u16> {
        let b = std::fs::read(path).ok()?;
        let off = u32::from_le_bytes(b.get(0x3C..0x40)?.try_into().ok()?) as usize;
        Some(u16::from_le_bytes(
            b.get(off + 4..off + 6)?.try_into().ok()?,
        ))
    }

    /// On ARM64 Windows an x64 program runs emulated — not WOW64 — with the same 64-bit PEB as a
    /// native one. Proved on a real x64 child when the machine has one to offer (Git for
    /// Windows' `usr\bin\bash.exe` is x64 on ARM64); skipped, and said so, otherwise.
    #[test]
    fn an_x64_child_on_arm64_reads_through_the_native_layout() {
        let bash = Path::new(r"C:\Program Files\Git\usr\bin\bash.exe");
        if !cfg!(target_arch = "aarch64") || pe_machine(bash) != Some(0x8664) {
            eprintln!("no x64 program to emulate here — the x64-on-ARM64 path is not exercised");
            return;
        }
        let dir = temp_dir("x64");
        let marker = format!("x64-{}", std::process::id());
        let child = Command::new(bash)
            .args(["--norc", "--noprofile", "-c", "read -t 30 x; exit 0"])
            .current_dir(&dir)
            .env("AGENTSTUDIO_WINPROC_X64", &marker)
            .stdin(std::process::Stdio::piped())
            .no_window()
            .spawn()
            .expect("the x64 bash starts");
        let child = Reaped(child);
        let pid = child.0.id();
        let p = wait_for("the x64 child", || {
            list(my_uid().unwrap()).into_iter().find(|p| p.pid == pid)
        });
        let h = open(pid, PROCESS_QUERY_LIMITED_INFORMATION).unwrap();
        assert_eq!(is_wow64(&h), Some(false), "x64 on ARM64 is not WOW64");
        assert_eq!(
            p.argv[1..],
            ["--norc", "--noprofile", "-c", "read -t 30 x; exit 0"]
        );
        let cwd = wait_for("the x64 child's cwd", || process_cwd(pid));
        assert!(same_dir(&cwd, &dir), "{cwd} vs {}", dir.display());
        let env = read_env(pid).expect("the x64 child's env");
        assert!(
            env.iter()
                .any(|(k, v)| k == "AGENTSTUDIO_WINPROC_X64" && v == &marker),
            "the marker is in the x64 child's env ({} vars)",
            env.len()
        );
        drop(child);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── open files ──────────────────────────────────────────────────────────

    fn lower(p: &Path) -> String {
        p.to_string_lossy().to_ascii_lowercase()
    }

    /// `path` is under `dir` (both non-verbatim; case-insensitive, as NTFS is).
    fn under(path: &str, dir: &Path) -> bool {
        path.to_ascii_lowercase().starts_with(&lower(dir))
    }

    /// The PowerShell under test: its stdout+stderr go to `out.txt` (a `Stdio` from a file
    /// — the `> out.txt 2>&1` case), and it opens `held.log` itself for append, writes to it
    /// and holds it.
    fn spawn_redirected_powershell(dir: &Path) -> Reaped {
        let out = std::fs::File::create(dir.join("out.txt")).unwrap();
        let err = out.try_clone().unwrap();
        let script = "$f = [System.IO.File]::Open('held.log', 'Append', 'Write', 'ReadWrite'); \
                      $w = New-Object System.IO.StreamWriter($f); $w.WriteLine('held: ready'); \
                      $w.Flush(); Write-Output 'stdout: ready'; [Console]::Error.WriteLine('stderr: ready'); \
                      Start-Sleep 30";
        let child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .stdout(out)
            .stderr(err)
            .no_window()
            .spawn()
            .expect("powershell starts");
        Reaped(child)
    }

    #[test]
    fn a_redirected_child_shows_its_stdout_file_and_the_log_it_holds() {
        use super::super::logfiles::{console_of, log_files, Console, LogVia};
        let dir = temp_dir("redir");
        let child = spawn_redirected_powershell(&dir);
        let pid = child.0.id();
        let (out, held) = (dir.join("out.txt"), dir.join("held.log"));
        wait_for("both files to be written", || {
            let has = |p: &Path, s: &str| std::fs::read_to_string(p).is_ok_and(|t| t.contains(s));
            (has(&out, "stdout: ready") && has(&out, "stderr: ready") && has(&held, "ready"))
                .then_some(())
        });
        let t0 = Instant::now();
        let (cwd, handles) = examine(pid, proc_start(pid));
        let took = t0.elapsed();
        assert!(cwd.is_some_and(|c| same_dir(&c, &dir)));
        let out_s = out.to_string_lossy().into_owned();
        let held_s = held.to_string_lossy().into_owned();
        let [o, e] = handles.std.clone().expect("the std handles were examined");
        let is_out = |t: &Option<StdTarget>| matches!(t, Some(StdTarget::File(p)) if p.eq_ignore_ascii_case(&out_s));
        assert!(is_out(&o) && is_out(&e), "fd 1/2 → out.txt: {o:?} {e:?}");
        let ours: Vec<&String> = handles.files.iter().filter(|f| under(f, &dir)).collect();
        assert!(
            ours.iter().any(|f| f.eq_ignore_ascii_case(&held_s)),
            "held.log is open for writing: {ours:?}"
        );
        assert!(
            handles.files.iter().all(|f| !f.starts_with(r"\\?\")),
            "never verbatim: {:?}",
            handles.files
        );
        assert!(took < WALK_BUDGET + Duration::from_secs(2), "{took:?}");
        // Through `inspect` and the pure rules: console = file, stdout first, then the log.
        let mut p = list(my_uid().unwrap())
            .into_iter()
            .find(|p| p.pid == pid)
            .expect("listed");
        inspect(&mut p);
        assert_eq!(console_of(&p.fds), Console::File);
        let files: Vec<(String, LogVia)> = log_files(&p.fds, None)
            .into_iter()
            .filter(|(f, _)| under(f, &dir))
            .map(|(f, v)| (f.to_ascii_lowercase(), v))
            .collect();
        assert_eq!(
            files,
            vec![
                (out_s.to_ascii_lowercase(), LogVia::Stdout),
                (held_s.to_ascii_lowercase(), LogVia::Log),
            ]
        );
        // The tail guard admits both, and nothing else of ours.
        let open = open_paths(pid);
        for f in [&out_s, &held_s] {
            assert!(
                open.iter().any(|o| o.eq_ignore_ascii_case(f)),
                "{f} in {open:?}"
            );
        }
        drop(child);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The negative control: stdout a pipe, stderr `NUL`, no file of its own → `pipe`, and none
    /// of the test's files offered. (Handles the child inherited from whatever ran the tests may
    /// be there too — they are real open files, so only the test dir is asserted on.)
    #[test]
    fn a_piped_child_reads_as_a_pipe_with_no_files_of_ours() {
        use super::super::logfiles::{console_of, log_files, Console};
        let dir = temp_dir("piped");
        std::fs::write(dir.join("unrelated.log"), "not held\n").unwrap();
        let child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep 30",
            ])
            .current_dir(&dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .no_window()
            .spawn()
            .expect("powershell starts");
        let child = Reaped(child);
        let pid = child.0.id();
        let mut p = wait_for("the piped child", || {
            list(my_uid().unwrap()).into_iter().find(|p| p.pid == pid)
        });
        wait_for("its cwd", || process_cwd(pid));
        let (_, handles) = examine(pid, p.started_ms);
        assert_eq!(
            handles.std,
            Some([
                Some(StdTarget::Device(Device::Pipe)),
                Some(StdTarget::Device(Device::Null)),
            ])
        );
        inspect(&mut p);
        assert_eq!(console_of(&p.fds), Console::Pipe);
        let ours: Vec<_> = log_files(&p.fds, None)
            .into_iter()
            .filter(|(f, _)| under(f, &dir))
            .collect();
        assert!(ours.is_empty(), "{ours:?}");
        drop(child);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The device numbers [`device_of`] maps, read off real handles: a file, `NUL`, a pipe — and
    /// a console, via `ping` whose stdout `cmd` pointed at `CON` (a console with no window).
    #[test]
    fn real_handles_report_the_device_types_the_table_maps() {
        let dir = temp_dir("devices");
        let me = open(std::process::id(), WALK_ACCESS).expect("our own process");
        let kind = |h: &dyn std::os::windows::io::AsRawHandle| {
            let dup = duplicate(&me, h.as_raw_handle() as u64).expect("dup");
            device_type(&dup).map(device_of)
        };
        let file = std::fs::File::create(dir.join("f.txt")).unwrap();
        assert_eq!(kind(&file), Some(Device::Disk));
        let null = std::fs::OpenOptions::new().write(true).open("NUL").unwrap();
        assert_eq!(kind(&null), Some(Device::Null));
        let (reader, _writer) = std::io::pipe().unwrap();
        assert_eq!(kind(&reader), Some(Device::Pipe));
        // A handle that is not a file object at all has no device.
        let not_a_file = open(std::process::id(), PROCESS_QUERY_LIMITED_INFORMATION).unwrap();
        assert_eq!(device_type(&not_a_file), None);
        assert!(duplicate(&me, u64::MAX).is_none(), "-1 is never duplicated");

        let cmd = Command::new(r"C:\Windows\System32\cmd.exe")
            .args(["/d", "/c", "ping -n 30 127.0.0.1 >CON"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .no_window()
            .spawn()
            .expect("cmd starts");
        let cmd = Reaped(cmd);
        let cmd_pid = cmd.0.id();
        let ping = wait_for("ping under cmd", || {
            snapshot()
                .into_iter()
                .find(|e| e.ppid == cmd_pid && e.name.eq_ignore_ascii_case("PING.EXE"))
        });
        let _ping = TerminateProcessGuard(ping.pid);
        let (_, handles) = examine(ping.pid, proc_start(ping.pid));
        let [out, _] = handles.std.expect("ping's std handles");
        assert_eq!(out, Some(StdTarget::Device(Device::Console)), ">CON");
        // cmd was GIVEN `NUL`, but redirects by `SetStdHandle` on itself before it starts the
        // child (measured) — the PEB read follows that: while ping runs, cmd's stdout is CON.
        let (_, cmd_handles) = examine(cmd_pid, proc_start(cmd_pid));
        assert_eq!(
            cmd_handles.std.and_then(|[o, _]| o),
            Some(StdTarget::Device(Device::Console)),
            "cmd's stdout, as SetStdHandle left it"
        );
        drop(cmd);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Ends a process we did not spawn ourselves (a grandchild) when dropped.
    struct TerminateProcessGuard(u32);

    impl Drop for TerminateProcessGuard {
        fn drop(&mut self) {
            if let Some(h) = open(self.0, PROCESS_TERMINATE) {
                // SAFETY: a live handle opened with `PROCESS_TERMINATE`.
                unsafe { TerminateProcess(h.raw(), 1) };
            }
        }
    }

    /// A name query behind a pending byte-range lock wait does not return — measured. The
    /// helper is abandoned after [`NAME_BUDGET`], the handle is remembered (no second helper for
    /// it), the device query on the same handle still answers at once, and the helper finishes
    /// by itself once the lock is released.
    #[test]
    fn a_name_query_stuck_behind_a_lock_wait_is_abandoned_not_waited_for() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            LockFileEx, UnlockFileEx, LOCKFILE_EXCLUSIVE_LOCK,
        };
        use windows_sys::Win32::System::IO::OVERLAPPED;
        let dir = temp_dir("lockwait");
        let path = dir.join("locked.log");
        std::fs::write(&path, "x").unwrap();
        let rw = || {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap()
        };
        let (holder, waiter) = (rw(), rw());
        // SAFETY: plain data; all-zero is valid.
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        // SAFETY: a live synchronous handle and a zeroed OVERLAPPED (offset 0).
        let locked = unsafe {
            LockFileEx(
                holder.as_raw_handle(),
                LOCKFILE_EXCLUSIVE_LOCK,
                0,
                1,
                0,
                &mut ov,
            )
        };
        assert_ne!(locked, 0, "the holder takes the lock");
        let w = waiter.as_raw_handle() as usize;
        let blocked = std::thread::spawn(move || {
            // SAFETY: as above; this call blocks until the holder unlocks.
            let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
            unsafe { LockFileEx(w as HANDLE, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &mut ov) };
        });
        std::thread::sleep(Duration::from_millis(300));
        let me = open(std::process::id(), WALK_ACCESS).unwrap();
        let value = waiter.as_raw_handle() as u64;
        let key = (std::process::id(), 7, value);
        // The device query does not wait.
        let t0 = Instant::now();
        let dup = duplicate(&me, value).unwrap();
        assert_eq!(device_type(&dup).map(device_of), Some(Device::Disk));
        assert!(
            t0.elapsed() < Duration::from_millis(100),
            "{:?}",
            t0.elapsed()
        );
        // The name query does, and is abandoned.
        let before = HELPERS.load(Ordering::SeqCst);
        let t0 = Instant::now();
        assert_eq!(ask_name(dup, key), Named::NoAnswer);
        let took = t0.elapsed();
        assert!(
            took >= NAME_BUDGET && took < NAME_BUDGET + Duration::from_millis(500),
            "{took:?}"
        );
        assert!(stuck().contains(&key));
        // Asked again: no wait and no new helper.
        let t0 = Instant::now();
        assert_eq!(
            ask_name(duplicate(&me, value).unwrap(), key),
            Named::NoAnswer
        );
        assert!(
            t0.elapsed() < Duration::from_millis(50),
            "{:?}",
            t0.elapsed()
        );
        // An unblocked file is still named meanwhile (helpers are per handle).
        let free = std::fs::File::create(dir.join("free.log")).unwrap();
        let named = ask_name(
            duplicate(&me, free.as_raw_handle() as u64).unwrap(),
            (std::process::id(), 7, free.as_raw_handle() as u64),
        );
        assert!(
            matches!(&named, Named::File(p) if p.to_ascii_lowercase().ends_with("free.log")),
            "{named:?}"
        );
        // Release the lock: the waiter, then the abandoned helper, return by themselves.
        let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
        // SAFETY: the holder's own lock, released.
        unsafe { UnlockFileEx(holder.as_raw_handle(), 0, 1, 0, &mut ov) };
        blocked.join().unwrap();
        drop(waiter);
        wait_for("the abandoned helper to return", || {
            (HELPERS.load(Ordering::SeqCst) <= before).then_some(())
        });
        drop(holder);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refused_and_missing_pids() {
        assert!(terminate(0).is_err());
        assert!(terminate(4).is_err());
        assert!(terminate(std::process::id())
            .unwrap_err()
            .contains("IDE itself"));
        // Pids are multiples of 4; this one can never exist.
        let ghost = 0xFFFF_FFF1;
        assert_eq!(uid_of(ghost), None);
        assert_eq!(proc_start(ghost), None);
        assert_eq!(process_cwd(ghost), None);
        assert_eq!(read_env(ghost), None);
        assert_eq!(parent_and_exe(ghost), None);
        assert!(terminate(ghost).is_err());
        // The kernel (pid 4) is never listed and its token is not ours.
        assert_ne!(uid_of(4), my_uid());
    }
}
