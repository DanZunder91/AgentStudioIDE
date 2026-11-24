//! The Windows process table, as bytes → facts. **Pure, and compiled on every OS** (the shape
//! of `netmachine/wintable.rs`, so a platform nobody runs locally is still tested): everything
//! here is decided from buffers and a memory-reader closure, so it is tested on a Mac or Linux
//! box with hand-written bytes. Only the API calls that fill those buffers live behind
//! `cfg(windows)` ([`super::winproc`]).
//!
//! | piece | input | used for |
//! |---|---|---|
//! | [`split_command_line`] | the command line string | `RawProc.argv` — the rules of `CommandLineToArgvW` (cross-checked against the real API by a Windows test) |
//! | [`unicode_in_buffer`] | the buffer `NtQueryInformationProcess(ProcessCommandLineInformation)` filled | the command line |
//! | [`params_of`], [`cwd_at`], [`env_at`], [`console_at`] | the PEB address + a reader of the target's memory | cwd, environment, whether it has a console |
//! | [`parse_env_block`] | the UTF-16 `K=V\0…\0\0` block | `read_env` (the env never leaves Rust) |
//! | [`sid_string`], [`uid_of_sid`] | the token's user SID bytes | the "uid" Windows does not have |
//! | [`filetime_to_epoch_ms`] | `GetProcessTimes` creation time | `started_ms` |
//! | [`listener_fds`], [`console_fds`] | TCP rows, the console handle | the `Fd` table the classifier reads |
//! | [`std_handles_at`] | the PEB address + a reader | the handle values of stdout / stderr |
//! | [`parse_handle_snapshot`], [`access_writes`] | the buffer `NtQueryInformationProcess(ProcessHandleInformation)` filled | which handles are files opened for writing |
//! | [`device_of`] | `FILE_FS_DEVICE_INFORMATION.DeviceType` | disk file, pipe, socket, console or `NUL` — asked before any name |
//! | [`std_fd`], [`fds_of`] | what fds 1/2 point at, the open files, the listeners | the `Fd` table, with `File` fds the log-file rules read |
//! | [`sanitize_ppids`] | the snapshot | a parent pid that was reused by a younger process is cut |
//! | [`terminate_refusal`] | a pid | which pids `sigterm` never touches |
//!
//! **Layouts (64-bit — x64 and ARM64 share them, and an x64 program emulated on ARM64 Windows
//! has the same native PEB).** `PEB.ProcessParameters` and `RTL_USER_PROCESS_PARAMETERS
//! .CommandLine` are in the public headers (`winternl.h`) and their offsets are asserted against
//! `windows-sys`'s structs by a Windows test. `CurrentDirectory`, `Environment` and
//! `EnvironmentSize` are not public; their offsets are the ones every process tool uses (phnt,
//! Process Hacker), stable since Vista, and are proved by live Windows tests that read a real
//! child's cwd and an env marker back. A 32-bit (WOW64) target keeps its own 32-bit copy of the
//! parameters, so its cwd/env are **not read** (the 64-bit copy may be stale) — never misread.

use super::logfiles::{Fd, FdKind};
use super::os::RawProc;
use crate::netmachine::wintable::{TcpRow, STATE_LISTEN};
use std::collections::HashMap;

/// `PEB.ProcessParameters` (winternl.h: `Reserved1[2]`, `BeingDebugged`, `Reserved2[1]`,
/// `Reserved3[2]` pointers, `Ldr`, then this).
pub const PEB_PROCESS_PARAMETERS: u64 = 0x20;
/// `RTL_USER_PROCESS_PARAMETERS.ConsoleHandle`.
pub const PARAMS_CONSOLE_HANDLE: u64 = 0x10;
/// `RTL_USER_PROCESS_PARAMETERS.StandardOutput` (phnt: `ConsoleHandle`, `ConsoleFlags` + padding,
/// `StandardInput`, then this; `SetStdHandle` in the process writes it).
pub const PARAMS_STANDARD_OUTPUT: u64 = 0x28;
/// `RTL_USER_PROCESS_PARAMETERS.StandardError`.
pub const PARAMS_STANDARD_ERROR: u64 = 0x30;
/// `RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath` (a `UNICODE_STRING`; `CURDIR`'s first
/// field).
pub const PARAMS_CURRENT_DIRECTORY: u64 = 0x38;
/// `RTL_USER_PROCESS_PARAMETERS.CommandLine` (public: winternl.h).
pub const PARAMS_COMMAND_LINE: u64 = 0x70;
/// `RTL_USER_PROCESS_PARAMETERS.Environment` (a pointer to the UTF-16 block).
pub const PARAMS_ENVIRONMENT: u64 = 0x80;
/// `RTL_USER_PROCESS_PARAMETERS.EnvironmentSize` (bytes, Vista+), after the 32
/// `RTL_DRIVE_LETTER_CURDIR` entries.
pub const PARAMS_ENVIRONMENT_SIZE: u64 = 0x3F0;
/// `sizeof(UNICODE_STRING)` on 64-bit: `Length`, `MaximumLength`, 4 bytes padding, `Buffer`.
pub const UNICODE_STRING_SIZE: usize = 16;
/// The largest environment block [`env_at`] will copy out of another process. Windows caps one
/// variable at 32 767 characters; a block past this is a corrupt or hostile size field.
pub const MAX_ENV_BYTES: u64 = 8 * 1024 * 1024;

/// The `Fd.fd` of a Windows listener or of an open file that is not stdout/stderr: handles have
/// no small-integer fd here, and `-1` can never be mistaken for stdout/stderr (fds 1 and 2,
/// which decide the console kind).
pub const WIN_NO_FD: i32 = -1;
/// `PROCESS_HANDLE_SNAPSHOT_INFORMATION` (phnt, Windows 8+): `NumberOfHandles` and `Reserved`
/// (pointer-sized each), then the entries.
pub const HANDLE_SNAPSHOT_HEADER: usize = 16;
/// One `PROCESS_HANDLE_TABLE_ENTRY_INFO` on 64-bit: `HandleValue`, `HandleCount`,
/// `PointerCount` (8 bytes each), `GrantedAccess`, `ObjectTypeIndex`, `HandleAttributes`,
/// `Reserved` (4 bytes each).
pub const HANDLE_ENTRY_SIZE: usize = 40;
/// The device name a Windows console fd carries. ConPTY has no slave path (`pty::tty_name` is
/// `None` on Windows), so this never matches an IDE terminal's tty — an IDE app's console reads
/// as `terminal`, which the card shows as "held by <the terminal>".
pub const WIN_CONSOLE_DEVICE: &str = "\\Device\\ConDrv";

