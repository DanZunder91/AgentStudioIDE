//! Rust-service fixture (docs/design/testing-strategy.md). reqwest + rustls + webpki-roots only, so
//! the IDE must tunnel it (`GAZELLE_EXTRA_ROOT` adds a test root, never the IDE's CA). Logs go to
//! stdout and to ./gazelle-like.log, kept open for writing: that is how the IDE finds it.

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct Logger {
    file: Option<std::fs::File>,
}

impl Logger {
    fn line(&mut self, level: &str, target: &str, msg: &str) {
        let line = format!("{} {level:>5} gazelle_like::{target}: {msg}\n", rfc3339_now());
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(line.as_bytes());
        let _ = out.flush();
        if let Some(f) = self.file.as_mut() {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
    }
}

type Log = Arc<Mutex<Logger>>;

fn log(l: &Log, level: &str, target: &str, msg: &str) {
    if let Ok(mut g) = l.lock() {
        g.line(level, target, msg);
    }
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC) without a date crate: days → civil date (H. Hinnant).
fn rfc3339_now() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        sod / 3600,
        (sod / 60) % 60,
        sod % 60,
        d.subsec_millis()
    )
}

struct Upstream {
    url: String,
    host: String,
    client: reqwest::blocking::Client,
}

struct Hit {
    status: u16,
    bytes: usize,
}

impl Upstream {
    fn new(url: String) -> Result<Self, String> {
        let host = reqwest::Url::parse(&url)
            .map_err(|e| format!("bad GAZELLE_UPSTREAM: {e}"))?
            .host_str()
            .unwrap_or("?")
            .to_string();
        // rustls + webpki-roots (the Cargo features); env proxies are honoured by default.
        let mut b = reqwest::blocking::Client::builder()
            .user_agent("gazelle-like/0.1")
            .timeout(Duration::from_secs(20))
            // One connection per call (no idle pool): each call is its own tunnel, which CLOSES and
            // shows its final bytes, instead of one pooled tunnel idling open for 90 s.
            .pool_max_idle_per_host(0);
        if let Ok(path) = std::env::var("GAZELLE_EXTRA_ROOT") {
            let pem = std::fs::read(&path).map_err(|e| format!("GAZELLE_EXTRA_ROOT: {e}"))?;
            let cert = reqwest::Certificate::from_pem(&pem).map_err(|e| format!("GAZELLE_EXTRA_ROOT: {e}"))?;
            b = b.add_root_certificate(cert);
        }
        let client = b.build().map_err(|e| format!("client: {e}"))?;
        Ok(Self { url, host, client })
    }

    fn call(&self) -> Result<Hit, String> {
        let r = self.client.get(&self.url).send().map_err(|e| chain(&e))?;
        let status = r.status().as_u16();
        let body = r.bytes().map_err(|e| chain(&e))?;
        Ok(Hit { status, bytes: body.len() })
    }
}

/// An error and its sources on one line — `UnknownIssuer` lives three levels down.
fn chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(c) = cur {
        s.push_str(": ");
        s.push_str(&c.to_string());
        cur = c.source();
    }
    s
}

fn call_logged(up: &Upstream, l: &Log, why: &str) -> Result<Hit, String> {
    let r = up.call();
    match &r {
        Ok(h) => log(l, "INFO", "upstream", &format!("{why}: GET {} {} ({} bytes)", up.host, h.status, h.bytes)),
        Err(e) => log(l, "ERROR", "upstream", &format!("{why}: GET {} failed: {e}", up.host)),
    }
    r
}

fn json(status: u16, v: serde_json::Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let ct = tiny_http::Header::from_bytes("Content-Type", "application/json").expect("static header");
    let svc = tiny_http::Header::from_bytes("X-Svc", "gazelle-like").expect("static header");
    tiny_http::Response::from_string(v.to_string())
        .with_status_code(status)
        .with_header(ct)
        .with_header(svc)
}

fn handle(req: tiny_http::Request, up: &Upstream, l: &Log) {
    let method = req.method().to_string();
    let raw = req.url().to_string();
    let (path, query) = raw.split_once('?').unwrap_or((raw.as_str(), ""));
    let (status, resp) = match (method.as_str(), path) {
        ("GET", "/health") => (200, json(200, serde_json::json!({ "status": "ok" }))),
        ("GET", "/shipping/rates") => {
            let zone = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("zone="))
                .unwrap_or("eu:1")
                .replace("%3A", ":")
                .replace("%3a", ":");
            match call_logged(up, l, "rates") {
                Ok(h) => (
                    200,
                    json(
                        200,
                        serde_json::json!({
                            "zone": zone,
                            "rates": { "low": "1.1", "mid": "2.4", "high": "5.0", "unit": "eur" },
                            "upstream": { "host": up.host, "status": h.status, "bytes": h.bytes }
                        }),
                    ),
                ),
                Err(e) => (502, json(502, serde_json::json!({ "error": "upstream failed", "why": e }))),
            }
        }
        _ => (404, json(404, serde_json::json!({ "error": "not found" }))),
    };
    let level = if status >= 500 { "ERROR" } else if status >= 400 { "WARN" } else { "INFO" };
    log(l, level, "http", &format!("{method} {raw} {status}"));
    let _ = req.respond(resp);
}

fn main() {
    let addr = std::env::var("GAZELLE_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let url = std::env::var("GAZELLE_UPSTREAM").unwrap_or_else(|_| "https://example.com/".into());
    let every = std::env::var("GAZELLE_UPSTREAM_EVERY_S")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(30)
        .max(1);
    let log_path = std::env::var("GAZELLE_LOG").unwrap_or_else(|_| "gazelle-like.log".into());
    let file = OpenOptions::new().create(true).append(true).open(&log_path).ok();
    let l: Log = Arc::new(Mutex::new(Logger { file }));

    let up = match Upstream::new(url) {
        Ok(u) => Arc::new(u),
        Err(e) => {
            log(&l, "ERROR", "main", &e);
            std::process::exit(2);
        }
    };
    let server = match tiny_http::Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            log(&l, "ERROR", "main", &format!("cannot listen on {addr}: {e}"));
            std::process::exit(2);
        }
    };
    log(&l, "INFO", "main", &format!("listening on http://{addr} (upstream {}, log {log_path})", up.host));

    {
        let (up, l) = (up.clone(), l.clone());
        std::thread::spawn(move || loop {
            let _ = call_logged(&up, &l, "tick");
            std::thread::sleep(Duration::from_secs(every));
        });
    }

    for req in server.incoming_requests() {
        let (up, l) = (up.clone(), l.clone());
        std::thread::spawn(move || handle(req, &up, &l));
    }
}
