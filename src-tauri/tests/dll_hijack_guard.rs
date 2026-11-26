//! Security gate: vendored `portable-pty` must never load `conpty.dll` by bare name (CWE-427:
//! the exe dir and cwd are searched; only KnownDLLs like kernel32 are safe). A source check runs
//! on every OS, so re-vendoring upstream's sideload turns the build red.

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

/// Matches the bare-name `open(...)` construct, not the string `conpty.dll`, which comments use.
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

/// ConPTY must survive the patch: the `kernel32` load is why the function stays (ARCHITECTURE
/// §6); this fails faster than Windows CI, and on every OS.
#[test]
fn vendored_conpty_still_loads_kernel32() {
    let src = std::fs::read_to_string(vendored_psuedocon()).expect("read vendored psuedocon.rs");
    assert!(
        src.contains(r#"ConPtyFuncs::open(Path::new("kernel32.dll"))"#),
        "the kernel32 ConPTY load is gone — Windows terminals would break entirely"
    );
}
