//! Agent Village live weather (`village_weather`; wire `WeatherWire` in `villageTypes.ts`).
//! No location prompt: the IANA zone's principal city from the tz table; only coordinates
//! rounded to 2 decimals go to Open-Meteo. Cached [`FRESH_MS`]; stale fallback to [`STALE_MS`].

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};

/// A cached report is served without a fetch while younger than this.
pub const FRESH_MS: u64 = 10 * 60_000;
/// On a failed fetch, a cached report younger than this is still better than nothing.
pub const STALE_MS: u64 = 2 * 3_600_000;
/// Whole-request deadline for the Open-Meteo call.
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
/// Zones remembered at once — realistically one; the cap only bounds a misbehaving caller.
const CACHE_CAP: usize = 32;

/// The coded errors the frontend switches on.
pub const ERR_NO_LOCATION: &str = "no-location";
pub const ERR_OFFLINE: &str = "offline";
pub const ERR_BAD_RESPONSE: &str = "bad-response";

/// The system tz tables, newest format first.
const TZ_TABLES: [&str; 2] = [
    "/usr/share/zoneinfo/zone1970.tab",
    "/usr/share/zoneinfo/zone.tab",
];

/// `villageTypes.ts` `WeatherKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WeatherKind {
    Clear,
    Cloudy,
    Fog,
    Drizzle,
    Rain,
    Snow,
    Storm,
}

/// `villageTypes.ts` `WeatherWire` — field order and spelling are the contract
/// (`tests/contract_goldens/weather.rs` pins it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherWire {
    pub kind: WeatherKind,
    /// 0..1 — how heavy.
    pub intensity: f64,
    pub temperature_c: Option<f64>,
    /// Horizontal component of where the wind blows TO: -1 (left/west) .. 1 (right/east).
    pub wind: f64,
    pub sunrise_ms: Option<u64>,
    pub sunset_ms: Option<u64>,
    /// City-level place name, e.g. "Vancouver".
    pub place: String,
    pub fetched_at_ms: u64,
}

/// Where to ask about: a zone's principal city.
#[derive(Debug, Clone, PartialEq)]
pub struct Location {
    pub lat: f64,
    pub lon: f64,
    pub place: String,
}

// ───────────────────────────── location ─────────────────────────────

/// Common zones for when there is no system table (Windows) or it lacks the zone.
/// City coordinates, `(zone, lat, lon)`.
const FALLBACK_ZONES: &[(&str, f64, f64)] = &[
    ("America/New_York", 40.71, -74.01),
    ("America/Chicago", 41.85, -87.65),
    ("America/Denver", 39.74, -104.98),
    ("America/Phoenix", 33.45, -112.07),
    ("America/Los_Angeles", 34.05, -118.24),
    ("America/Anchorage", 61.22, -149.90),
    ("Pacific/Honolulu", 21.31, -157.86),
    ("America/Toronto", 43.65, -79.38),
    ("America/Vancouver", 49.26, -123.12),
    ("America/Mexico_City", 19.43, -99.13),
    ("America/Bogota", 4.60, -74.08),
    ("America/Lima", -12.05, -77.04),
    ("America/Caracas", 10.50, -66.93),
    ("America/Santiago", -33.45, -70.67),
    ("America/Argentina/Buenos_Aires", -34.60, -58.38),
    ("America/Sao_Paulo", -23.53, -46.62),
    ("Europe/London", 51.51, -0.13),
    ("Europe/Dublin", 53.33, -6.25),
    ("Europe/Lisbon", 38.72, -9.13),
    ("Europe/Madrid", 40.40, -3.68),
    ("Europe/Paris", 48.87, 2.33),
    ("Europe/Brussels", 50.83, 4.33),
    ("Europe/Amsterdam", 52.37, 4.90),
    ("Europe/Berlin", 52.50, 13.37),
    ("Europe/Zurich", 47.38, 8.53),
    ("Europe/Rome", 41.90, 12.48),
    ("Europe/Stockholm", 59.33, 18.05),
    ("Europe/Oslo", 59.91, 10.75),
    ("Europe/Warsaw", 52.25, 21.00),
    ("Europe/Athens", 37.97, 23.72),
    ("Europe/Istanbul", 41.02, 28.97),
    ("Europe/Kyiv", 50.43, 30.52),
    ("Europe/Kiev", 50.43, 30.52),
    ("Europe/Moscow", 55.76, 37.62),
    ("Africa/Cairo", 30.05, 31.25),
    ("Africa/Lagos", 6.45, 3.40),
    ("Africa/Nairobi", -1.28, 36.82),
    ("Africa/Johannesburg", -26.25, 28.00),
    ("Asia/Dubai", 25.30, 55.30),
    ("Asia/Karachi", 24.87, 67.05),
    ("Asia/Kolkata", 22.53, 88.37),
    ("Asia/Calcutta", 22.53, 88.37),
    ("Asia/Dhaka", 23.72, 90.42),
    ("Asia/Bangkok", 13.75, 100.52),
    ("Asia/Jakarta", -6.17, 106.80),
    ("Asia/Singapore", 1.28, 103.85),
    ("Asia/Hong_Kong", 22.28, 114.15),
    ("Asia/Shanghai", 31.23, 121.47),
    ("Asia/Taipei", 25.05, 121.50),
    ("Asia/Manila", 14.59, 120.97),
    ("Asia/Seoul", 37.55, 126.97),
    ("Asia/Tokyo", 35.65, 139.74),
    ("Australia/Perth", -31.95, 115.85),
    ("Australia/Brisbane", -27.47, 153.03),
    ("Australia/Sydney", -33.87, 151.21),
    ("Australia/Melbourne", -37.82, 144.97),
    ("Pacific/Auckland", -36.87, 174.77),
];

