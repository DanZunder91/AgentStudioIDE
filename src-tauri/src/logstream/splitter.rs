//! Per-terminal line splitter (pure; runs on the hub task, never the pump): strips escapes, `\r`
//! is last-write-wins, nothing logged on the alternate screen, 4 KiB cap per line, and UTF-8 is
//! decoded only on emit so a split character is joined. The hub owns flush timing.

/// Longest line we keep, in bytes — the `…` marker of a capped line included.
pub const MAX_LINE_BYTES: usize = 4 * 1024;

/// Longest CSI parameter worth remembering: the alt-screen modes are at most 4 bytes.
const CSI_PARAM_MAX: usize = 8;

const ELLIPSIS: char = '…';

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    /// Saw `ESC`.
    Esc,
    /// `ESC` + intermediate bytes (`ESC ( B` and friends) — waiting for the final.
    EscIntermediate,
    /// Inside `ESC [` … collecting parameters until a final byte.
    Csi,
    /// Inside an OSC string, until BEL or ST.
    Osc,
    /// Inside a DCS / SOS / PM / APC string, until ST.
    Str,
    /// Saw `ESC` inside an OSC/string — `ESC \` is ST.
    StrEsc,
}

#[derive(Debug)]
pub struct LineSplitter {
    state: State,
    /// The CSI parameter being parsed, judged one at a time, so an alt-screen mode is recognised
    /// however many others precede it.
    csi: Vec<u8>,
    /// The current parameter outgrew [`CSI_PARAM_MAX`], so it is not an alt-screen mode.
    csi_overflow: bool,
    /// Any byte of this CSI seen yet (`?` only marks a private mode as the first byte).
    csi_started: bool,
    /// `CSI ?` — a DEC private mode sequence.
    csi_private: bool,
    /// One of this CSI's parameters is an alt-screen mode.
    csi_alt: bool,
    line: Vec<u8>,
    /// A bare `\r` was seen: the next printable byte clears the line first.
    cr_pending: bool,
    /// The line hit [`MAX_LINE_BYTES`]; further bytes are dropped until it ends.
    truncated: bool,
    /// A silence flush already emitted this capped line; its excess stays dropped until the line
    /// ends (or `\r` redraws), or the tail would return as a new line starting with U+FFFD.
    discard: bool,
    alt_screen: bool,
}

impl Default for LineSplitter {
    fn default() -> Self {
        Self::new()
    }
}

impl LineSplitter {
    pub fn new() -> Self {
        Self {
            state: State::Ground,
            csi: Vec::new(),
            csi_overflow: false,
            csi_started: false,
            csi_private: false,
            csi_alt: false,
            line: Vec::new(),
            cr_pending: false,
            truncated: false,
            discard: false,
            alt_screen: false,
        }
    }

    /// Forget everything — used when a terminal comes back from suppression (a bound
    /// `claude` session may have left it mid-sequence or in the alternate screen).
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    pub fn in_alt_screen(&self) -> bool {
        self.alt_screen
    }

    /// Is there an unterminated line waiting (something a silence-flush would emit)?
    pub fn has_partial(&self) -> bool {
        !self.alt_screen && !self.line.is_empty()
    }

