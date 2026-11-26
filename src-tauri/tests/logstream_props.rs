//! Property-style tests of the Agent Logs splitter and level heuristic: hand-rolled `rand`
//! generators on fixed seeds (no `proptest`), so a failure prints a reproducible seed. Contract
//! numbers are restated literals on purpose.

use agent_studio_scaffold_lib::logstream::splitter::LineSplitter;
use agent_studio_scaffold_lib::logstream::{classify_level, LogLevel};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

/// The contract: "caps a line at 4 KiB".
const CAP: usize = 4 * 1024;
const CASES: u64 = 400;

// ---------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------

/// A random Unicode scalar, biased toward the awkward ones: multibyte of every width,
/// C1 controls encoded as UTF-8, combining marks, emoji, CJK. Never U+FFFD itself (so a
/// U+FFFD in the output can only have been manufactured by the splitter).
fn any_char(rng: &mut StdRng) -> char {
    loop {
        let c = match rng.random_range(0..10) {
            0..=3 => rng.random_range(0x20u32..0x7f),
            4 => rng.random_range(0x80u32..0xa0), // C1 controls, as UTF-8
            5 => rng.random_range(0xa0u32..0x800), // 2-byte
            6 => rng.random_range(0x800u32..0x1_0000), // 3-byte (incl. CJK, arrows)
            7 => rng.random_range(0x1_0000u32..0x11_0000), // 4-byte
            8 => *[0x2192u32, 0x2713, 0x2717, 0x1F600, 0x0301, 0x4E2D]
                .get(rng.random_range(0..6))
                .unwrap(),
            _ => rng.random_range(0u32..0x11_0000),
        };
        if let Some(ch) = char::from_u32(c) {
            if ch != '\u{FFFD}' && (ch as u32) >= 0x20 && ch != '\u{7f}' {
                return ch;
            }
        }
    }
}

fn push_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(s.as_bytes());
}

fn random_text(rng: &mut StdRng, max: usize) -> String {
    let n = rng.random_range(0..=max);
    (0..n).map(|_| any_char(rng)).collect()
}

/// One random token of terminal output (always valid UTF-8 on its own). `alt` also
/// emits alternate-screen toggles.
fn token(rng: &mut StdRng, out: &mut Vec<u8>, alt: bool) {
    match rng.random_range(0..if alt { 20 } else { 18 }) {
        0..=4 => push_str(out, &random_text(rng, 12)),
        5 => push_str(out, "\n"),
        6 => push_str(out, "\r\n"),
        7 => push_str(out, "\r"),
        8 => push_str(out, "\t"),
        9 => out.push(0x07),  // BEL
        10 => out.push(0x08), // BS
        11 => {
            // SGR / cursor CSI with random numeric params.
            let finals = b"mKHJABCDGfhlr";
            let params: Vec<String> = (0..rng.random_range(0..4))
                .map(|_| rng.random_range(0..300).to_string())
                .collect();
            push_str(out, "\x1b[");
            if rng.random_bool(0.2) {
                push_str(out, "?");
            }
            push_str(out, &params.join(";"));
            // Never let a random private-mode token toggle the alt screen.
            let f = finals[rng.random_range(0..finals.len())];
            out.push(if matches!(f, b'h' | b'l') { b'm' } else { f });
        }
        12 => {
            // OSC (title / hyperlink) with BEL or ST, payload may be multibyte.
            push_str(out, "\x1b]");
            push_str(out, &rng.random_range(0..9).to_string());
            push_str(out, ";");
            let payload: String = random_text(rng, 10)
                .chars()
                .filter(|c| (*c as u32) >= 0x20 && !('\u{80}'..='\u{9f}').contains(c))
                .collect();
            push_str(out, &payload);
            push_str(
                out,
                if rng.random_bool(0.5) {
                    "\x07"
                } else {
                    "\x1b\\"
                },
            );
        }
        13 => {
            // DCS / APC / PM / SOS string with an ST.
            let intro = b"P_^X"[rng.random_range(0..4)];
            out.extend_from_slice(&[0x1b, intro]);
            push_str(out, "q#0;2;0;0;0");
            push_str(out, "\x1b\\");
        }
        14 => {
            // Two-byte escapes (DECSC, DECKPAM, charset designations) — never RIS.
            let e = [
                "\x1b7", "\x1b8", "\x1b=", "\x1b>", "\x1b(B", "\x1b)0", "\x1bM",
            ];
            push_str(out, e[rng.random_range(0..e.len())]);
        }
        15 => {
            // A long run that crosses the cap, often landing the cap inside a
            // multibyte char.
            let ch = ['a', 'é', '→', '😀'][rng.random_range(0..4)];
            let n = rng.random_range(CAP / 4..CAP + 800);
            let lead = rng.random_range(0..4);
            push_str(out, &"x".repeat(lead));
            push_str(out, &ch.to_string().repeat(n / ch.len_utf8()));
        }
        16 | 17 => push_str(out, "plain words here"),
        18 => push_str(out, "\x1b[?1049h"),
        _ => push_str(out, "\x1b[?1049l"),
    }
}

