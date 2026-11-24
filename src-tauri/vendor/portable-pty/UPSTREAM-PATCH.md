# Upstream patch: remove the `conpty.dll` sideload (CWE-427)

This directory is a **temporary vendored fork** of [`portable-pty`] 0.9.0, carrying
exactly one change. It exists only until the fix below lands upstream — at which
point delete `vendor/portable-pty/`, drop `[patch.crates-io]` from
`src-tauri/Cargo.toml`, and bump the dependency.

- **Upstream:** https://github.com/wezterm/wezterm (`pty/src/win/psuedocon.rs`)
- **Affected:** `portable-pty` ≤ 0.9.0 (0.9.0 is the latest published version at
  the time of writing — there is no fixed release to upgrade to)
- **License:** MIT, unchanged. This fork adds no new terms.
- **Platform:** Windows only.

## The vulnerability

`load_conpty()` preferred a *sideloaded* `conpty.dll`, loaded by **bare name**:

```rust
// portable-pty 0.9.0, src/win/psuedocon.rs:55
if let Ok(sideloaded) = ConPtyFuncs::open(Path::new("conpty.dll")) {
    sideloaded
} else {
    kernel
}
```

`ConPtyFuncs::open` (the `shared_library` crate) resolves to
`LoadLibraryW(L"conpty.dll")` — a bare filename, which sends Windows down the
[standard DLL search order][search]. That order includes **the directory the
executable was loaded from** and **the current directory**.

Any user able to write a file named `conpty.dll` to either location gets their
`DllMain` executed inside the host process with its full privileges. For a program
whose whole job is spawning PTYs, that is arbitrary code execution in a process
that spawns shells and reads the user's filesystem. This is **CWE-427: Uncontrolled
Search Path Element** (a.k.a. DLL preloading / DLL hijacking).

The `kernel32.dll` load two lines above is **not** affected: `kernel32` is a
protected [KnownDLL][knowndlls], so the loader resolves it from `\KnownDlls`
(System32) and never consults the application directory. `conpty.dll` receives no
such protection — that asymmetry is the entire bug.

Notably, an attacker does **not** need to overwrite the application binary or hold
elevated rights: dropping a DLL beside an installed per-user application, or into a
directory the app happens to be launched from, is enough. The signed host binary
still loads and runs, which is exactly what makes this attractive for evasion.

## The fix

Delete the sideload and always use the kernel's ConPTY:

```rust
fn load_conpty() -> ConPtyFuncs {
    // If the kernel doesn't export these functions then their system is
    // too old and we cannot run.
    ConPtyFuncs::open(Path::new("kernel32.dll")).expect(
        "this system does not support conpty.  Windows 10 October 2018 or newer is required",
    )
}
```

Verified to compile for `x86_64-pc-windows-msvc`.

## Note for upstream maintainers

The sideload is a deliberate feature for WezTerm, which *does* ship a
`conpty.dll` + `openconsole.exe` next to its binary to get a newer ConPTY than the
host OS provides. Removing it outright is right for library consumers but would
regress WezTerm itself, so a straight deletion may not be the patch you want.

Two options that keep the capability without the hole:

1. **Load by absolute path** (recommended). Resolve the DLL relative to the running
   executable and hand `LoadLibraryW` a full path, so the search order is never
   consulted:

   ```rust
   let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
   if let Some(dir) = exe_dir {
       if let Ok(sideloaded) = ConPtyFuncs::open(&dir.join("conpty.dll")) {
           return sideloaded;
       }
   }
   ```

   This preserves WezTerm's intent exactly — "a conpty.dll deployed *alongside the
   application*" — while removing the current-directory vector and making the
   app-directory load explicit rather than incidental. It is still only as
   trustworthy as the install directory's ACLs, but that is a property of the
   deployment rather than a search-order accident.

   Pairing it with `LoadLibraryExW(..., LOAD_LIBRARY_SEARCH_SYSTEM32 |
   LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR)` would further constrain how the sideloaded
   DLL's own dependencies are resolved.

2. **Make it opt-in**, behind a Cargo feature or an explicit API call, so consumers
   that never ship a `conpty.dll` (the common case) do not carry the risk by
   default. Libraries should not widen a consumer's attack surface for a capability
   the consumer does not use.

For Agent Studio the straight deletion is correct and lossless: we never ship a
`conpty.dll`, so the sideload could only ever fail and fall through to `kernel32` —
the branch is unreachable for us in the benign case, and reachable only by an
attacker.

[`portable-pty`]: https://crates.io/crates/portable-pty
[search]: https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order
[knowndlls]: https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-search-order#known-dlls