/// Reads `len` bytes of the target process at `addr`; `None` when that memory is unreadable.
pub type Reader<'a> = &'a dyn Fn(u64, usize) -> Option<Vec<u8>>;

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// UTF-16LE bytes → a string (lossy; an odd trailing byte is dropped).
pub fn utf16le(b: &[u8]) -> String {
    let units: Vec<u16> = b
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// A `UNICODE_STRING` header → `(Length in bytes, Buffer address)`.
pub fn unicode_header(b: &[u8]) -> Option<(usize, u64)> {
    Some((usize::from(u16_at(b, 0)?), u64_at(b, 8)?))
}

/// The string a `UNICODE_STRING` at the start of `buf` describes, when its `Buffer` points back
/// INTO `buf` — what `NtQueryInformationProcess(ProcessCommandLineInformation)` returns. `base`
/// is `buf`'s own address. A pointer outside the buffer, or a length past its end, is `None`:
/// never a read outside what the API wrote.
pub fn unicode_in_buffer(buf: &[u8], base: u64) -> Option<String> {
    let (len, ptr) = unicode_header(buf)?;
    if len == 0 {
        return Some(String::new());
    }
    let off = usize::try_from(ptr.checked_sub(base)?).ok()?;
    Some(utf16le(buf.get(off..off.checked_add(len)?)?))
}

fn read_u64(read: Reader<'_>, addr: u64) -> Option<u64> {
    u64_at(&read(addr, 8)?, 0)
}

/// The `RTL_USER_PROCESS_PARAMETERS` address from the PEB's (`None` for a null pointer).
pub fn params_of(peb: u64, read: Reader<'_>) -> Option<u64> {
    read_u64(read, peb.checked_add(PEB_PROCESS_PARAMETERS)?).filter(|p| *p != 0)
}

/// The string a remote `UNICODE_STRING` at `at` describes.
pub fn remote_unicode(read: Reader<'_>, at: u64) -> Option<String> {
    let (len, ptr) = unicode_header(&read(at, UNICODE_STRING_SIZE)?)?;
    if len == 0 {
        return Some(String::new());
    }
    if ptr == 0 || len % 2 != 0 {
        return None;
    }
    let bytes = read(ptr, len)?;
    (bytes.len() == len).then(|| utf16le(&bytes))
}

/// A cwd as Windows keeps it (`C:\work\app\`, always with a trailing separator) → as
/// `std::env::current_dir` spells it (`C:\work\app`). A drive root keeps its separator
/// (`C:\`), and so does a UNC share root (`\\srv\share\`); `None` for an empty string.
pub fn trim_cwd(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    let trimmed = raw.trim_end_matches(['\\', '/']);
    let is_drive_root = trimmed.len() == 2 && trimmed.ends_with(':');
    let is_unc_root = trimmed.starts_with("\\\\") && trimmed[2..].split(['\\', '/']).count() <= 2;
    if trimmed.is_empty() || is_drive_root || is_unc_root {
        Some(raw.to_string())
    } else {
        Some(trimmed.to_string())
    }
}

/// The current directory from a process's parameters.
pub fn cwd_at(params: u64, read: Reader<'_>) -> Option<String> {
    trim_cwd(&remote_unicode(
        read,
        params.checked_add(PARAMS_CURRENT_DIRECTORY)?,
    )?)
}

/// The console handle value from a process's parameters (`0` = none).
pub fn console_at(params: u64, read: Reader<'_>) -> Option<u64> {
    read_u64(read, params.checked_add(PARAMS_CONSOLE_HANDLE)?)
}

/// The handle values of stdout and stderr from a process's parameters — values in THAT
/// process's handle table, to be duplicated before anything is asked of them. `None` when the
/// parameters cannot be read.
pub fn std_handles_at(params: u64, read: Reader<'_>) -> Option<[u64; 2]> {
    Some([
        read_u64(read, params.checked_add(PARAMS_STANDARD_OUTPUT)?)?,
        read_u64(read, params.checked_add(PARAMS_STANDARD_ERROR)?)?,
    ])
}

/// May this value from another process be passed to `DuplicateHandle`? Not `0` (none), and not
/// a negative one: `-1` (`INVALID_HANDLE_VALUE`, a detached process's std handle) means "the
/// current process" to `DuplicateHandle` — it would hand us a handle to the target process
/// itself — and `-2`… are the other pseudo-handles. Every real handle value is positive.
pub fn duplicable(value: u64) -> bool {
    (value as i64) > 0
}

/// One entry of another process's handle table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandleEntry {
    /// The handle's value in that process.
    pub value: u64,
    /// `GrantedAccess`: the rights the handle was opened with.
    pub access: u32,
    /// `ObjectTypeIndex`: the same number for every handle of one object type (`File`, `Event`,
    /// …) on this boot, so it is learned once from a handle of our own.
    pub type_index: u32,
}

/// The entries of a `PROCESS_HANDLE_SNAPSHOT_INFORMATION` buffer, at most `max`. A count that
/// claims more entries than the buffer holds yields the whole entries that are there — never a
/// read past what the API wrote.
pub fn parse_handle_snapshot(buf: &[u8], max: usize) -> Vec<HandleEntry> {
    let Some(count) = u64_at(buf, 0) else {
        return Vec::new();
    };
    let room = buf.len().saturating_sub(HANDLE_SNAPSHOT_HEADER) / HANDLE_ENTRY_SIZE;
    let n = usize::try_from(count)
        .unwrap_or(usize::MAX)
        .min(room)
        .min(max);
    let u32_at = |b: &[u8], at: usize| u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]);
    (0..n)
        .map(|i| {
            let at = HANDLE_SNAPSHOT_HEADER + i * HANDLE_ENTRY_SIZE;
            let e = &buf[at..at + HANDLE_ENTRY_SIZE];
            HandleEntry {
                value: u64::from_le_bytes([e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7]]),
                access: u32_at(e, 24),
                type_index: u32_at(e, 28),
            }
        })
        .collect()
}

/// Does this `GrantedAccess` let the holder write the file — `FILE_WRITE_DATA` (`0x2`) or
/// `FILE_APPEND_DATA` (`0x4`)? (Generic rights are already mapped to these by the time a
/// handle exists.) The Windows twin of "open with `O_WRONLY`/`O_RDWR`".
pub fn access_writes(access: u32) -> bool {
    access & (0x2 | 0x4) != 0
}