fn stream(rng: &mut StdRng, alt: bool) -> Vec<u8> {
    let mut out = Vec::new();
    for _ in 0..rng.random_range(1..60) {
        token(rng, &mut out, alt);
    }
    out
}

/// Random cut points — which, over hundreds of cases, land inside multibyte chars, inside
/// CSI/OSC/DCS sequences and between `\r` and `\n`.
fn random_chunks<'a>(rng: &mut StdRng, bytes: &'a [u8]) -> Vec<&'a [u8]> {
    let mut chunks = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let n = match rng.random_range(0..4) {
            0 => 1,
            1 => rng.random_range(1..4),
            2 => rng.random_range(1..64),
            _ => rng.random_range(1..4096),
        };
        let end = (i + n).min(bytes.len());
        chunks.push(&bytes[i..end]);
        i = end;
    }
    chunks
}

fn feed_all(chunks: &[&[u8]]) -> Vec<String> {
    let mut sp = LineSplitter::new();
    chunks.iter().flat_map(|c| sp.feed(c)).collect()
}

/// Every invariant a finished log line owes the UI.
fn assert_clean_line(line: &str, ctx: &str) {
    assert!(
        line.len() <= CAP,
        "{ctx}: line is {} bytes, over the 4 KiB cap",
        line.len()
    );
    assert!(
        !line.contains('\u{FFFD}'),
        "{ctx}: U+FFFD in a line built from valid UTF-8: {:?}",
        excerpt(line)
    );
    if let Some(c) = line.chars().find(|c| c.is_control() && *c != '\t') {
        panic!(
            "{ctx}: control char U+{:04X} in {:?}",
            c as u32,
            excerpt(line)
        );
    }
    assert!(!line.trim().is_empty(), "{ctx}: blank line emitted");
    assert_eq!(line, line.trim_end(), "{ctx}: trailing whitespace kept");
}

fn excerpt(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 80 {
        return s.to_string();
    }
    let head: String = chars[..40].iter().collect();
    let tail: String = chars[chars.len() - 40..].iter().collect();
    format!("{head}…[{} chars]…{tail}", chars.len())
}

// ---------------------------------------------------------------------------------------
// Splitter properties
// ---------------------------------------------------------------------------------------

/// The splitter is fed whatever the PTY read returned, so the lines must not depend on
/// where the reads happened to split the stream.
#[test]
fn lines_do_not_depend_on_how_the_stream_was_chunked() {
    for seed in 0..CASES {
        let mut rng = StdRng::seed_from_u64(seed);
        let bytes = stream(&mut rng, true);
        let whole = feed_all(&[&bytes]);
        let bytewise: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(feed_all(&bytewise), whole, "seed {seed}: byte-at-a-time");
        for round in 0..4 {
            let chunks = random_chunks(&mut rng, &bytes);
            assert_eq!(
                feed_all(&chunks),
                whole,
                "seed {seed} round {round}: split at {:?}",
                chunks.iter().map(|c| c.len()).collect::<Vec<_>>()
            );
        }
    }
}

