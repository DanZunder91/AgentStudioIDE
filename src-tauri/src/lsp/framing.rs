//! Content-Length JSON-RPC framing — the pure, hard-tested core of the relay.
//!
//! LSP frames each message as `Content-Length: N\r\n\r\n<body>` over a byte stream
//! (`docs/design/code-intelligence.md` §1). This module does exactly two things and
//! knows nothing about LSP semantics:
//!
//! - [`encode`] frames a client→server body (`lsp_send`).
//! - [`FrameDecoder`] reassembles server→client bodies from a stream that arbitrarily
//!   **splits messages across reads** and **packs several messages into one read**.
//!
//! It is deliberately Tauri-free and side-effect-free so it is fixture- and
//! property-testable in isolation, like the pane-tree canonicalizer.

/// Frame `body` for the wire: `Content-Length: <bytes>\r\n\r\n<body>`.
///
/// The length is the body's **byte** length (UTF-8), which is what the header must
/// carry — not its character count.
pub fn encode(body: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

/// Stateful reassembler: feed it stream chunks, it yields complete message bodies.
///
/// The whole point is tolerating a stream that does not respect message boundaries —
/// a body may arrive over many `push`es, and one `push` may complete several bodies.
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

/// The result of one attempt to pull a message off the front of the buffer.
enum Step {
    /// A complete body was decoded and drained.
    Message(String),
    /// A malformed header block was dropped to resync; try again immediately.
    Skipped,
    /// Not enough bytes yet — wait for the next chunk.
    NeedMore,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append `chunk` and return every message now complete, in stream order.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            match self.step() {
                Step::Message(body) => out.push(body),
                Step::Skipped => continue,
                Step::NeedMore => break,
            }
        }
        out
    }

    fn step(&mut self) -> Step {
        // Headers end at the first blank line. Until we have it, we can't know how
        // long the body is. (This is also why body bytes that happen to contain
        // `\r\n\r\n` are safe: the *first* occurrence is always the header break, and
        // once we've measured the body we index by length, not by re-scanning.)
        let Some(sep) = find(&self.buf, b"\r\n\r\n") else {
            return Step::NeedMore;
        };
        let body_start = sep + 4;

        let Some(len) = content_length(&self.buf[..sep]) else {
            // A header block with no usable Content-Length. A well-behaved server
            // never does this; drop the block and resync rather than spin on it.
            self.buf.drain(..body_start);
            return Step::Skipped;
        };

        if self.buf.len() < body_start + len {
            return Step::NeedMore; // body not fully arrived
        }

        let body = self.buf[body_start..body_start + len].to_vec();
        self.buf.drain(..body_start + len);
        // Bodies are UTF-8 JSON; be lossy rather than drop a message on a stray byte.
        Step::Message(String::from_utf8_lossy(&body).into_owned())
    }
}

/// The `Content-Length` value from a header block, case-insensitively.
fn content_length(headers: &[u8]) -> Option<usize> {
    let text = std::str::from_utf8(headers).ok()?;
    text.split("\r\n")
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
}

/// First index of `needle` in `haystack`, or `None`.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_frames_with_the_byte_length() {
        assert_eq!(encode("{}"), b"Content-Length: 2\r\n\r\n{}".to_vec());
        // Multibyte: "é" is 2 bytes, so the body "é" has length 2, not 1.
        assert_eq!(encode("é"), b"Content-Length: 2\r\n\r\n\xc3\xa9".to_vec());
    }

    #[test]
    fn decodes_a_single_message() {
        let mut d = FrameDecoder::new();
        assert_eq!(d.push(&encode("hello")), vec!["hello"]);
    }

    #[test]
    fn decodes_multiple_messages_in_one_chunk() {
        let mut d = FrameDecoder::new();
        let mut bytes = encode("first");
        bytes.extend(encode("second"));
        bytes.extend(encode("third"));
        assert_eq!(d.push(&bytes), vec!["first", "second", "third"]);
    }

    #[test]
    fn reassembles_a_message_split_across_chunks() {
        let bytes = encode(r#"{"jsonrpc":"2.0","id":1}"#);
        // Try EVERY split point: header mid-way, on the separator, mid-body.
        for split in 1..bytes.len() {
            let mut d = FrameDecoder::new();
            let first = d.push(&bytes[..split]);
            let second = d.push(&bytes[split..]);
            let all: Vec<String> = first.into_iter().chain(second).collect();
            assert_eq!(
                all,
                vec![r#"{"jsonrpc":"2.0","id":1}"#.to_string()],
                "split at {split} lost or duplicated the message"
            );
        }
    }

    /// Feed a whole stream of messages one byte at a time — the worst-case split —
    /// and get them all back, in order, exactly once.
    #[test]
    fn byte_by_byte_stream_reassembles_in_order() {
        let messages = ["a", "bb", "ccc", "{}", "café", "line1\r\nline2"];
        let mut stream = Vec::new();
        for m in messages {
            stream.extend(encode(m));
        }

        let mut d = FrameDecoder::new();
        let mut got: Vec<String> = Vec::new();
        for b in stream {
            got.extend(d.push(&[b]));
        }
        assert_eq!(got, messages);
    }

    #[test]
    fn handles_content_length_case_insensitively_and_extra_headers() {
        let mut d = FrameDecoder::new();
        let framed = b"content-length: 5\r\nContent-Type: application/vscode-jsonrpc\r\n\r\nhello";
        assert_eq!(d.push(framed), vec!["hello"]);
    }

    #[test]
    fn a_multibyte_body_uses_byte_length_not_char_count() {
        // "日本語" is 9 bytes / 3 chars. The frame declares 9; the decoder must take
        // 9 bytes, not 3.
        let mut d = FrameDecoder::new();
        assert_eq!(d.push(&encode("日本語")), vec!["日本語"]);
    }

    #[test]
    fn a_malformed_header_block_is_skipped_and_the_next_message_survives() {
        let mut d = FrameDecoder::new();
        // A header block with no Content-Length, then a valid message.
        let mut bytes = b"Garbage: nope\r\n\r\n".to_vec();
        bytes.extend(encode("recovered"));
        assert_eq!(d.push(&bytes), vec!["recovered"]);
    }

    #[test]
    fn incomplete_input_yields_nothing_until_complete() {
        let mut d = FrameDecoder::new();
        // Only headers, no body yet.
        assert!(d.push(b"Content-Length: 5\r\n\r\n").is_empty());
        assert!(d.push(b"hel").is_empty());
        assert_eq!(d.push(b"lo"), vec!["hello"]);
    }
}
