//! Windows: a terminal's ConPTY output → log lines, by interpreting it as the screen it draws.
//!
//! **Why this exists beside [`super::splitter`] (platform-native).** On macOS and Linux a PTY
//! carries the program's own bytes: text, `\r`, `\n` and a few escapes, so a line splitter that
//! strips escapes and treats `\r` as "redraw this line" is right. On Windows every terminal goes
//! through ConPTY, and ConPTY is a *screen renderer*: conhost keeps the screen and sends the
//! terminal whatever repaints it — the prompt and each keystroke drawn with cursor positioning
//! (`CSI row;col H`), blank rows skipped with a cursor jump instead of `\r\n`, a whole-screen
//! repaint after every resize. Fed to the stream splitter that became
//! `GeGetGet-Get-LGet-Lo…Get-Location`. Recordings of the real bytes are in
//! `tests/fixtures/logstream/conpty/` and `tests/logstream_conpty.rs` holds this module to them.
//!
//! So on Windows the hub keeps a small model of the screen instead:
//! - **A grid of rows**, the viewport's size (the hub passes the PTY size, and every resize), a
//!   cursor, and the VT operations ConPTY uses: cursor moves (`H f A B C D E F G d \``), erase in
//!   line / display (`K J X`), insert/delete characters and lines (`@ P L M`), scroll (`S T`, a
//!   line feed at the bottom, reverse index), scroll margins (`r`), save/restore cursor.
//!   Colours and modes are rendering, not content.
//! - **Autowrap with the wrap remembered.** ConPTY leaves a long line to the terminal's autowrap
//!   (deferred, as VT does: the wrap happens at the next character, so a row filled exactly and
//!   then `\r\n` is not wrapped). Rows joined by a wrap are ONE logical line — the log shows
//!   `Lost = 0 (0% loss),` whole, not cut where the pane happened to end.
//! - **A line is emitted when it is finished**: the cursor leaves it (a line feed, a jump to
//!   another row) or it scrolls away. Keystroke repaints rewrite the row in place, so the command
//!   is logged once, as typed. The hub's ~250 ms silence flush emits the cursor's line too (a
//!   prompt, `Password:`); when that line is later finished with more text, only what was added
//!   is emitted — the stream splitter's behaviour, so both OSes read the same.
//! - **A repaint is not new output.** Each row remembers the text it last emitted; a row redrawn
//!   with the same text emits nothing. A resize can also *shift* the screen (a shorter pane drops
//!   the top rows) and reflow it, so on a resize (and on `CSI H`, where every ConPTY full repaint
//!   starts) the lines already on screen are noted in order, and the repaint's lines are matched
//!   against them in that order — each old line once, so two identical `Reply from …` rows stay
//!   two. The match ends at the next silence flush.
//! - **A bare `\n` is a new line** (as `\r\n`): ConPTY always sends `\r\n` for one, and so the
//!   hub's other feeders (tests, a non-ConPTY byte source) read as on Unix. Were ConPTY to move
//!   down one row in the same column with a bare `\n`, the cost is that row's indentation only.
//! - **Alternate screen** (`CSI ?1049h` / `?1047h` / `?47h`): nothing is logged while a TUI owns
//!   the screen, as in the stream splitter; leaving it restores the main screen, whose repaint
//!   is matched like a resize's.
//! - **4 KiB cap** per line (the `…` marker included), C0/C1 controls never content, UTF-8 decoded
//!   as it arrives (a character split across reads is joined), wide (CJK, emoji) characters take
//!   two columns as they do in conhost.
//!
//! Pure and clock-free, like the stream splitter: every rule is testable without a runtime, and it
//! compiles and is tested on every OS. Only the hub's choice of it is `cfg(windows)`.

use std::collections::VecDeque;

use super::splitter::MAX_LINE_BYTES;

/// The size a model starts at before the hub has told it the PTY's (ConPTY's own default).
pub const DEFAULT_ROWS: u16 = 24;
pub const DEFAULT_COLS: u16 = 80;
/// Bounds on the model's size, whatever a resize (or a `CSI 8;r;c t` in the stream) says.
const MAX_ROWS: usize = 1000;
const MAX_COLS: usize = 4096;
/// CSI parameters kept per sequence; the rest are ignored.
const MAX_PARAMS: usize = 16;
/// Tab stops every this many columns (VT default).
const TAB: usize = 8;
const ELLIPSIS: char = '…';
/// The second cell of a wide character — not text.
const WIDE_TAIL: char = '\0';

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Esc,
    EscIntermediate,
    Csi,
    Osc,
    Str,
    StrEsc,
}

#[derive(Debug, Clone, Default)]
struct Row {
    cells: Vec<char>,
    /// Autowrapped onto the next row: the two are one logical line.
    wrapped: bool,
    /// The text last emitted for the logical line that starts on this row.
    committed: Option<String>,
    /// `committed` came from a silence flush — the line may still grow, and only the growth
    /// is emitted when it does.
    flushed: bool,
}