/// ICU's legacy canonical ids → today's IANA names. WKWebView's
/// `Intl.DateTimeFormat().resolvedOptions().timeZone` can still answer with these, but
/// `zone.tab` (and macOS ships no `zone1970.tab` nor `backward`) only lists the new names.
pub const ZONE_ALIASES: &[(&str, &str)] = &[
    ("America/Buenos_Aires", "America/Argentina/Buenos_Aires"),
    ("America/Catamarca", "America/Argentina/Catamarca"),
    ("America/Cordoba", "America/Argentina/Cordoba"),
    ("America/Jujuy", "America/Argentina/Jujuy"),
    ("America/Mendoza", "America/Argentina/Mendoza"),
    ("America/Indianapolis", "America/Indiana/Indianapolis"),
    ("America/Louisville", "America/Kentucky/Louisville"),
    ("America/Godthab", "America/Nuuk"),
    ("America/Montreal", "America/Toronto"),
    ("Atlantic/Faeroe", "Atlantic/Faroe"),
    ("Asia/Calcutta", "Asia/Kolkata"),
    ("Asia/Saigon", "Asia/Ho_Chi_Minh"),
    ("Asia/Katmandu", "Asia/Kathmandu"),
    ("Asia/Rangoon", "Asia/Yangon"),
    ("Asia/Dacca", "Asia/Dhaka"),
    ("Asia/Thimbu", "Asia/Thimphu"),
    ("Asia/Ulan_Bator", "Asia/Ulaanbaatar"),
    ("Asia/Macao", "Asia/Macau"),
    ("Asia/Ujung_Pandang", "Asia/Makassar"),
    ("Asia/Chongqing", "Asia/Shanghai"),
    ("Asia/Chungking", "Asia/Shanghai"),
    ("Asia/Harbin", "Asia/Shanghai"),
    ("Europe/Kiev", "Europe/Kyiv"),
    ("Pacific/Truk", "Pacific/Chuuk"),
    ("Pacific/Ponape", "Pacific/Pohnpei"),
    ("Pacific/Enderbury", "Pacific/Kanton"),
];

/// The current IANA name for a legacy alias; any other zone is returned as is.
pub fn canonical_zone(zone: &str) -> &str {
    ZONE_ALIASES
        .iter()
        .find(|(alias, _)| *alias == zone)
        .map_or(zone, |(_, canon)| canon)
}

/// A zone name worth looking up: `Area/City` shape, tz-database characters only. It is
/// never used as a path, but a garbage string should not even reach the tables.
pub fn valid_zone(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() <= 64
        && zone.contains('/')
        && !zone.starts_with('/')
        && !zone.ends_with('/')
        && !zone.contains("..")
        && !zone.contains("//")
        && zone
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'+' | b'/'))
}

/// `"America/Argentina/Buenos_Aires"` → `"Buenos Aires"`.
pub fn place_from_zone(zone: &str) -> String {
    zone.rsplit('/').next().unwrap_or(zone).replace('_', " ")
}

/// One ISO 6709 half: sign, then `whole` degree digits, then minutes, optional seconds.
fn iso6709_part(s: &str, whole: usize) -> Option<f64> {
    let (sign, digits) = match s.as_bytes().first()? {
        b'+' => (1.0, &s[1..]),
        b'-' => (-1.0, &s[1..]),
        _ => return None,
    };
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let num = |a: usize, b: usize| digits[a..b].parse::<f64>().ok();
    let secs = match digits.len().checked_sub(whole)? {
        2 => 0.0,
        4 => num(whole + 2, whole + 4)?,
        _ => return None,
    };
    let (deg, min) = (num(0, whole)?, num(whole, whole + 2)?);
    if min >= 60.0 || secs >= 60.0 {
        return None;
    }
    Some(sign * (deg + min / 60.0 + secs / 3600.0))
}

/// `"+3541+13946"` / `"+353916+1394441"` → `(lat, lon)`.
pub fn parse_iso6709(s: &str) -> Option<(f64, f64)> {
    let split = s
        .char_indices()
        .skip(1)
        .find(|(_, c)| matches!(c, '+' | '-'))?
        .0;
    let lat = iso6709_part(&s[..split], 2)?;
    let lon = iso6709_part(&s[split..], 3)?;
    (lat.abs() <= 90.0 && lon.abs() <= 180.0).then_some((lat, lon))
}

/// The zone's coordinates in one `zone.tab`/`zone1970.tab` text (tab-separated:
/// country code(s), coordinates, zone, comment; `#` lines are comments).
pub fn lookup_zone_tab(text: &str, zone: &str) -> Option<(f64, f64)> {
    text.lines().filter(|l| !l.starts_with('#')).find_map(|l| {
        let mut cols = l.split('\t');
        let (_cc, coords, name) = (cols.next()?, cols.next()?, cols.next()?);
        (name == zone).then(|| parse_iso6709(coords)).flatten()
    })
}

