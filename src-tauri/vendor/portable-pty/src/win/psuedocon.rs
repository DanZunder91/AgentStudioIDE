use super::WinChild;
use crate::cmdbuilder::CommandBuilder;
use crate::win::procthreadattr::ProcThreadAttributeList;
use anyhow::{bail, ensure, Error};
use filedescriptor::{FileDescriptor, OwnedHandle};
use lazy_static::lazy_static;
use shared_library::shared_library;
use std::ffi::OsString;
use std::io::Error as IoError;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::sync::Mutex;
use std::{mem, ptr};
use winapi::shared::minwindef::DWORD;
use winapi::shared::winerror::{HRESULT, S_OK};
use winapi::um::handleapi::*;
use winapi::um::processthreadsapi::*;
use winapi::um::winbase::{
    CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};
use winapi::um::wincon::COORD;
use winapi::um::winnt::HANDLE;

pub type HPCON = HANDLE;

#[allow(dead_code)]
pub const PSUEDOCONSOLE_INHERIT_CURSOR: DWORD = 0x1;
pub const PSEUDOCONSOLE_RESIZE_QUIRK: DWORD = 0x2;
pub const PSEUDOCONSOLE_WIN32_INPUT_MODE: DWORD = 0x4;
#[allow(dead_code)]
pub const PSEUDOCONSOLE_PASSTHROUGH_MODE: DWORD = 0x8;

shared_library!(ConPtyFuncs,
    pub fn CreatePseudoConsole(
        size: COORD,
        hInput: HANDLE,
        hOutput: HANDLE,
        flags: DWORD,
        hpc: *mut HPCON
    ) -> HRESULT,
    pub fn ResizePseudoConsole(hpc: HPCON, size: COORD) -> HRESULT,
    pub fn ClosePseudoConsole(hpc: HPCON),
);

// ── Agent Studio local patch — DO NOT re-vendor this file without re-applying ──
//
// Upstream (portable-pty 0.9.0) tried a *sideloaded* `conpty.dll` here first:
//
//     if let Ok(sideloaded) = ConPtyFuncs::open(Path::new("conpty.dll")) {
//         sideloaded
//     } else {
//         kernel
//     }
//
// That is an arbitrary-code-execution hole (CWE-427, uncontrolled search path).
// `ConPtyFuncs::open` calls `LoadLibraryW(L"conpty.dll")` with a **bare name**, so
// Windows walks the standard DLL search order — which includes the directory the
// .exe was loaded from and the current directory. Anyone able to drop a file named
// `conpty.dll` in either location gets their `DllMain` executed inside our process,
// with our privileges — and we spawn shells and read the user's filesystem.
//
// The neighbouring `kernel32.dll` load is safe only because kernel32 is a
// protected **KnownDLL**: the loader resolves it from \KnownDlls (System32) and
// ignores the app directory entirely. `conpty.dll` gets no such protection.
//
// Removing this costs us nothing: Agent Studio never ships a `conpty.dll`, so the
// sideload could never succeed on a clean machine — it already fell through to
// `kernel32` every time. The only thing it could ever load is an attacker's DLL.
// ConPTY itself is unaffected: `kernel32`'s built-in implementation is the path we
// already use, and Windows terminals remain fully supported (ARCHITECTURE §6).
//
// Guarded by `tests/dll_hijack_guard.rs`, which fails the build if the sideload
// ever returns. Upstream patch pending; drop this vendor when it lands.
fn load_conpty() -> ConPtyFuncs {
    // If the kernel doesn't export these functions then their system is
    // too old and we cannot run.
    ConPtyFuncs::open(Path::new("kernel32.dll")).expect(
        "this system does not support conpty.  Windows 10 October 2018 or newer is required",
    )
}

lazy_static! {
    static ref CONPTY: ConPtyFuncs = load_conpty();
}

