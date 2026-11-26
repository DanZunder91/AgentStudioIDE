//! Gate on the TLS policy: one crypto provider (`ring`; reqwest on `rustls-no-provider`, so no
//! `aws-lc-sys`) and one trust story. No unit test sees feature flags, so this asserts on the
//! committed `Cargo.lock`: any `aws-lc-*` package, on any target, means a provider came back.

use std::collections::BTreeSet;

/// Every `name = "…"` in the committed `src-tauri/Cargo.lock`; `CARGO_MANIFEST_DIR` is fixed at
/// compile time, so any cwd works.
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
    // Trust axis: all three clients trust OS roots plus bundled Mozilla. Asserted on the manifest,
    // not the lockfile, which has those crates via `rustls-platform-verifier` anyway. Dropping
    // tonic's `tls-native-roots` breaks gRPC behind a corporate CA while HTTP and WS still work.
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

    // reqwest gets the OS store from `rustls-platform-verifier`, which both `rustls` features pull,
    // so what matters is the provider-less feature (aws-lc absent above) and the verifier present.
    assert!(
        locked_packages().contains("rustls-platform-verifier"),
        "`rustls-platform-verifier` left the graph, so `http_send` no longer verifies \
         against the OS trust store."
    );
}

#[test]
fn no_native_tls_or_openssl_crept_in() {
    // rustls only: `openssl-sys` needs a system OpenSSL; `native-tls` is a per-platform backend we
    // don't control.
    let pkgs = locked_packages();
    for banned in ["openssl-sys", "openssl", "native-tls"] {
        assert!(
            !pkgs.contains(banned),
            "`{banned}` entered Cargo.lock — we are rustls-only. \
             Some dependency's default features were probably left on."
        );
    }
}