#[derive(Debug)]
pub struct ScreenSplitter {
    state: State,
    params: Vec<u32>,
    param: Option<u32>,
    /// `CSI ?` (or another private marker) — a mode sequence.
    private: bool,
    /// An intermediate byte (`CSI ! p`, `CSI SP q`): not a sequence this model acts on.
    intermediate: bool,
    csi_started: bool,
    utf8: Vec<u8>,
    utf8_need: usize,
    rows: usize,
    cols: usize,
    grid: VecDeque<Row>,
    row: usize,
    col: usize,
    /// VT's deferred wrap: the last column was written; the next character wraps first.
    pending_wrap: bool,
    /// Scroll margins (inclusive rows).
    top: usize,
    bottom: usize,
    saved: Option<(usize, usize)>,
    /// The text of the rows of the current top row's logical line that have scrolled off.
    carry: String,
    alt_screen: bool,
    alt_saved: Option<(usize, usize)>,
    /// While a repaint may be in progress: the lines that were on screen, in order.
    repaint: Option<VecDeque<String>>,
    /// Something was written since the cursor's line was last emitted or flushed.
    dirty: bool,
}

impl Default for ScreenSplitter {
    fn default() -> Self {
        Self::new()
    }
}

fn clamp_size(rows: u16, cols: u16) -> (usize, usize) {
    (
        (rows as usize).clamp(1, MAX_ROWS),
        (cols as usize).clamp(1, MAX_COLS),
    )
}

impl ScreenSplitter {
    pub fn new() -> Self {
        Self::with_size(DEFAULT_ROWS, DEFAULT_COLS)
    }

    pub fn with_size(rows: u16, cols: u16) -> Self {
        let (rows, cols) = clamp_size(rows, cols);
        Self {
            state: State::Ground,
            params: Vec::new(),
            param: None,
            private: false,
            intermediate: false,
            csi_started: false,
            utf8: Vec::new(),
            utf8_need: 0,
            rows,
            cols,
            grid: (0..rows).map(|_| Row::default()).collect(),
            row: 0,
            col: 0,
            pending_wrap: false,
            top: 0,
            bottom: rows - 1,
            saved: None,
            carry: String::new(),
            alt_screen: false,
            alt_saved: None,
            repaint: None,
            dirty: false,
        }
    }

    /// Forget everything but the size — a terminal back from suppression (a bound `claude`
    /// session may have left it mid-sequence or in the alternate screen).
    pub fn reset(&mut self) {
        *self = Self::with_size(self.rows as u16, self.cols as u16);
    }

    pub fn in_alt_screen(&self) -> bool {
        self.alt_screen
    }

    /// Is the cursor's line changed and not yet emitted (what a silence flush would emit)?
    pub fn has_partial(&self) -> bool {
        !self.alt_screen && self.dirty
    }

    /// The PTY was resized: ConPTY is about to repaint the screen at the new size.
    pub fn resize(&mut self, rows: u16, cols: u16) {
        let (rows, cols) = clamp_size(rows, cols);
        if rows == self.rows && cols == self.cols {
            return;
        }
        self.start_repaint();
        // conhost keeps the cursor on screen: a shorter screen loses its top rows.
        while self.row >= rows {
            self.grid.pop_front();
            self.row -= 1;
            self.carry.clear();
        }
        self.grid.resize_with(rows, Row::default);
        if cols < self.cols {
            for r in &mut self.grid {
                r.cells.truncate(cols);
            }
        }
        self.rows = rows;
        self.cols = cols;
        self.col = self.col.min(cols - 1);
        self.pending_wrap = false;
        self.top = 0;
        self.bottom = rows - 1;
        self.saved = self.saved.map(|(r, c)| (r.min(rows - 1), c.min(cols - 1)));
    }