    /// Feed one chunk; returns the lines it completed (blank lines are skipped).
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            self.step(b, &mut out);
        }
        out
    }

    /// Emit the unterminated line (the hub calls this after ~250 ms of silence, and
    /// at EOF). An incomplete UTF-8 sequence at the very end is **kept** for the next
    /// chunk rather than emitted as U+FFFD.
    pub fn flush_partial(&mut self) -> Option<String> {
        if self.alt_screen || self.line.is_empty() {
            return None;
        }
        // After the cap the rest of a cut character was dropped, so its first bytes are
        // not waiting for anything: keeping them would glue them to the NEXT line as
        // U+FFFD (found by `tests/logstream_props.rs`). `finish` drops them instead.
        let keep = if self.truncated {
            0
        } else {
            incomplete_utf8_tail(&self.line)
        };
        let tail = self.line.split_off(self.line.len() - keep);
        let line = std::mem::replace(&mut self.line, tail);
        let truncated = std::mem::take(&mut self.truncated);
        self.discard = truncated;
        self.cr_pending = false;
        finish(&line, truncated)
    }

    fn step(&mut self, b: u8, out: &mut Vec<String>) {
        match self.state {
            State::Ground => self.ground(b, out),
            State::Esc => match b {
                b'[' => {
                    self.csi.clear();
                    self.csi_overflow = false;
                    self.csi_started = false;
                    self.csi_private = false;
                    self.csi_alt = false;
                    self.state = State::Csi;
                }
                // RIS (full reset, `tput reset`): the terminal returns to the main screen,
                // so must we, or it is never logged again.
                b'c' => {
                    if self.alt_screen {
                        self.leave_alt_screen();
                    }
                    self.state = State::Ground;
                }
                b']' => self.state = State::Osc,
                b'P' | b'X' | b'^' | b'_' => self.state = State::Str,
                0x20..=0x2f => self.state = State::EscIntermediate,
                0x1b => {}                       // ESC ESC: stay
                _ => self.state = State::Ground, // two-byte escape (ESC 7, ESC =, …)
            },
            State::EscIntermediate => {
                if !(0x20..=0x2f).contains(&b) {
                    self.state = State::Ground;
                }
            }
            State::Csi => {
                if (0x40..=0x7e).contains(&b) {
                    self.csi_param_end();
                    self.csi_final(b, out);
                    self.state = State::Ground;
                } else if b == 0x1b {
                    self.state = State::Esc; // malformed; restart
                } else {
                    if b == b';' {
                        self.csi_param_end();
                    } else if b == b'?' && !self.csi_started {
                        self.csi_private = true;
                    } else if self.csi.len() < CSI_PARAM_MAX {
                        self.csi.push(b);
                    } else {
                        self.csi_overflow = true;
                    }
                    self.csi_started = true;
                }
            }
            State::Osc => match b {
                0x07 => self.state = State::Ground,
                0x1b => self.state = State::StrEsc,
                _ => {}
            },
            State::Str => {
                if b == 0x1b {
                    self.state = State::StrEsc;
                }
            }
            State::StrEsc => {
                self.state = if b == b'\\' {
                    State::Ground
                } else {
                    // Not ST — a stray ESC inside the string; keep swallowing.
                    State::Str
                };
            }
        }
    }

    fn ground(&mut self, b: u8, out: &mut Vec<String>) {
        match b {
            0x1b => self.state = State::Esc,
            b'\n' => {
                if !self.alt_screen {
                    self.end_line(out);
                }
            }
            b'\r' => self.cr_pending = true,
            0x08 => {
                // Backspace: drop the last whole character.
                while let Some(last) = self.line.pop() {
                    if last & 0xC0 != 0x80 {
                        break;
                    }
                }
            }
            b'\t' => self.push(b),
            0x00..=0x1f | 0x7f => {} // other C0 controls (BEL, …) are not content
            _ => self.push(b),
        }
    }

    // No alt-screen check here: bytes pushed on the alt screen are never emitted (`\n`
    // and `flush_partial` are gated on it) and leaving it clears the line.
    fn push(&mut self, b: u8) {
        if self.cr_pending {
            // Last write wins: `\r` then text redraws the line from column 0.
            self.cr_pending = false;
            self.line.clear();
            self.truncated = false;
            self.discard = false;
        }
        if self.discard {
            return;
        }
        if self.line.len() >= MAX_LINE_BYTES {
            self.truncated = true;
            return;
        }
        self.line.push(b);
    }

    fn end_line(&mut self, out: &mut Vec<String>) {
        self.cr_pending = false;
        self.discard = false;
        let line = std::mem::take(&mut self.line);
        let truncated = std::mem::take(&mut self.truncated);
        if let Some(s) = finish(&line, truncated) {
            out.push(s);
        }
    }

    /// One CSI parameter ended (`;` or the final byte): is it an alt-screen mode?
    fn csi_param_end(&mut self) {
        let p = self.csi.as_slice();
        if !self.csi_overflow && (p == b"1049" || p == b"1047" || p == b"47") {
            self.csi_alt = true;
        }
        self.csi.clear();
        self.csi_overflow = false;
    }

    fn leave_alt_screen(&mut self) {
        // Leaving the TUI: its screen is gone, start clean.
        self.alt_screen = false;
        self.line.clear();
        self.cr_pending = false;
        self.truncated = false;
        self.discard = false;
    }

    fn csi_final(&mut self, final_byte: u8, out: &mut Vec<String>) {
        if final_byte != b'h' && final_byte != b'l' {
            return;
        }
        if !(self.csi_private && self.csi_alt) {
            return;
        }
        if final_byte == b'h' {
            // Whatever was typed before the TUI took over is real output.
            if !self.alt_screen {
                if let Some(s) = self.flush_partial() {
                    out.push(s);
                }
                self.line.clear();
            }
            self.alt_screen = true;
        } else {
            self.leave_alt_screen();
        }
    }
}