/// Targeted splits, so the invariance does not rest on luck: every cut position of a
/// stream dense in multibyte chars, escapes and CRLFs.
#[test]
fn every_single_cut_point_of_a_dense_stream_gives_the_same_lines() {
    let dense = "a→b\x1b[1;31mé\x1b[0m\r\nc\x1b]0;tï→tle\x07d😀\x1b]8;;u\x1b\\e\r\n\
                 prog 1%\rprog 99%\r\n\x1bPq#0\x1b\\f\x1b(Bg\n"
        .as_bytes();
    let whole = feed_all(&[dense]);
    assert_eq!(
        whole,
        ["a→bé", "cd😀e", "prog 99%", "fg"],
        "the reference split itself"
    );
    for cut in 1..dense.len() {
        assert_eq!(
            feed_all(&[&dense[..cut], &dense[cut..]]),
            whole,
            "cut at byte {cut}"
        );
    }
}

/// No emitted line — completed by `\n` or by the hub's silence flush — carries an escape
/// or control byte, a U+FFFD the input did not have, or more than 4 KiB.
#[test]
fn no_line_ever_carries_controls_replacement_chars_or_exceeds_the_cap() {
    for seed in 0..CASES {
        let mut rng = StdRng::seed_from_u64(1_000 + seed);
        let bytes = stream(&mut rng, true);
        let mut sp = LineSplitter::new();
        let mut n = 0;
        for chunk in random_chunks(&mut rng, &bytes) {
            for line in sp.feed(chunk) {
                assert_clean_line(&line, &format!("seed {seed}"));
                n += 1;
            }
            // The hub flushes a partial line after ~250 ms of silence, which can fall
            // between any two reads.
            if rng.random_bool(0.3) {
                if let Some(line) = sp.flush_partial() {
                    assert_clean_line(&line, &format!("seed {seed} (silence flush)"));
                    n += 1;
                }
            }
        }
        if let Some(line) = sp.flush_partial() {
            assert_clean_line(&line, &format!("seed {seed} (final flush)"));
        }
        let _ = n;
    }
}

/// The silence flush can land right after the cap cut a character in half. Whatever it
/// keeps for "the rest of the char" must not come back as U+FFFD on the NEXT line.
#[test]
fn a_silence_flush_after_the_cap_cut_a_char_does_not_poison_the_next_line() {
    for ch in ['é', '→', '😀'] {
        for pad in 0..4 {
            let mut sp = LineSplitter::new();
            let mut first = "a".repeat(CAP - pad - 1);
            first.push(ch);
            first.push_str(" dropped tail");
            assert!(sp.feed(first.as_bytes()).is_empty());
            let flushed = sp.flush_partial().expect("a partial line to flush");
            assert_clean_line(&flushed, &format!("{ch:?} pad {pad} (flushed)"));
            assert!(flushed.ends_with('…'), "the cap is marked");
            // The terminal line goes on past the flush; its excess is still excess.
            let next = sp.feed(b"rest of the same over-long line\nnext line\n");
            assert_eq!(next, ["next line"], "{ch:?} pad {pad}");
        }
    }
}

/// A line at the cap is at most 4 KiB INCLUDING its `…` marker — the contract says the
/// text is ≤ 4 KiB, not "4 KiB plus a marker".
#[test]
fn a_capped_line_including_its_marker_fits_in_4_kib() {
    for ch in ['a', 'é', '→', '😀'] {
        let body = ch.to_string().repeat(2 * CAP / ch.len_utf8());
        let out = feed_all(&[format!("{body}\n").as_bytes()]);
        assert_eq!(out.len(), 1);
        assert!(out[0].ends_with('…'), "{ch:?}: truncation is marked");
        assert!(out[0].len() <= CAP, "{ch:?}: {} bytes", out[0].len());
        // Two-sided: the cap keeps as much as fits, not an arbitrary little.
        assert!(
            out[0].len() > CAP - 3 - ch.len_utf8(),
            "{ch:?}: only {} bytes kept",
            out[0].len()
        );
    }
}

