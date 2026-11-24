//! Passphrase sealing for shareable config bundles — PBKDF2-HMAC-SHA256 → AES-256-GCM.
//!
//! Contract: `src/features/portability/types.ts` (`SealedPayload`). Crypto is `ring` and only
//! `ring`.
//!
//! ## Deliberately the only file in `portability/` that knows any cryptography
//!
//! `bundle.rs` owns the *format* and this file owns the *wrapper*, because "one shape for both
//! modes with sealing as a wrapper" (the contract's own words) is only true if the two are not
//! interleaved. Everything here takes bytes and returns bytes; it has never heard of a DB
//! connection.
//!
//! ## The parameters, and why each is recorded in the file rather than assumed
//!
//! | | value | why |
//! |---|---|---|
//! | KDF | PBKDF2-HMAC-SHA256, [`KDF_ITERATIONS`] = 600 000 | OWASP 2023 for this PRF |
//! | salt | 16 random bytes, per bundle | |
//! | AEAD | AES-256-GCM, 12-byte random nonce, per bundle | one bundle, one key, one nonce |
//! | AAD | the canonical header (`kind|version|mode|createdAtMs|label`) | see below |
//!
//! Every one of them travels in the clear inside `SealedPayload`, which is normal (a decryptor
//! needs them) and is what lets the iteration count be raised later without making today's files
//! unreadable. [`open`] therefore reads them from the file — and so must **bound** them, because
//! a hostile file that declared 4 000 000 000 iterations would otherwise be a one-line
//! denial-of-service (see [`MAX_KDF_ITERATIONS`]).
//!
//! ## What the AAD buys, precisely
//!
//! The header is *outside* the ciphertext so a sealed bundle can describe itself before anyone
//! types a passphrase. Binding it as AEAD additional data is what stops that from being a hole:
//! a ciphertext cannot be lifted into a bundle that says it is smaller, older or friendlier,
//! because the tag was computed over those exact bytes. `relabelling_a_sealed_bundle_stops_it_from_opening`
//! is the test for it, and it was verified by breaking the AAD and watching it go red.
//!
//! ## Stated limitations, so nothing here reads as more than it is
//!
//! * **PBKDF2 is markedly weaker than Argon2id against GPU cracking.** It was chosen because
//!   `ring` is already the whole binary's crypto provider and Argon2 would be a new
//!   dependency. A weak passphrase is still the weak link, which is why
//!   [`MIN_PASSPHRASE_LENGTH`] is enforced **here** and not only in the dialog.
//! * **Nothing is zeroized.** The derived key and the plaintext live in ordinary `Vec`s; there is
//!   no `zeroize` dependency in this tree and adding one would be a false comfort while the same
//!   plaintext is also handed to `serde_json`. What *is* guaranteed is that the plaintext never
//!   crosses IPC and never touches disk (types.ts's "the bundle's bytes never cross the IPC
//!   boundary").
//! * **`bad-passphrase` and `tampered` are not fully distinguishable** — see [`open`].

use std::num::NonZeroU32;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ring::rand::SecureRandom;
use ring::{aead, pbkdf2};
use serde::{Deserialize, Serialize};

use super::{PortError, PortErrorCode};

/// The only KDF version 1 defines.
pub const KDF_ALGORITHM: &str = "pbkdf2-hmac-sha256";
/// The only AEAD version 1 defines.
pub const AEAD_ALGORITHM: &str = "aes-256-gcm";
/// PBKDF2 rounds at introduction — OWASP's 2023 guidance for PBKDF2-HMAC-SHA256.
pub const KDF_ITERATIONS: u32 = 600_000;
/// Salt length we *write*. [`open`] accepts a range, so the number can change later.
pub const SALT_LEN: usize = 16;
/// AES-GCM's nonce length. Not a choice — 96 bits is what the construction takes.
pub const NONCE_LEN: usize = 12;
/// The floor on a sealing passphrase, enforced in Rust (contract: `MIN_PASSPHRASE_LENGTH`).
///
/// Counted in **characters, not bytes**: a 12-character passphrase of non-ASCII is a
/// 12-character passphrase, and counting bytes would silently accept a 3-character one made of
/// 4-byte code points.
pub const MIN_PASSPHRASE_LENGTH: usize = 12;