/// What a file handle is, from `FILE_FS_DEVICE_INFORMATION.DeviceType`. The query behind it
/// (`NtQueryVolumeInformationFile(FileFsDeviceInformation)`, also what `GetFileType` asks) is
/// answered without waiting for I/O already pending on the handle — measured on a
/// pipe with a pending synchronous read, a console with a pending read and a file whose
/// handle waited on a byte-range lock — so it is asked of every handle BEFORE anything that can
/// block (a name query blocks behind all three).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    /// A file on a local or network file system — the only kind whose name is ever asked.
    Disk,
    Pipe,
    Socket,
    /// `\Device\ConDrv` (the console every console program is attached to).
    Console,
    /// `NUL`.
    Null,
    Other,
}

/// `DeviceType` → [`Device`]. Numbers from `devioctl.h`, written as literals here (so a test
/// never compares the code with itself) and checked against real handles by a Windows test.
pub fn device_of(device_type: u32) -> Device {
    match device_type {
        // CD_ROM, CD_ROM_FILE_SYSTEM, DFS, DISK, DISK_FILE_SYSTEM, NETWORK_FILE_SYSTEM,
        // VIRTUAL_DISK, DFS_FILE_SYSTEM, DFS_VOLUME.
        0x02 | 0x03 | 0x06 | 0x07 | 0x08 | 0x14 | 0x24 | 0x35 | 0x36 => Device::Disk,
        0x11 => Device::Pipe,          // NAMED_PIPE (anonymous pipes too)
        0x12 | 0x21 => Device::Socket, // NETWORK, TRANSPORT
        0x50 | 0x1c | 0x0b => Device::Console, // CONSOLE (ConDrv), SCREEN, KEYBOARD
        0x15 => Device::Null,          // NULL
        _ => Device::Other,
    }
}

/// What a std handle (fd 1 or 2) turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StdTarget {
    /// A regular file, by its path (verbatim prefix already stripped).
    File(String),
    /// Anything else. `Device(Disk)` is a disk handle with no usable path: a directory, or one
    /// whose name did not come back in time.
    Device(Device),
}

/// fd `fd` (1 or 2) as the classifier's [`Fd`], or `None` when nothing is known about it (no
/// handle, or one that is not a file object at all).
pub fn std_fd(fd: i32, target: Option<&StdTarget>) -> Option<Fd> {
    let kind = match target? {
        StdTarget::File(path) => FdKind::File {
            path: path.clone(),
            // A std handle is what the process writes its output to.
            writable: true,
        },
        StdTarget::Device(Device::Console) => FdKind::Tty(WIN_CONSOLE_DEVICE.to_string()),
        StdTarget::Device(Device::Pipe) => FdKind::Pipe,
        StdTarget::Device(Device::Socket) => FdKind::Socket,
        StdTarget::Device(Device::Null) => FdKind::Null,
        StdTarget::Device(Device::Disk | Device::Other) => FdKind::Other,
    };
    Some(Fd { fd, kind })
}

/// What [`super::winproc`] read about one process's open handles.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenHandles {
    /// `RTL_USER_PROCESS_PARAMETERS.ConsoleHandle` (`None` = unreadable).
    pub console: Option<u64>,
    /// What stdout and stderr point at; `None` = they could not be examined (the PEB or the
    /// handles were not readable, or a 32-bit process — whose 64-bit copy of the parameters
    /// `SetStdHandle` does not update). Inside, `None` for a handle that is not a file object.
    pub std: Option<[Option<StdTarget>; 2]>,
    /// Regular files open for writing, by path, from the handle table (stdout/stderr's file
    /// may be among them too — [`super::logfiles::log_files`] lists a path once).
    pub files: Vec<String>,
}

/// The `Fd` table of a Windows process: fds 1/2 from what they point at — or, when they could
/// not be examined, from whether the process has a console at all ([`console_fds`]) — then
/// every file it holds open for writing, then its listening TCP ports.
pub fn fds_of(open: &OpenHandles, rows: &[TcpRow], pid: u32) -> Vec<Fd> {
    let mut fds: Vec<Fd> = match &open.std {
        Some([out, err]) => [std_fd(1, out.as_ref()), std_fd(2, err.as_ref())]
            .into_iter()
            .flatten()
            .collect(),
        None => console_fds(open.console),
    };
    fds.extend(open.files.iter().map(|path| Fd {
        fd: WIN_NO_FD,
        kind: FdKind::File {
            path: path.clone(),
            writable: true,
        },
    }));
    fds.extend(listener_fds(rows, pid));
    fds
}

/// The environment block's UTF-16 units from a process's parameters. `None` for a null block or
/// a size of 0 or past [`MAX_ENV_BYTES`].
pub fn env_units_at(params: u64, read: Reader<'_>) -> Option<Vec<u16>> {
    let ptr = read_u64(read, params.checked_add(PARAMS_ENVIRONMENT)?)?;
    let size = read_u64(read, params.checked_add(PARAMS_ENVIRONMENT_SIZE)?)?;
    if ptr == 0 || size == 0 || size > MAX_ENV_BYTES {
        return None;
    }
    let bytes = read(ptr, usize::try_from(size).ok()?)?;
    Some(
        bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect(),
    )
}

/// The environment from a process's parameters, as `(K, V)` pairs ([`parse_env_block`]).
pub fn env_at(params: u64, read: Reader<'_>) -> Option<Vec<(String, String)>> {
    Some(super::os::env_pairs(parse_env_block(&env_units_at(
        params, read,
    )?)))
}