// ── Agent Studio local patch #2 — no PSEUDOCONSOLE_INHERIT_CURSOR ──────────────
//
// Upstream creates the pseudo-console with
// `PSUEDOCONSOLE_INHERIT_CURSOR | PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE`.
// INHERIT_CURSOR tells the console host to take over the cursor position of an
// *existing* terminal session: it writes a cursor-position query (`ESC[6n`) to the
// output pipe and holds the client until a report (`ESC[row;colR`) comes back on the
// input pipe. Measured on Windows 11 (`tests/pty_lifecycle.rs`): with the
// flag, `cmd /C "exit 7"` never exits and the only thing the terminal ever shows is
// `ESC[6n`; without it, it exits at once with code 7 and no query is sent.
//
// xterm.js answers the query, so a terminal open in the UI works either way. But
// nothing answers a PTY before its UI attaches (a restored agent, a background view)
// or in a test, and a host blocked on that query also never notices its creator dying,
// so `cmd.exe` + `conhost.exe` pairs outlive a crashed parent process.
// Agent Studio always opens a FRESH console, so there is no cursor to inherit; the
// flag bought nothing. RESIZE_QUIRK and WIN32_INPUT_MODE stay (input through
// cmd and PowerShell is covered by `typing_into_cmd_and_powershell_echoes_back_…`).
//
// Guarded by `a_child_that_exits_at_once_is_reaped_with_nobody_answering_the_terminal`.
const PSEUDOCONSOLE_FLAGS: DWORD = PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE;

pub struct PsuedoCon {
    con: HPCON,
}

unsafe impl Send for PsuedoCon {}
unsafe impl Sync for PsuedoCon {}

impl Drop for PsuedoCon {
    fn drop(&mut self) {
        unsafe { (CONPTY.ClosePseudoConsole)(self.con) };
    }
}

impl PsuedoCon {
    pub fn new(size: COORD, input: FileDescriptor, output: FileDescriptor) -> Result<Self, Error> {
        let mut con: HPCON = INVALID_HANDLE_VALUE;
        let result = unsafe {
            (CONPTY.CreatePseudoConsole)(
                size,
                input.as_raw_handle() as _,
                output.as_raw_handle() as _,
                PSEUDOCONSOLE_FLAGS,
                &mut con,
            )
        };
        ensure!(
            result == S_OK,
            "failed to create psuedo console: HRESULT {}",
            result
        );
        Ok(Self { con })
    }

    pub fn resize(&self, size: COORD) -> Result<(), Error> {
        let result = unsafe { (CONPTY.ResizePseudoConsole)(self.con, size) };
        ensure!(
            result == S_OK,
            "failed to resize console to {}x{}: HRESULT: {}",
            size.X,
            size.Y,
            result
        );
        Ok(())
    }

    pub fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<WinChild> {
        let mut si: STARTUPINFOEXW = unsafe { mem::zeroed() };
        si.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
        // Explicitly set the stdio handles as invalid handles otherwise
        // we can end up with a weird state where the spawned process can
        // inherit the explicitly redirected output handles from its parent.
        // For example, when daemonizing wezterm-mux-server, the stdio handles
        // are redirected to a log file and the spawned process would end up
        // writing its output there instead of to the pty we just created.
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;

        let mut attrs = ProcThreadAttributeList::with_capacity(1)?;
        attrs.set_pty(self.con)?;
        si.lpAttributeList = attrs.as_mut_ptr();

        let mut pi: PROCESS_INFORMATION = unsafe { mem::zeroed() };

        let (mut exe, mut cmdline) = cmd.cmdline()?;
        let cmd_os = OsString::from_wide(&cmdline);

        let cwd = cmd.current_directory();

        let res = unsafe {
            CreateProcessW(
                exe.as_mut_slice().as_mut_ptr(),
                cmdline.as_mut_slice().as_mut_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                cmd.environment_block().as_mut_slice().as_mut_ptr() as *mut _,
                cwd.as_ref()
                    .map(|c| c.as_slice().as_ptr())
                    .unwrap_or(ptr::null()),
                &mut si.StartupInfo,
                &mut pi,
            )
        };
        if res == 0 {
            let err = IoError::last_os_error();
            let msg = format!(
                "CreateProcessW `{:?}` in cwd `{:?}` failed: {}",
                cmd_os,
                cwd.as_ref().map(|c| OsString::from_wide(c)),
                err
            );
            log::error!("{}", msg);
            bail!("{}", msg);
        }

        // Make sure we close out the thread handle so we don't leak it;
        // we do this simply by making it owned
        let _main_thread = unsafe { OwnedHandle::from_raw_handle(pi.hThread as _) };
        let proc = unsafe { OwnedHandle::from_raw_handle(pi.hProcess as _) };

        Ok(WinChild {
            proc: Mutex::new(proc),
        })
    }
}