/// Accepted salt lengths on read. Wider than [`SALT_LEN`] so a future writer can grow it;
/// bounded so a one-byte salt cannot be smuggled in.
const SALT_LEN_ACCEPTED: std::ops::RangeInclusive<usize> = 8..=64;
/// The ceiling on a file-declared iteration count.
///
/// ~8× today's value, so the count can be raised several times without a format break, and far
/// below the point where opening a bundle stops being a user action and becomes a hang. A file
/// asking for more than this is refused rather than obeyed.
const MAX_KDF_ITERATIONS: u64 = 5_000_000;
/// AES-GCM's authentication tag, appended to the ciphertext by `seal_in_place_append_tag`.
const GCM_TAG_LEN: usize = 16;
/// AES-256's key length.
const KEY_LEN: usize = 32;

/// The encrypted payload and the parameters needed to open it. Mirrors `SealedPayload`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedPayload {
    pub kdf: KdfParams,
    pub aead: AeadParams,
    pub ciphertext_b64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub algorithm: String,
    /// `u64` rather than `u32` **on purpose**: an absurd count must arrive as a value this code
    /// can refuse with a named error, not as a serde parse failure that reads as "not a bundle".
    pub iterations: u64,
    pub salt_b64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AeadParams {
    pub algorithm: String,
    pub nonce_b64: String,
}

/// Seal `plaintext` under `passphrase`, binding `aad` (the canonical header).
///
/// `iterations` is a parameter rather than a constant so the *mechanics* can be unit-tested in
/// milliseconds while [`the_shipped_iteration_count_round_trips`] proves the shipped constant.
/// Every production caller passes [`KDF_ITERATIONS`]; nothing in the command path can lower it.
pub fn seal(
    passphrase: &str,
    aad: &str,
    plaintext: &[u8],
    iterations: u32,
) -> Result<SealedPayload, PortError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_LENGTH {
        return Err(PortError::new(
            PortErrorCode::WeakPassphrase,
            format!(
                "A sealing passphrase must be at least {MIN_PASSPHRASE_LENGTH} characters. \
                 Sealing is only as strong as the passphrase you share out of band."
            ),
        ));
    }
    let rng = ring::rand::SystemRandom::new();
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut salt).map_err(|_| random_failed())?;
    rng.fill(&mut nonce_bytes).map_err(|_| random_failed())?;

    let key = derive_key(passphrase, &salt, iterations)?;
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| {
        PortError::new(
            PortErrorCode::Unknown,
            "Could not initialise AES-256-GCM.".to_string(),
        )
    })?;
    let sealing = aead::LessSafeKey::new(unbound);
    let mut in_out = plaintext.to_vec();
    sealing
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce_bytes),
            aead::Aad::from(aad.as_bytes()),
            &mut in_out,
        )
        .map_err(|_| PortError::new(PortErrorCode::Unknown, "Encryption failed.".to_string()))?;

    Ok(SealedPayload {
        kdf: KdfParams {
            algorithm: KDF_ALGORITHM.to_string(),
            iterations: u64::from(iterations),
            salt_b64: B64.encode(salt),
        },
        aead: AeadParams {
            algorithm: AEAD_ALGORITHM.to_string(),
            nonce_b64: B64.encode(nonce_bytes),
        },
        ciphertext_b64: B64.encode(&in_out),
    })
}

