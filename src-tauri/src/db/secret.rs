//! `{{VAR}}` references, Vault reads/writes, and redaction.
//!
//! ## The rule this module exists to enforce
//!
//! **`db-connections.json` never holds a secret.** It holds `""` or a `{{VAR}}` name; the
//! value lives in exactly one place — the Vault, i.e. the `environments` list in
//! `api-store.json`, the store the API client already uses and `<VaultPanel/>` already
//! surfaces. The DB client invents **no second secret store**, because two stores means two
//! things to encrypt later, two things to audit, and two chances to get file permissions
//! wrong.
//!
//! The direct payoff: a connection record is safe to screenshot, paste into an issue, or
//! sync. A shared screenshot is one of the commonest ways a live token leaks; this is that
//! class of accident, pre-defused.
//!
//! ## What this module does NOT claim (stated so nobody "hardens" it wrongly)
//!
//! A local process running as the user can read `api-store.json`, because the app can. Mode
//! `0600` stops other *users* on a shared machine, not the user's own processes. Encrypting
//! the file with a key the app can retrieve unattended would be obfuscation, and calling it
//! encryption would be worse than not doing it. At-rest encryption is a separate decision
//! with a prompt cost. What *is* guaranteed: no secret
//! in the repo, none in a screenshot-able connection file, none in the renderer, none in a
//! log, and **no OS permission prompt** (an OS permission prompt is a design failure, which is
//! exactly why the OS keychain is not used here).

use crate::api_store::{ApiStore, EnvVar, Environment};
use crate::db::error::{DbError, MASK};

/// The Vault variable suffix. `<CONNECTION_NAME>_PASSWORD`, so the entry is discoverable in
/// `<VaultPanel/>` by the name of the connection that needs it.
const SUFFIX: &str = "_PASSWORD";

/// The environment created when the Vault has none yet. Named the same thing the API client
/// would call a first environment, so the two features do not each invent a home.
const DEFAULT_ENVIRONMENT: &str = "Default";

/// `true` iff `s` is a `{{VAR}}` reference rather than a value.
///
/// Used everywhere a "password-shaped" string is handled, because a reference must be treated
/// as **public** (it survives into the stored URL, it is safe to copy to a clipboard, and
/// calling it "a password we took out and stored separately" would be a lie) while a value
/// must be treated as radioactive.
pub fn is_ref(s: &str) -> bool {
    let t = s.trim();
    t.len() > 4 && t.starts_with("{{") && t.ends_with("}}") && !t[2..t.len() - 2].contains("{{")
}

/// The variable name inside a `{{VAR}}` reference, or `None` when `s` is not one.
pub fn ref_name(s: &str) -> Option<&str> {
    if !is_ref(s) {
        return None;
    }
    let t = s.trim();
    Some(t[2..t.len() - 2].trim())
}

/// `NAME` → `{{NAME}}`.
pub fn wrap_ref(name: &str) -> String {
    format!("{{{{{name}}}}}")
}

/// A Vault variable name derived from a connection name, guaranteed not to collide with
/// anything in `taken`.
///
/// `"Mongo Maestro"` → `MONGO_MAESTRO_PASSWORD`; a second connection with the same name gets
/// `MONGO_MAESTRO_PASSWORD_2`. Pure, so it is unit-testable without a Vault, and the name is
/// **shown to the user** so the Vault entry is discoverable rather than magic.
///
/// A name that reduces to nothing (`"???"`, `""`, `"🎉"`) falls back to `DB`, because a
/// variable called `_PASSWORD` is worse than one called `DB_PASSWORD`.
pub fn vault_var_name(connection_name: &str, taken: &[String]) -> String {
    let mut stem = String::new();
    let mut last_was_sep = true; // leading separators are dropped
    for ch in connection_name.chars() {
        if ch.is_ascii_alphanumeric() {
            stem.push(ch.to_ascii_uppercase());
            last_was_sep = false;
        } else if !last_was_sep {
            stem.push('_');
            last_was_sep = true;
        }
    }
    while stem.ends_with('_') {
        stem.pop();
    }
    if stem.is_empty() || stem.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        // A leading digit would be a legal Vault key but an illegal shell-ish variable name,
        // and these names get pasted into places that care.
        stem.insert_str(0, "DB");
        while stem.ends_with('_') {
            stem.pop();
        }
    }
    let base = format!("{stem}{SUFFIX}");
    if !taken.iter().any(|t| t == &base) {
        return base;
    }
    // `_2`, `_3`, … — deliberately not a hash or a ULID: the user has to read this.
    for n in 2..u32::MAX {
        let candidate = format!("{base}_{n}");
        if !taken.iter().any(|t| t == &candidate) {
            return candidate;
        }
    }
    unreachable!("u32::MAX distinct names for one connection is not a reachable state")
}