/// Zone → principal-city location: the given tables in order, then the embedded fallback, also
/// under the current name of a legacy alias ([`ZONE_ALIASES`]). `Err("no-location")` otherwise.
pub fn locate(zone: &str, tables: &[String]) -> Result<Location, String> {
    if !valid_zone(zone) {
        return Err(ERR_NO_LOCATION.into());
    }
    let find = |z: &str| {
        tables
            .iter()
            .find_map(|t| lookup_zone_tab(t, z))
            .or_else(|| {
                FALLBACK_ZONES
                    .iter()
                    .find(|(f, _, _)| *f == z)
                    .map(|(_, lat, lon)| (*lat, *lon))
            })
    };
    let canon = canonical_zone(zone);
    find(zone)
        .map(|c| (c, zone))
        .or_else(|| find(canon).map(|c| (c, canon)))
        .map(|((lat, lon), named)| Location {
            lat,
            lon,
            place: place_from_zone(named),
        })
        .ok_or_else(|| ERR_NO_LOCATION.into())
}

/// The system tz tables that exist on this machine (none on Windows).
fn system_tables() -> Vec<String> {
    TZ_TABLES
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .collect()
}

/// [`system_tables`], read once per process: the command is async and polled, so the
/// steady state must not do blocking file I/O on a runtime worker.
static TABLES: LazyLock<Vec<String>> = LazyLock::new(system_tables);

// ───────────────────────────── Open-Meteo ─────────────────────────────

/// The forecast URL for a location — coordinates rounded to 2 decimals (~1 km; the city
/// point is all we have anyway).
pub fn forecast_url(loc: &Location) -> String {
    format!(
        "https://api.open-meteo.com/v1/forecast?latitude={:.2}&longitude={:.2}\
         &current=temperature_2m,precipitation,rain,showers,snowfall,weather_code,cloud_cover,\
         wind_speed_10m,wind_direction_10m,is_day&daily=sunrise,sunset&timezone=auto\
         &forecast_days=1&timeformat=unixtime",
        loc.lat, loc.lon
    )
}

#[derive(Deserialize)]
struct Forecast {
    current: Option<Current>,
    daily: Option<Daily>,
}

#[derive(Deserialize)]
struct Current {
    /// Seconds the `precipitation`/`snowfall` amounts are summed over (Open-Meteo's
    /// `current` block is 15-minutely data: 900).
    interval: Option<f64>,
    temperature_2m: Option<f64>,
    precipitation: Option<f64>,
    snowfall: Option<f64>,
    weather_code: Option<i64>,
    cloud_cover: Option<f64>,
    wind_speed_10m: Option<f64>,
    wind_direction_10m: Option<f64>,
}

#[derive(Deserialize)]
struct Daily {
    #[serde(default)]
    sunrise: Vec<Option<i64>>,
    #[serde(default)]
    sunset: Vec<Option<i64>>,
}

/// WMO weather interpretation code → [`WeatherKind`]. Codes outside the table (the
/// "present weather" range Open-Meteo does not emit) read as cloudy.
pub fn wmo_kind(code: i64) -> WeatherKind {
    match code {
        0 | 1 => WeatherKind::Clear,
        45 | 48 => WeatherKind::Fog,
        51..=57 => WeatherKind::Drizzle,
        61..=67 | 80..=82 => WeatherKind::Rain,
        71..=77 | 85 | 86 => WeatherKind::Snow,
        95..=99 => WeatherKind::Storm,
        _ => WeatherKind::Cloudy,
    }
}

/// Piecewise-linear through `points` (ascending x), clamped at both ends.
fn ramp(x: f64, points: &[(f64, f64)]) -> f64 {
    let (first, last) = (points[0], points[points.len() - 1]);
    if x <= first.0 {
        return first.1;
    }
    for w in points.windows(2) {
        let ((x0, y0), (x1, y1)) = (w[0], w[1]);
        if x <= x1 {
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        }
    }
    last.1
}

/// Rain-family intensity from mm/h: 0.5 → 0.3, 4 → 0.8, ≥ 8 → 1 (a falling code with
/// no measured rate still shows a light shower).
const RAIN_RAMP: &[(f64, f64)] = &[(0.0, 0.2), (0.5, 0.3), (4.0, 0.8), (8.0, 1.0)];
/// Snow intensity from cm/h: 0.2 → 0.3, 1 → 0.7, ≥ 2 → 1.
const SNOW_RAMP: &[(f64, f64)] = &[(0.0, 0.2), (0.2, 0.3), (1.0, 0.7), (2.0, 1.0)];

/// 0..1 heaviness for `kind`. `None`/NaN inputs read as 0.
pub fn intensity(
    kind: WeatherKind,
    precipitation: Option<f64>,
    snowfall: Option<f64>,
    cloud_cover: Option<f64>,
) -> f64 {
    let v = |o: Option<f64>| o.filter(|x| x.is_finite()).unwrap_or(0.0).max(0.0);
    let cloud = (v(cloud_cover) / 100.0).min(1.0);
    let raw = match kind {
        WeatherKind::Clear => 0.0,
        WeatherKind::Cloudy => cloud,
        WeatherKind::Fog => cloud.max(0.5),
        WeatherKind::Drizzle | WeatherKind::Rain => ramp(v(precipitation), RAIN_RAMP),
        WeatherKind::Storm => ramp(v(precipitation), RAIN_RAMP).max(0.6),
        // Open-Meteo reports snowfall in cm; when only the water equivalent is given,
        // ~1 mm water ≈ 0.7 cm snow.
        WeatherKind::Snow => ramp(v(snowfall).max(v(precipitation) * 0.7), SNOW_RAMP),
    };
    // Three decimals: float dust (0.6199999…) is noise on the wire.
    (raw.clamp(0.0, 1.0) * 1000.0).round() / 1000.0
}