/// Open `payload` under `passphrase`, requiring `aad` to be the canonical header it was sealed
/// against.
///
/// ## The one place this module cannot give the contract what it asks for
///
/// `types.ts` lists both `bad-passphrase` and `tampered`, the latter for "the AEAD tag failed in
/// a way that implicates the header binding, not the passphrase". **With the fields
/// `SealedPayload` defines, that distinction is not computable.** AES-GCM's tag check fails
/// identically for a wrong key and for altered additional data, and there is nothing else in the
/// file — no key-check value, no header MAC — to tell the two apart. Telling them apart would
/// need a field the contract does not have.
///
/// So the split implemented here is the honest one, and it is structural rather than
/// cryptographic:
///
/// * **`tampered`** — the file's *sealing parameters* are impossible: an algorithm it does not
///   name, base64 that does not decode, a nonce of the wrong length, a ciphertext too short to
///   contain a tag, an iteration count outside [`MAX_KDF_ITERATIONS`]. None of those can be
///   caused by mistyping a passphrase, so blaming the passphrase would send the user hunting for
///   the wrong thing.
/// * **`bad-passphrase`** — well-formed inputs, tag check failed. This covers a mistyped
///   passphrase *and* a flipped ciphertext byte *and* a relabelled header, which is exactly what
///   the contract's own comment already admits ("indistinguishable from tampering to AES-GCM,
///   but *usually* this"). The important guarantee — that none of the three opens the file — is
///   unaffected and is what the tests assert.
///
/// [`MIN_PASSPHRASE_LENGTH`] is deliberately **not** enforced here: refusing to open a bundle a
/// colleague sealed under an older, shorter rule would destroy data to enforce a policy that only
/// makes sense at creation time.
pub fn open(payload: &SealedPayload, passphrase: &str, aad: &str) -> Result<Vec<u8>, PortError> {
    if !payload.kdf.algorithm.eq_ignore_ascii_case(KDF_ALGORITHM) {
        return Err(tampered(format!(
            "This build only understands the `{KDF_ALGORITHM}` key derivation, and this file \
             says `{}`.",
            payload.kdf.algorithm
        )));
    }
    if !payload.aead.algorithm.eq_ignore_ascii_case(AEAD_ALGORITHM) {
        return Err(tampered(format!(
            "This build only understands `{AEAD_ALGORITHM}` encryption, and this file says `{}`.",
            payload.aead.algorithm
        )));
    }
    if payload.kdf.iterations == 0 || payload.kdf.iterations > MAX_KDF_ITERATIONS {
        return Err(tampered(format!(
            "This file asks for {} key-derivation rounds, which is outside the 1–{} range this \
             build will run.",
            payload.kdf.iterations, MAX_KDF_ITERATIONS
        )));
    }
    let salt = decode_b64(&payload.kdf.salt_b64, "salt")?;
    if !SALT_LEN_ACCEPTED.contains(&salt.len()) {
        return Err(tampered(format!(
            "The salt in this file is {} bytes, which is not a usable length.",
            salt.len()
        )));
    }
    let nonce = decode_b64(&payload.aead.nonce_b64, "nonce")?;
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|v: Vec<u8>| {
        tampered(format!(
            "The nonce in this file is {} bytes; AES-GCM takes {NONCE_LEN}.",
            v.len()
        ))
    })?;
    let mut in_out = decode_b64(&payload.ciphertext_b64, "ciphertext")?;
    if in_out.len() < GCM_TAG_LEN {
        return Err(tampered(
            "The encrypted payload is too short to contain an authentication tag.".to_string(),
        ));
    }

    // `iterations` was bounded above, so this cast cannot lose information.
    let key = derive_key(passphrase, &salt, payload.kdf.iterations as u32)?;
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| {
        PortError::new(
            PortErrorCode::Unknown,
            "Could not initialise AES-256-GCM.".to_string(),
        )
    })?;
    let opening = aead::LessSafeKey::new(unbound);
    let plain = opening
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(aad.as_bytes()),
            &mut in_out,
        )
        .map_err(|_| {
            PortError::new(
                PortErrorCode::BadPassphrase,
                "That passphrase did not open this bundle. It may be wrong, or the file may \
                 have been altered since it was sealed — AES-GCM cannot tell those apart."
                    .to_string(),
            )
        })?;
    Ok(plain.to_vec())
}

