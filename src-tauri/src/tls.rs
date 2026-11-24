//! Process-wide TLS policy for the three outbound network clients.
//!
//! `http.rs` (`reqwest`), `ws.rs` (`tokio-tungstenite`) and `grpc.rs` (`tonic`) all sit on
//! the same rustls 0.23 stack. Before this policy they disagreed on both axes that matter,
//! and the manifest's comments asserted the opposite of what was resolved:
//!
//! * **Provider.** `reqwest`'s plain `rustls` feature is an alias for
//!   `__rustls-aws-lc-rs`, so `aws-lc-rs` + `aws-lc-sys` (a BoringSSL fork, C + asm) were
//!   compiled and linked *alongside* the `ring` that `tokio-tungstenite` and
//!   `tonic/tls-ring` pull. Two C crypto stacks in one binary.
//! * **Trust roots.** That same feature pulls `rustls-platform-verifier`, so `reqwest`
//!   verified against the OS trust store while WS and gRPC verified against bundled
//!   Mozilla roots — three clients, two trust stories, neither of them chosen.
//!
//! Now: **one provider (`ring`, installed here) and one trust policy (the OS trust store,
//! unioned with the bundled Mozilla set).** The full reasoning — why `ring` over
//! `aws-lc-rs`, why the OS store for a desktop IDE pointed at internal hosts, and the one
//! place the *mechanism* still differs between the clients — lives in the TLS policy block
//! at the top of `Cargo.toml`'s `[dependencies]`, next to the feature flags that implement
//! it. Read that before changing any of this.
//!
//! ## Why this file has to exist
//!
//! `reqwest`'s `rustls-no-provider` feature gives us `__rustls` **without** a
//! `CryptoProvider`. `ClientBuilder::build()` then calls
//! `CryptoProvider::get_default()` and, finding nothing, **panics** with
//! *"No rustls crypto provider is configured"*. `tonic` and `tokio-tungstenite` are
//! gentler — they fall back to whatever provider their own crate features enabled — but
//! they check `get_default()` first too. So installing `ring` here is not decoration: it
//! is what makes `http_send` work at all, and it is what makes all three clients provably
//! agree instead of each falling back to its own crate-feature default.

use std::sync::Once;

/// Guards the one-time install. `CryptoProvider::install_default()` is itself
/// race-free (it writes a `OnceLock` and returns `Err` if it lost), but a `Once` keeps
/// the hot path — every `http_send` / `ws_connect` / gRPC dial calls this — down to a
/// single acquire load, and keeps the "already installed" case from looking like an
/// error we're swallowing.
static INSTALL: Once = Once::new();

/// Install `ring` as the process-wide rustls [`CryptoProvider`], exactly once.
///
/// Idempotent and thread-safe, so it is called from **two** kinds of place on purpose:
///
/// * once at startup from `run()`, so the choice happens deterministically at launch
///   rather than on whichever request happens to be first, and
/// * at the head of each client's entry point (`http::send`, `ws::run_connection`,
///   `grpc::connect_channel`), because `cargo test` never goes through `run()` — without
///   that, every `#[tokio::test]` in `http.rs` would panic inside
///   `reqwest::ClientBuilder::build()`.
///
/// [`CryptoProvider`]: rustls::crypto::CryptoProvider
pub fn install_crypto_provider() {
    INSTALL.call_once(|| {
        // `Err` means someone (a dependency, or a second call that raced past the `Once`
        // in a future refactor) already installed one. Either way a provider is present,
        // which is the whole postcondition — so this is genuinely nothing to report.
        // The *identity* of what ends up installed is asserted by the tests below.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cipher-suite + key-exchange names of a provider, as comparable strings. Field
    /// identity is what distinguishes `ring` from `aws-lc-rs` at runtime: the aws-lc
    /// provider's `DEFAULT_KX_GROUPS` carry the ML-KEM hybrids (`X25519MLKEM768`,
    /// `SECP256R1MLKEM768`, …) that `ring` has no implementation for.
    fn fingerprint(p: &rustls::crypto::CryptoProvider) -> (Vec<String>, Vec<String>) {
        (
            p.cipher_suites
                .iter()
                .map(|s| format!("{:?}", s.suite()))
                .collect(),
            p.kx_groups
                .iter()
                .map(|g| format!("{:?}", g.name()))
                .collect(),
        )
    }

    #[test]
    fn the_installed_process_provider_is_ring() {
        install_crypto_provider();

        let installed = rustls::crypto::CryptoProvider::get_default()
            .expect("install_crypto_provider must leave a process-default provider behind");

        assert_eq!(
            fingerprint(installed),
            fingerprint(&rustls::crypto::ring::default_provider()),
            "the process-wide provider is not `ring` — some dependency installed its own, \
             or the `rustls` features in Cargo.toml changed (see the TLS policy block there)"
        );
    }

    #[test]
    fn no_post_quantum_kx_group_is_offered_which_is_rings_signature() {
        // The accepted cost of choosing `ring` (Cargo.toml TLS policy block, axis 1):
        // no ML-KEM hybrid key exchange. Asserted so the track-off is a *recorded* fact
        // rather than folklore — if this ever starts failing, the provider changed.
        install_crypto_provider();
        let installed = rustls::crypto::CryptoProvider::get_default().expect("provider installed");
        let (_, kx) = fingerprint(installed);
        assert!(
            !kx.iter().any(|n| n.contains("MLKEM")),
            "a post-quantum kx group appeared, so this is no longer the `ring` provider: {kx:?}"
        );
        assert!(
            kx.iter().any(|n| n.contains("X25519")),
            "X25519 must still be offered: {kx:?}"
        );
    }

    #[test]
    fn installing_twice_is_a_no_op_not_a_panic() {
        install_crypto_provider();
        install_crypto_provider();
        install_crypto_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }

    #[test]
    fn a_reqwest_client_builds_once_the_provider_is_installed() {
        // The regression this file exists for: with `rustls-no-provider` and no installed
        // provider, `ClientBuilder::build()` PANICS ("No rustls crypto provider is
        // configured"). Every `http_send` in the app goes through that call.
        install_crypto_provider();
        assert!(
            reqwest::Client::builder().build().is_ok(),
            "reqwest could not build a client with the installed provider"
        );
    }
}