/// Horizontal wind for the renderer: `wind_direction_10m` is where the wind comes FROM
/// (meteorological, 0° = north, 90° = east), so a west wind (270°) blows toward the east
/// = right = positive. Full strength at 40 km/h. 0 when either half is unknown.
pub fn wind_component(speed_kmh: Option<f64>, from_deg: Option<f64>) -> f64 {
    match (speed_kmh, from_deg) {
        (Some(s), Some(d)) if s.is_finite() && d.is_finite() => {
            let w = -d.to_radians().sin() * (s.max(0.0) / 40.0).min(1.0);
            // Round away float dust (sin(180°) ≈ 1.2e-16) so "calm" serialises as 0.
            (w * 1000.0).round() / 1000.0 + 0.0
        }
        _ => 0.0,
    }
}

/// Open-Meteo's `current` interval when the body has none (or a nonsense one): 15 min.
const DEFAULT_INTERVAL_S: f64 = 900.0;

/// Factor turning an amount summed over `interval` seconds into a per-hour rate.
pub fn per_hour(interval: Option<f64>) -> f64 {
    let s = interval
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(DEFAULT_INTERVAL_S);
    3600.0 / s
}

/// An Open-Meteo forecast body → the wire report. `Err("bad-response")` when it is not
/// JSON of that shape or carries no current weather code.
pub fn parse_forecast(body: &str, place: &str, now_ms: u64) -> Result<WeatherWire, String> {
    let f: Forecast = serde_json::from_str(body).map_err(|_| ERR_BAD_RESPONSE.to_string())?;
    let cur = f.current.ok_or(ERR_BAD_RESPONSE)?;
    let kind = wmo_kind(cur.weather_code.ok_or(ERR_BAD_RESPONSE)?);
    let first_ms = |v: Option<&Vec<Option<i64>>>| {
        v.and_then(|v| v.first().copied().flatten())
            .filter(|s| *s > 0)
            .map(|s| s as u64 * 1000)
    };
    // `current` amounts are totals over the last `interval` seconds; the ramps are per hour.
    let k = per_hour(cur.interval);
    Ok(WeatherWire {
        kind,
        intensity: intensity(
            kind,
            cur.precipitation.map(|p| p * k),
            cur.snowfall.map(|s| s * k),
            cur.cloud_cover,
        ),
        temperature_c: cur.temperature_2m.filter(|t| t.is_finite()),
        wind: wind_component(cur.wind_speed_10m, cur.wind_direction_10m),
        sunrise_ms: first_ms(f.daily.as_ref().map(|d| &d.sunrise)),
        sunset_ms: first_ms(f.daily.as_ref().map(|d| &d.sunset)),
        place: place.to_string(),
        fetched_at_ms: now_ms,
    })
}

// ───────────────────────────── cache ─────────────────────────────

/// Last good report per zone. The clock is always passed in.
#[derive(Default)]
pub struct WeatherCache {
    entries: Mutex<HashMap<String, WeatherWire>>,
}

impl WeatherCache {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, WeatherWire>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The cached report while younger than [`FRESH_MS`].
    pub fn fresh(&self, zone: &str, now_ms: u64) -> Option<WeatherWire> {
        self.map()
            .get(zone)
            .filter(|w| now_ms.saturating_sub(w.fetched_at_ms) < FRESH_MS)
            .cloned()
    }

    /// Store a good fetch, or fall back on a failed one: a cached report younger than
    /// [`STALE_MS`] beats the error.
    pub fn settle(
        &self,
        zone: &str,
        now_ms: u64,
        fetched: Result<WeatherWire, String>,
    ) -> Result<WeatherWire, String> {
        let mut map = self.map();
        match fetched {
            Ok(w) => {
                if map.len() >= CACHE_CAP && !map.contains_key(zone) {
                    map.clear();
                }
                map.insert(zone.to_string(), w.clone());
                Ok(w)
            }
            Err(e) => map
                .get(zone)
                .filter(|w| now_ms.saturating_sub(w.fetched_at_ms) < STALE_MS)
                .cloned()
                .ok_or(e),
        }
    }
}

static CACHE: LazyLock<WeatherCache> = LazyLock::new(WeatherCache::default);

/// Module-local client: rustls via the app's one crypto provider, https only,
/// no redirects, 8 s deadline. Built once so the pool (and its warm connection) survives
/// between polls (a `reqwest::Client` IS the connection pool).
static CLIENT: LazyLock<Result<Client, String>> = LazyLock::new(|| {
    crate::tls::install_crypto_provider();
    Client::builder()
        .timeout(FETCH_TIMEOUT)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))
});

/// A non-2xx status → `"http-<status>"`.
pub fn http_error(status: u16) -> String {
    format!("http-{status}")
}