/// Every variable name currently in the Vault, across **all** environments.
///
/// All of them, not just the active one, so switching environment can never make a
/// previously-minted name collide with a different secret.
pub fn taken_names(store: &ApiStore) -> Vec<String> {
    let mut names: Vec<String> = store
        .environments
        .iter()
        .flat_map(|e| e.variables.iter().map(|v| v.key.clone()))
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Resolve a `password_ref` against the Vault.
///
/// * `""` → `Ok("")`. No password is a legitimate configuration (trust auth, a Redis with no
///   `requirepass`), so it is not an error.
/// * `{{VAR}}` → the value, or `secret-missing` naming the variable. Naming it is the whole
///   point: "a secret is missing" is unactionable, "`PG_PROD_PASSWORD` has no value in the
///   Vault" tells the user exactly which row to fill in.
/// * anything else → treated as a **literal** value. That case cannot arise from our own
///   writes, but a hand-edited file could contain one and refusing to connect would be a
///   worse outcome than connecting; it is never written back.
pub fn resolve(password_ref: &str, store: &ApiStore) -> Result<String, DbError> {
    if password_ref.is_empty() {
        return Ok(String::new());
    }
    let Some(name) = ref_name(password_ref) else {
        return Ok(password_ref.to_string());
    };
    match lookup(store, name) {
        Some(v) => Ok(v),
        None => Err(DbError::secret_missing(format!(
            "The Vault has no value for `{name}`. Add it in the Vault panel, or re-enter the \
             password in this connection."
        ))),
    }
}

/// The value of `name`, searching the **active** environment first and then the others.
///
/// Falling through to the other environments is deliberate: a user who switches the API
/// client's environment should not silently lose their database password, and a DB
/// connection is not environment-scoped in this design.
fn lookup(store: &ApiStore, name: &str) -> Option<String> {
    let active = store
        .active_environment_id
        .as_deref()
        .and_then(|id| store.environments.iter().find(|e| e.id == id));
    if let Some(env) = active {
        if let Some(v) = env.variables.iter().find(|v| v.key == name) {
            return Some(v.value.clone());
        }
    }
    store
        .environments
        .iter()
        .flat_map(|e| e.variables.iter())
        .find(|v| v.key == name)
        .map(|v| v.value.clone())
}

/// Write `name = value` into the Vault's active environment, creating that environment if the
/// Vault has none. Overwrites an existing entry with the same name.
///
/// Pure over `&mut ApiStore` so the whole write is unit-testable without touching a real
/// config dir — the caller does the (atomic, `0600`) file write.
pub fn put(store: &mut ApiStore, name: &str, value: &str) {
    let target_id = store
        .active_environment_id
        .clone()
        .filter(|id| store.environments.iter().any(|e| &e.id == id))
        .or_else(|| store.environments.first().map(|e| e.id.clone()));

    let env = match target_id {
        Some(id) => store
            .environments
            .iter_mut()
            .find(|e| e.id == id)
            .expect("id came from this list"),
        None => {
            let id = ulid::Ulid::new().to_string();
            store.environments.push(Environment {
                id: id.clone(),
                name: DEFAULT_ENVIRONMENT.to_string(),
                variables: Vec::new(),
            });
            store.active_environment_id = Some(id);
            store.environments.last_mut().expect("just pushed one")
        }
    };

    match env.variables.iter_mut().find(|v| v.key == name) {
        Some(existing) => existing.value = value.to_string(),
        None => env.variables.push(EnvVar {
            key: name.to_string(),
            value: value.to_string(),
        }),
    }
}

/// `text` with every non-empty secret in `secrets` replaced by [`MASK`].
///
/// Two things make this more than a `replace` call, and both are the difference between a
/// redactor and a comforting no-op:
///
/// 1. **Empty secrets are skipped.** `"".replace()` inserts the mask between every character,
///    which both destroys the message and looks like the redactor worked.
/// 2. **Percent-encoded forms are scrubbed too.** A driver echoing a DSN has already
///    percent-encoded the password, so the literal bytes of the secret may simply not be
///    present in the message — matching only the raw form is the classic way this check
///    passes while the secret ships.
pub fn redact(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if secret.is_empty() {
            continue;
        }
        out = out.replace(secret, MASK);
        let encoded = crate::db::url::encode_userinfo(secret);
        if encoded != *secret {
            out = out.replace(&encoded, MASK);
        }
    }
    out
}