/// A Windows environment block: `K=V` strings, each NUL-terminated, ended by an empty one. The
/// hidden per-drive cwd entries (`=C:=C:\work`) start with `=` and are dropped by
/// [`super::os::env_pairs`] (empty key), not here.
pub fn parse_env_block(units: &[u16]) -> Vec<String> {
    units
        .split(|u| *u == 0)
        .take_while(|s| !s.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

/// A Windows command line → argv, by the rules of `CommandLineToArgvW` (what the C runtime and
/// every program on the machine use):
///
/// - **argv\[0\]** (the program) ends at the next space/tab, or — when it starts with `"` — at
///   the next `"`, with no escapes at all (`"C:\Program Files\x.exe"`).
/// - **The rest**: space/tab outside quotes separates; `"` toggles quoting; `2n` backslashes
///   before a `"` are `n` backslashes (and the quote toggles), `2n+1` are `n` and a literal `"`;
///   backslashes not before a quote are literal; inside quotes `""` is a literal `"` that also
///   ends the quoted run (the pre-2008 rule `CommandLineToArgvW` keeps).
///
/// Differs from the API on one input only: an empty line is `[]` here, where the API answers
/// with the CALLER's own path.
pub fn split_command_line(line: &str) -> Vec<String> {
    let s: Vec<char> = line.chars().collect();
    let blank = |c: char| c == ' ' || c == '\t';
    let mut out = Vec::new();
    if s.is_empty() {
        return out;
    }
    let mut i = 0;
    let mut first = String::new();
    if s[0] == '"' {
        i = 1;
        while i < s.len() {
            let c = s[i];
            i += 1;
            if c == '"' {
                break;
            }
            first.push(c);
        }
    } else {
        while i < s.len() && !blank(s[i]) {
            first.push(s[i]);
            i += 1;
        }
    }
    out.push(first);
    while i < s.len() && blank(s[i]) {
        i += 1;
    }
    if i >= s.len() {
        return out;
    }
    let mut cur = String::new();
    // `quotes`: 0 = outside a quoted run, 1 = inside; 2 and 3 only while counting a run of `"`.
    let mut quotes = 0u32;
    let mut backslashes = 0usize;
    while i < s.len() {
        let c = s[i];
        if blank(c) && quotes == 0 {
            out.push(std::mem::take(&mut cur));
            while i < s.len() && blank(s[i]) {
                i += 1;
            }
            backslashes = 0;
            if i >= s.len() {
                return out;
            }
        } else if c == '\\' {
            cur.push('\\');
            backslashes += 1;
            i += 1;
        } else if c == '"' {
            let keep = cur.len() - backslashes / 2 - (backslashes % 2);
            cur.truncate(keep);
            if backslashes.is_multiple_of(2) {
                quotes += 1;
            } else {
                cur.push('"');
            }
            i += 1;
            backslashes = 0;
            while i < s.len() && s[i] == '"' {
                quotes += 1;
                if quotes == 3 {
                    cur.push('"');
                    quotes = 0;
                }
                i += 1;
            }
            if quotes == 2 {
                quotes = 0;
            }
        } else {
            cur.push(c);
            backslashes = 0;
            i += 1;
        }
    }
    out.push(cur);
    out
}

/// The length of a binary SID (revision 1, at most 15 sub-authorities): `8 + 4 × count`.
pub fn sid_len(b: &[u8]) -> Option<usize> {
    let count = usize::from(*b.get(1)?);
    (*b.first()? == 1 && count <= 15).then_some(8 + 4 * count)
}

/// A binary SID → its string form (`S-1-5-21-…-1001`), as `ConvertSidToStringSidW` writes it:
/// the 48-bit identifier authority in decimal, or `0x` + 12 hex digits when it does not fit in
/// 32 bits; sub-authorities little-endian, in decimal.
pub fn sid_string(b: &[u8]) -> Option<String> {
    let len = sid_len(b)?;
    let b = b.get(..len)?;
    let auth = &b[2..8];
    let mut out = if auth[0] != 0 || auth[1] != 0 {
        let hex: String = auth.iter().map(|x| format!("{x:02X}")).collect();
        format!("S-{}-0x{hex}", b[0])
    } else {
        let v = u64::from_be_bytes([0, 0, auth[0], auth[1], auth[2], auth[3], auth[4], auth[5]]);
        format!("S-{}-{v}", b[0])
    };
    for sub in b[8..].chunks_exact(4) {
        out.push_str(&format!(
            "-{}",
            u32::from_le_bytes([sub[0], sub[1], sub[2], sub[3]])
        ));
    }
    Some(out)
}

/// The "uid" of a Windows user: FNV-1a (32-bit) of the user SID's string form. Windows has no
/// uids; procscan's callers compare `uid_of(pid) == my_uid()` and pass `my_uid()` to `list`, and
/// a stable number derived from the SID keeps every one of those call sites unchanged. Two SIDs
/// colliding would need a 1-in-2³² accident between the handful of accounts on one machine — and
/// even then another user's process can neither be opened for its token nor terminated without
/// administrator rights, so the hash is never the only guard.
pub fn uid_of_sid(sid: &str) -> u32 {
    sid.bytes().fold(0x811c_9dc5u32, |h, b| {
        (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
    })
}

/// 100-ns ticks since 1601-01-01 (a `FILETIME`) → unix ms. `None` for 0 (unknown).
pub fn filetime_to_epoch_ms(ticks: u64) -> Option<i64> {
    const UNIX_EPOCH_MS_SINCE_1601: i64 = 11_644_473_600_000;
    (ticks != 0).then(|| (ticks / 10_000) as i64 - UNIX_EPOCH_MS_SINCE_1601)
}

/// `pid`'s listening TCP sockets as fds (both families; a port listened on twice is once in
/// `ports` — [`super::logfiles::listen_ports`] dedups).
pub fn listener_fds(rows: &[TcpRow], pid: u32) -> Vec<Fd> {
    rows.iter()
        .filter(|r| r.pid == pid && r.state == STATE_LISTEN)
        .map(|r| Fd {
            fd: WIN_NO_FD,
            kind: FdKind::Listen(r.local.port()),
        })
        .collect()
}

/// The FALLBACK for fds 1 and 2, used only when their handles could not be examined
/// ([`fds_of`]), from `RTL_USER_PROCESS_PARAMETERS.ConsoleHandle`: attached to a console → both
/// are that console (`console: "terminal"`); no console (`0`, a GUI program) or one of
/// `CreateProcess`'s placeholders (`-1` detached, `-2` new console, `-3` no window — values
/// that are never a real handle) → no fds (`console: "none"`).
pub fn console_fds(console_handle: Option<u64>) -> Vec<Fd> {
    let attached = console_handle.is_some_and(|h| (h as i64) > 0);
    if !attached {
        return Vec::new();
    }
    [1, 2]
        .into_iter()
        .map(|fd| Fd {
            fd,
            kind: FdKind::Tty(WIN_CONSOLE_DEVICE.to_string()),
        })
        .collect()
}

/// Windows reuses pids and never re-parents: a process whose parent exited keeps the parent's
/// old pid, which a younger, unrelated process may now hold. A parent that started AFTER its
/// child is that reuse — the link is cut (`ppid = 0`, as for an orphan), so a process is never
/// placed under an IDE terminal or a `claude` it does not descend from.
pub fn sanitize_ppids(procs: &mut [RawProc]) {
    let started: HashMap<u32, Option<i64>> = procs.iter().map(|p| (p.pid, p.started_ms)).collect();
    for p in procs.iter_mut() {
        if let (Some(Some(parent)), Some(child)) = (started.get(&p.ppid), p.started_ms) {
            if *parent > child {
                p.ppid = 0;
            }
        }
    }
}

/// Why `sigterm` refuses `pid` (`None` = it may be stopped): the idle process (0), the kernel
/// (4) and the IDE itself are never terminated, whatever the caller checked before.
pub fn terminate_refusal(pid: u32, me: u32) -> Option<String> {
    match pid {
        0 | 4 => Some(format!("refusing to stop system process {pid}")),
        p if p == me => Some("refusing to stop the IDE itself".to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn command_lines_split_by_the_windows_rules() {
        let cases: &[(&str, &[&str])] = &[
            (
                r#""C:\Program Files\nodejs\node.exe" server.js --port 3000"#,
                &[
                    r"C:\Program Files\nodejs\node.exe",
                    "server.js",
                    "--port",
                    "3000",
                ],
            ),
            // argv[0]: no escapes, ends at the next quote — a trailing backslash is kept.
            (r#""C:\dir\" x"#, &[r"C:\dir\", "x"]),
            (
                r"C:\w\target\debug\gazelle.exe",
                &[r"C:\w\target\debug\gazelle.exe"],
            ),
            (r#"a "b c" d"#, &["a", "b c", "d"]),
            // 2n backslashes + quote → n backslashes, the quote toggles.
            (r#"a "c:\dir\\" b"#, &["a", r"c:\dir\", "b"]),
            // 2n+1 backslashes + quote → n backslashes and a literal quote.
            (r#"a \"x\" b"#, &["a", r#""x""#, "b"]),
            (r#"a \\\"x b"#, &["a", r#"\"x"#, "b"]),
            // Backslashes not before a quote are literal.
            (r"a C:\w\x\\y z", &["a", r"C:\w\x\\y", "z"]),
            // `""` inside quotes: a literal quote that ends the quoted run.
            (r#"a "x""y z" w"#, &["a", r#"x"y"#, "z w"]),
            // Four quotes: open, a literal that closes, then open again — the space is quoted
            // (what the real `CommandLineToArgvW` answers; the Windows test compares them).
            (r#"a """" b"#, &["a", r#"" b"#]),
            (r#"a "" b"#, &["a", "", "b"]),
            ("a   b\t\tc  ", &["a", "b", "c"]),
            ("prog", &["prog"]),
            ("prog   ", &["prog"]),
            (r#"a "unterminated arg"#, &["a", "unterminated arg"]),
            (
                r#"node.exe C:\w\web\node_modules\.bin\\..\vite\bin\vite.js"#,
                &[
                    "node.exe",
                    r"C:\w\web\node_modules\.bin\\..\vite\bin\vite.js",
                ],
            ),
            ("", &[]),
        ];
        for (line, want) in cases {
            assert_eq!(split_command_line(line), v(want), "{line:?}");
        }
    }

    #[test]
    fn a_command_line_buffer_is_read_only_inside_itself() {
        let base = 0x1000u64;
        let text: Vec<u8> = "node.exe x"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let mut buf = vec![0u8; UNICODE_STRING_SIZE];
        buf[0..2].copy_from_slice(&(text.len() as u16).to_le_bytes());
        buf[2..4].copy_from_slice(&(text.len() as u16 + 2).to_le_bytes());
        buf[8..16].copy_from_slice(&(base + 16).to_le_bytes());
        buf.extend_from_slice(&text);
        assert_eq!(unicode_in_buffer(&buf, base).as_deref(), Some("node.exe x"));
        // A pointer before the buffer, or a length past its end: nothing.
        let mut before = buf.clone();
        before[8..16].copy_from_slice(&(base - 2).to_le_bytes());
        assert_eq!(unicode_in_buffer(&before, base), None);
        let mut long = buf.clone();
        long[0..2].copy_from_slice(&(text.len() as u16 + 4).to_le_bytes());
        assert_eq!(unicode_in_buffer(&long, base), None);
        assert_eq!(unicode_in_buffer(&buf[..8], base), None, "a short header");
        let mut empty = buf.clone();
        empty[0..2].copy_from_slice(&0u16.to_le_bytes());
        assert_eq!(unicode_in_buffer(&empty, base).as_deref(), Some(""));
    }

    /// A fake address space: `(address, bytes)` regions; a read must fit inside one.
    struct Mem(Vec<(u64, Vec<u8>)>);

    impl Mem {
        fn read(&self, addr: u64, len: usize) -> Option<Vec<u8>> {
            self.0.iter().find_map(|(at, b)| {
                let off = usize::try_from(addr.checked_sub(*at)?).ok()?;
                b.get(off..off + len).map(<[u8]>::to_vec)
            })
        }
    }

    fn unicode(len_bytes: usize, ptr: u64) -> Vec<u8> {
        let mut h = vec![0u8; UNICODE_STRING_SIZE];
        h[0..2].copy_from_slice(&(len_bytes as u16).to_le_bytes());
        h[2..4].copy_from_slice(&(len_bytes as u16 + 2).to_le_bytes());
        h[8..16].copy_from_slice(&ptr.to_le_bytes());
        h
    }

    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    /// A process laid out as the real one is: PEB → parameters → cwd / env / console. The
    /// offsets are written as LITERALS (phnt's 64-bit `RTL_USER_PROCESS_PARAMETERS`), not from
    /// the constants under test — a wrong constant must fail here too.
    fn process(cwd: &str, env: &str, env_size: u64, console: u64) -> Mem {
        const PEB: u64 = 0x7000_0000;
        const PARAMS: u64 = 0x2000_0000;
        const CWD: u64 = 0x3000_0000;
        const ENV: u64 = 0x4000_0000;
        let mut peb = vec![0u8; 0x40];
        peb[0x20..0x28].copy_from_slice(&PARAMS.to_le_bytes());
        let mut params = vec![0u8; 0x400];
        params[0x10..0x18].copy_from_slice(&console.to_le_bytes());
        params[0x38..0x48].copy_from_slice(&unicode(utf16(cwd).len(), CWD));
        params[0x80..0x88].copy_from_slice(&ENV.to_le_bytes());
        params[0x3F0..0x3F8].copy_from_slice(&env_size.to_le_bytes());
        Mem(vec![
            (PEB, peb),
            (PARAMS, params),
            (CWD, utf16(cwd)),
            (ENV, utf16(env)),
        ])
    }

    #[test]
    fn the_peb_walk_finds_cwd_env_and_console_at_the_real_offsets() {
        let env = "=C:=C:\\w\0PATH=C:\\bin\0MARKER=a=b\0\0";
        let mem = process("C:\\w\\app\\", env, utf16(env).len() as u64, 0x44);
        let read = |a: u64, n: usize| mem.read(a, n);
        let params = params_of(0x7000_0000, &read).expect("the parameters pointer");
        assert_eq!(params, 0x2000_0000);
        assert_eq!(cwd_at(params, &read).as_deref(), Some("C:\\w\\app"));
        assert_eq!(console_at(params, &read), Some(0x44));
        assert_eq!(
            env_at(params, &read),
            Some(vec![
                ("PATH".to_string(), "C:\\bin".to_string()),
                ("MARKER".to_string(), "a=b".to_string()),
            ]),
            "the hidden `=C:` entry is dropped, a value may hold `=`"
        );
        // A size of 0, or one past the cap, reads nothing (never a huge copy).
        let mem = process("C:\\", env, 0, 0);
        let read = |a: u64, n: usize| mem.read(a, n);
        assert_eq!(env_at(0x2000_0000, &read), None);
        assert_eq!(cwd_at(0x2000_0000, &read).as_deref(), Some("C:\\"));
        let mem = process("C:\\", env, MAX_ENV_BYTES + 2, 0);
        let read = |a: u64, n: usize| mem.read(a, n);
        assert_eq!(env_at(0x2000_0000, &read), None);
        // Unreadable memory: nothing, never a panic.
        let none = |_: u64, _: usize| None::<Vec<u8>>;
        assert_eq!(params_of(0x7000_0000, &none), None);
        assert_eq!(cwd_at(0x2000_0000, &none), None);
    }

    #[test]
    fn a_remote_string_must_be_whole() {
        let mem = Mem(vec![(0x100, unicode(6, 0x900)), (0x900, utf16("ab"))]);
        let read = |a: u64, n: usize| mem.read(a, n);
        assert_eq!(
            remote_unicode(&read, 0x100),
            None,
            "6 bytes claimed, 4 there"
        );
        let odd = Mem(vec![(0x100, unicode(3, 0x900)), (0x900, utf16("ab"))]);
        let read = |a: u64, n: usize| odd.read(a, n);
        assert_eq!(remote_unicode(&read, 0x100), None, "an odd length");
        let null = Mem(vec![(0x100, unicode(4, 0))]);
        let read = |a: u64, n: usize| null.read(a, n);
        assert_eq!(remote_unicode(&read, 0x100), None, "a null buffer");
    }

    #[test]
    fn cwds_lose_the_trailing_separator_except_at_a_root() {
        assert_eq!(trim_cwd("C:\\w\\app\\").as_deref(), Some("C:\\w\\app"));
        assert_eq!(trim_cwd("C:\\w\\app").as_deref(), Some("C:\\w\\app"));
        assert_eq!(trim_cwd("C:\\").as_deref(), Some("C:\\"));
        assert_eq!(
            trim_cwd("\\\\srv\\share\\").as_deref(),
            Some("\\\\srv\\share\\")
        );
        assert_eq!(
            trim_cwd("\\\\srv\\share\\proj\\").as_deref(),
            Some("\\\\srv\\share\\proj")
        );
        assert_eq!(trim_cwd(""), None);
    }

    #[test]
    fn an_environment_block_ends_at_the_empty_string() {
        let units: Vec<u16> = "A=1\0=C:=C:\\x\0B=\0\0JUNK=after\0"
            .encode_utf16()
            .collect();
        assert_eq!(parse_env_block(&units), v(&["A=1", "=C:=C:\\x", "B="]));
        assert!(parse_env_block(&[]).is_empty());
        assert!(parse_env_block(&[0, 0]).is_empty());
        // No terminator at all (a truncated read): what is there.
        let open: Vec<u16> = "A=1\0B=2".encode_utf16().collect();
        assert_eq!(parse_env_block(&open), v(&["A=1", "B=2"]));
        // Non-ASCII survives UTF-16.
        let wide: Vec<u16> = "NAME=Zoë 日本\0\0".encode_utf16().collect();
        assert_eq!(parse_env_block(&wide), v(&["NAME=Zoë 日本"]));
    }

    #[test]
    fn sids_render_like_the_os_and_hash_to_a_stable_uid() {
        // S-1-5-18 (LocalSystem): revision 1, one sub-authority, NT authority (5).
        let system = [1u8, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0];
        assert_eq!(sid_string(&system).as_deref(), Some("S-1-5-18"));
        let mut user = vec![1u8, 5, 0, 0, 0, 0, 0, 5];
        for sub in [21u32, 1_111_111_111, 2_222_222_222, 3_333_333_333, 1001] {
            user.extend_from_slice(&sub.to_le_bytes());
        }
        let user_s = "S-1-5-21-1111111111-2222222222-3333333333-1001";
        assert_eq!(sid_string(&user).as_deref(), Some(user_s));
        assert_eq!(sid_len(&user), Some(28));
        // Trailing bytes past the SID's own length are ignored.
        let mut padded = system.to_vec();
        padded.extend_from_slice(&[9, 9, 9]);
        assert_eq!(sid_string(&padded).as_deref(), Some("S-1-5-18"));
        // An authority that needs more than 32 bits is written in hex.
        let wide = [1u8, 0, 0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC];
        assert_eq!(sid_string(&wide).as_deref(), Some("S-1-0x123456789ABC"));
        // Not a SID: a wrong revision, too many sub-authorities, a truncated buffer.
        assert_eq!(sid_string(&[2, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0]), None);
        assert_eq!(sid_string(&[1, 16, 0, 0, 0, 0, 0, 5]), None);
        assert_eq!(sid_string(&system[..10]), None);
        assert_eq!(sid_string(&[]), None);
        // FNV-1a 32, the expected values computed independently (in Node).
        assert_eq!(uid_of_sid("S-1-5-18"), 3_472_482_492);
        assert_eq!(uid_of_sid(user_s), 3_879_267_298);
        assert_eq!(uid_of_sid(""), 0x811c_9dc5);
        assert_eq!(
            uid_of_sid("S-1-5-19"),
            3_489_260_111,
            "one character apart, far apart"
        );
    }

    #[test]
    fn filetimes_become_unix_ms() {
        // Computed independently: (Date.UTC(2026, 0, 1) + 11644473600000) × 10000.
        assert_eq!(
            filetime_to_epoch_ms(134_116_992_000_000_000),
            Some(1_767_225_600_000)
        );
        assert_eq!(filetime_to_epoch_ms(116_444_736_000_000_000), Some(0));
        assert_eq!(filetime_to_epoch_ms(116_444_736_000_009_999), Some(0));
        assert_eq!(filetime_to_epoch_ms(0), None);
    }

    fn row(local: &str, state: u32, pid: u32) -> TcpRow {
        TcpRow {
            local: local.parse::<SocketAddr>().unwrap(),
            remote: "0.0.0.0:0".parse().unwrap(),
            state,
            pid,
        }
    }

    #[test]
    fn listeners_become_fds_the_console_rule_never_reads() {
        let rows = [
            row("0.0.0.0:5173", STATE_LISTEN, 40),
            row("[::]:5173", STATE_LISTEN, 40),
            row("127.0.0.1:9229", STATE_LISTEN, 40),
            row("127.0.0.1:50000", 5, 40), // ESTABLISHED: not a listener
            row("0.0.0.0:8080", STATE_LISTEN, 41),
        ];
        let fds = listener_fds(&rows, 40);
        assert_eq!(fds.len(), 3);
        assert!(fds.iter().all(|f| f.fd == WIN_NO_FD));
        assert_eq!(super::super::logfiles::listen_ports(&fds), vec![5173, 9229]);
        assert_eq!(
            super::super::logfiles::console_of(&fds),
            super::super::logfiles::Console::None,
            "a listener is never mistaken for stdout"
        );
        assert!(listener_fds(&rows, 99).is_empty());
    }

    #[test]
    fn a_console_handle_makes_fds_1_and_2_a_terminal() {
        use super::super::logfiles::{console_of, stdout_tty, Console};
        let fds = console_fds(Some(0x44));
        assert_eq!(console_of(&fds), Console::Terminal);
        assert_eq!(stdout_tty(&fds), Some(WIN_CONSOLE_DEVICE));
        for none in [
            None,
            Some(0),
            Some(u64::MAX),
            Some(u64::MAX - 1),
            Some(u64::MAX - 2),
        ] {
            assert_eq!(console_of(&console_fds(none)), Console::None, "{none:?}");
        }
    }

    #[test]
    fn the_std_handles_are_read_at_their_offsets() {
        // Literal offsets (phnt's 64-bit RTL_USER_PROCESS_PARAMETERS), not the constants.
        let mut params = vec![0u8; 0x40];
        params[0x10..0x18].copy_from_slice(&0x44u64.to_le_bytes()); // ConsoleHandle
        params[0x20..0x28].copy_from_slice(&0x50u64.to_le_bytes()); // StandardInput
        params[0x28..0x30].copy_from_slice(&0xb4u64.to_le_bytes()); // StandardOutput
        params[0x30..0x38].copy_from_slice(&0xb8u64.to_le_bytes()); // StandardError
        let mem = Mem(vec![(0x2000_0000, params)]);
        let read = |a: u64, n: usize| mem.read(a, n);
        assert_eq!(std_handles_at(0x2000_0000, &read), Some([0xb4, 0xb8]));
        assert_eq!(console_at(0x2000_0000, &read), Some(0x44));
        let none = |_: u64, _: usize| None::<Vec<u8>>;
        assert_eq!(std_handles_at(0x2000_0000, &none), None);
    }

    /// A snapshot buffer laid out by hand (literal offsets: 16-byte header, 40-byte entries,
    /// `GrantedAccess` at +24, `ObjectTypeIndex` at +28).
    fn snapshot(count: u64, entries: &[(u64, u32, u32)]) -> Vec<u8> {
        let mut b = vec![0u8; 16];
        b[0..8].copy_from_slice(&count.to_le_bytes());
        for (value, access, ty) in entries {
            let mut e = vec![0u8; 40];
            e[0..8].copy_from_slice(&value.to_le_bytes());
            e[8..16].copy_from_slice(&1u64.to_le_bytes()); // HandleCount: never read
            e[16..24].copy_from_slice(&7u64.to_le_bytes()); // PointerCount: never read
            e[24..28].copy_from_slice(&access.to_le_bytes());
            e[28..32].copy_from_slice(&ty.to_le_bytes());
            e[32..36].copy_from_slice(&2u32.to_le_bytes()); // HandleAttributes: never read
            b.extend_from_slice(&e);
        }
        b
    }

    #[test]
    fn a_handle_snapshot_is_read_entry_by_entry_and_never_past_its_end() {
        let entries = [
            (0x4, 0x0012_019f, 42),
            (0xb4, 0x0012_0196, 42),
            (0xc8, 0x001f_0003, 17),
        ];
        let want: Vec<HandleEntry> = entries
            .iter()
            .map(|&(value, access, type_index)| HandleEntry {
                value,
                access,
                type_index,
            })
            .collect();
        let buf = snapshot(3, &entries);
        assert_eq!(parse_handle_snapshot(&buf, 100), want);
        assert_eq!(parse_handle_snapshot(&buf, 2), want[..2], "at most `max`");
        // A count past the buffer: only the whole entries that are there.
        let lying = snapshot(1_000_000, &entries);
        assert_eq!(parse_handle_snapshot(&lying, usize::MAX), want);
        let mut cut = buf.clone();
        cut.truncate(16 + 40 + 39);
        assert_eq!(parse_handle_snapshot(&cut, 100), want[..1], "a torn entry");
        assert!(parse_handle_snapshot(&buf[..7], 100).is_empty());
        assert!(parse_handle_snapshot(&snapshot(0, &entries), 100).is_empty());
    }

    #[test]
    fn pseudo_handles_are_never_duplicated() {
        for (value, want) in [
            (0x4u64, true),
            (0xb4, true),
            (0x00ff_fffc, true),
            (0, false),
            (u64::MAX, false),     // -1: "the current process" to DuplicateHandle
            (u64::MAX - 1, false), // -2: the current thread
            (u64::MAX - 5, false),
        ] {
            assert_eq!(duplicable(value), want, "{value:#x}");
        }
    }

    #[test]
    fn write_access_is_write_data_or_append_data() {
        // Hand-written: the masks real handles carry (measured on Windows 11).
        let table: &[(u32, bool)] = &[
            (0x0012_019f, true),  // a pipe end / console opened read+write
            (0x0012_0196, true),  // FILE_GENERIC_WRITE (`>` redirection, a log opened to append)
            (0x0000_0004, true),  // FILE_APPEND_DATA alone
            (0x0000_0002, true),  // FILE_WRITE_DATA alone
            (0x0012_0089, false), // FILE_GENERIC_READ
            (0x0010_0020, false), // a directory opened to traverse (the cwd handle)
            (0x0010_0001, false), // read data + synchronize (a mapped .mui)
            (0, false),
        ];
        for (access, want) in table {
            assert_eq!(access_writes(*access), *want, "{access:#x}");
        }
    }

    #[test]
    fn device_types_name_what_a_handle_is() {
        let table: &[(u32, Device)] = &[
            (0x07, Device::Disk), // a file on a local volume
            (0x08, Device::Disk),
            (0x14, Device::Disk), // SMB
            (0x24, Device::Disk),
            (0x11, Device::Pipe),
            (0x12, Device::Socket),
            (0x50, Device::Console),
            (0x15, Device::Null),
            (0x0c, Device::Other), // a mailslot
            (0x22, Device::Other),
            (0, Device::Other),
        ];
        for (t, want) in table {
            assert_eq!(device_of(*t), *want, "{t:#x}");
        }
    }

    #[test]
    fn std_targets_and_open_files_become_the_fd_table() {
        use super::super::logfiles::{console_of, log_files, Console, LogVia};
        let file = |p: &str| Some(StdTarget::File(p.to_string()));
        let dev = |d: Device| Some(StdTarget::Device(d));
        let rows = [row("0.0.0.0:5173", STATE_LISTEN, 40)];
        // `npm run dev > dev.log 2>&1`, plus a log the app opened itself.
        let redirected = OpenHandles {
            console: Some(0x44),
            std: Some([file(r"C:\w\dev.log"), file(r"C:\w\dev.log")]),
            files: vec![r"C:\w\dev.log".into(), r"C:\w\logs\app.log".into()],
        };
        let fds = fds_of(&redirected, &rows, 40);
        assert_eq!(console_of(&fds), Console::File);
        assert_eq!(super::super::logfiles::listen_ports(&fds), vec![5173]);
        assert_eq!(
            log_files(&fds, None),
            vec![
                (r"C:\w\dev.log".to_string(), LogVia::Stdout),
                (r"C:\w\logs\app.log".to_string(), LogVia::Log),
            ]
        );
        // stderr alone to a file.
        let split = OpenHandles {
            std: Some([dev(Device::Console), file(r"C:\w\err.txt")]),
            ..OpenHandles::default()
        };
        assert_eq!(
            log_files(&fds_of(&split, &[], 1), None),
            vec![(r"C:\w\err.txt".to_string(), LogVia::Stderr)]
        );
        let cases: Vec<(OpenHandles, Console)> = vec![
            (
                OpenHandles {
                    console: Some(0x44),
                    std: Some([dev(Device::Console), dev(Device::Console)]),
                    files: vec![],
                },
                Console::Terminal,
            ),
            (
                OpenHandles {
                    console: Some(0x44),
                    std: Some([dev(Device::Pipe), dev(Device::Null)]),
                    files: vec![],
                },
                Console::Pipe,
            ),
            (
                OpenHandles {
                    std: Some([dev(Device::Socket), None]),
                    ..OpenHandles::default()
                },
                Console::Pipe,
            ),
            // Examined and found to be NUL: none — even with a console attached (the old rule
            // would have said terminal).
            (
                OpenHandles {
                    console: Some(0x44),
                    std: Some([dev(Device::Null), dev(Device::Null)]),
                    files: vec![],
                },
                Console::None,
            ),
            // Handles that are not files at all (a GUI program's empty slots).
            (
                OpenHandles {
                    console: Some(0x44),
                    std: Some([None, None]),
                    files: vec![],
                },
                Console::None,
            ),
            // A disk handle with no path (a directory, or a name that never came back).
            (
                OpenHandles {
                    std: Some([dev(Device::Disk), None]),
                    ..OpenHandles::default()
                },
                Console::None,
            ),
            // Not examinable: the console rule.
            (
                OpenHandles {
                    console: Some(0x44),
                    std: None,
                    files: vec![],
                },
                Console::Terminal,
            ),
            (OpenHandles::default(), Console::None),
        ];
        for (open, want) in cases {
            assert_eq!(console_of(&fds_of(&open, &[], 1)), want, "{open:?}");
        }
        // A file opened for writing is offered even when stdout is a terminal.
        let held = OpenHandles {
            console: Some(0x44),
            std: Some([dev(Device::Console), dev(Device::Console)]),
            files: vec![r"C:\w\held.log".into(), r"C:\w\data.db".into()],
        };
        assert_eq!(
            log_files(&fds_of(&held, &[], 1), None),
            vec![(r"C:\w\held.log".to_string(), LogVia::Log)]
        );
    }

    fn rp(pid: u32, ppid: u32, started: Option<i64>) -> RawProc {
        RawProc {
            pid,
            ppid,
            exe: None,
            argv: Vec::new(),
            cwd: None,
            started_ms: started,
            fds: Vec::new(),
        }
    }

    #[test]
    fn a_reused_parent_pid_is_cut() {
        let mut procs = vec![
            rp(10, 1, Some(100)),
            rp(20, 10, Some(200)), // a real child: its parent is older
            rp(30, 40, Some(300)), // 40 is YOUNGER than 30: pid reuse
            rp(40, 1, Some(400)),
            rp(50, 10, None),      // unknown start: left alone
            rp(60, 99, Some(600)), // parent not in the table: left alone
            rp(70, 10, Some(100)), // the same tick as its parent: a child
        ];
        sanitize_ppids(&mut procs);
        let ppids: Vec<u32> = procs.iter().map(|p| p.ppid).collect();
        assert_eq!(ppids, vec![1, 10, 0, 1, 10, 99, 10]);
    }

    #[test]
    fn system_pids_and_our_own_are_never_terminated() {
        assert!(terminate_refusal(0, 100).is_some());
        assert!(terminate_refusal(4, 100).is_some());
        assert!(terminate_refusal(100, 100).is_some_and(|r| r.contains("IDE itself")));
        assert_eq!(terminate_refusal(8, 100), None);
    }
}
