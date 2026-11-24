//! WebSocket frame boundaries, parsed only to COUNT data messages per direction (frame
//! capture is a follow-up). Streaming: bytes arrive in arbitrary chunks, so the
//! header is accumulated across calls and payloads are skipped without buffering.

#[derive(Debug, Default)]
pub struct FrameCounter {
    header: Vec<u8>,
    /// Payload bytes still to skip in the current frame.
    remaining: u64,
    pub messages: u64,
}

/// Header length once the first two bytes are known.
fn header_len(b0_b1: &[u8]) -> usize {
    let len7 = b0_b1[1] & 0x7f;
    let ext = match len7 {
        126 => 2,
        127 => 8,
        _ => 0,
    };
    let mask = if b0_b1[1] & 0x80 != 0 { 4 } else { 0 };
    2 + ext + mask
}

impl FrameCounter {
    /// Feed the next chunk of one direction's byte stream; returns how many data messages
    /// completed inside it. A message completes on a frame with FIN set and a non-control
    /// opcode (text, binary, or the final continuation); ping/pong/close are not messages.
    pub fn feed(&mut self, mut data: &[u8]) -> u64 {
        let before = self.messages;
        while !data.is_empty() {
            if self.remaining > 0 {
                let skip = (self.remaining.min(data.len() as u64)) as usize;
                self.remaining -= skip as u64;
                data = &data[skip..];
                continue;
            }
            // Accumulate the header.
            let need = if self.header.len() < 2 {
                2
            } else {
                header_len(&self.header)
            };
            let take = (need - self.header.len()).min(data.len());
            self.header.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.header.len() < 2 || self.header.len() < header_len(&self.header) {
                continue;
            }
            let h = std::mem::take(&mut self.header);
            let fin = h[0] & 0x80 != 0;
            let opcode = h[0] & 0x0f;
            let len = match h[1] & 0x7f {
                126 => u16::from_be_bytes([h[2], h[3]]) as u64,
                127 => u64::from_be_bytes(h[2..10].try_into().unwrap_or([0; 8])),
                n => n as u64,
            };
            if fin && opcode < 0x8 {
                self.messages += 1;
            }
            self.remaining = len;
        }
        self.messages - before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(fin: bool, opcode: u8, masked: bool, payload: &[u8]) -> Vec<u8> {
        let mut f = vec![(if fin { 0x80 } else { 0 }) | opcode];
        let m = if masked { 0x80 } else { 0 };
        match payload.len() {
            n if n < 126 => f.push(m | n as u8),
            n if n <= u16::MAX as usize => {
                f.push(m | 126);
                f.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                f.push(m | 127);
                f.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        if masked {
            f.extend_from_slice(&[1, 2, 3, 4]);
        }
        f.extend_from_slice(payload);
        f
    }

    #[test]
    fn counts_text_and_binary_but_not_control_frames() {
        let mut s = Vec::new();
        s.extend(frame(true, 0x1, true, b"hi"));
        s.extend(frame(true, 0x9, true, b"")); // ping
        s.extend(frame(true, 0x2, true, &[0; 300])); // 16-bit length
        s.extend(frame(true, 0xA, false, b"")); // pong
        s.extend(frame(true, 0x8, true, &[3, 232])); // close
        let mut c = FrameCounter::default();
        assert_eq!(c.feed(&s), 2);
    }

    #[test]
    fn a_fragmented_message_counts_once_on_its_final_frame() {
        let mut s = Vec::new();
        s.extend(frame(false, 0x1, false, b"he"));
        s.extend(frame(false, 0x0, false, b"ll"));
        s.extend(frame(true, 0x0, false, b"o"));
        let mut c = FrameCounter::default();
        assert_eq!(c.feed(&s), 1);
    }

    #[test]
    fn byte_at_a_time_gives_the_same_count_as_one_chunk() {
        let mut s = Vec::new();
        for i in 0..5 {
            s.extend(frame(true, 0x1, i % 2 == 0, &vec![b'x'; 130 * i]));
        }
        s.extend(frame(true, 0x2, false, &vec![0u8; 70_000])); // 64-bit length
        let mut whole = FrameCounter::default();
        assert_eq!(whole.feed(&s), 6);
        let mut drip = FrameCounter::default();
        let total: u64 = s.iter().map(|b| drip.feed(std::slice::from_ref(b))).sum();
        assert_eq!(total, 6);
        assert_eq!(drip.messages, 6);
    }
}
