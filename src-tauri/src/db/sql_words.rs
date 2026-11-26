//! Where statements can start in SQL text, and its words, for the agent tools' refusals. Every `;`
//! (even in a string) is a possible start, so a false start only refuses more. Comments are skipped
//! only where the server surely skips them too (its own lexer rules), never a superset.

/// Whose comment rules a text is read by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// PostgreSQL's scanner: `--` to the end of the line (`\n` or `\r`), and `/* … */`, which
    /// **nests**.
    Postgres,
    /// MySQL/MariaDB lexer: `#` to line end; `--` only before a space, control char or end; `/* */`
    /// does not nest. `/*! */` and `/*M! */` are executable and read as code.
    Mysql,
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Every word in `text`, lower-cased, in order — inside strings and comments too.
pub fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !is_word(c))
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

/// For every place in `text` a statement can start (its start, and after every `;`), the words
/// from that statement's first word to the next `;`. The first word is the statement's keyword.
/// Places with no word after them are left out.
pub fn statements(text: &str, dialect: Dialect) -> Vec<Vec<String>> {
    let starts = std::iter::once(0).chain(text.match_indices(';').map(|(at, _)| at + 1));
    starts
        .filter_map(|at| {
            let code = past_comments(&text[at..], dialect);
            let end = code.find(';').unwrap_or(code.len());
            let w = words(&code[..end]);
            (!w.is_empty()).then_some(w)
        })
        .collect()
}

/// Whether `text` holds a MySQL or MariaDB executable comment (`/*!`, `/*M!`, any case).
pub fn has_executable_comment(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("/*!") || lower.contains("/*m!")
}

/// `text` from its first character that is not whitespace or inside a comment the server skips.
fn past_comments(mut text: &str, dialect: Dialect) -> &str {
    loop {
        let trimmed = text.trim_start_matches(|c: char| c.is_ascii_whitespace() || c == '\u{b}');
        let next = match dialect {
            Dialect::Postgres => past_pg_comment(trimmed),
            Dialect::Mysql => past_mysql_comment(trimmed),
        };
        match next {
            Some(rest) => text = rest,
            None => return trimmed,
        }
    }
}

/// After the PostgreSQL comment `text` starts with, or `None` when it does not start with one. A
/// `/*` that never closes is not skipped (see [`past_mysql_comment`]).
fn past_pg_comment(text: &str) -> Option<&str> {
    if let Some(rest) = text.strip_prefix("--") {
        return Some(rest.find(['\n', '\r']).map_or("", |at| &rest[at..]));
    }
    let mut rest = text.strip_prefix("/*")?;
    let mut depth = 1usize;
    while depth > 0 {
        let open = rest.find("/*");
        let close = rest.find("*/")?;
        match open {
            Some(o) if o < close => {
                depth += 1;
                rest = &rest[o + 2..];
            }
            _ => {
                depth -= 1;
                rest = &rest[close + 2..];
            }
        }
    }
    Some(rest)
}