    /// Feed one chunk; returns the lines it finished (blank lines are skipped).
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            self.step(b, &mut out);
        }
        out
    }

    /// Emit the cursor's line if it changed (the hub calls this after ~250 ms of silence, and
    /// at EOF). A silence also ends any repaint in progress.
    pub fn flush_partial(&mut self) -> Option<String> {
        let mut out = Vec::new();
        if !self.alt_screen {
            let (s, e) = self.bounds(self.row);
            self.finalize(s, e, true, &mut out);
        }
        self.repaint = None;
        out.pop()
    }

    fn step(&mut self, b: u8, out: &mut Vec<String>) {
        match self.state {
            State::Ground => self.ground(b, out),
            State::Esc => self.esc(b, out),
            State::EscIntermediate => {
                if !(0x20..=0x2f).contains(&b) {
                    self.state = State::Ground;
                }
            }
            State::Csi => self.csi_byte(b, out),
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
                    State::Str
                };
            }
        }
    }

    fn ground(&mut self, b: u8, out: &mut Vec<String>) {
        if self.utf8_need > 0 {
            if b & 0xC0 == 0x80 {
                self.utf8.push(b);
                if self.utf8.len() == self.utf8_need {
                    let c = std::str::from_utf8(&self.utf8)
                        .ok()
                        .and_then(|s| s.chars().next())
                        .unwrap_or('\u{FFFD}');
                    self.utf8.clear();
                    self.utf8_need = 0;
                    self.print(c);
                }
                return;
            }
            // A character cut short: show that something was there, then handle this byte.
            self.utf8.clear();
            self.utf8_need = 0;
            self.print('\u{FFFD}');
        }
        if self.alt_screen && b != 0x1b {
            return;
        }
        match b {
            0x1b => self.state = State::Esc,
            b'\r' => {
                self.col = 0;
                self.pending_wrap = false;
            }
            b'\n' | 0x0b | 0x0c => {
                self.col = 0;
                self.line_feed(out);
            }
            0x08 => {
                self.col = self.col.saturating_sub(1);
                self.pending_wrap = false;
            }
            b'\t' => {
                self.col = ((self.col / TAB + 1) * TAB).min(self.cols - 1);
                self.pending_wrap = false;
            }
            0x00..=0x1f | 0x7f => {}
            0x20..=0x7e => self.print(b as char),
            0xC2..=0xDF => self.utf8_start(b, 2),
            0xE0..=0xEF => self.utf8_start(b, 3),
            0xF0..=0xF4 => self.utf8_start(b, 4),
            _ => self.print('\u{FFFD}'),
        }
    }

    fn utf8_start(&mut self, b: u8, len: usize) {
        self.utf8.clear();
        self.utf8.push(b);
        self.utf8_need = len;
    }

    fn esc(&mut self, b: u8, out: &mut Vec<String>) {
        self.state = State::Ground;
        match b {
            b'[' => {
                self.params.clear();
                self.param = None;
                self.private = false;
                self.intermediate = false;
                self.csi_started = false;
                self.state = State::Csi;
            }
            b']' => self.state = State::Osc,
            b'P' | b'X' | b'^' | b'_' => self.state = State::Str,
            0x20..=0x2f => self.state = State::EscIntermediate,
            0x1b => self.state = State::Esc,
            // RIS: the terminal is reset, main screen included.
            b'c' => self.reset(),
            _ if self.alt_screen => {}
            b'7' => self.saved = Some((self.row, self.col)),
            b'8' => self.restore_cursor(out),
            b'D' => self.line_feed(out),
            b'E' => {
                self.col = 0;
                self.line_feed(out);
            }
            b'M' => self.reverse_index(out),
            _ => {}
        }
    }

    fn csi_byte(&mut self, b: u8, out: &mut Vec<String>) {
        match b {
            b'0'..=b'9' => {
                let d = u32::from(b - b'0');
                self.param = Some(
                    self.param
                        .unwrap_or(0)
                        .saturating_mul(10)
                        .saturating_add(d)
                        .min(65_535),
                );
                self.csi_started = true;
            }
            b';' | b':' => {
                self.push_param();
                self.csi_started = true;
            }
            b'<'..=b'?' => {
                if !self.csi_started {
                    self.private = true;
                }
                self.csi_started = true;
            }
            0x20..=0x2f => self.intermediate = true,
            0x40..=0x7e => {
                self.push_param();
                self.state = State::Ground;
                self.csi_dispatch(b, out);
            }
            0x1b => self.state = State::Esc, // malformed; restart
            _ => {}
        }
    }

    fn push_param(&mut self) {
        if self.params.len() < MAX_PARAMS {
            self.params.push(self.param.unwrap_or(0));
        }
        self.param = None;
    }

    /// Parameter `i`, with 0 or missing meaning `default`.
    fn p(&self, i: usize, default: usize) -> usize {
        match self.params.get(i) {
            Some(&v) if v != 0 => v as usize,
            _ => default,
        }
    }

    fn csi_dispatch(&mut self, final_byte: u8, out: &mut Vec<String>) {
        if self.intermediate {
            return;
        }
        if self.private {
            let alt = self
                .params
                .iter()
                .any(|&v| v == 1049 || v == 1047 || v == 47);
            match final_byte {
                b'h' if alt => self.enter_alt_screen(out),
                b'l' if alt => self.leave_alt_screen(),
                _ => {}
            }
            return;
        }
        if self.alt_screen {
            return;
        }
        let n = self.p(0, 1);
        match final_byte {
            b'H' | b'f' => {
                let (r, c) = (self.p(0, 1) - 1, self.p(1, 1) - 1);
                self.move_to(r, c, out);
                // Every ConPTY full repaint starts at home.
                if r == 0 && c == 0 {
                    self.start_repaint();
                }
            }
            b'A' => self.move_to(self.row.saturating_sub(n), self.col, out),
            b'B' => self.move_to(self.row.saturating_add(n), self.col, out),
            b'C' => {
                self.col = self.col.saturating_add(n).min(self.cols - 1);
                self.pending_wrap = false;
            }
            b'D' => {
                self.col = self.col.saturating_sub(n);
                self.pending_wrap = false;
            }
            b'E' => self.move_to(self.row.saturating_add(n), 0, out),
            b'F' => self.move_to(self.row.saturating_sub(n), 0, out),
            b'G' | b'`' => {
                self.col = (n - 1).min(self.cols - 1);
                self.pending_wrap = false;
            }
            b'd' => self.move_to(n - 1, self.col, out),
            b'K' => self.erase_in_line(self.p(0, 0)),
            b'J' => self.erase_in_display(self.p(0, 0)),
            b'X' => {
                let (col, cols) = (self.col, self.cols);
                let cells = &mut self.grid[self.row].cells;
                for i in col..col.saturating_add(n).min(cols).min(cells.len()) {
                    cells[i] = ' ';
                }
            }
            b'P' => {
                let col = self.col;
                let cells = &mut self.grid[self.row].cells;
                if col < cells.len() {
                    let end = col.saturating_add(n).min(cells.len());
                    cells.drain(col..end);
                }
            }
            b'@' => {
                let (col, cols) = (self.col, self.cols);
                let cells = &mut self.grid[self.row].cells;
                if col < cells.len() {
                    for _ in 0..n.min(cols) {
                        cells.insert(col, ' ');
                    }
                    cells.truncate(cols);
                }
            }
            // These move the cursor's line out from under it: it is finished first.
            b'L' | b'M' | b'S' | b'T' => {
                let (s, e) = self.bounds(self.row);
                self.finalize(s, e, false, out);
                match final_byte {
                    b'L' => self.insert_lines(n),
                    b'M' => self.delete_lines(n),
                    b'S' => self.scroll_up(n),
                    _ => self.scroll_down(n),
                }
            }
            b'r' => {
                let (t, b) = (self.p(0, 1) - 1, self.p(1, self.rows) - 1);
                if t < b && b < self.rows {
                    (self.top, self.bottom) = (t, b);
                } else {
                    (self.top, self.bottom) = (0, self.rows - 1);
                }
                self.move_to(0, 0, out);
            }
            b's' => self.saved = Some((self.row, self.col)),
            b'u' => self.restore_cursor(out),
            // `CSI 8;rows;cols t` — ConPTY announcing a new size (not after every resize).
            b't' if self.params.first() == Some(&8) => {
                let (r, c) = (self.p(1, self.rows), self.p(2, self.cols));
                self.resize(
                    r.min(u16::MAX as usize) as u16,
                    c.min(u16::MAX as usize) as u16,
                );
            }
            _ => {}
        }
    }

    fn print(&mut self, c: char) {
        if self.alt_screen || ('\u{80}'..='\u{9f}').contains(&c) {
            return;
        }
        let wide = is_wide(c) && self.cols >= 2;
        if self.pending_wrap || (wide && self.col + 1 >= self.cols) {
            self.wrap();
        }
        let (row, col) = (self.row, self.col);
        let cells = &mut self.grid[row].cells;
        let need = col + if wide { 2 } else { 1 };
        if cells.len() < need {
            cells.resize(need, ' ');
        }
        cells[col] = c;
        if wide {
            cells[col + 1] = WIDE_TAIL;
        }
        if need >= self.cols {
            self.col = self.cols - 1;
            self.pending_wrap = true;
        } else {
            self.col = need;
        }
        self.dirty = true;
    }

    /// Autowrap: the row continues on the next one — same logical line, nothing finished.
    fn wrap(&mut self) {
        self.grid[self.row].wrapped = true;
        self.pending_wrap = false;
        self.col = 0;
        if self.row == self.bottom {
            self.scroll_up(1);
        } else if self.row + 1 < self.rows {
            self.row += 1;
        }
    }

    /// Move the cursor; leaving the cursor's logical line finishes it.
    fn move_to(&mut self, row: usize, col: usize, out: &mut Vec<String>) {
        let row = row.min(self.rows - 1);
        let col = col.min(self.cols - 1);
        if row != self.row {
            let (s, e) = self.bounds(self.row);
            if !(s..=e).contains(&row) {
                self.finalize(s, e, false, out);
            }
        }
        self.row = row;
        self.col = col;
        self.pending_wrap = false;
    }

    fn line_feed(&mut self, out: &mut Vec<String>) {
        self.pending_wrap = false;
        if self.row == self.bottom {
            let (s, e) = self.bounds(self.row);
            self.finalize(s, e, false, out);
            self.scroll_up(1);
        } else {
            self.move_to(self.row + 1, self.col, out);
        }
    }

    fn reverse_index(&mut self, out: &mut Vec<String>) {
        if self.row == self.top {
            self.scroll_down(1);
        } else {
            self.move_to(self.row.saturating_sub(1), self.col, out);
        }
    }

    fn restore_cursor(&mut self, out: &mut Vec<String>) {
        if let Some((r, c)) = self.saved {
            self.move_to(r, c, out);
        }
    }

    /// Scroll the margin region up `n` rows. A row leaving the top of the screen takes its
    /// text into `carry` when its logical line goes on below.
    fn scroll_up(&mut self, n: usize) {
        for _ in 0..n.min(self.bottom - self.top + 1) {
            let gone = self.grid.remove(self.top).unwrap_or_default();
            if self.top == 0 {
                if gone.wrapped {
                    if self.carry.len() < MAX_LINE_BYTES {
                        self.carry
                            .extend(gone.cells.iter().filter(|&&c| c != WIDE_TAIL));
                    }
                    if let Some(next) = self.grid.front_mut() {
                        next.committed = gone.committed;
                        next.flushed = gone.flushed;
                    }
                } else {
                    self.carry.clear();
                }
            }
            self.grid.insert(self.bottom, Row::default());
        }
    }

    fn scroll_down(&mut self, n: usize) {
        for _ in 0..n.min(self.bottom - self.top + 1) {
            self.grid.remove(self.bottom);
            self.grid.insert(self.top, Row::default());
        }
        if self.top == 0 {
            self.carry.clear();
        }
    }

    fn insert_lines(&mut self, n: usize) {
        if !(self.top..=self.bottom).contains(&self.row) {
            return;
        }
        for _ in 0..n.min(self.bottom - self.row + 1) {
            self.grid.remove(self.bottom);
            self.grid.insert(self.row, Row::default());
        }
        if self.row == 0 {
            self.carry.clear();
        }
        self.col = 0;
        self.pending_wrap = false;
    }

    fn delete_lines(&mut self, n: usize) {
        if !(self.top..=self.bottom).contains(&self.row) {
            return;
        }
        for _ in 0..n.min(self.bottom - self.row + 1) {
            self.grid.remove(self.row);
            self.grid.insert(self.bottom, Row::default());
        }
        if self.row == 0 {
            self.carry.clear();
        }
        self.col = 0;
        self.pending_wrap = false;
    }

    fn erase_in_line(&mut self, mode: usize) {
        let col = self.col;
        let row = &mut self.grid[self.row];
        match mode {
            0 => {
                row.cells.truncate(col);
                row.wrapped = false;
            }
            1 => {
                for c in row.cells.iter_mut().take(col + 1) {
                    *c = ' ';
                }
            }
            2 => {
                row.cells.clear();
                row.wrapped = false;
            }
            _ => {}
        }
    }

    fn erase_in_display(&mut self, mode: usize) {
        match mode {
            0 => {
                self.erase_in_line(0);
                for r in self.grid.iter_mut().skip(self.row + 1) {
                    r.cells.clear();
                    r.wrapped = false;
                }
            }
            1 => {
                self.erase_in_line(1);
                for r in self.grid.iter_mut().take(self.row) {
                    r.cells.clear();
                    r.wrapped = false;
                }
                if self.row > 0 {
                    self.carry.clear();
                }
            }
            // A cleared screen (`cls`): what comes next is new, even if it reads the same.
            2 | 3 => {
                for r in &mut self.grid {
                    *r = Row::default();
                }
                self.carry.clear();
                self.repaint = None;
                self.dirty = false;
            }
            _ => {}
        }
    }

    fn enter_alt_screen(&mut self, out: &mut Vec<String>) {
        if self.alt_screen {
            return;
        }
        // Whatever was typed before the TUI took over is real output.
        let (s, e) = self.bounds(self.row);
        self.finalize(s, e, true, out);
        self.alt_saved = Some((self.row, self.col));
        self.alt_screen = true;
    }

    fn leave_alt_screen(&mut self) {
        if !self.alt_screen {
            return;
        }
        self.alt_screen = false;
        if let Some((r, c)) = self.alt_saved.take() {
            self.row = r.min(self.rows - 1);
            self.col = c.min(self.cols - 1);
        }
        self.pending_wrap = false;
        self.dirty = false;
        // The main screen comes back as it was: its repaint is not new output.
        self.start_repaint();
    }

    /// Note the lines on screen, in order, so a repaint of them is recognised.
    fn start_repaint(&mut self) {
        let expect: VecDeque<String> = self
            .grid
            .iter()
            .filter_map(|r| r.committed.clone())
            .collect();
        self.repaint = (!expect.is_empty()).then_some(expect);
    }

    /// The rows `(start, end)` of the logical line through `row`.
    fn bounds(&self, row: usize) -> (usize, usize) {
        let mut s = row;
        while s > 0 && self.grid[s - 1].wrapped {
            s -= 1;
        }
        let mut e = row;
        while e + 1 < self.rows && self.grid[e].wrapped {
            e += 1;
        }
        (s, e)
    }

    /// The logical line's text: trailing blanks trimmed, capped, `None` when blank.
    fn line_text(&self, s: usize, e: usize) -> Option<String> {
        let mut text = String::new();
        if s == 0 {
            text.push_str(&self.carry);
        }
        for r in self.grid.range(s..=e) {
            if text.len() > MAX_LINE_BYTES {
                break;
            }
            text.extend(r.cells.iter().filter(|&&c| c != WIDE_TAIL));
        }
        let truncated = text.len() > MAX_LINE_BYTES;
        if truncated {
            let mut end = MAX_LINE_BYTES - ELLIPSIS.len_utf8();
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        let trimmed = text.trim_end().len();
        text.truncate(trimmed);
        if text.trim_start().is_empty() {
            return None;
        }
        if truncated {
            text.push(ELLIPSIS);
        }
        Some(text)
    }

    /// The logical line `s..=e` is finished (or, `flushed`, flushed by silence): emit it unless
    /// it is a repaint of what was already emitted.
    fn finalize(&mut self, s: usize, e: usize, flushed: bool, out: &mut Vec<String>) {
        self.dirty = false;
        let Some(text) = self.line_text(s, e) else {
            return;
        };
        if let Some(expect) = &mut self.repaint {
            if let Some(i) = expect.iter().position(|t| *t == text) {
                expect.drain(..=i);
                if expect.is_empty() {
                    self.repaint = None;
                }
                let row = &mut self.grid[s];
                row.committed = Some(text);
                row.flushed = flushed;
                return;
            }
        }
        let row = &mut self.grid[s];
        let prev = row.committed.replace(text.clone());
        let was_flushed = std::mem::replace(&mut row.flushed, flushed);
        match prev {
            Some(p) if p == text => {}
            Some(p) if was_flushed && text.starts_with(p.as_str()) => {
                let rest = text[p.len()..].trim_start();
                if !rest.is_empty() {
                    out.push(rest.to_string());
                }
            }
            _ => out.push(text),
        }
    }
}

