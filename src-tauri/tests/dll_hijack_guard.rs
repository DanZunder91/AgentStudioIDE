//! Security gate: the Windows ConPTY DLL-hijack hole must stay closed.
//!
//! **The vulnerability.** `portable-pty` 0.9.0 (`src/win/psuedocon.rs`) preferred a
//! *sideloaded* `conpty.dll`, loading it by **bare name**:
//!
//! ```text
//! ConPtyFuncs::open(Path::new("conpty.dll"))  ->  LoadLibraryW(L"conpty.dll")
//! ```
//!
//! A bare name sends Windows down the standard DLL search order, which includes
//! **the directory the .exe was loaded from** and **the current directory**. Anyone
//! who can drop a `conpty.dll` in either one gets their `DllMain` run inside our
//! process, with our privileges — and we spawn shells and read the user's files.
//! That is CWE-427 (uncontrolled search path element). The `kernel32.dll` load
//! beside it is safe only because kernel32 is a protected **KnownDLL**, resolved
//! from `\KnownDlls` with the app directory ignored; `conpty.dll` gets no such
//! protection.
//!
//! **Why a source-level assertion rather than a behavioural test.** The hole is
//! Windows-only and lives in a `lazy_static` inside a dependency, so there is no
//! API to interrogate at runtime and no portable way to observe *which* library
//! backed the ConPTY calls. What we can do — on **every** platform, including the
//! macOS and Linux CI legs — is assert the dangerous construct is absent from the
//! source we actually compile. That makes this gate useful precisely where a
//! Windows-only test would not run at all.
//!
//! This exists to survive a re-vendor: bumping or re-copying `portable-pty` would
//! silently restore upstream's sideload, and this test is what turns that from a
//! shipped vulnerability into a red build.

use std::path::PathBuf;

/// The vendored, patched `portable-pty` — the source Cargo actually builds, via
/// `[patch.crates-io]` in `Cargo.toml`.
fn vendored_psuedocon() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor/portable-pty/src/win/psuedocon.rs")
}

/// The `[patch.crates-io]` must stay wired up. Without it Cargo silently resolves
/// the unpatched crates.io `portable-pty` and the hole is back — with the vendored
/// file still sitting in the tree looking reassuring.
#[test]
fn portable_pty_is_still_patched_to_the_vendored_copy() {
    let manifest =
        std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
            .expect("failed to read Cargo.toml");

    let patch = manifest
        .split("[patch.crates-io]")
        .nth(1)
        .expect("[patch.crates-io] section is gone — portable-pty is no longer patched");

    assert!(
        patch.contains("portable-pty") && patch.contains("vendor/portable-pty"),
        "portable-pty is no longer patched to the vendored copy; the upstream \
         crate reintroduces the conpty.dll sideload (CWE-427)"
    );
}

/// The vendored source must exist — `[patch.crates-io]` pointing at a missing path
/// is a build error, but a *renamed* file would leave the guard above passing while
/// this test explains what actually broke.
#[test]
fn vendored_portable_pty_is_present() {
    assert!(
        vendored_psuedocon().is_file(),
        "vendored portable-pty is missing at {} — the DLL-hijack patch is gone",
        vendored_psuedocon().display()
    );
}

/// **The core assertion: no bare-name `conpty.dll` load.**
///
/// Matches the dangerous *construct* (`open(...)` on a bare `conpty.dll`) rather
/// than the string `conpty.dll`, which legitimately appears throughout the file's
/// comments and in the explanation of what was removed.
#[test]
fn vendored_conpty_has_no_sideload_call() {
    let src = std::fs::read_to_string(vendored_psuedocon()).expect("read vendored psuedocon.rs");

    // Strip comments: the patch documents the removed code in a comment block on
    // purpose, and that must not trip the guard (nor let it pass vacuously).
    let code: String = src
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");

    assert!(
        !code.contains("conpty.dll"),
        "a bare-name `conpty.dll` load is back in vendored portable-pty — this is \
         the Windows DLL-hijack hole (CWE-427). ConPTY must come from kernel32 \
         only. See the header comment in vendor/portable-pty/src/win/psuedocon.rs"
    );

    // Belt and braces: `ConPtyFuncs::open` must be called exactly once, for the
    // KnownDLL. A second `open` is by definition a non-KnownDLL load.
    assert_eq!(
        code.matches("ConPtyFuncs::open").count(),
        1,
        "expected exactly one ConPtyFuncs::open (kernel32, a protected KnownDLL); \
         any additional load is a DLL-hijack vector"
    );
}

/// ConPTY itself must survive the patch: the `kernel32` load is the whole point of
/// keeping the function, and Windows terminals are non-negotiable (ARCHITECTURE §6).
/// Deleting `load_conpty`'s kernel32 path would break every Windows terminal —
/// which the Windows CI leg would catch, but this fails faster and everywhere.
#[test]
fn vendored_conpty_still_loads_kernel32() {
    let src = std::fs::read_to_string(vendored_psuedocon()).expect("read vendored psuedocon.rs");
    assert!(
        src.contains(r#"ConPtyFuncs::open(Path::new("kernel32.dll"))"#),
        "the kernel32 ConPTY load is gone — Windows terminals would break entirely"
    );
}