/// PBKDF2-HMAC-SHA256 → 32 bytes.
fn derive_key(passphrase: &str, salt: &[u8], iterations: u32) -> Result<[u8; KEY_LEN], PortError> {
    let rounds = NonZeroU32::new(iterations)
        .ok_or_else(|| tampered("A key-derivation round count of 0 is not usable.".to_string()))?;
    let mut key = [0u8; KEY_LEN];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        rounds,
        salt,
        passphrase.as_bytes(),
        &mut key,
    );
    Ok(key)
}

fn decode_b64(text: &str, what: &str) -> Result<Vec<u8>, PortError> {
    B64.decode(text.trim()).map_err(|e| {
        tampered(format!(
            "The {what} in this file is not valid base64 ({e})."
        ))
    })
}

fn tampered(message: String) -> PortError {
    PortError::new(PortErrorCode::Tampered, message)
}

fn random_failed() -> PortError {
    PortError::new(
        PortErrorCode::Unknown,
        "The system random number generator is unavailable, so nothing was sealed.".to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fast enough to use everywhere the *mechanics* are under test rather than the constant.
    const FAST: u32 = 1_000;
    const PASS: &str = "correct horse battery staple";
    const AAD: &str = "agentstudio.bundle|1|sealed|1785000000000|Team staging";

    fn sealed(plaintext: &[u8]) -> SealedPayload {
        seal(PASS, AAD, plaintext, FAST).expect("seal")
    }

    #[test]
    fn a_sealed_payload_round_trips_and_records_the_parameters_it_used() {
        let payload = sealed(b"{\"dbConnections\":[]}");
        assert_eq!(payload.kdf.algorithm, "pbkdf2-hmac-sha256");
        assert_eq!(payload.aead.algorithm, "aes-256-gcm");
        assert_eq!(payload.kdf.iterations, u64::from(FAST));
        assert_eq!(
            B64.decode(&payload.kdf.salt_b64).unwrap().len(),
            SALT_LEN,
            "the salt must be 16 bytes"
        );
        assert_eq!(
            B64.decode(&payload.aead.nonce_b64).unwrap().len(),
            NONCE_LEN
        );
        assert_eq!(
            open(&payload, PASS, AAD).expect("open"),
            b"{\"dbConnections\":[]}"
        );
    }

    /// The shipped constant, exercised **once**. Everything else uses [`FAST`], so the suite
    /// stays quick while the number that actually ships is still proven to work end to end.
    #[test]
    fn the_shipped_iteration_count_round_trips() {
        let payload = seal(PASS, AAD, b"secret payload", KDF_ITERATIONS).expect("seal");
        assert_eq!(
            payload.kdf.iterations, 600_000,
            "OWASP 2023 for PBKDF2-HMAC-SHA256"
        );
        assert_eq!(open(&payload, PASS, AAD).unwrap(), b"secret payload");
    }

    #[test]
    fn two_seals_of_the_same_plaintext_share_no_salt_nonce_or_ciphertext() {
        // One bundle, one salt, one nonce, one key. A fixed nonce under a fixed key is the
        // catastrophic misuse of GCM, so this is worth an assertion rather than a comment.
        let a = sealed(b"same");
        let b = sealed(b"same");
        assert_ne!(a.kdf.salt_b64, b.kdf.salt_b64);
        assert_ne!(a.aead.nonce_b64, b.aead.nonce_b64);
        assert_ne!(a.ciphertext_b64, b.ciphertext_b64);
    }

    #[test]
    fn the_wrong_passphrase_does_not_open_it() {
        let payload = sealed(b"plaintext");
        let err = open(&payload, "wrong passphrase here", AAD).expect_err("must not open");
        assert_eq!(err.code, PortErrorCode::BadPassphrase);
        // The negative case's mirror: the RIGHT passphrase does open it, so the failure above
        // is the passphrase and not a broken fixture.
        assert!(open(&payload, PASS, AAD).is_ok());
    }

    #[test]
    fn a_tampered_ciphertext_does_not_open_it() {
        let payload = sealed(b"plaintext that is long enough to flip a byte inside");
        let mut raw = B64.decode(&payload.ciphertext_b64).unwrap();
        raw[4] ^= 0x01; // one bit, in the middle of the body rather than the tag
        let tampered_payload = SealedPayload {
            ciphertext_b64: B64.encode(&raw),
            ..payload.clone()
        };
        assert!(open(&tampered_payload, PASS, AAD).is_err());
        assert!(
            open(&payload, PASS, AAD).is_ok(),
            "the fixture itself opens"
        );
    }

    #[test]
    fn a_flipped_bit_in_the_tag_does_not_open_it_either() {
        let payload = sealed(b"plaintext");
        let mut raw = B64.decode(&payload.ciphertext_b64).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x80;
        let broken = SealedPayload {
            ciphertext_b64: B64.encode(&raw),
            ..payload
        };
        assert_eq!(
            open(&broken, PASS, AAD).unwrap_err().code,
            PortErrorCode::BadPassphrase
        );
    }

    /// 🔴 **This is what the AAD is for**, and it is the test most likely to be skipped.
    ///
    /// The header lives outside the ciphertext so a sealed bundle can describe itself before
    /// anyone types a passphrase. Without the binding, a ciphertext could be lifted into a
    /// header claiming a friendlier label or a smaller payload and nothing would notice.
    ///
    /// Falsified: with `aead::Aad::from(aad)` replaced by `aead::Aad::empty()` in **both**
    /// `seal` and `open`, this test failed with
    /// `a relabelled header must not open: Ok([112, 108, ...])`.
    #[test]
    fn relabelling_a_sealed_bundle_stops_it_from_opening() {
        let payload = sealed(b"plaintext");
        let relabelled = "agentstudio.bundle|1|sealed|1785000000000|Harmless notes";
        assert_ne!(relabelled, AAD, "the fixture must actually differ");
        assert!(
            open(&payload, PASS, relabelled).is_err(),
            "a relabelled header must not open: {:?}",
            open(&payload, PASS, relabelled)
        );
        // Every other component of the canonical header is bound too, one at a time, so a
        // passing test cannot be an accident of the label happening to be first.
        for altered in [
            "agentstudio.bundle|1|sealed|1785000000000|Team staging ", // one trailing space
            "agentstudio.bundle|2|sealed|1785000000000|Team staging",  // version
            "agentstudio.bundle|1|structure|1785000000000|Team staging", // mode
            "agentstudio.bundle|1|sealed|1785000000001|Team staging",  // createdAtMs
            "other.kind|1|sealed|1785000000000|Team staging",          // kind
        ] {
            assert!(
                open(&payload, PASS, altered).is_err(),
                "{altered:?} must not open"
            );
        }
        assert!(
            open(&payload, PASS, AAD).is_ok(),
            "the fixture itself opens"
        );
    }

    #[test]
    fn a_short_passphrase_is_refused_at_seal_time_in_rust() {
        // 11 characters — one short. Not a strength meter: a hard floor, because the whole
        // value of sealed mode rests on it and the dialog is advice.
        let err = seal("12345678901", AAD, b"x", FAST).expect_err("must be refused");
        assert_eq!(err.code, PortErrorCode::WeakPassphrase);
        assert!(err.message.contains("12"), "{}", err.message);
        // …and exactly 12 is accepted, so the boundary is pinned on both sides.
        assert!(seal("123456789012", AAD, b"x", FAST).is_ok());
    }

    #[test]
    fn the_passphrase_floor_counts_characters_not_bytes() {
        // 12 four-byte code points = 48 bytes. A byte count would accept a 3-character
        // passphrase of the same weight, which is the bug this asserts against.
        assert!(seal("🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐🔐", AAD, b"x", FAST).is_ok());
        assert_eq!(
            seal("🔐🔐🔐", AAD, b"x", FAST).unwrap_err().code,
            PortErrorCode::WeakPassphrase,
            "3 characters is 12 bytes — it must still be refused"
        );
    }

    #[test]
    fn impossible_sealing_parameters_are_tampered_rather_than_a_bad_passphrase() {
        let good = sealed(b"plaintext");
        let cases: Vec<(&str, SealedPayload)> = vec![
            (
                "an unknown KDF",
                SealedPayload {
                    kdf: KdfParams {
                        algorithm: "argon2id".into(),
                        ..good.kdf.clone()
                    },
                    ..good.clone()
                },
            ),
            (
                "an unknown AEAD",
                SealedPayload {
                    aead: AeadParams {
                        algorithm: "chacha20-poly1305".into(),
                        ..good.aead.clone()
                    },
                    ..good.clone()
                },
            ),
            (
                "a denial-of-service iteration count",
                SealedPayload {
                    kdf: KdfParams {
                        iterations: 4_000_000_000,
                        ..good.kdf.clone()
                    },
                    ..good.clone()
                },
            ),
            (
                "zero iterations",
                SealedPayload {
                    kdf: KdfParams {
                        iterations: 0,
                        ..good.kdf.clone()
                    },
                    ..good.clone()
                },
            ),
            (
                "a salt that is not base64",
                SealedPayload {
                    kdf: KdfParams {
                        salt_b64: "not base64!!".into(),
                        ..good.kdf.clone()
                    },
                    ..good.clone()
                },
            ),
            (
                "a one-byte salt",
                SealedPayload {
                    kdf: KdfParams {
                        salt_b64: B64.encode([7u8]),
                        ..good.kdf.clone()
                    },
                    ..good.clone()
                },
            ),
            (
                "a nonce of the wrong length",
                SealedPayload {
                    aead: AeadParams {
                        nonce_b64: B64.encode([0u8; 8]),
                        ..good.aead.clone()
                    },
                    ..good.clone()
                },
            ),
            (
                "a ciphertext too short to hold a tag",
                SealedPayload {
                    ciphertext_b64: B64.encode([1u8, 2, 3]),
                    ..good.clone()
                },
            ),
            (
                "a ciphertext that is not base64",
                SealedPayload {
                    ciphertext_b64: "%%%".into(),
                    ..good.clone()
                },
            ),
        ];
        for (what, payload) in cases {
            let err = open(&payload, PASS, AAD).expect_err(what);
            assert_eq!(
                err.code,
                PortErrorCode::Tampered,
                "{what} should not blame the passphrase: {}",
                err.message
            );
        }
    }

    #[test]
    fn an_iteration_count_at_the_ceiling_is_read_from_the_file_rather_than_assumed() {
        // The point of recording the count is that it can be raised without a format break, so
        // a payload sealed at one count must open at that count and NOT at the shipped one.
        let payload = seal(PASS, AAD, b"x", 2_000).expect("seal");
        assert_eq!(payload.kdf.iterations, 2_000);
        assert_eq!(open(&payload, PASS, AAD).unwrap(), b"x");
        let lying = SealedPayload {
            kdf: KdfParams {
                iterations: 2_001,
                ..payload.kdf.clone()
            },
            ..payload
        };
        assert_eq!(
            open(&lying, PASS, AAD).unwrap_err().code,
            PortErrorCode::BadPassphrase,
            "a different count derives a different key"
        );
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        // The frontend reads these names off a file people email to each other; a snake_case
        // slip would make every bundle unreadable by the next version.
        let json = serde_json::to_value(sealed(b"x")).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("ciphertextB64"), "{json}");
        assert!(obj["kdf"].as_object().unwrap().contains_key("saltB64"));
        assert!(obj["aead"].as_object().unwrap().contains_key("nonceB64"));
        assert!(!json.to_string().contains("ciphertext_b64"));
    }

    #[test]
    fn an_empty_plaintext_seals_and_opens() {
        // Degenerate but reachable: an export that selected nothing.
        let payload = sealed(b"");
        assert_eq!(open(&payload, PASS, AAD).unwrap(), b"");
        assert_eq!(
            B64.decode(&payload.ciphertext_b64).unwrap().len(),
            GCM_TAG_LEN,
            "an empty plaintext still carries a tag"
        );
    }
}