// ---------------------------------------------------------------------------------------
// Alternate screen
// ---------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Seg {
    Line(u32),
    Enter(usize),
    Exit(usize),
}

/// Every way a program enters the alternate screen that the splitter must recognise.
fn enter_form(i: usize) -> String {
    match i % 6 {
        0 => "\x1b[?1049h".into(),
        1 => "\x1b[?1047h".into(),
        2 => "\x1b[?47h".into(),
        3 => "\x1b[?25;1049h".into(),
        4 => "\x1b[?1049;1h".into(),
        // A long private-mode list (a TUI setting many modes at once): the alt-screen
        // parameter comes after more than 64 bytes of others.
        _ => format!("\x1b[?{}1049h", "1000;1002;1006;2004;".repeat(5)),
    }
}

/// …and every way it leaves: the matching resets, and a full terminal reset (RIS,
/// `ESC c` — what `reset`/`tput reset` print after a TUI died without cleaning up).
fn exit_form(i: usize) -> String {
    match i % 7 {
        0 => "\x1b[?1049l".into(),
        1 => "\x1b[?1047l".into(),
        2 => "\x1b[?47l".into(),
        3 => "\x1b[?1049;25l".into(),
        4 => "\x1b[?25;1049l".into(),
        5 => format!("\x1b[?{}1049l", "1000;1002;1006;2004;".repeat(5)),
        _ => "\x1bc".into(),
    }
}

/// Random enter/exit interleavings, chunked randomly: every line printed outside the
/// alternate screen is logged, none printed inside it is, and after a final exit the
/// splitter is never left stuck suppressing the terminal.
#[test]
fn alt_screen_interleavings_never_leave_the_splitter_stuck() {
    for seed in 0..CASES {
        let mut rng = StdRng::seed_from_u64(2_000 + seed);
        let mut segs = Vec::new();
        for i in 0..rng.random_range(1..30) {
            segs.push(match rng.random_range(0..3) {
                0 => Seg::Line(i),
                1 => Seg::Enter(rng.random_range(0..6)),
                _ => Seg::Exit(rng.random_range(0..7)),
            });
        }
        segs.push(Seg::Exit(rng.random_range(0..7)));
        segs.push(Seg::Line(999));

        let mut bytes = Vec::new();
        let mut want = Vec::new();
        let mut alt = false;
        for s in &segs {
            match *s {
                Seg::Line(n) => {
                    push_str(&mut bytes, &format!("line {n}\r\n"));
                    if !alt {
                        want.push(format!("line {n}"));
                    }
                }
                Seg::Enter(f) => {
                    push_str(&mut bytes, &enter_form(f));
                    alt = true;
                }
                Seg::Exit(f) => {
                    push_str(&mut bytes, &exit_form(f));
                    alt = false;
                }
            }
        }
        let mut sp = LineSplitter::new();
        let got: Vec<String> = random_chunks(&mut rng, &bytes)
            .into_iter()
            .flat_map(|c| sp.feed(c))
            .collect();
        assert!(
            !sp.in_alt_screen(),
            "seed {seed}: stuck in the alternate screen after {segs:?}"
        );
        assert_eq!(got, want, "seed {seed}: {segs:?}");
    }
}

// ---------------------------------------------------------------------------------------
// Level heuristic
// ---------------------------------------------------------------------------------------

const ERROR_WORDS: [&str; 12] = [
    "error",
    "ERROR",
    "Error",
    "fatal",
    "FATAL",
    "Fatal",
    "panic",
    "panicked",
    "PANIC",
    "Traceback",
    "FAILED",
    "✗",
];
const WARN_WORDS: [&str; 9] = [
    "warn",
    "WARN",
    "Warn",
    "warning",
    "Warning",
    "WARNING",
    "deprecated",
    "Deprecated",
    "DEPRECATED",
];
const DEBUG_WORDS: [&str; 2] = ["DEBUG", "TRACE"];

