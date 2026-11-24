//! **The gate on the TLS policy: one crypto provider, one trust story.**
//!
//! `reqwest`'s plain `rustls` feature — an alias for `__rustls-aws-lc-rs` — compiles and
//! links **`aws-lc-sys` (a BoringSSL fork, C + asm) alongside the `ring`** that
//! `tokio-tungstenite` and `tonic/tls-ring` pull: two C crypto stacks in one binary, while
//! `Cargo.toml`'s own comments assert one. The same feature makes `reqwest` verify against
//! the OS trust store while WS and gRPC use bundled Mozilla roots —
//! three network clients, two accidental trust stories.
//!
//! Both were fixed by *feature flags and one `install_default()` call*, which means the
//! whole change is **invisible to every ordinary unit test**: swap `rustls-no-provider`
//! back to `rustls` and nothing fails, nothing warns, and a whole BoringSSL fork silently
//! returns. That is exactly the regression this file exists to trip.
//!
//! It asserts on **`Cargo.lock`**, not on a `cargo tree` sub-process, because the lockfile
//! is the resolution's ground truth, is committed, and makes the test hermetic and instant
//! (no network, no nested cargo). `aws-lc-*` is absent from the lock
//! *entirely*, not merely from the macOS graph: under this policy nothing anywhere in the
//! tree, on any target, asks for it — so its mere presence as a `[[package]]` is proof a
//! provider feature came back.
//!
//! The same result from `cargo tree` on the macOS target:
//! ```text
//! cargo tree --locked -i aws-lc-sys -e all --target aarch64-apple-darwin
//! → error: package ID specification `aws-lc-sys` did not match any packages
//! cargo tree --locked -i ring       -e all --target aarch64-apple-darwin
//! → ring v0.17.14 ← rustls v0.23.42 ← {agent-studio-scaffold, hyper-rustls/reqwest,
//!                                     rustls-platform-verifier, tokio-rustls/tonic}
//! ```

use std::collections::BTreeSet;

/// Every `name = "…"` in the committed `src-tauri/Cargo.lock`.
///
/// `CARGO_MANIFEST_DIR` is the crate root at *compile* time, so this finds the lockfile
/// regardless of the cwd `cargo test` was invoked from.
fn locked_packages() -> BTreeSet<String> {
    let lock = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock");
    let text = std::fs::read_to_string(&lock)
        .unwrap_or_else(|e| panic!("could not read {}: {e}", lock.display()));
    text.lines()
        .filter_map(|l| l.strip_prefix("name = \""))
        .filter_map(|l| l.strip_suffix('"'))
        .map(str::to_string)
        .collect()
}

#[test]
fn aws_lc_is_absent_so_only_one_c_crypto_stack_is_compiled() {
    let pkgs = locked_packages();
    for banned in ["aws-lc-sys", "aws-lc-rs"] {
        assert!(
            !pkgs.contains(banned),
            "`{banned}` is back in Cargo.lock — a SECOND C crypto stack is being compiled \
             next to `ring`. Almost certainly a `rustls`-family feature regressed: check \
             `reqwest` (must be `rustls-no-provider`, NOT `rustls`), `rustls` (must be \
             `default-features = false`, since its defaults include `aws_lc_rs` and \
             `prefer-post-quantum`), and `tonic` (must be `tls-ring`, not `tls-aws-lc`). \
             See the TLS policy block in Cargo.toml."
        );
    }
}

#[test]
fn ring_is_the_one_provider_present() {
    let pkgs = locked_packages();
    assert!(
        pkgs.contains("ring"),
        "`ring` is gone from Cargo.lock — but it is the provider `src/tls.rs` installs \
         process-wide, so the app cannot do TLS at all. See the TLS policy block in \
         Cargo.toml."
    );
}

/// The `[dependencies]` lines of the committed `src-tauri/Cargo.toml`, whitespace intact.
fn manifest() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()))
}

/// The declared feature list for `crate_name` in our manifest, e.g. `tonic`.
fn declared_features(crate_name: &str) -> String {
    let needle = format!("\n{crate_name} = ");
    let line = manifest()
        .split_once(&needle)
        .unwrap_or_else(|| panic!("`{crate_name}` is not declared in Cargo.toml at all"))
        .1
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    line
}

#[test]
fn every_client_still_declares_the_os_trust_store_features() {
    // The trust axis of the policy: all three clients trust what the OS trusts, unioned with the
    // bundled Mozilla set. This is asserted against the **manifest**, not the lockfile,
    // on purpose — `rustls-native-certs` and `webpki-roots` are *also* target-gated deps
    // of `rustls-platform-verifier`, so they sit in `Cargo.lock` whether or not `tonic`
    // and `tokio-tungstenite` ask for them. A lockfile assertion here would have passed
    // before the fix as well, i.e. proved nothing (don't let a test read its expectation
    // from something that agrees by construction).
    //
    // What regresses in practice is somebody "tidying" a feature list. Drop
    // `tls-native-roots` and gRPC silently reverts to webpki-roots-only: an internal
    // `grpcs://` behind a corporate CA, or any host behind a TLS-inspecting proxy, stops
    // verifying — while HTTP and WS keep working. That divergence is the exact bug
    // the policy exists to prevent, and nothing else in the suite would notice it.
    for (crate_name, required) in [
        ("tonic", ["tls-native-roots", "tls-webpki-roots"]),
        (
            "tokio-tungstenite",
            ["rustls-tls-native-roots", "rustls-tls-webpki-roots"],
        ),
    ] {
        let declared = declared_features(crate_name);
        for feature in required {
            assert!(
                declared.contains(feature),
                "`{crate_name}` no longer enables `{feature}`, so its trust roots diverged \
                 from the other clients'. Declared: {declared}\nSee the TLS policy block in \
                 Cargo.toml."
            );
        }
    }

    // `reqwest` gets the OS store from `rustls-platform-verifier`, which BOTH `rustls` and
    // `rustls-no-provider` pull unconditionally — so the check that matters for reqwest is
    // that it is on the provider-less feature (asserted above by aws-lc's absence) and that
    // the verifier crate is genuinely in the graph.
    assert!(
        locked_packages().contains("rustls-platform-verifier"),
        "`rustls-platform-verifier` left the graph, so `http_send` no longer verifies \
         against the OS trust store."
    );
}

#[test]
fn no_native_tls_or_openssl_crept_in() {
    // Standing invariant from dependency hygiene and the zero-install
    // principle: rustls only. `openssl-sys` would mean a system OpenSSL the user has to
    // have; `native-tls` would mean a per-platform backend we don't control. Cheap to
    // assert here while we are already holding the lockfile.
    let pkgs = locked_packages();
    for banned in ["openssl-sys", "openssl", "native-tls"] {
        assert!(
            !pkgs.contains(banned),
            "`{banned}` entered Cargo.lock — we are rustls-only. \
             Some dependency's default features were probably left on."
        );
    }
}