/// How many trailing bytes of `bytes` form an *incomplete* (but so far valid) UTF-8
/// sequence — i.e. the start of a character whose remaining bytes have not arrived.
fn incomplete_utf8_tail(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => 0,
        // `error_len() == None` means "unexpected end of input": the tail is a
        // truncated-but-valid prefix.
        Err(e) if e.error_len().is_none() => bytes.len() - e.valid_up_to(),
        Err(_) => 0,
    }
}

/// Decode a finished line: drop an incomplete trailing char, decode lossily, drop C1 controls,
/// trim trailing whitespace, skip blanks. A capped line's `…` fits within [`MAX_LINE_BYTES`].
fn finish(bytes: &[u8], truncated: bool) -> Option<String> {
    let cut = bytes.len() - incomplete_utf8_tail(bytes);
    let mut s = String::from_utf8_lossy(&bytes[..cut]).into_owned();
    s.retain(|c| c == '\t' || !c.is_control());
    if truncated {
        let mut end = s.len().min(MAX_LINE_BYTES - ELLIPSIS.len_utf8());
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    let trimmed = s.trim_end().len();
    s.truncate(trimmed);
    if s.trim_start().is_empty() {
        return None;
    }
    if truncated {
        s.push(ELLIPSIS);
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(chunks: &[&[u8]]) -> Vec<String> {
        let mut s = LineSplitter::new();
        chunks.iter().flat_map(|c| s.feed(c)).collect()
    }

    #[test]
    fn lf_and_crlf_end_lines() {
        assert_eq!(lines(&[b"a\nb\r\nc\n"]), ["a", "b", "c"]);
    }

    #[test]
    fn a_crlf_split_across_chunks_is_still_one_line_end() {
        assert_eq!(lines(&[b"hello\r", b"\nworld\n"]), ["hello", "world"]);
    }

    #[test]
    fn carriage_return_overwrites_so_a_progress_bar_is_one_line() {
        let mut bar = Vec::new();
        for pct in (0..=100).step_by(10) {
            bar.extend_from_slice(format!("\r[{pct:>3}%] downloading").as_bytes());
        }
        bar.extend_from_slice(b"\n");
        assert_eq!(lines(&[&bar]), ["[100%] downloading"]);
    }

    #[test]
    fn ansi_csi_and_sgr_are_stripped() {
        assert_eq!(
            lines(&[b"\x1b[1;31merror\x1b[0m: \x1b[2Kboom\x1b[?25l\n"]),
            ["error: boom"]
        );
    }

    #[test]
    fn osc_with_bel_and_with_st_is_stripped() {
        assert_eq!(
            lines(&[b"\x1b]0;window title\x07a\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\\n"]),
            ["alink"]
        );
    }

    #[test]
    fn dcs_and_two_byte_escapes_are_stripped() {
        assert_eq!(
            lines(&[b"\x1bPq#0;2;0;0;0\x1b\\x\x1b7y\x1b(Bz\x1b=\n"]),
            ["xyz"]
        );
    }

    #[test]
    fn an_escape_split_across_chunks_is_still_stripped() {
        assert_eq!(
            lines(&[b"a\x1b[3", b"2mb\x1b]0;t", b"itle\x07c\n"]),
            ["abc"]
        );
    }

    #[test]
    fn blank_and_whitespace_lines_are_skipped_and_trailing_space_trimmed() {
        assert_eq!(lines(&[b"\n   \n\x1b[0m\nx  \t\n"]), ["x"]);
    }

    #[test]
    fn a_line_is_capped_at_4_kib_with_an_ellipsis() {
        let mut long = vec![b'a'; MAX_LINE_BYTES + 500];
        long.push(b'\n');
        long.extend_from_slice(b"next\n");
        let out = lines(&[&long]);
        assert_eq!(out.len(), 2);
        // The marker is inside the cap, not on top of it (contract: text ≤ 4 KiB).
        assert_eq!(out[0].len(), MAX_LINE_BYTES);
        assert!(out[0].ends_with('…'));
        assert_eq!(out[1], "next");
    }

    #[test]
    fn the_cap_never_cuts_a_multibyte_char_into_replacement_chars() {
        // 4095 ASCII + "é" (2 bytes) → the cap lands inside the é.
        let mut long = vec![b'a'; MAX_LINE_BYTES - 1];
        long.extend_from_slice("é tail\n".as_bytes());
        let out = lines(&[&long]);
        assert!(
            !out[0].contains('\u{FFFD}'),
            "cap cut a char: {:?}",
            &out[0][4090..]
        );
        assert!(out[0].ends_with('…'));
    }

    #[test]
    fn utf8_split_across_chunks_is_joined_not_replaced() {
        let s = "héllo → wörld ✓\n".as_bytes();
        // Split inside the 3-byte arrow.
        let at = "héllo ".len() + 1;
        assert_eq!(lines(&[&s[..at], &s[at..]]), ["héllo → wörld ✓"]);
    }

    #[test]
    fn a_partial_flush_keeps_an_incomplete_char_for_the_next_chunk() {
        let mut sp = LineSplitter::new();
        let arrow = "→".as_bytes();
        sp.feed(b"wait ");
        sp.feed(&arrow[..1]);
        assert_eq!(sp.flush_partial().as_deref(), Some("wait"));
        let out = sp.feed(&[&arrow[1..], b" go\n"].concat());
        assert_eq!(out, ["→ go"]);
    }

    #[test]
    fn flush_partial_emits_an_unterminated_prompt_once() {
        let mut sp = LineSplitter::new();
        assert!(sp.feed(b"Password: ").is_empty());
        assert!(sp.has_partial());
        assert_eq!(sp.flush_partial().as_deref(), Some("Password:"));
        assert!(!sp.has_partial());
        assert_eq!(sp.flush_partial(), None);
    }

    #[test]
    fn the_alternate_screen_is_not_logged_and_logging_resumes_after_it() {
        for mode in ["1049", "1047", "47"] {
            let enter = format!("before\n\x1b[?{mode}h");
            let leave = format!("\x1b[?{mode}l");
            let out = lines(&[
                enter.as_bytes(),
                b"\x1b[H\x1b[2Jrepaint 1\nrepaint 2\r\n",
                leave.as_bytes(),
                b"after\n",
            ]);
            assert_eq!(out, ["before", "after"], "mode {mode}");
        }
    }

    #[test]
    fn alt_screen_with_combined_params_is_recognised() {
        assert_eq!(lines(&[b"\x1b[?1049;25hTUI\n\x1b[?25;1049lok\n"]), ["ok"]);
    }

    #[test]
    fn a_partial_line_before_entering_the_alt_screen_is_kept() {
        assert_eq!(lines(&[b"$ vim\x1b[?1049hjunk\n\x1b[?1049l"]), ["$ vim"]);
    }

    #[test]
    fn other_private_modes_do_not_toggle_the_alt_screen() {
        assert_eq!(lines(&[b"\x1b[?2004hbracketed\n"]), ["bracketed"]);
    }

    #[test]
    fn backspace_removes_the_last_character() {
        assert_eq!(lines(&["abé\x08\x08c\n".as_bytes()]), ["ac"]);
    }

    #[test]
    fn reset_clears_alt_screen_and_partial_state() {
        let mut sp = LineSplitter::new();
        sp.feed(b"half\x1b[?1049h");
        assert!(sp.in_alt_screen());
        sp.reset();
        assert!(!sp.in_alt_screen());
        assert_eq!(sp.feed(b"fresh\n"), ["fresh"]);
    }
}