/// Filler that can never spell a keyword: digits, punctuation, and letters that appear
/// in none of them (no a/c/d/e/f/g/i/k/l/n/p/r/t/w/…).
fn filler(rng: &mut StdRng, max: usize) -> String {
    const ALPHABET: &[char] = &[
        ' ', ' ', ' ', '0', '7', '9', ':', '/', '.', '-', '[', ']', 'q', 'z', 'y', 'j', 'm', 'Q',
        'Z', 'Y', 'J', 'M', 'é', '→', '中',
    ];
    (0..rng.random_range(0..=max))
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())])
        .collect()
}

fn pick<'a>(rng: &mut StdRng, words: &[&'a str]) -> &'a str {
    words[rng.random_range(0..words.len())]
}

#[test]
fn the_level_function_never_panics_on_arbitrary_unicode() {
    for seed in 0..CASES * 5 {
        let mut rng = StdRng::seed_from_u64(3_000 + seed);
        let mut s = random_text(&mut rng, 200);
        if rng.random_bool(0.3) {
            // Sprinkle raw C0 controls and keywords glued to multibyte neighbours.
            s.push('\u{1b}');
            s.push_str(pick(&mut rng, &ERROR_WORDS));
            s.push(any_char(&mut rng));
        }
        let _ = classify_level(&s);
    }
}

/// A word-boundary keyword in the MESSAGE decides error > warn > debug > info; lines open with
/// a word because a leading level token is a logger column, which wins.
#[test]
fn keywords_decide_the_level_with_error_over_warn_over_debug() {
    for seed in 0..CASES {
        let mut rng = StdRng::seed_from_u64(4_000 + seed);
        let (e, w, d) = (
            rng.random_bool(0.4),
            rng.random_bool(0.4),
            rng.random_bool(0.4),
        );
        let mut parts = vec![format!("msg{}", filler(&mut rng, 20))];
        if e {
            parts.push(pick(&mut rng, &ERROR_WORDS).into());
        }
        if w {
            parts.push(pick(&mut rng, &WARN_WORDS).into());
        }
        if d {
            parts.push(pick(&mut rng, &DEBUG_WORDS).into());
        }
        parts.push(filler(&mut rng, 20));
        // Shuffle the middle so position never matters.
        let n = parts.len();
        for i in (2..n - 1).rev() {
            let j = rng.random_range(1..=i);
            parts.swap(i, j);
        }
        let line = parts.join(" ");
        let want = if e {
            LogLevel::Error
        } else if w {
            LogLevel::Warn
        } else if d {
            LogLevel::Debug
        } else {
            LogLevel::Info
        };
        assert_eq!(classify_level(&line), want, "seed {seed}: {line:?}");
    }
}

/// A structured logger's level column — the token that opens the line, bare or after an
/// ISO timestamp — decides the level whatever keywords the message carries.
#[test]
fn a_leading_level_column_wins_over_any_keyword() {
    const COLUMNS: [(&str, LogLevel); 8] = [
        ("INFO", LogLevel::Info),
        ("WARN", LogLevel::Warn),
        ("ERROR", LogLevel::Error),
        ("DEBUG", LogLevel::Debug),
        ("TRACE", LogLevel::Debug),
        ("WARNING", LogLevel::Warn),
        ("INF", LogLevel::Info),
        ("ERR", LogLevel::Error),
    ];
    for seed in 0..CASES {
        let mut rng = StdRng::seed_from_u64(6_000 + seed);
        let (token, want) = COLUMNS[rng.random_range(0..COLUMNS.len())];
        let prefix = if rng.random_bool(0.5) {
            "2026-01-01T12:00:05.152Z  ".to_string()
        } else {
            String::new()
        };
        let mut parts = vec![format!("{prefix}{token}"), "svc:".to_string()];
        for _ in 0..rng.random_range(0..4) {
            parts.push(
                match rng.random_range(0..3) {
                    0 => pick(&mut rng, &ERROR_WORDS),
                    1 => pick(&mut rng, &WARN_WORDS),
                    _ => pick(&mut rng, &DEBUG_WORDS),
                }
                .to_string(),
            );
            parts.push(filler(&mut rng, 10).trim().to_string());
        }
        let line = parts.join(" ");
        assert_eq!(classify_level(&line), want, "seed {seed}: {line:?}");
    }
}