#[cfg(test)]
// `pub(crate)` because [`tests::hostile_secrets`] is the *shared* hostile alphabet: `url.rs`'s
// property tests draw their passwords, users and databases from it too, so the two modules
// cannot drift into testing different corners. Without this the module is private and the
// cross-module use is `E0603` — which is exactly how it was found, the first time this tree was
// ever type-checked.
pub(crate) mod tests {
    use super::*;

    fn store_with(vars: &[(&str, &str)]) -> ApiStore {
        ApiStore {
            environments: vec![Environment {
                id: "env-1".into(),
                name: "prod".into(),
                variables: vars
                    .iter()
                    .map(|(k, v)| EnvVar {
                        key: (*k).into(),
                        value: (*v).into(),
                    })
                    .collect(),
            }],
            active_environment_id: Some("env-1".into()),
            ..ApiStore::default()
        }
    }

    // ── references ────────────────────────────────────────────────────────────

    #[test]
    fn is_ref_recognises_a_reference_and_rejects_the_lookalikes() {
        let refs = ["{{X}}", "{{PG_PROD_PASSWORD}}", "  {{A}}  "];
        for r in refs {
            assert!(is_ref(r), "{r:?} is a reference");
        }
        // A password that merely CONTAINS braces is a password, not a reference. Getting this
        // wrong would mean storing `{{oops` as a "reference" and never asking for the real
        // secret again.
        let values = [
            "",
            "{}",
            "{{}}",
            "{{",
            "}}",
            "{{a}} and {{b}}",
            "hunter{{2}}",
            "{{a}}b",
            "not a ref",
        ];
        for v in values {
            assert!(!is_ref(v), "{v:?} is NOT a reference");
        }
    }

    #[test]
    fn ref_name_and_wrap_ref_are_inverses() {
        assert_eq!(ref_name("{{PG_PASSWORD}}"), Some("PG_PASSWORD"));
        assert_eq!(ref_name("{{ PG_PASSWORD }}"), Some("PG_PASSWORD"));
        assert_eq!(ref_name("hunter2"), None);
        assert_eq!(wrap_ref("PG_PASSWORD"), "{{PG_PASSWORD}}");
        assert_eq!(ref_name(&wrap_ref("A_B")), Some("A_B"));
    }

    // ── variable naming ───────────────────────────────────────────────────────

    #[test]
    fn vault_var_name_upper_snake_cases_and_suffixes() {
        // Literal expectations, hand-written.
        let cases: &[(&str, &str)] = &[
            ("Mongo Maestro", "MONGO_MAESTRO_PASSWORD"),
            ("prod", "PROD_PASSWORD"),
            ("Prod  Postgres", "PROD_POSTGRES_PASSWORD"),
            ("my-db.internal", "MY_DB_INTERNAL_PASSWORD"),
            ("  padded  ", "PADDED_PASSWORD"),
            ("a", "A_PASSWORD"),
            ("Aurora (writer)", "AURORA_WRITER_PASSWORD"),
            // Derived, not guessed: `ü` is a non-ASCII-alphanumeric at the *start*, so it is
            // dropped as a leading separator; `n` survives; `ï` collapses to `_`; `code`
            // survives; everything after it collapses and the trailing `_` is stripped. Hence
            // `N_CODE`. (Easy to hand-compute wrongly as `CODE_PASSWORD` by dropping the `n`.)
            ("ünïcode ✓ 中文", "N_CODE_PASSWORD"),
            ("", "DB_PASSWORD"),
            ("???", "DB_PASSWORD"),
            ("🎉", "DB_PASSWORD"),
            ("2nd db", "DB2ND_DB_PASSWORD"),
        ];
        for (input, want) in cases {
            assert_eq!(
                &vault_var_name(input, &[]),
                want,
                "connection name {input:?}"
            );
        }
    }

    #[test]
    fn vault_var_name_de_duplicates_against_what_the_vault_already_holds() {
        let taken = vec![
            "PROD_PASSWORD".to_string(),
            "PROD_PASSWORD_2".to_string(),
            "PROD_PASSWORD_3".to_string(),
        ];
        assert_eq!(vault_var_name("prod", &taken), "PROD_PASSWORD_4");
        // An unrelated name is unaffected.
        assert_eq!(vault_var_name("staging", &taken), "STAGING_PASSWORD");
    }

