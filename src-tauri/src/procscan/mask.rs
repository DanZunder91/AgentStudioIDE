//! Secrets in a command line, masked **for display**. A dev app's
//! argv is shown in the app card and in Restart's confirm; `--password=…` there would put a
//! credential on screen and into a screenshot. The real argv never leaves Rust (Restart
//! uses it from the token store, [`super::restart`]).
//!
//! Masked, each keeping its key so the user still sees *what* was passed:
//! - `--password=x`, `-password=x`, `--api-key=x`: a flag whose name is secret-looking;
//! - `--token x`: the value after such a flag (unless it is itself a flag);
//! - `DB_PASSWORD=x`, `OPENAI_API_KEY=x` (the `env K=V cmd` / `launcher K=V` shape): an
//!   environment-style assignment whose name is secret-looking — `*_KEY`, `*_TOKEN`, …;
//! - `-Ddb.password=x` (a JVM system property);
//! - `postgres://user:pw@host` → `postgres://user:••••@host` (URL userinfo anywhere);
//! - `Authorization: Bearer x` → `Authorization: ••••`.
//!
//! A false positive (`--key ./tls.pem` masked) costs a path on screen; a false negative
//! leaks a secret. So the word list leans wide. Pure; table-tested.

/// What a masked value is replaced with.
pub const MASK: &str = "••••";

/// Last `-`/`_`/`.`-separated word of a name that marks it secret (`DB_PASS`, `--token`).
const SECRET_WORDS: &[&str] = &[
    "password",
    "passwd",
    "passphrase",
    "pass",
    "pwd",
    "secret",
    "token",
    "key",
    "apikey",
    "credential",
    "credentials",
    "auth",
];

/// Suffixes of the name with separators removed (`--apiKey`, `--access-key` are one word
/// once joined: `apikey`, `accesskey`).
const SECRET_SUFFIXES: &[&str] = &[
    "password",
    "passwd",
    "passphrase",
    "secret",
    "token",
    "apikey",
    "accesskey",
    "privatekey",
    "secretkey",
    "clientsecret",
];

/// Is this flag / variable / property name secret-looking?
pub fn secret_name(name: &str) -> bool {
    let lower = name.trim_start_matches('-').to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    let last = lower.rsplit(['-', '_', '.']).next().unwrap_or(&lower);
    if SECRET_WORDS.contains(&last) {
        return true;
    }
    let joined: String = lower
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    SECRET_SUFFIXES.iter().any(|s| joined.ends_with(s))
}

/// `NAME=value` with an environment-variable-shaped name.
fn env_assignment(arg: &str) -> Option<(&str, &str)> {
    let (k, v) = arg.split_once('=')?;
    let mut chars = k.chars();
    let first = chars.next()?;
    let ok = (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    ok.then_some((k, v))
}

/// A long-ish flag name (`--token`, `-password`; never `-p`, `-t`: one letter says nothing).
fn flag_name(arg: &str) -> Option<&str> {
    let name = arg.strip_prefix("--").or_else(|| arg.strip_prefix('-'))?;
    (name.len() >= 2 && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic()))
        .then_some(name)
}