/// A keyword glued inside a longer word is not a keyword ("errorless", "forewarned").
#[test]
fn a_keyword_inside_a_word_does_not_trigger() {
    for seed in 0..CASES {
        let mut rng = StdRng::seed_from_u64(5_000 + seed);
        let words: Vec<&str> = ERROR_WORDS[..11]
            .iter()
            .chain(&WARN_WORDS)
            .chain(&DEBUG_WORDS)
            .copied()
            .collect();
        let w = pick(&mut rng, &words);
        // A letter or digit on at least one side (possibly a non-ASCII letter: `\b` is
        // Unicode-aware, and so must the heuristic be).
        let glue = ['x', 'Q', '0', 'é', '中', '_'];
        let pre = rng.random_bool(0.5);
        let g = glue[rng.random_range(0..glue.len())];
        let line = if pre {
            format!("{} {g}{w} {}", filler(&mut rng, 8), filler(&mut rng, 8))
        } else {
            format!("{} {w}{g} {}", filler(&mut rng, 8), filler(&mut rng, 8))
        };
        assert_eq!(
            classify_level(&line),
            LogLevel::Info,
            "seed {seed}: {line:?}"
        );
    }
}

/// os_log compact rows: the type column is the process's own declaration and wins over
/// any keyword in the message — a `Df`/`Db`/`D` row is NEVER an error, an `E`/`F`/`Fa`
/// row is always one, and `I`/`A` rows are info.
#[test]
fn an_os_log_type_column_always_wins_over_message_keywords() {
    let cols: [(&str, LogLevel); 8] = [
        ("E", LogLevel::Error),
        ("F", LogLevel::Error),
        ("Fa", LogLevel::Error),
        ("Df", LogLevel::Debug),
        ("Db", LogLevel::Debug),
        ("D", LogLevel::Debug),
        ("I", LogLevel::Info),
        ("A", LogLevel::Info),
    ];
    for seed in 0..CASES * 2 {
        let mut rng = StdRng::seed_from_u64(6_000 + seed);
        let (col, want) = cols[rng.random_range(0..cols.len())];
        let frac_digits = rng.random_range(1..=9);
        let frac: String = (0..frac_digits)
            .map(|_| char::from(b'0' + rng.random_range(0..10u8)))
            .collect();
        let tz = match rng.random_range(0..3) {
            0 => String::new(),
            1 => format!("+{:04}", rng.random_range(0..1400)),
            _ => format!("-{:04}", rng.random_range(0..1400)),
        };
        let gap = " ".repeat(rng.random_range(1..3));
        // The message deliberately carries keywords of every level.
        let mut msg = random_text(&mut rng, 30);
        for _ in 0..rng.random_range(0..4) {
            let pool: &[&str] = match rng.random_range(0..3) {
                0 => &ERROR_WORDS,
                1 => &WARN_WORDS,
                _ => &DEBUG_WORDS,
            };
            msg.push(' ');
            msg.push_str(pick(&mut rng, pool));
            msg.push(' ');
        }
        let line = format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{frac}{tz}{gap}{col}{}Proc[{}:{:x}] {msg}",
            rng.random_range(2000..2100),
            rng.random_range(1..13),
            rng.random_range(1..29),
            rng.random_range(0..24),
            rng.random_range(0..60),
            rng.random_range(0..60),
            if col.len() == 1 { "  " } else { " " },
            rng.random_range(1..99_999),
            rng.random::<u32>(),
        );
        assert_eq!(classify_level(&line), want, "seed {seed}: {line:?}");
    }
}