    #[test]
    fn taken_names_spans_every_environment_sorted_and_deduped() {
        let store = ApiStore {
            environments: vec![
                Environment {
                    id: "b".into(),
                    name: "b".into(),
                    variables: vec![EnvVar {
                        key: "B".into(),
                        value: "1".into(),
                    }],
                },
                Environment {
                    id: "a".into(),
                    name: "a".into(),
                    variables: vec![
                        EnvVar {
                            key: "A".into(),
                            value: "1".into(),
                        },
                        EnvVar {
                            key: "B".into(),
                            value: "2".into(),
                        },
                    ],
                },
            ],
            ..ApiStore::default()
        };
        assert_eq!(taken_names(&store), vec!["A".to_string(), "B".to_string()]);
    }

    // ── resolution ────────────────────────────────────────────────────────────

    #[test]
    fn resolve_reads_the_value_behind_a_reference() {
        let store = store_with(&[("PG_PASSWORD", "s3cret")]);
        assert_eq!(resolve("{{PG_PASSWORD}}", &store).unwrap(), "s3cret");
    }

    #[test]
    fn resolve_of_an_empty_ref_is_an_empty_password_not_an_error() {
        // Trust auth and a Redis with no `requirepass` are real configurations.
        assert_eq!(resolve("", &ApiStore::default()).unwrap(), "");
    }

    #[test]
    fn resolve_of_a_missing_variable_names_the_variable() {
        let err = resolve("{{PG_PROD_PASSWORD}}", &store_with(&[])).unwrap_err();
        assert_eq!(err.code, crate::db::error::DbErrorCode::SecretMissing);
        assert!(
            err.message.contains("PG_PROD_PASSWORD"),
            "the message must name the variable: {}",
            err.message
        );
    }

    #[test]
    fn resolve_prefers_the_active_environment_but_falls_back_to_the_others() {
        let store = ApiStore {
            environments: vec![
                Environment {
                    id: "dev".into(),
                    name: "dev".into(),
                    variables: vec![
                        EnvVar {
                            key: "PW".into(),
                            value: "dev-value".into(),
                        },
                        EnvVar {
                            key: "ONLY_DEV".into(),
                            value: "d".into(),
                        },
                    ],
                },
                Environment {
                    id: "prod".into(),
                    name: "prod".into(),
                    variables: vec![EnvVar {
                        key: "PW".into(),
                        value: "prod-value".into(),
                    }],
                },
            ],
            active_environment_id: Some("prod".into()),
            ..ApiStore::default()
        };
        assert_eq!(resolve("{{PW}}", &store).unwrap(), "prod-value");
        // Not in the active environment → still found, rather than "secret missing".
        assert_eq!(resolve("{{ONLY_DEV}}", &store).unwrap(), "d");
    }

    #[test]
    fn resolve_passes_a_non_reference_through_as_a_literal() {
        // Cannot arise from our writes; a hand-edited file could. Connecting beats refusing,
        // and nothing writes it back.
        assert_eq!(
            resolve("literal-pw", &ApiStore::default()).unwrap(),
            "literal-pw"
        );
    }

    // ── writing ───────────────────────────────────────────────────────────────

    #[test]
    fn put_creates_a_default_environment_when_the_vault_is_empty() {
        let mut store = ApiStore::default();
        put(&mut store, "PG_PASSWORD", "s3cret");
        assert_eq!(store.environments.len(), 1);
        assert_eq!(store.environments[0].name, "Default");
        assert!(store.active_environment_id.is_some());
        assert_eq!(resolve("{{PG_PASSWORD}}", &store).unwrap(), "s3cret");
    }

    #[test]
    fn put_overwrites_the_same_name_and_appends_a_new_one() {
        let mut store = store_with(&[("PG_PASSWORD", "old")]);
        put(&mut store, "PG_PASSWORD", "new");
        put(&mut store, "OTHER", "x");
        assert_eq!(store.environments[0].variables.len(), 2);
        assert_eq!(resolve("{{PG_PASSWORD}}", &store).unwrap(), "new");
        assert_eq!(resolve("{{OTHER}}", &store).unwrap(), "x");
    }