/// `scheme://user:secret@host` → `scheme://user:••••@host`, for every URL in `arg`.
fn mask_userinfo(arg: &str) -> String {
    let mut out = String::with_capacity(arg.len());
    let mut rest = arg;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        // The authority ends at the first `/`, `?`, `#` or whitespace.
        let end = tail
            .find(|c: char| matches!(c, '/' | '?' | '#') || c.is_whitespace())
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => {
                let userinfo = &authority[..at];
                match userinfo.split_once(':') {
                    Some((user, pw)) if !pw.is_empty() => {
                        out.push_str(user);
                        out.push(':');
                        out.push_str(MASK);
                    }
                    _ => out.push_str(userinfo),
                }
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// Mask one argument on its own (the `--flag value` pair is handled by [`mask_argv`]).
fn mask_one(arg: &str) -> String {
    if arg
        .get(..14)
        .is_some_and(|h| h.eq_ignore_ascii_case("authorization:"))
    {
        return format!("{} {MASK}", &arg[..14]);
    }
    // A script in one argument (`sh -c '…; API_TOKEN=x ./worker --password y'`): mask its
    // words like an argv of their own. Runs of whitespace become one space — display only.
    if arg.split_whitespace().nth(1).is_some() {
        let words: Vec<String> = arg.split_whitespace().map(str::to_string).collect();
        return mask_words(&words).join(" ");
    }
    // `-Dsome.password=x`
    if let Some(prop) = arg.strip_prefix("-D") {
        if let Some((k, _)) = prop.split_once('=') {
            if secret_name(k) {
                return format!("-D{k}={MASK}");
            }
        }
    }
    // `--password=x`
    if let Some((flag, _)) = arg.split_once('=') {
        if let Some(name) = flag_name(flag) {
            if secret_name(name) {
                return format!("{flag}={MASK}");
            }
        }
    }
    // `API_KEY=x`
    if let Some((k, _)) = env_assignment(arg) {
        if secret_name(k) {
            return format!("{k}={MASK}");
        }
    }
    mask_userinfo(arg)
}

/// The argv as shown to the user. Same length as the input (an element is masked in
/// place, never removed), so the UI can still line it up with what ran.
pub fn mask_argv(argv: &[String]) -> Vec<String> {
    mask_words(argv)
}

fn mask_words(argv: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(argv.len());
    let mut mask_next = false;
    for (i, arg) in argv.iter().enumerate() {
        if mask_next && !arg.starts_with('-') {
            out.push(MASK.to_string());
            mask_next = false;
            continue;
        }
        mask_next = false;
        // argv[0] is the program: never a flag.
        if i > 0 && !arg.contains('=') {
            if let Some(name) = flag_name(arg) {
                if secret_name(name) {
                    mask_next = true;
                }
            }
        }
        out.push(mask_one(arg));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    /// Hand-written expectations: input → what the user may see.
    #[test]
    fn the_masking_table() {
        let table: &[(&[&str], &[&str])] = &[
            (
                &["java", "-jar", "app.jar", "--password=hunter2"],
                &["java", "-jar", "app.jar", "--password=••••"],
            ),
            (
                &["node", "server.js", "--token", "abc123", "--port", "3000"],
                &["node", "server.js", "--token", "••••", "--port", "3000"],
            ),
            (
                &["env", "OPENAI_API_KEY=sk-1", "DEBUG=1", "node", "x.js"],
                &["env", "OPENAI_API_KEY=••••", "DEBUG=1", "node", "x.js"],
            ),
            (
                &["python3", "run_local.py", "SERVICE_KEY=abc", "PORT=8080"],
                &["python3", "run_local.py", "SERVICE_KEY=••••", "PORT=8080"],
            ),
            (
                &["java", "-Ddb.password=pw", "-Dserver.port=8080", "Main"],
                &["java", "-Ddb.password=••••", "-Dserver.port=8080", "Main"],
            ),
            (
                &[
                    "./gazelle",
                    "--db",
                    "postgres://app:s3cret@localhost:5432/g",
                ],
                &["./gazelle", "--db", "postgres://app:••••@localhost:5432/g"],
            ),
            (
                &["curl", "-H", "Authorization: Bearer xyz", "http://a"],
                &["curl", "-H", "Authorization: ••••", "http://a"],
            ),
            (
                &[
                    "svc",
                    "--api-key",
                    "k",
                    "--apiKey=k2",
                    "--client-secret",
                    "s",
                ],
                &[
                    "svc",
                    "--api-key",
                    "••••",
                    "--apiKey=••••",
                    "--client-secret",
                    "••••",
                ],
            ),
            (
                &["mysqld", "-p", "notmasked", "--no-password", "--verbose"],
                &["mysqld", "-p", "notmasked", "--no-password", "--verbose"],
            ),
            (
                &["svc", "--token-file", "/run/tok", "--monkey", "banana"],
                &["svc", "--token-file", "/run/tok", "--monkey", "banana"],
            ),
            (
                &["svc", "--url=https://user@host/x", "https://h/a?b=1"],
                &["svc", "--url=https://user@host/x", "https://h/a?b=1"],
            ),
            (&["DB_PASS=x"], &["DB_PASS=••••"]),
            (
                &[
                    "sh",
                    "-c",
                    "exec >x 2>&1;  API_TOKEN=abc ./worker --password hunter2",
                ],
                &[
                    "sh",
                    "-c",
                    "exec >x 2>&1; API_TOKEN=•••• ./worker --password ••••",
                ],
            ),
        ];
        for (input, want) in table {
            assert_eq!(mask_argv(&v(input)), v(want), "input: {input:?}");
        }
    }

    #[test]
    fn secret_names() {
        for yes in [
            "password",
            "--password",
            "DB_PASSWORD",
            "AWS_SECRET_ACCESS_KEY",
            "GITHUB_TOKEN",
            "api-key",
            "apiKey",
            "private_key",
            "db.pass",
        ] {
            assert!(secret_name(yes), "{yes} should be secret");
        }
        for no in [
            "port",
            "verbose",
            "monkey",
            "token-file",
            "keyfile",
            "",
            "--",
        ] {
            assert!(!secret_name(no), "{no} should not be secret");
        }
    }
}
