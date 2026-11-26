//! One TLS policy for `http.rs`, `ws.rs`, `grpc.rs`: the `ring` provider (installed here) and
//! the OS trust store plus bundled Mozilla roots; the reasoning is in `Cargo.toml`'s TLS block.
//! Required: with `rustls-no-provider`, `reqwest`'s `build()` panics without a provider.

use std::sync::Once;

/// A `Once` keeps the hot path (every client call) to one acquire load; `install_default`
/// alone is race-free but would report "already installed" as an `Err`.
static INSTALL: Once = Once::new();

/// Install `ring` as the process-wide [`CryptoProvider`](rustls::crypto::CryptoProvider), once.
/// Called from `run()` and at each client entry point: `cargo test` never runs `run()`.
pub fn install_crypto_provider() {
    INSTALL.call_once(|| {
        // `Err` = a provider is already installed, which is the postcondition; the tests below
        // assert which one.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cipher-suite and key-exchange names: aws-lc's default KX groups carry ML-KEM hybrids
    /// (`X25519MLKEM768`, …) that `ring` lacks, which tells the providers apart.
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