/// GET the forecast body. Transport failures (no route, DNS, timeout, TLS) are `"offline"`.
async fn fetch_body(url: &str) -> Result<String, String> {
    let client = CLIENT.as_ref().map_err(|_| ERR_OFFLINE.to_string())?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|_| ERR_OFFLINE.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(http_error(status.as_u16()));
    }
    resp.text().await.map_err(|_| ERR_OFFLINE.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The real weather where the user's time zone says they are. See the module doc for
/// what leaves the machine and the error codes.
#[tauri::command]
pub async fn village_weather(time_zone: String) -> Result<WeatherWire, String> {
    let loc = locate(&time_zone, &TABLES)?;
    let now = now_ms();
    if let Some(w) = CACHE.fresh(&time_zone, now) {
        return Ok(w);
    }
    let fetched = match fetch_body(&forecast_url(&loc)).await {
        Ok(body) => parse_forecast(&body, &loc.place, now),
        Err(e) => Err(e),
    };
    CACHE.settle(&time_zone, now_ms(), fetched)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAIN_VANCOUVER: &str = include_str!("../tests/fixtures/weather/rain_vancouver.json");
    const CLEAR_MADRID: &str = include_str!("../tests/fixtures/weather/clear_madrid.json");
    const SNOW_OSLO: &str = include_str!("../tests/fixtures/weather/snow_oslo.json");
    const STORM_MIAMI: &str = include_str!("../tests/fixtures/weather/storm_miami.json");
    const FOG_LONDON: &str = include_str!("../tests/fixtures/weather/fog_london.json");
    const PARTIAL: &str = include_str!("../tests/fixtures/weather/partial.json");

    const T: u64 = 1_790_251_200_000;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-3
    }

    // ── location ──

    #[test]
    fn iso6709_minutes_and_seconds_forms() {
        let (lat, lon) = parse_iso6709("+3541+13946").unwrap();
        assert!(close(lat, 35.0 + 41.0 / 60.0) && close(lon, 139.0 + 46.0 / 60.0));
        let (lat, lon) = parse_iso6709("+404251-0740023").unwrap();
        assert!(
            close(lat, 40.714_17) && close(lon, -74.006_39),
            "{lat} {lon}"
        );
        let (lat, lon) = parse_iso6709("-3352+15113").unwrap();
        assert!(lat < 0.0 && lon > 0.0);
    }

    #[test]
    fn iso6709_rejects_malformed() {
        for bad in [
            "",
            "+",
            "3541+13946",
            "+3541",
            "+35x1+13946",
            "+354+13946",
            "+3541+1394",
            "+3561+13946",
            "+354161+1394441",
            "+9541+13946",
            "+3541+19946",
            "+3541*13946",
            "+3+13946",
            "+3541+13",
        ] {
            assert_eq!(parse_iso6709(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn zone_tab_lookup_skips_comments_and_short_lines() {
        let tab = "# comment\tAsia/Tokyo\nshort\nJP\t+353916+1394441\tAsia/Tokyo\n\
                   US\t+404251-0740023\tAmerica/New_York\tEastern\nXX\tgarbage\tEtc/Bad\n";
        let (lat, _) = lookup_zone_tab(tab, "Asia/Tokyo").unwrap();
        assert!(close(lat, 35.0 + 39.0 / 60.0 + 16.0 / 3600.0));
        assert!(lookup_zone_tab(tab, "America/New_York").is_some());
        assert_eq!(lookup_zone_tab(tab, "Etc/Bad"), None);
        assert_eq!(lookup_zone_tab(tab, "Europe/Nowhere"), None);
    }

    #[test]
    fn valid_zone_shape() {
        for ok in [
            "Asia/Tokyo",
            "America/Argentina/Buenos_Aires",
            "Etc/GMT+5",
            "America/Port-au-Prince",
        ] {
            assert!(valid_zone(ok), "{ok}");
        }
        let long = format!("Europe/{}", "a".repeat(60));
        for bad in [
            "",
            "UTC",
            "/Asia/Tokyo",
            "Asia/",
            "Asia/../etc",
            "Asia//Tokyo",
            "Asia/To kyo",
            "Asia/Tōkyō",
            long.as_str(),
        ] {
            assert!(!valid_zone(bad), "{bad}");
        }
    }

    #[test]
    fn place_is_the_city_part() {
        assert_eq!(place_from_zone("Asia/Tokyo"), "Tokyo");
        assert_eq!(place_from_zone("America/New_York"), "New York");
        assert_eq!(
            place_from_zone("America/Argentina/Buenos_Aires"),
            "Buenos Aires"
        );
    }

    #[test]
    fn locate_prefers_the_system_table_then_the_fallback() {
        let tab = "JP\t+3000+13000\tAsia/Tokyo\n".to_string();
        let l = locate("Asia/Tokyo", &[tab]).unwrap();
        assert_eq!((l.lat, l.lon, l.place.as_str()), (30.0, 130.0, "Tokyo"));
        // No tables (Windows) → embedded city coordinates.
        let l = locate("Europe/Madrid", &[]).unwrap();
        assert_eq!((l.lat, l.lon, l.place.as_str()), (40.40, -3.68, "Madrid"));
        // Table without the zone → still the fallback.
        assert!(locate("Asia/Tokyo", &["#only a comment".to_string()]).is_ok());
        assert_eq!(locate("UTC", &[]), Err("no-location".into()));
        assert_eq!(locate("Mars/Olympus_Mons", &[]), Err("no-location".into()));
    }

    #[test]
    fn legacy_icu_zone_ids_resolve_through_their_current_name() {
        let tab = "AR\t-3436-05827\tAmerica/Argentina/Buenos_Aires\n".to_string();
        let l = locate("America/Buenos_Aires", &[tab]).unwrap();
        assert!(close(l.lat, -34.6) && close(l.lon, -58.45));
        assert_eq!(l.place, "Buenos Aires");
        // Only in the embedded table under its current name.
        let l = locate("America/Buenos_Aires", &[]).unwrap();
        assert_eq!((l.lat, l.lon), (-34.60, -58.38));
        // The place comes from the current name.
        let tab = "VN\t+1045+10640\tAsia/Ho_Chi_Minh\n".to_string();
        assert_eq!(locate("Asia/Saigon", &[tab]).unwrap().place, "Ho Chi Minh");
        // A zone listed under its own (old) name keeps it.
        let tab = "IN\t+2232+08822\tAsia/Calcutta\n".to_string();
        assert_eq!(locate("Asia/Calcutta", &[tab]).unwrap().place, "Calcutta");
        // Not an alias, not known → still no-location.
        assert_eq!(canonical_zone("Asia/Tokyo"), "Asia/Tokyo");
        assert_eq!(locate("Asia/Nowhere", &[]), Err("no-location".into()));
    }

    #[test]
    fn every_alias_resolves_against_the_real_system_table_when_present() {
        for (alias, canon) in ZONE_ALIASES {
            assert!(valid_zone(alias) && valid_zone(canon), "{alias}");
            assert_ne!(alias, canon);
            assert_eq!(canonical_zone(alias), *canon);
        }
        if !TABLES.is_empty() {
            for (alias, canon) in ZONE_ALIASES {
                let l = locate(alias, &TABLES).unwrap_or_else(|e| panic!("{alias}: {e}"));
                assert!(l.lat.abs() <= 90.0 && l.lon.abs() <= 180.0, "{alias}");
                assert!(
                    TABLES.iter().any(|t| lookup_zone_tab(t, canon).is_some()),
                    "{canon} in the system table"
                );
            }
        }
    }

    #[test]
    fn every_fallback_zone_is_valid_and_sane() {
        for (z, lat, lon) in FALLBACK_ZONES {
            assert!(
                valid_zone(z) && lat.abs() <= 90.0 && lon.abs() <= 180.0,
                "{z}"
            );
        }
        assert!(FALLBACK_ZONES.len() >= 40);
    }

    #[test]
    fn the_real_system_table_knows_tokyo_when_present() {
        let tables = system_tables();
        if !tables.is_empty() {
            let (lat, lon) = tables
                .iter()
                .find_map(|t| lookup_zone_tab(t, "Asia/Tokyo"))
                .expect("Tokyo in the system tz table");
            assert!((35.0..36.0).contains(&lat) && (139.0..140.0).contains(&lon));
        }
    }

    #[test]
    fn url_carries_only_rounded_coordinates_over_https() {
        let u = forecast_url(&Location {
            lat: 35.653_456,
            lon: -139.744_1,
            place: "X".into(),
        });
        assert!(
            u.starts_with(
                "https://api.open-meteo.com/v1/forecast?latitude=35.65&longitude=-139.74&"
            ),
            "{u}"
        );
        assert!(u.contains("current=temperature_2m,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day"));
        assert!(
            u.ends_with("&daily=sunrise,sunset&timezone=auto&forecast_days=1&timeformat=unixtime")
        );
        assert!(!u.contains(' ') && !u.contains('X'));
    }

    // ── mapping ──

    #[test]
    fn wmo_codes_map_to_kinds() {
        use WeatherKind::*;
        let cases = [
            (0, Clear),
            (1, Clear),
            (2, Cloudy),
            (3, Cloudy),
            (45, Fog),
            (48, Fog),
            (51, Drizzle),
            (57, Drizzle),
            (61, Rain),
            (67, Rain),
            (80, Rain),
            (82, Rain),
            (71, Snow),
            (77, Snow),
            (85, Snow),
            (86, Snow),
            (95, Storm),
            (99, Storm),
            (4, Cloudy),
            (-1, Cloudy),
            (100, Cloudy),
        ];
        for (code, kind) in cases {
            assert_eq!(wmo_kind(code), kind, "{code}");
        }
    }

    #[test]
    fn intensity_follows_the_ramps() {
        use WeatherKind::*;
        assert!(close(intensity(Rain, Some(0.5), None, None), 0.3));
        assert!(close(intensity(Rain, Some(4.0), None, None), 0.8));
        assert!(close(intensity(Rain, Some(8.0), None, None), 1.0));
        assert!(close(intensity(Rain, Some(50.0), None, None), 1.0));
        assert!(close(intensity(Rain, Some(2.25), None, None), 0.55));
        assert!(close(intensity(Drizzle, None, None, None), 0.2));
        assert!(close(intensity(Rain, Some(f64::NAN), None, None), 0.2));
        assert!(close(intensity(Rain, Some(-3.0), None, None), 0.2));
        assert!(close(intensity(Storm, Some(0.0), None, None), 0.6));
        assert!(close(intensity(Storm, Some(9.0), None, None), 1.0));
        assert!(close(intensity(Snow, None, Some(1.0), None), 0.7));
        assert!(close(intensity(Snow, None, Some(5.0), None), 1.0));
        assert!(close(intensity(Snow, Some(1.0), Some(0.0), None), 0.55));
        assert!(close(intensity(Cloudy, None, None, Some(80.0)), 0.8));
        assert!(close(intensity(Cloudy, None, None, Some(250.0)), 1.0));
        assert!(close(intensity(Fog, None, None, Some(10.0)), 0.5));
        assert!(close(intensity(Fog, None, None, Some(90.0)), 0.9));
        assert_eq!(intensity(Clear, Some(9.0), Some(9.0), Some(100.0)), 0.0);
    }

    #[test]
    fn wind_blows_the_way_it_goes() {
        // From the west (270°) → blows east → right → positive.
        assert!(close(wind_component(Some(40.0), Some(270.0)), 1.0));
        assert!(close(wind_component(Some(20.0), Some(90.0)), -0.5));
        assert!(close(wind_component(Some(80.0), Some(225.0)), 0.707));
        // North/south winds have no horizontal component, and serialise as plain 0.
        assert_eq!(wind_component(Some(30.0), Some(180.0)).to_string(), "0");
        assert_eq!(wind_component(Some(30.0), Some(0.0)).to_string(), "0");
        assert_eq!(wind_component(Some(-5.0), Some(270.0)), 0.0);
        assert_eq!(wind_component(None, Some(270.0)), 0.0);
        assert_eq!(wind_component(Some(10.0), None), 0.0);
        assert_eq!(wind_component(Some(f64::NAN), Some(270.0)), 0.0);
    }

    // ── parse ──

    #[test]
    fn current_amounts_are_scaled_from_their_interval_to_per_hour() {
        assert_eq!(per_hour(Some(900.0)), 4.0);
        assert_eq!(per_hour(Some(3600.0)), 1.0);
        for bad in [
            None,
            Some(0.0),
            Some(-60.0),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            assert_eq!(per_hour(bad), 4.0, "{bad:?}");
        }
        let body = |interval: &str| {
            format!(
                r#"{{"current":{{{interval}"weather_code":63,"precipitation":1.0,"snowfall":0.0}}}}"#
            )
        };
        // 1 mm in 15 min is moderate rain (4 mm/h → 0.8); 1 mm in an hour is light.
        let quarter = parse_forecast(&body(r#""interval":900,"#), "X", T).unwrap();
        let hour = parse_forecast(&body(r#""interval":3600,"#), "X", T).unwrap();
        let unknown = parse_forecast(&body(""), "X", T).unwrap();
        assert!(close(quarter.intensity, 0.8), "{}", quarter.intensity);
        assert!(close(hour.intensity, 0.371), "{}", hour.intensity);
        assert_eq!(unknown.intensity, quarter.intensity);
        // Snow too: 0.25 cm in 15 min = 1 cm/h → 0.7.
        let snow = r#"{"current":{"interval":900,"weather_code":73,"snowfall":0.25}}"#;
        assert!(close(parse_forecast(snow, "X", T).unwrap().intensity, 0.7));
    }

    #[test]
    fn rain_in_vancouver() {
        let w = parse_forecast(RAIN_VANCOUVER, "Vancouver", T).unwrap();
        assert_eq!(w.kind, WeatherKind::Rain);
        assert_eq!(w.intensity, 0.686);
        assert_eq!(w.temperature_c, Some(12.0));
        assert!(w.wind > 0.2, "SW wind blows to the right: {}", w.wind);
        assert_eq!(w.sunrise_ms, Some(1_790_258_400_000));
        assert_eq!(w.sunset_ms, Some(1_790_301_600_000));
        assert_eq!((w.place.as_str(), w.fetched_at_ms), ("Vancouver", T));
    }

    #[test]
    fn the_other_fixtures() {
        let w = parse_forecast(CLEAR_MADRID, "Madrid", T).unwrap();
        assert_eq!((w.kind, w.intensity), (WeatherKind::Clear, 0.0));
        assert!(w.wind < 0.0, "east wind blows left");
        let w = parse_forecast(SNOW_OSLO, "Oslo", T).unwrap();
        assert_eq!(w.kind, WeatherKind::Snow);
        assert!(w.temperature_c.unwrap() < 0.0 && w.intensity > 0.5);
        let w = parse_forecast(STORM_MIAMI, "New York", T).unwrap();
        assert_eq!(
            (w.kind, w.intensity, w.wind),
            (WeatherKind::Storm, 1.0, 1.0)
        );
        let w = parse_forecast(FOG_LONDON, "London", T).unwrap();
        assert_eq!((w.kind, w.intensity, w.wind), (WeatherKind::Fog, 1.0, 0.0));
    }

    #[test]
    fn missing_fields_are_null_not_errors() {
        let w = parse_forecast(PARTIAL, "Sydney", T).unwrap();
        assert_eq!(w.kind, WeatherKind::Drizzle);
        assert_eq!(
            (w.temperature_c, w.wind, w.sunrise_ms, w.sunset_ms),
            (None, 0.0, None, None)
        );
        // Empty / null / non-positive daily arrays.
        let body = r#"{"current":{"weather_code":2,"cloud_cover":40},"daily":{"sunrise":[],"sunset":[null]}}"#;
        let w = parse_forecast(body, "X", T).unwrap();
        assert_eq!(
            (w.kind, w.sunrise_ms, w.sunset_ms),
            (WeatherKind::Cloudy, None, None)
        );
        assert!(close(w.intensity, 0.4));
        let body = r#"{"current":{"weather_code":0},"daily":{"sunrise":[0]}}"#;
        assert_eq!(parse_forecast(body, "X", T).unwrap().sunrise_ms, None);
    }

    #[test]
    fn bad_bodies_are_bad_response() {
        for body in [
            "",
            "not json",
            "[]",
            r#"{"daily":{}}"#,
            r#"{"current":{}}"#,
            r#"{"current":{"weather_code":"x"}}"#,
        ] {
            assert_eq!(
                parse_forecast(body, "X", T),
                Err("bad-response".into()),
                "{body}"
            );
        }
    }

    #[test]
    fn the_wire_is_camel_case_with_lowercase_kinds() {
        let w = parse_forecast(RAIN_VANCOUVER, "Vancouver", T).unwrap();
        let v = serde_json::to_value(&w).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        let mut want = vec![
            "kind",
            "intensity",
            "temperatureC",
            "wind",
            "sunriseMs",
            "sunsetMs",
            "place",
            "fetchedAtMs",
        ];
        want.sort_unstable();
        let mut keys = keys;
        keys.sort_unstable();
        assert_eq!(keys, want);
        assert_eq!(v["kind"], "rain");
        let back: WeatherWire = serde_json::from_value(v).unwrap();
        assert_eq!(back, w);
        for (k, s) in [
            (WeatherKind::Drizzle, "\"drizzle\""),
            (WeatherKind::Storm, "\"storm\""),
        ] {
            assert_eq!(serde_json::to_string(&k).unwrap(), s);
        }
    }

    #[test]
    fn http_errors_are_coded() {
        assert_eq!(http_error(503), "http-503");
    }

    // ── cache ──

    fn report(at: u64) -> WeatherWire {
        let mut w = parse_forecast(RAIN_VANCOUVER, "Vancouver", at).unwrap();
        w.fetched_at_ms = at;
        w
    }

    #[test]
    fn fresh_for_ten_minutes() {
        let c = WeatherCache::default();
        assert_eq!(c.fresh("America/Vancouver", T), None);
        assert_eq!(
            c.settle("America/Vancouver", T, Ok(report(T))),
            Ok(report(T))
        );
        assert_eq!(
            c.fresh("America/Vancouver", T + FRESH_MS - 1),
            Some(report(T))
        );
        assert_eq!(c.fresh("America/Vancouver", T + FRESH_MS), None);
        assert_eq!(c.fresh("Europe/Madrid", T), None);
        // A clock that went backwards still serves it.
        assert_eq!(c.fresh("America/Vancouver", T - 5), Some(report(T)));
    }

    #[test]
    fn a_failed_fetch_falls_back_to_a_report_under_two_hours_old() {
        let c = WeatherCache::default();
        assert_eq!(
            c.settle("America/Vancouver", T, Err("offline".into())),
            Err("offline".into())
        );
        c.settle("America/Vancouver", T, Ok(report(T))).unwrap();
        assert_eq!(
            c.settle(
                "America/Vancouver",
                T + STALE_MS - 1,
                Err("http-500".into())
            ),
            Ok(report(T))
        );
        assert_eq!(
            c.settle("America/Vancouver", T + STALE_MS, Err("http-500".into())),
            Err("http-500".into())
        );
        // A newer good fetch replaces it.
        let later = T + STALE_MS + 1;
        assert_eq!(
            c.settle("America/Vancouver", later, Ok(report(later)))
                .unwrap()
                .fetched_at_ms,
            later
        );
        assert_eq!(c.fresh("America/Vancouver", later), Some(report(later)));
    }

    #[test]
    fn the_cache_is_bounded() {
        let c = WeatherCache::default();
        for i in 0..CACHE_CAP {
            c.settle(&format!("Zone/N{i}"), T, Ok(report(T))).unwrap();
        }
        // Re-storing a known zone at the cap keeps the others.
        c.settle("Zone/N0", T, Ok(report(T))).unwrap();
        assert!(c.fresh("Zone/N1", T).is_some());
        // A new one past the cap starts over.
        c.settle("Zone/New", T, Ok(report(T))).unwrap();
        assert!(c.fresh("Zone/N1", T).is_none() && c.fresh("Zone/New", T).is_some());
        assert_eq!(c.map().len(), 1);
    }

    #[test]
    fn a_poisoned_cache_still_serves() {
        let c = std::sync::Arc::new(WeatherCache::default());
        c.settle("America/Vancouver", T, Ok(report(T))).unwrap();
        let c2 = c.clone();
        let _ = std::thread::spawn(move || {
            let _g = c2.entries.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert_eq!(c.fresh("America/Vancouver", T), Some(report(T)));
    }

    // ── the command, hermetic paths ──

    #[tokio::test]
    async fn unknown_zone_is_no_location_without_touching_the_network() {
        assert_eq!(
            village_weather("UTC".into()).await,
            Err("no-location".into())
        );
        assert_eq!(
            village_weather("Mars/Olympus_Mons".into()).await,
            Err("no-location".into())
        );
    }

    #[tokio::test]
    async fn a_plain_http_url_is_refused_and_unreachable_hosts_are_offline() {
        // https_only: the client refuses plain http before dialling.
        assert_eq!(
            fetch_body("http://127.0.0.1:9/").await,
            Err("offline".into())
        );
        // Port 9 (discard) on loopback: nothing listens → connection refused → offline.
        assert_eq!(
            fetch_body("https://127.0.0.1:9/").await,
            Err("offline".into())
        );
    }

    #[test]
    fn now_is_after_2026() {
        assert!(now_ms() > 1_767_225_600_000);
    }

    /// LIVE (public internet, non-blocking — `scripts/verify.mjs` EXTERNAL): the real
    /// Open-Meteo answer for London through the real command.
    #[tokio::test]
    #[ignore = "public internet: api.open-meteo.com"]
    async fn live_open_meteo_reports_london() {
        let w = village_weather("Europe/London".into())
            .await
            .expect("live weather");
        eprintln!("live weather: {}", serde_json::to_string(&w).unwrap());
        assert_eq!(w.place, "London");
        assert!((0.0..=1.0).contains(&w.intensity) && (-1.0..=1.0).contains(&w.wind));
        assert!(w.temperature_c.is_some_and(|t| (-40.0..55.0).contains(&t)));
        let (rise, set) = (w.sunrise_ms.unwrap(), w.sunset_ms.unwrap());
        assert!(rise < set && set - rise < 86_400_000);
        assert!(w.fetched_at_ms.abs_diff(now_ms()) < 60_000);
        // The second call is the cache: same report, no refetch.
        assert_eq!(village_weather("Europe/London".into()).await, Ok(w));
    }
}