    #[test]
    fn put_targets_the_active_environment_not_the_first() {
        let mut store = ApiStore {
            environments: vec![
                Environment {
                    id: "first".into(),
                    name: "first".into(),
                    variables: vec![],
                },
                Environment {
                    id: "active".into(),
                    name: "active".into(),
                    variables: vec![],
                },
            ],
            active_environment_id: Some("active".into()),
            ..ApiStore::default()
        };
        put(&mut store, "K", "v");
        assert!(store.environments[0].variables.is_empty());
        assert_eq!(store.environments[1].variables[0].key, "K");
    }

    #[test]
    fn put_falls_back_to_the_first_environment_when_the_active_id_is_stale() {
        let mut store = ApiStore {
            environments: vec![Environment {
                id: "real".into(),
                name: "real".into(),
                variables: vec![],
            }],
            active_environment_id: Some("deleted-long-ago".into()),
            ..ApiStore::default()
        };
        put(&mut store, "K", "v");
        assert_eq!(
            store.environments.len(),
            1,
            "no phantom environment created"
        );
        assert_eq!(store.environments[0].variables[0].value, "v");
    }

    // ── redaction ──────────────────────────────────────────────────────

    #[test]
    fn redact_masks_each_secret_and_leaves_the_rest_of_the_message() {
        let msg = "connect to pg://u:hunter2@h/db failed; token=abc123";
        let out = redact(msg, &["hunter2", "abc123"]);
        assert_eq!(out, "connect to pg://u:••••@h/db failed; token=••••");
    }

    #[test]
    fn redact_ignores_the_empty_secret_rather_than_shredding_the_message() {
        // `"x".replace("", M)` interleaves the mask between every char — a redactor that
        // "worked" while destroying the message.
        assert_eq!(redact("hello", &[""]), "hello");
        assert_eq!(redact("", &[""]), "");
    }

    #[test]
    fn redact_also_masks_the_percent_encoded_form_a_driver_would_have_echoed() {
        // The realistic shape: sqlx echoes a DSN, so the password in the message is already
        // percent-encoded and the raw bytes are simply not there.
        let secret = "p@ss w/ord";
        let encoded = crate::db::url::encode_userinfo(secret);
        assert_ne!(encoded, secret, "the fixture must actually need encoding");
        let msg = format!("error with url postgresql://u:{encoded}@h:5432/db");
        let out = redact(&msg, &[secret]);
        assert!(!out.contains(&encoded), "encoded form survived: {out}");
        assert!(out.contains(MASK), "{out}");
    }

    /// The redaction property, over a deliberately hostile alphabet: for **any** generated
    /// password and any message containing it, the output does not contain it.
    ///
    /// Hand-rolled generation rather than `proptest` (no such dev-dependency in this tree, and
    /// a deterministic cartesian sweep is reproducible in CI where a seeded random one is
    /// only reproducible if you log the seed). Every case is a distinct hostile shape, not a
    /// random draw, so a failure names the exact input.
    #[test]
    fn redact_never_leaves_any_hostile_password_in_the_output() {
        for secret in hostile_secrets() {
            if secret.is_empty() {
                continue; // an empty secret is not a secret; asserted separately above
            }
            let encoded = crate::db::url::encode_userinfo(&secret);
            for template in [
                format!("plain {secret} plain"),
                format!("postgresql://u:{secret}@h:5432/db"),
                format!("postgresql://u:{encoded}@h:5432/db"),
                secret.to_string(),
                format!("{secret}{secret}"),
                format!("prefix{secret}"),
            ] {
                let out = redact(&template, &[&secret]);
                assert!(
                    !out.contains(&secret),
                    "secret {secret:?} survived redaction of {template:?} → {out:?}"
                );
            }
        }
    }

    /// The hostile alphabet, shared by the redaction and URL round-trip properties.
    pub(crate) fn hostile_secrets() -> Vec<String> {
        let mut v: Vec<String> = [
            "",
            "simple",
            "p@ssword",
            "colon:pw",
            "slash/pw",
            "question?pw",
            "hash#pw",
            "bracket[pw]",
            "percent%pw",
            "percent%41pw",
            "amp&pw",
            "eq=pw",
            "plus+pw",
            "quote\"pw",
            "apos'pw",
            "back\\slash",
            "back`tick",
            "space pw",
            "tab\tpw",
            "ünïcode-✓-中文",
            "emoji-🎉-pw",
            "{{looks-like-a-ref",
            "{{}}",
            "@:/?#[]%&=+",
            "-",
            "..",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        v.push("x".repeat(512));
        v
    }
}