/// Does `c` take two columns? The East Asian wide and emoji ranges conhost draws double.
fn is_wide(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x115F
        | 0x2E80..=0x303E
        | 0x3041..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA000..=0xA4CF
        | 0xAC00..=0xD7A3
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFF60
        | 0xFFE0..=0xFFE6
        | 0x1F300..=0x1F64F
        | 0x1F900..=0x1F9FF
        | 0x20000..=0x3FFFD)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(chunks: &[&[u8]]) -> Vec<String> {
        let mut s = ScreenSplitter::new();
        let mut out: Vec<String> = chunks.iter().flat_map(|c| s.feed(c)).collect();
        out.extend(s.flush_partial());
        out
    }

    #[test]
    fn crlf_and_bare_lf_end_lines_as_on_unix() {
        assert_eq!(lines(&[b"a\r\nb\nc\r\n"]), ["a", "b", "c"]);
    }

    #[test]
    fn a_row_rewritten_in_place_is_one_line_with_its_last_text() {
        // PSReadLine's shape: the input is redrawn from its first column on every key.
        assert_eq!(
            lines(&[
                b"PS> G",
                b"\x08Ge",
                b"\x1b[1;5HGet",
                b"\x1b[1;5HGet-Date\r\n"
            ]),
            ["PS> Get-Date"]
        );
    }

    #[test]
    fn a_cursor_jump_to_another_row_finishes_the_line() {
        // ConPTY skips a blank row with a jump instead of `\r\n\r\n`.
        assert_eq!(
            lines(&[b"one\r\ntwo\x1b[4;1Hfour\r\n"]),
            ["one", "two", "four"]
        );
    }

    #[test]
    fn carriage_return_overwrites_so_a_progress_bar_is_one_line() {
        let mut bar = Vec::new();
        for pct in (0..=100).step_by(10) {
            bar.extend_from_slice(format!("\r[{pct:>3}%] downloading").as_bytes());
        }
        bar.extend_from_slice(b"\r\n");
        assert_eq!(lines(&[&bar]), ["[100%] downloading"]);
    }

    #[test]
    fn a_wrapped_line_is_one_logical_line_and_a_full_row_then_crlf_is_not_wrapped() {
        let mut sp = ScreenSplitter::with_size(5, 10);
        let mut out = sp.feed(b"0123456789abcde\r\n");
        // Exactly full, then CRLF: deferred wrap never happens.
        out.extend(sp.feed(b"0123456789\r\nnext\r\n"));
        assert_eq!(out, ["0123456789abcde", "0123456789", "next"]);
    }

    #[test]
    fn a_line_feed_at_the_bottom_scrolls_and_cursor_addresses_stay_viewport_rows() {
        let mut sp = ScreenSplitter::with_size(3, 20);
        let mut out = sp.feed(b"1\r\n2\r\n3\r\n4\r\n> ");
        // The prompt is on the bottom row (3); a keystroke repaint addresses it as row 3.
        out.extend(sp.feed(b"x\x1b[3;3Hxy\r\n"));
        assert_eq!(out, ["1", "2", "3", "4", "> xy"]);
    }

    #[test]
    fn a_wrapped_line_longer_than_the_screen_is_kept_whole() {
        let mut sp = ScreenSplitter::with_size(2, 4);
        let out = sp.feed(b"abcdefghijklmnop\r\nz\r\n");
        assert_eq!(out, ["abcdefghijklmnop", "z"]);
    }

    #[test]
    fn a_resize_repaint_of_the_same_screen_emits_nothing() {
        let mut sp = ScreenSplitter::with_size(5, 20);
        assert_eq!(sp.feed(b"a\r\nb\r\nb\r\n"), ["a", "b", "b"]);
        sp.resize(5, 30);
        assert!(sp
            .feed(b"\x1b[Ha\x1b[K\r\nb\x1b[K\r\nb\x1b[K\r\n")
            .is_empty());
        // …and output after it is new, even when it reads the same as a line above.
        assert_eq!(sp.feed(b"b\r\n"), ["b"]);
    }

    #[test]
    fn a_resize_that_shifts_the_screen_is_matched_in_order() {
        let mut sp = ScreenSplitter::with_size(4, 20);
        assert_eq!(sp.feed(b"1\r\n2\r\n3\r\n> "), ["1", "2", "3"]);
        assert_eq!(sp.flush_partial().as_deref(), Some(">"));
        sp.resize(2, 20);
        assert!(sp.feed(b"\x1b[H3\x1b[K\r\n> \x1b[K").is_empty());
        assert_eq!(sp.flush_partial(), None);
    }

    #[test]
    fn a_silence_flush_then_more_text_emits_only_what_was_added() {
        let mut sp = ScreenSplitter::new();
        sp.feed(b"PS C:\\> ");
        assert!(sp.has_partial());
        assert_eq!(sp.flush_partial().as_deref(), Some("PS C:\\>"));
        assert!(!sp.has_partial());
        assert_eq!(sp.flush_partial(), None);
        assert_eq!(sp.feed(b"dir\r\n"), ["dir"]);
    }

    #[test]
    fn a_rewritten_flushed_line_is_emitted_whole() {
        let mut sp = ScreenSplitter::new();
        sp.feed(b"loading");
        assert_eq!(sp.flush_partial().as_deref(), Some("loading"));
        assert_eq!(sp.feed(b"\rdone   \r\n"), ["done"]);
    }

    #[test]
    fn a_cleared_screen_logs_the_same_text_again() {
        let mut sp = ScreenSplitter::new();
        assert_eq!(sp.feed(b"hello\r\n"), ["hello"]);
        assert_eq!(sp.feed(b"\x1b[2J\x1b[Hhello\r\n"), ["hello"]);
    }

    #[test]
    fn escapes_colours_titles_and_modes_are_not_content() {
        assert_eq!(
            lines(&[b"\x1b[?25l\x1b]0;title\x07\x1b[93mred\x1b[m \x1bPq#\x1b\\x\x1b(B\r\n"]),
            ["red x"]
        );
    }

    #[test]
    fn erase_in_line_and_erase_characters() {
        assert_eq!(lines(&[b"abcdef\x1b[4G\x1b[K\r\n"]), ["abc"]);
        assert_eq!(lines(&[b"abcdef\x1b[2G\x1b[2X\r\n"]), ["a  def"]);
        assert_eq!(lines(&[b"abcdef\x1b[3G\x1b[1K\r\n"]), ["   def"]);
        assert_eq!(lines(&[b"abcdef\x1b[2K\r\n"]), Vec::<String>::new());
    }

    #[test]
    fn insert_and_delete_characters() {
        assert_eq!(lines(&[b"abcdef\x1b[2G\x1b[2P\r\n"]), ["adef"]);
        assert_eq!(lines(&[b"abcdef\x1b[2G\x1b[2@\r\n"]), ["a  bcdef"]);
    }

    #[test]
    fn cursor_moves_relative_and_absolute() {
        assert_eq!(
            lines(&[b"one\r\ntwo\x1b[A\x1b[2D-\x1b[B\x1b[1G2\r\n"]),
            ["one", "two", "o-e", "2wo"]
        );
        assert_eq!(lines(&[b"a\x1b[3Cb\x1b[3d\x1b[1`c\r\n"]), ["a   b", "c"]);
        assert_eq!(lines(&[b"x\x1b[2Ey\x1b[1Fz\r\n"]), ["x", "y", "z"]);
    }

    #[test]
    fn tabs_move_to_the_next_stop() {
        assert_eq!(lines(&[b"a\tb\r\n"]), ["a       b"]);
    }

    #[test]
    fn save_and_restore_cursor() {
        assert_eq!(lines(&[b"ab\x1b7\r\nx\x1b8c\r\n"]), ["ab", "x", "abc"]);
        assert_eq!(lines(&[b"ab\x1b[s\r\nx\x1b[uc\r\n"]), ["ab", "x", "abc"]);
    }

    #[test]
    fn index_next_line_and_reverse_index() {
        assert_eq!(
            lines(&[b"ab\x1bDc\x1bEd\x1bMe\r\n"]),
            ["ab", "  c", "d", " ec"]
        );
        // Reverse index at the top scrolls the screen down.
        let mut sp = ScreenSplitter::with_size(3, 10);
        let mut out = sp.feed(b"top\x1b[H\x1bMnew\r\n");
        out.extend(sp.feed(b"\x1b[3;1Hlast\r\n"));
        assert_eq!(out, ["new", "top", "last"]);
    }

    #[test]
    fn scroll_up_down_and_insert_delete_lines() {
        let mut sp = ScreenSplitter::with_size(3, 10);
        let mut out = sp.feed(b"a\r\nb\x1b[1S\x1b[1;1Hc\r\n");
        assert_eq!(out, ["a", "b", "c"]);
        out = sp.feed(b"\x1b[1;1H\x1b[1Tz\r\n");
        assert_eq!(out, ["z"]);
        let mut sp = ScreenSplitter::with_size(3, 10);
        out = sp.feed(b"a\r\nb\x1b[1;1H\x1b[Lq\r\n");
        assert_eq!(out, ["a", "b", "q"]);
        out = sp.feed(b"\x1b[1;1H\x1b[Mw\r\n");
        assert_eq!(out, ["w"]);
    }

    #[test]
    fn scroll_margins_scroll_only_their_region() {
        let mut sp = ScreenSplitter::with_size(4, 10);
        let mut out = sp.feed(b"head\x1b[2;4r\x1b[2;1Hx\r\ny\r\nz\r\nw\r\n");
        out.extend(sp.feed(b"\x1b[r\x1b[1;1Hhead!\r\n"));
        assert_eq!(out, ["head", "x", "y", "z", "w", "head!"]);
    }

    #[test]
    fn the_alternate_screen_is_not_logged_and_logging_resumes_after_it() {
        for mode in ["1049", "1047", "47"] {
            let enter = format!("before\r\n$ vim\x1b[?{mode}h");
            let leave = format!("\x1b[?{mode}l");
            let out = lines(&[
                enter.as_bytes(),
                b"\x1b[H\x1b[2Jrepaint 1\r\nrepaint 2\r\n\x1bM\x1b7",
                leave.as_bytes(),
                b"\r\nafter\r\n",
            ]);
            assert_eq!(out, ["before", "$ vim", "after"], "mode {mode}");
        }
    }

    #[test]
    fn other_private_modes_and_intermediates_do_nothing() {
        assert_eq!(
            lines(&[b"\x1b[?2004h\x1b[?9001hab\x1b[2 q\x1b[!pc\r\n"]),
            ["abc"]
        );
    }

    #[test]
    fn utf8_split_across_chunks_is_joined_and_broken_utf8_is_visible() {
        let s = "héllo → wörld\r\n".as_bytes();
        let at = "héllo ".len() + 1;
        assert_eq!(lines(&[&s[..at], &s[at..]]), ["héllo → wörld"]);
        assert_eq!(lines(&[b"a\xe2\x86b\xffc\r\n"]), ["a\u{FFFD}b\u{FFFD}c"]);
    }

    #[test]
    fn c1_controls_are_not_content() {
        assert_eq!(lines(&["a\u{85}b\r\n".as_bytes()]), ["ab"]);
    }

    #[test]
    fn wide_characters_take_two_columns() {
        // "日本" is four columns: the cursor-addressed `!` lands after them.
        assert_eq!(lines(&["日本\x1b[1;5H!\r\n".as_bytes()]), ["日本!"]);
        // A wide character that does not fit in the last column wraps whole.
        let mut sp = ScreenSplitter::with_size(3, 3);
        assert_eq!(sp.feed("ab日\r\n".as_bytes()), ["ab日"]);
    }

    #[test]
    fn a_line_is_capped_at_4_kib_with_an_ellipsis() {
        let mut long = vec![b'a'; MAX_LINE_BYTES + 500];
        long.extend_from_slice(b"\r\nnext\r\n");
        let out = lines(&[&long]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].len(), MAX_LINE_BYTES);
        assert!(out[0].ends_with('…'));
        assert_eq!(out[1], "next");
    }

    #[test]
    fn a_ris_resets_the_screen_and_leaves_the_alt_screen() {
        let mut sp = ScreenSplitter::new();
        sp.feed(b"half\x1b[?1049h");
        assert!(sp.in_alt_screen());
        sp.feed(b"\x1bc");
        assert!(!sp.in_alt_screen());
        assert_eq!(sp.feed(b"fresh\r\n"), ["fresh"]);
    }

    #[test]
    fn reset_keeps_the_size() {
        let mut sp = ScreenSplitter::with_size(2, 4);
        sp.feed(b"junk\x1b[?1049h");
        sp.reset();
        assert!(!sp.in_alt_screen());
        assert_eq!(sp.feed(b"abcdefgh\r\n"), ["abcdefgh"]);
        assert_eq!((sp.rows, sp.cols), (2, 4));
    }

    #[test]
    fn conpty_announcing_a_size_resizes_the_model() {
        let mut sp = ScreenSplitter::new();
        sp.feed(b"\x1b[8;3;5t");
        assert_eq!((sp.rows, sp.cols), (3, 5));
        // Absurd sizes are bounded.
        sp.feed(b"\x1b[8;65535;65535t");
        assert_eq!((sp.rows, sp.cols), (MAX_ROWS, MAX_COLS));
    }
}