/// After the MySQL comment `text` starts with, or `None`. An executable comment's inside is
/// returned as code; an unclosed `/*` is not skipped (reading its words only refuses more).
fn past_mysql_comment(text: &str) -> Option<&str> {
    let to_line_end = |rest: &str| -> usize { rest.find(['\n', '\0']).unwrap_or(rest.len()) };
    if let Some(rest) = text.strip_prefix('#') {
        return Some(&rest[to_line_end(rest)..]);
    }
    if let Some(rest) = text.strip_prefix("--") {
        // MySQL's lexer: a comment only when `my_isspace || my_iscntrl` holds for the next byte
        // (the end of the text reads as `\0`). Bytes of a multi-byte character are neither.
        let comment = rest
            .chars()
            .next()
            .is_none_or(|c| u32::from(c) <= 0x20 || c == '\u{7f}');
        return comment.then(|| &rest[to_line_end(rest)..]);
    }
    let rest = text.strip_prefix("/*")?;
    let executable = rest
        .strip_prefix('!')
        .or_else(|| rest.strip_prefix("M!"))
        .or_else(|| rest.strip_prefix("m!"));
    if let Some(code) = executable {
        return Some(code.trim_start_matches(|c: char| c.is_ascii_digit()));
    }
    rest.find("*/").map(|at| &rest[at + 2..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keywords(text: &str, dialect: Dialect) -> Vec<String> {
        statements(text, dialect)
            .into_iter()
            .map(|w| w[0].clone())
            .collect()
    }

    #[test]
    fn words_are_lower_case_runs_of_letters_digits_and_underscores_anywhere() {
        assert_eq!(
            words("SELECT \"PG_READ_FILE\"('x'), pg_catalog.lo_import/**/($$y$$) -- z"),
            [
                "select",
                "pg_read_file",
                "x",
                "pg_catalog",
                "lo_import",
                "y",
                "z"
            ]
        );
        assert!(words(" ;'\"() ").is_empty());
    }

    #[test]
    fn a_statement_may_start_after_any_semicolon_even_one_inside_a_string() {
        assert_eq!(
            statements("SELECT 'a; COPY t' ; do $$ x $$", Dialect::Postgres),
            [vec!["select", "a"], vec!["copy", "t"], vec!["do", "x"],]
        );
        assert_eq!(keywords("SELECT 1;", Dialect::Postgres), ["select"]);
        assert!(statements(" ; ;\n", Dialect::Mysql).is_empty());
    }

    #[test]
    fn postgres_comments_are_skipped_as_its_scanner_skips_them_nesting_included() {
        assert_eq!(
            keywords("/* /* */ */ COPY t TO PROGRAM 'x'", Dialect::Postgres),
            ["copy"]
        );
        // Nested: the whole comment, COPY included, is skipped, as PostgreSQL skips it.
        assert_eq!(
            keywords("/* /* */ COPY */ SELECT 1", Dialect::Postgres),
            ["select"]
        );
        assert_eq!(keywords("-- a\rCOPY t", Dialect::Postgres), ["copy"]);
        assert_eq!(keywords("--x\n\t\u{b}COPY t", Dialect::Postgres), ["copy"]);
        // `#` is an operator in PostgreSQL, not a comment: its line is read.
        assert_eq!(keywords("# x\nCOPY t", Dialect::Postgres), ["x"]);
        // A comment that never closes is read as words: the server refuses the statement, and
        // reading it can only refuse more.
        assert_eq!(
            keywords("/* never closed COPY", Dialect::Postgres),
            ["never"]
        );
        assert_eq!(
            keywords("/* /* */ never closed", Dialect::Postgres),
            ["never"]
        );
    }

    #[test]
    fn mysql_comments_are_skipped_as_its_lexer_skips_them_control_characters_included() {
        for text in [
            "--\u{1}\nCALL p()",
            "--\u{7f}\nCALL p()",
            "--\u{0}\nCALL p()",
            "-- x\nCALL p()",
            "--\tx\nCALL p()",
            "# x\nCALL p()",
            "#x\u{0}CALL p()",
            "/* x */CALL p()",
            "/* a */ /* b */\n\tcall p()",
            "/*!50000 CALL p() */",
            "/*!CALL p() */",
            "/*M!100000 CALL p() */",
            "/*m! CALL p() */",
        ] {
            assert_eq!(keywords(text, Dialect::Mysql), ["call"], "{text:?}");
        }
        // Not comments to MySQL, so not skipped: `--` followed by a word, or by a character
        // outside ASCII (U+00A0 is two bytes, neither of them space or control).
        assert_eq!(keywords("--x\nCALL p()", Dialect::Mysql), ["x"]);
        assert_eq!(keywords("--\u{a0}x\nCALL p()", Dialect::Mysql), ["x"]);
        assert_eq!(keywords("--1", Dialect::Mysql), ["1"]);
        // MySQL comments do not nest: the first `*/` ends one.
        assert_eq!(keywords("/* /* */ CALL p() */", Dialect::Mysql), ["call"]);
        assert_eq!(
            keywords("/* never closed CALL p()", Dialect::Mysql),
            ["never"]
        );
        assert!(keywords("# never ends CALL p()", Dialect::Mysql).is_empty());
        assert!(keywords("--", Dialect::Mysql).is_empty());
    }

    #[test]
    fn executable_comments_are_found_in_either_spelling() {
        for text in ["SELECT 1 /*! ; COMMIT */", "/*M!100000 x */", "/*m! x */"] {
            assert!(has_executable_comment(text), "{text:?}");
        }
        for text in [
            "SELECT 1 /* ! */",
            "/*+ MAX_EXECUTION_TIME(10) */ SELECT 1",
            "x!",
        ] {
            assert!(!has_executable_comment(text), "{text:?}");
        }
    }
}
