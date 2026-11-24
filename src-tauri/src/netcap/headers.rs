//! How captured headers are stored: **verbatim**. Nothing
//! is hidden (this supersedes the original redact-at-capture rule). Every value,
//! `Authorization`, cookies and API keys included, is kept exactly as it crossed the proxy, in
//! wire order, so the detail view shows the real request and Copy as cURL replays it. The UI's
//! optional "Mask secrets" button hides credential values on screen only. Flows live in memory
//! only (the 5 000-flow ring); nothing here is ever written to disk.

use hyper::HeaderMap;

/// A header map as the ordered `[name, value]` pairs the UI shows — values unmodified. A value
/// that is not UTF-8 is shown lossily (U+FFFD); that is display, not hiding.
pub fn capture_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::{HeaderName, HeaderValue};

    #[test]
    fn credentials_are_captured_verbatim_and_in_wire_order() {
        let mut h = HeaderMap::new();
        for (k, v) in [
            ("authorization", "Bearer sk-live-4f9a"),
            ("x-api-key", "key_1234abcd"),
            ("cookie", "sid=abc; theme=dark"),
            ("x-csrf-token", "t0k3n"),
            ("accept", "*/*"),
        ] {
            h.append(
                HeaderName::from_static(k),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        assert_eq!(
            capture_headers(&h),
            vec![
                (
                    "authorization".to_string(),
                    "Bearer sk-live-4f9a".to_string()
                ),
                ("x-api-key".to_string(), "key_1234abcd".to_string()),
                ("cookie".to_string(), "sid=abc; theme=dark".to_string()),
                ("x-csrf-token".to_string(), "t0k3n".to_string()),
                ("accept".to_string(), "*/*".to_string()),
            ]
        );
    }

    #[test]
    fn repeated_headers_are_all_kept() {
        let mut h = HeaderMap::new();
        h.append("set-cookie", HeaderValue::from_static("a=1"));
        h.append("set-cookie", HeaderValue::from_static("b=2"));
        assert_eq!(
            capture_headers(&h),
            vec![
                ("set-cookie".to_string(), "a=1".to_string()),
                ("set-cookie".to_string(), "b=2".to_string()),
            ]
        );
    }

    #[test]
    fn a_non_utf8_value_is_shown_lossily_not_dropped() {
        let mut h = HeaderMap::new();
        h.append("x-bin", HeaderValue::from_bytes(b"ok\xffend").unwrap());
        assert_eq!(
            capture_headers(&h),
            vec![("x-bin".to_string(), "ok\u{fffd}end".to_string())]
        );
    }
}
