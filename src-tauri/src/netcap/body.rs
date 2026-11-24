//! Capturing a body while it streams through, and turning a capture into the UI's
//! [`FlowBody`]. The tee never buffers the stream: each frame is forwarded as it arrives and a
//! copy of at most [`BODY_CAP`](super::store::BODY_CAP) bytes is kept on the side.

use std::io::Read as _;
use std::pin::Pin;
use std::task::{Context, Poll};

use base64::Engine as _;
use bytes::Bytes;
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::HeaderMap;

use super::store::Captured;
use super::types::FlowBody;

/// What a finished (or abandoned) body reports.
pub struct TeeOutcome {
    pub captured: Captured,
    pub trailers: Option<HeaderMap>,
    /// `None` = the stream reached its end cleanly.
    pub error: Option<String>,
}

type OnDone = Box<dyn FnOnce(TeeOutcome) + Send>;

/// Forwards `inner` frame by frame, capturing data + trailers, and calls `on_done` exactly
/// once — at end of stream, on error, or when dropped early.
pub struct TeeBody {
    inner: Incoming,
    cap: usize,
    captured: Captured,
    trailers: Option<HeaderMap>,
    on_done: Option<OnDone>,
}

impl TeeBody {
    pub fn new(
        inner: Incoming,
        cap: usize,
        on_done: impl FnOnce(TeeOutcome) + Send + 'static,
    ) -> Self {
        TeeBody {
            inner,
            cap,
            captured: Captured::default(),
            trailers: None,
            on_done: Some(Box::new(on_done)),
        }
    }

    fn finish(&mut self, error: Option<String>) {
        if let Some(f) = self.on_done.take() {
            f(TeeOutcome {
                captured: std::mem::take(&mut self.captured),
                trailers: self.trailers.take(),
                error,
            });
        }
    }
}

impl Body for TeeBody {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    this.captured.push(data, this.cap);
                } else if let Some(t) = frame.trailers_ref() {
                    this.trailers = Some(t.clone());
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(e))) => {
                this.finish(Some(e.to_string()));
                Poll::Ready(Some(Err(e)))
            }
            Poll::Ready(None) => {
                this.finish(None);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for TeeBody {
    fn drop(&mut self) {
        // hyper never polls a body it knows is empty (HEAD, 204, 304), so "dropped at end of
        // stream" is a clean finish; anything else is a stream cut short.
        let err = (!self.inner.is_end_stream()).then(|| "stream closed early".to_string());
        self.finish(err);
    }
}

/// Decoded output cap: a 1 MiB gzip capture can inflate a lot; the UI needs a readable
/// prefix, not the whole bomb.
const DECODED_CAP: u64 = 4 << 20;

/// Undo a `content-encoding` (gzip / x-gzip / deflate / br). `None` = unknown encoding or
/// nothing decodable. A truncated capture decodes as far as it goes.
pub fn decode(encoding: &str, bytes: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let res = match encoding.trim().to_ascii_lowercase().as_str() {
        "gzip" | "x-gzip" => flate2::read::MultiGzDecoder::new(bytes)
            .take(DECODED_CAP)
            .read_to_end(&mut out),
        "deflate" => {
            // RFC 9110 says zlib-wrapped; some servers send raw deflate. Try both.
            let r = flate2::read::ZlibDecoder::new(bytes)
                .take(DECODED_CAP)
                .read_to_end(&mut out);
            if r.is_err() && out.is_empty() {
                flate2::read::DeflateDecoder::new(bytes)
                    .take(DECODED_CAP)
                    .read_to_end(&mut out)
            } else {
                r
            }
        }
        "br" => brotli::Decompressor::new(bytes, 4096)
            .take(DECODED_CAP)
            .read_to_end(&mut out),
        _ => return None,
    };
    match res {
        Ok(_) => Some(out),
        Err(_) if !out.is_empty() => Some(out),
        Err(_) => None,
    }
}

/// A capture as the UI's [`FlowBody`]: decoded when possible, `text` when UTF-8.
pub fn to_flow_body(c: &Captured, encoding: Option<&str>) -> FlowBody {
    let decoded = encoding
        .filter(|e| !e.eq_ignore_ascii_case("identity"))
        .and_then(|e| decode(e, &c.bytes));
    let bytes = decoded.as_deref().unwrap_or(&c.bytes);
    let (text, b64) = if bytes.is_empty() {
        (None, None)
    } else {
        match std::str::from_utf8(bytes) {
            Ok(s) => (Some(s.to_string()), None),
            // The cap cut valid text inside a character (`error_len() == None`: the only
            // fault is an unfinished char at the very end). That is our cut, not the
            // body's, so the UI gets the text up to it — not a base64 blob of a JSON reply
            // (found by `tests/netcap_robustness.rs`). An untruncated body that ends
            // mid-char really is malformed and stays base64.
            Err(e) if c.truncated && e.error_len().is_none() => (
                Some(String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned()),
                None,
            ),
            Err(_) => (
                None,
                Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            ),
        }
    };
    FlowBody {
        size: c.size,
        truncated: c.truncated,
        text,
        base64: b64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn cap(bytes: &[u8]) -> Captured {
        Captured {
            bytes: bytes.to_vec(),
            size: bytes.len() as u64,
            truncated: false,
        }
    }

    #[test]
    fn gzip_deflate_and_brotli_bodies_decode_to_text() {
        let plain = b"{\"hello\":\"world\"}";
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(plain).unwrap();
        let gz = gz.finish().unwrap();
        let mut zl = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        zl.write_all(plain).unwrap();
        let zl = zl.finish().unwrap();
        let mut br = Vec::new();
        {
            let mut w = brotli::CompressorWriter::new(&mut br, 4096, 5, 22);
            w.write_all(plain).unwrap();
        }
        for (enc, bytes) in [("gzip", &gz), ("deflate", &zl), ("br", &br)] {
            let body = to_flow_body(&cap(bytes), Some(enc));
            assert_eq!(body.text.as_deref(), Some("{\"hello\":\"world\"}"), "{enc}");
            assert_eq!(
                body.size,
                bytes.len() as u64,
                "size is the WIRE size ({enc})"
            );
        }
    }

    #[test]
    fn binary_is_base64_and_empty_is_neither() {
        let body = to_flow_body(&cap(&[0, 159, 146, 150]), None);
        assert_eq!(body.text, None);
        assert_eq!(body.base64.as_deref(), Some("AJ+Slg=="));
        let empty = to_flow_body(&cap(b""), None);
        assert_eq!((empty.text, empty.base64), (None, None));
    }

    #[test]
    fn an_undecodable_body_falls_back_to_the_raw_bytes() {
        let body = to_flow_body(&cap(b"not gzip"), Some("gzip"));
        assert_eq!(body.text.as_deref(), Some("not gzip"));
        let body = to_flow_body(&cap(b"zstd bytes"), Some("zstd"));
        assert_eq!(body.text.as_deref(), Some("zstd bytes"));
    }
}
