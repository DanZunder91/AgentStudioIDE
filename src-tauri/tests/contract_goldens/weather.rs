//! **Agent Village — `village_weather`** (`src/features/village/villageTypes.ts`
//! `WeatherWire`). Same rules as the parent file: the real production path, the typed
//! struct serialised as Tauri would.
//!
//! | golden | produced by |
//! |---|---|
//! | `weather.json` (`WeatherWire` by scenario) | `weather::locate` (the embedded city table — no system tz file, so the place is the same on every OS) + `weather::parse_forecast` over the Open-Meteo-shaped bodies hand-written in `tests/fixtures/weather/`, fetched at `T0`: rain (Vancouver), clear (Madrid), snow (Oslo), storm (New York zone, Miami body), fog (London), and a sparse body with null temperature/wind and no sunrise/sunset (Sydney) |
//!
//! Nothing is normalised: every value is a pure function of the fixture and `T0`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use agent_studio_scaffold_lib::weather::{locate, parse_forecast, WeatherKind, WeatherWire};

use super::{check_golden, T0};

fn body(name: &str) -> String {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/weather")
        .join(format!("{name}.json"));
    std::fs::read_to_string(p).expect("weather fixture")
}

fn report(zone: &str, fixture: &str) -> WeatherWire {
    let loc = locate(zone, &[]).expect("zone in the embedded table");
    parse_forecast(&body(fixture), &loc.place, T0).expect("fixture parses")
}

#[test]
fn weather_values_match_the_golden() {
    let mut scenarios: BTreeMap<&str, WeatherWire> = BTreeMap::new();
    scenarios.insert("rain", report("America/Vancouver", "rain_vancouver"));
    scenarios.insert("clear", report("Europe/Madrid", "clear_madrid"));
    scenarios.insert("snow", report("Europe/Oslo", "snow_oslo"));
    scenarios.insert("storm", report("America/New_York", "storm_miami"));
    scenarios.insert("fog", report("Europe/London", "fog_london"));
    scenarios.insert("sparse", report("Australia/Sydney", "partial"));
    // Not a golden that is all-null or all-one-kind by accident.
    assert_eq!(scenarios["rain"].kind, WeatherKind::Rain);
    assert!(scenarios["rain"].sunrise_ms.is_some() && scenarios["rain"].temperature_c.is_some());
    assert!(scenarios["sparse"].temperature_c.is_none() && scenarios["sparse"].sunset_ms.is_none());
    check_golden("weather.json", &scenarios);
}
