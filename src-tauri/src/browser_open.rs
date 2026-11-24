//! Open a local `.html` file in a **real browser** — the file tree's
//! "Open in Browser" context-menu entry.
//!
//! Two commands, one wire contract with `src/features/workspace/browserIpc.ts`:
//! [`list_browsers`] enumerates the browsers installed on this machine (default
//! first, `[]` rather than an error on an OS we cannot enumerate) and
//! [`open_in_browser`] launches one of them on a path.
//!
//! # Why this is not `url_open`
//!
//! [`crate::url_open`] is `https://`-only **by design**, asserted in its module
//! doc and in two security tests. Widening it to
//! `file://` would mean deleting those assertions. Its `REFUSED_CHARS` blocklist
//! would also reject perfectly legitimate paths — any filename containing a space
//! or an `&` — on every OS. So this is a separate, separately-shaped command.
//!
//! # The security shape, stated plainly
//!
//! The webview is the caller. A command that starts a program must therefore
//! trust it with exactly two things and nothing else:
//!
//! 1. **The path is scope-checked FIRST, before anything is spawned**, through
//!    [`resolve_in_scope`] — the single enforcement point `read_file`, the search
//!    walker and the `preview://` handler already share. It
//!    canonicalizes before the prefix check, so `..` and escaping symlinks are
//!    resolved to their real target and rejected. The **canonical** path is what
//!    is handed to the opener. Without this the command is arbitrary-local-file
//!    exfiltration from the webview.
//! 2. **`browser_id` is an opaque token we produced, never an executable path.**
//!    It is re-resolved against our *own* enumeration ([`resolve_requested`]); an
//!    id we do not recognise is `unknown-browser`. The frontend can never name a
//!    binary for us to spawn — the launch recipe ([`Launch`]) is built here and
//!    is not part of the wire type.
//!
//! A directory is refused (`not-a-file`), and so is a file that is not `.html` /
//! `.htm`. That second check is **defence in depth, not the primary gate** — the
//! frontend already only offers the menu entry when `previewKindOf(path) ===
//! "html"`. It is two literals inlined in [`is_html_path`], deliberately *not* a
//! second extension table, because a table here could drift out of step with
//! `previewKinds.ts` and silently disagree with the menu.
//!
//! # The per-OS bargain (the `url_open.rs` bargain)
//!
//! Every per-OS **decision** is a pure function, compiled and unit-tested on
//! every host — the argv shape ([`open_argv`]), the default-handler parse
//! ([`parse_default_handler`]), the `.desktop` parse
//! ([`browser_from_desktop_entry`]), the registry parse
//! ([`browsers_from_reg_output`]). Only the subprocess/filesystem glue is
//! untested. The enumerators take their directories as a parameter, so even the
//! Linux directory walk is exercised from a macOS test against a temp tree.
//!
//! ## macOS — MEASURED
//!
//! 🔴 `/usr/bin/open <path>` does **not** mean "open a browser": LaunchServices
//! resolves `public.html` by *content type*, which on a machine where `.html` is
//! bound to an editor opens the editor. `open -u file://…` is worse — the default
//! handler for the `file` scheme is `com.apple.finder`. The only correct argv is
//! **`/usr/bin/open -b <bundle-id> <absolute path>`**, with a plain path and not a
//! `file://` URL, so that `open` builds the URL itself and a `#` or `?` in a
//! filename cannot be eaten as a fragment. A missing bundle id exits 1 with a
//! clear `LSCopyApplicationURLsForBundleIdentifier` message on stderr (verified).
//!
//! Enumeration byte-scans each app's `Contents/Info.plist` for the literal
//! `NSUserActivityTypeBrowsingWeb` (measured: a hundred-odd plists in a few ms, zero
//! subprocesses). That marker returns exactly the real browsers and correctly
//! **excludes** iTerm2 and cmux, which both register the `http:` scheme and are
//! terminals — which is why `lsregister -dump` (2.5 s, 24 MB, undocumented) is
//! not used. `plutil -convert json -o -` then reads the identity of the ~4 hits.
//!
//! ## Linux and Windows — REASONED, NOT MEASURED
//!
//! Neither path has been measured on a live desktop the way macOS was. A verification
//! chain is platform-specific evidence, not a ritual — a macOS measurement must not
//! stand in for Linux. Both paths are therefore built to fail **loudly**
//! (`spawn-failed`) rather than degrade into "some program opened the file":
//! notably, the Linux default-browser path does **not** fall back to `xdg-open`,
//! because `xdg-open` on an `.html` file consults the `text/html` association and
//! would reintroduce exactly the open-in-the-editor bug macOS taught us about.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::fs_tree::{allowed_roots, resolve_in_scope};
use crate::spawn::NoWindow as _;

/// The complete error vocabulary, mirrored in `browserIpc.ts`. Errors are
/// `"<code>"` or `"<code>: <detail>"` — the house convention.
pub const ERROR_CODES: [&str; 5] = [
    // The path is outside every allowed workspace root (or does not exist — the
    // two are deliberately not distinguished, same posture as `html_preview`).
    "out-of-scope",
    // A directory, a device, or a file that is not `.html`/`.htm`.
    "not-a-file",
    // A `browser_id` that is not in OUR enumeration.
    "unknown-browser",
    // The browser could not be started (missing app, no default resolvable).
    "spawn-failed",
    // Anything else — an internal failure, never a user-caused one.
    "unknown",
];

// ---------------------------------------------------------------------------
// The wire type + the internal launch recipe
// ---------------------------------------------------------------------------

/// One browser the user can pick, as the frontend sees it.
///
/// 🔴 Carries **no** executable path. `id` is an opaque token (a macOS bundle id,
/// a Linux `.desktop` id, a Windows `StartMenuInternet` key name) that only means
/// something to [`resolve_requested`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserChoice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// How to actually start a browser. **Internal — never serialized, never
/// accepted from the webview.** Produced only by this module's enumerators.
///
/// The file path is *not* in here: [`open_argv`] appends it last, so "the path is
/// the final argument and never a flag" is one rule in one place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// An absolute program path wherever we can resolve one (*binary
    /// resolution is never a bare name* — a GUI-launched app has a minimal
    /// `PATH`). A bare name survives only as a documented lenient fallback on
    /// Linux, where a failure surfaces as `spawn-failed`, never silently.
    pub program: String,
    /// Fixed leading arguments — `["-b", "<bundle id>"]` on macOS, the `.desktop`
    /// `Exec` tail on Linux, empty on Windows.
    pub args: Vec<String>,
}

/// An enumerated browser: what the menu shows plus how to start it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Browser {
    pub choice: BrowserChoice,
    pub launch: Launch,
}

/// The argv for opening `path` with `launch` — the path **always last**, always a
/// plain filesystem path, never a URL and never a shell string.
///
/// This is the one place the final command line is built, on every OS.
pub fn open_argv(launch: &Launch, path: &str) -> (String, Vec<String>) {
    let mut args = launch.args.clone();
    args.push(path.to_string());
    (launch.program.clone(), args)
}

/// Pick the browser the caller asked for, or the first of the list.
///
/// `Some(id)` must match an id **we** produced; anything else is
/// `unknown-browser`. Pure, so "an unknown id is refused" is provable without a
/// process anywhere near the test.
pub fn resolve_requested(browsers: &[Browser], id: Option<&str>) -> Result<Launch, String> {
    match id {
        Some(id) => browsers
            .iter()
            .find(|b| b.choice.id == id)
            .map(|b| b.launch.clone())
            .ok_or_else(|| format!("unknown-browser: no installed browser has the id {id:?}")),
        // The list is default-first, so "no id" is "the first one".
        None => browsers
            .first()
            .map(|b| b.launch.clone())
            .ok_or_else(|| "spawn-failed: no browser could be found on this machine".to_string()),
    }
}

/// Order the menu: the default first, then case-insensitive alphabetical.
///
/// Sorting (rather than "whatever the directory walk returned") is what makes the
/// menu stable between sessions and the tests deterministic.
pub fn sort_default_first(browsers: &mut [Browser]) {
    browsers.sort_by(|a, b| {
        b.choice
            .is_default
            .cmp(&a.choice.is_default)
            .then_with(|| {
                a.choice
                    .name
                    .to_lowercase()
                    .cmp(&b.choice.name.to_lowercase())
            })
            .then_with(|| a.choice.id.cmp(&b.choice.id))
    });
}

/// Is this a page this command exists to open? `.html` / `.htm`, ASCII-case
/// insensitive.
///
/// Defence in depth only — see the module header. Two literals rather than a
/// table, mirroring `HTML_EXTS` in `src/features/editor/previewKinds.ts`.
pub fn is_html_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
}

/// The spelling of a canonical path that a *third-party program* can open.
///
/// 🔴 On Windows `std::fs::canonicalize` returns the **verbatim** form
/// (`\\?\C:\site\index.html`). Chrome, Firefox and Edge do not accept it — the
/// page would 404 or the browser would treat it as a search term. The prefix is
/// stripped here, *after* the scope check has already used the canonical path, so
/// the guard still sees the real path and only the launch argument is rewritten.
/// A verbatim **UNC** path (`\\?\UNC\server\share`) is left alone: rewriting it
/// correctly means `\\server\share`, which is a different-enough beast that
/// leaving it verbatim (and failing loudly) beats guessing.
pub fn launch_path_arg(path: &str) -> String {
    match path.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        _ => path.to_string(),
    }
}

// ---------------------------------------------------------------------------
// macOS — MEASURED (see the module header)
// ---------------------------------------------------------------------------

/// The marker every real browser's `Info.plist` carries and no terminal does.
/// Byte-compared, so it works on XML **and** binary plists without parsing either.
pub const MAC_BROWSER_MARKER: &[u8] = b"NSUserActivityTypeBrowsingWeb";

/// The fallback default when LaunchServices has recorded no choice at all (the
/// `com.apple.LaunchServices` domain is simply absent on a machine that has never
/// picked a browser). Safari is part of macOS, so this can be assumed present.
pub const MAC_DEFAULT_FALLBACK: &str = "com.apple.Safari";

/// macOS launch recipe: `/usr/bin/open -b <bundle id> <path>`.
///
/// `-b` is the whole point — without it `open` picks by *content type*, which is
/// an editor on a typical dev machine. `/usr/bin/open` is OS-shipped, so the
/// absolute path is used (never a `PATH` lookup).
pub fn macos_launch(bundle_id: &str) -> Launch {
    Launch {
        program: "/usr/bin/open".to_string(),
        args: vec!["-b".to_string(), bundle_id.to_string()],
    }
}

/// The default browser's bundle id from the LaunchServices secure plist, as JSON.
///
/// 🔴 The stored id is **lowercased** (`com.google.chrome`, while the bundle
/// itself says `com.google.Chrome`), so every comparison against it must be
/// case-insensitive. `-b` is case-insensitive too, so the lowercased id launches
/// correctly as-is.
///
/// The `http` URL-scheme handler is the authority. `com.apple.default-app.web-browser`
/// is consulted second: recent macOS writes it alongside, and it is the more
/// direct statement of the question we are asking. Returns `None` when neither is
/// present so the caller can apply [`MAC_DEFAULT_FALLBACK`] and say why.
pub fn parse_default_handler(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let handlers = v.get("LSHandlers")?.as_array()?;
    let role = |h: &serde_json::Value| {
        h.get("LSHandlerRoleAll")
            .and_then(|r| r.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    handlers
        .iter()
        .find(|h| h.get("LSHandlerURLScheme").and_then(|s| s.as_str()) == Some("http"))
        .and_then(role)
        .or_else(|| {
            handlers
                .iter()
                .find(|h| {
                    h.get("LSHandlerContentType").and_then(|s| s.as_str())
                        == Some("com.apple.default-app.web-browser")
                })
                .and_then(role)
        })
}

/// A browser's `(bundle id, display name)` from `plutil -convert json` output.
///
/// 🔴 Name preference is `CFBundleDisplayName`, then the `.app` basename —
/// **`CFBundleName` is deliberately not used**. Measured: Chrome's `CFBundleName`
/// is `"Chrome"` while its `CFBundleDisplayName` and its bundle name are
/// `"Google Chrome"`, and the menu has to read the way the Dock does. `CFBundleName`
/// is documented as a *short* name (≤ 16 characters), which is the wrong thing to
/// show. No bundle id → `None`: an app we cannot name to `open -b` is an app we
/// cannot launch, so it must not appear in the menu.
pub fn browser_from_info_plist_json(json: &str, app_file_name: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let id = v
        .get("CFBundleIdentifier")?
        .as_str()
        .filter(|s| !s.is_empty())?
        .to_string();
    let fallback = app_file_name
        .strip_suffix(".app")
        .unwrap_or(app_file_name)
        .to_string();
    let name = v
        .get("CFBundleDisplayName")
        .and_then(|n| n.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or(fallback);
    Some((id, name))
}

/// Does this `Info.plist`'s raw bytes declare web browsing?
pub fn plist_declares_browser(bytes: &[u8]) -> bool {
    contains_subslice(bytes, MAC_BROWSER_MARKER)
}

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Ceiling on an `Info.plist` read. Real ones are single-digit KB; this only
/// exists so a pathological file cannot be slurped whole into memory.
const MAX_PLIST_BYTES: u64 = 4 * 1024 * 1024;

/// Every `Contents/Info.plist` under `dirs` that carries [`MAC_BROWSER_MARKER`].
///
/// Scans each directory's `*.app` children **and** one level of plain
/// subdirectories, because people file browsers into `/Applications/Web/` and a
/// browser that is invisible to the menu looks like a bug in the feature. Pure
/// filesystem work with the directories injected, so it is unit-tested against a
/// temp tree on any host.
pub fn scan_app_dirs_for_browser_plists(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut hits = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_app = path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".app"));
            if is_app {
                collect_if_browser(&path, &mut hits);
            } else if path.is_dir() {
                // One level deeper — a folder of apps, not a bundle's innards.
                let Ok(nested) = std::fs::read_dir(&path) else {
                    continue;
                };
                for child in nested.flatten() {
                    let child = child.path();
                    if child
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.ends_with(".app"))
                    {
                        collect_if_browser(&child, &mut hits);
                    }
                }
            }
        }
    }
    hits.sort();
    hits.dedup();
    hits
}

fn collect_if_browser(app: &Path, hits: &mut Vec<PathBuf>) {
    let plist = app.join("Contents").join("Info.plist");
    let Ok(meta) = std::fs::metadata(&plist) else {
        return;
    };
    if !meta.is_file() || meta.len() > MAX_PLIST_BYTES {
        return;
    }
    if std::fs::read(&plist).is_ok_and(|b| plist_declares_browser(&b)) {
        hits.push(plist);
    }
}

/// The directories macOS browsers install into.
fn macos_app_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = home_dir() {
        dirs.push(home.join("Applications"));
    }
    dirs
}

/// `plutil -convert json -o - <path>` — OS-shipped, absolute, reads XML **and**
/// binary plists. Glue: the parsing it feeds is pure and tested.
fn plutil_json(path: &Path) -> Option<String> {
    let out = Command::new("/usr/bin/plutil")
        .no_window()
        .arg("-convert")
        .arg("json")
        .arg("-o")
        .arg("-")
        .arg(path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

/// The default browser bundle id on this Mac, or [`MAC_DEFAULT_FALLBACK`].
///
/// Reads `~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`.
/// That file is world-readable and outside every TCC-protected location, so this
/// raises **no** permission prompt (a permission prompt is a design failure).
fn macos_default_bundle_id() -> String {
    home_dir()
        .map(|h| {
            h.join("Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")
        })
        .and_then(|p| plutil_json(&p))
        .and_then(|json| parse_default_handler(&json))
        .unwrap_or_else(|| MAC_DEFAULT_FALLBACK.to_string())
}

/// Enumerate the browsers installed on this Mac, default first.
pub fn macos_browsers() -> Vec<Browser> {
    let default_id = macos_default_bundle_id();
    let mut out: Vec<Browser> = Vec::new();
    for plist in scan_app_dirs_for_browser_plists(&macos_app_dirs()) {
        // `…/Foo.app/Contents/Info.plist` → `Foo.app`
        let app_file_name = plist
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let Some(json) = plutil_json(&plist) else {
            continue;
        };
        let Some((id, name)) = browser_from_info_plist_json(&json, &app_file_name) else {
            continue;
        };
        if out.iter().any(|b| b.choice.id.eq_ignore_ascii_case(&id)) {
            continue;
        }
        let launch = macos_launch(&id);
        out.push(Browser {
            // 🔴 case-insensitive: LaunchServices stores the id lowercased.
            choice: BrowserChoice {
                is_default: id.eq_ignore_ascii_case(&default_id),
                id,
                name,
            },
            launch,
        });
    }
    sort_default_first(&mut out);
    out
}

// ---------------------------------------------------------------------------
// Linux — REASONED, NOT MEASURED (see the module header)
// ---------------------------------------------------------------------------

/// The MIME type a `.desktop` entry must claim to be a browser.
pub const LINUX_HTTP_HANDLER: &str = "x-scheme-handler/http";

/// Where a browser binary lives when a `.desktop` `Exec` names it bare.
///
/// The house rule is *binary resolution is never a bare name* (`agent/claude.rs`:
/// a GUI-launched process gets a minimal `PATH`). A `.desktop` `Exec=firefox` is
/// the XDG-sanctioned spelling, so it is resolved against these first and only
/// falls back to a bare name — the same lenient shape `url_open::linux_command`
/// documents, where a failure surfaces as `spawn-failed`, never silently.
const LINUX_BIN_DIRS: &[&str] = &[
    "/usr/bin",
    "/usr/local/bin",
    "/bin",
    "/snap/bin",
    "/var/lib/flatpak/exports/bin",
];

/// Split a `.desktop` `Exec=` value into argv per the Desktop Entry spec's
/// quoting rules: `"…"` groups, and inside quotes `\\ \" \` \$` are escapes.
pub fn split_exec(exec: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut started = false;
    let mut in_quotes = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                started = true;
            }
            '\\' if in_quotes => {
                // Only the four reserved characters are escapable; anything else
                // keeps the backslash (a Windows-ish path in a Linux Exec).
                match chars.peek() {
                    Some('"') | Some('\\') | Some('`') | Some('$') => {
                        cur.push(chars.next().unwrap_or_default());
                    }
                    _ => cur.push('\\'),
                }
                started = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if started {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            c => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started {
        out.push(cur);
    }
    out
}

/// The field codes a launcher must expand away. `%i %c %k` are "deprecated or
/// expanded by the launcher"; we supply none of them, so all are dropped.
const DESKTOP_FIELD_CODES: &[char] = &[
    'f', 'F', 'u', 'U', 'd', 'D', 'n', 'N', 'i', 'c', 'k', 'v', 'm',
];

/// Expand one `Exec` token: `%%` becomes a literal `%`, a field code becomes
/// nothing. Single left-to-right pass, so `%%u` survives as `%u` instead of being
/// mistaken for the `%u` field code.
pub fn expand_field_codes(token: &str) -> String {
    let mut out = String::new();
    let mut chars = token.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('%') => {
                chars.next();
                out.push('%');
            }
            Some(&code) if DESKTOP_FIELD_CODES.contains(&code) => {
                chars.next();
            }
            _ => out.push('%'),
        }
    }
    out
}

/// `Exec=` → argv with the field codes removed and empty tokens dropped.
pub fn exec_argv(exec: &str) -> Vec<String> {
    split_exec(exec)
        .into_iter()
        .map(|t| expand_field_codes(&t))
        .filter(|t| !t.is_empty())
        .collect()
}

/// Resolve a `.desktop` `Exec` program name to an absolute path where we can.
///
/// `probe` is injected (the glue passes `Path::is_file`) so both branches are
/// unit-testable from any host.
pub fn resolve_linux_program(argv0: &str, probe: &dyn Fn(&Path) -> bool) -> String {
    if argv0.contains('/') {
        return argv0.to_string();
    }
    // Joined as text with `/`, not with `Path::join`: these are Linux paths whatever OS
    // compiles this, and `Path::join` on Windows glues them with `\` (`/usr/bin\firefox`).
    // On Linux the two are identical.
    for dir in LINUX_BIN_DIRS {
        let candidate = format!("{dir}/{argv0}");
        if probe(Path::new(&candidate)) {
            return candidate;
        }
    }
    if let Some(home) = home_dir() {
        let candidate = format!(
            "{}/.local/bin/{argv0}",
            home.to_string_lossy().trim_end_matches('/')
        );
        if probe(Path::new(&candidate)) {
            return candidate;
        }
    }
    // Lenient fallback: PATH lookup at spawn, and a failure is reported.
    argv0.to_string()
}

/// One `.desktop` file → a [`Browser`], or `None` if it is not a browser we can
/// launch.
///
/// Refuses: a non-`Application` `Type`, `NoDisplay`/`Hidden` (entries the desktop
/// itself does not show), a `MimeType` without [`LINUX_HTTP_HANDLER`], an empty
/// `Exec`. Only the `[Desktop Entry]` group is read — an action group
/// (`[Desktop Action new-window]`) has its own `Exec`/`Name` and must not leak in.
/// Localized keys (`Name[es]`) are ignored: the menu shows the unlocalized name.
pub fn browser_from_desktop_entry(
    text: &str,
    desktop_id: &str,
    probe: &dyn Fn(&Path) -> bool,
) -> Option<Browser> {
    let mut in_main_group = false;
    let (mut name, mut exec, mut typ) = (None, None, None);
    let (mut mime, mut hidden) = (None, false);
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_main_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_main_group || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim_end(), value.trim());
        match key {
            "Name" if name.is_none() => name = Some(value.to_string()),
            "Exec" if exec.is_none() => exec = Some(value.to_string()),
            "Type" if typ.is_none() => typ = Some(value.to_string()),
            "MimeType" if mime.is_none() => mime = Some(value.to_string()),
            "NoDisplay" | "Hidden" => hidden |= value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }
    if hidden || typ.as_deref() != Some("Application") {
        return None;
    }
    let handles_http = mime
        .as_deref()
        .unwrap_or_default()
        .split(';')
        .any(|m| m.trim() == LINUX_HTTP_HANDLER);
    if !handles_http {
        return None;
    }
    let argv = exec_argv(&exec?);
    let (program, args) = argv.split_first()?;
    Some(Browser {
        choice: BrowserChoice {
            id: desktop_id.to_string(),
            name: name.unwrap_or_else(|| desktop_id.trim_end_matches(".desktop").to_string()),
            is_default: false,
        },
        launch: Launch {
            program: resolve_linux_program(program, probe),
            args: args.to_vec(),
        },
    })
}

/// Enumerate browsers from a precedence-ordered list of `applications`
/// directories.
///
/// **Basename shadowing**: the desktop id is the filename, and the first
/// directory that provides an id wins — `~/.local/share/applications/firefox.desktop`
/// overrides `/usr/share/applications/firefox.desktop`, exactly as the XDG menu
/// spec says. That is why the caller must pass the directories in precedence
/// order and why the id (not the path) is the dedupe key.
pub fn browsers_from_desktop_dirs(dirs: &[PathBuf], probe: &dyn Fn(&Path) -> bool) -> Vec<Browser> {
    let mut out: Vec<Browser> = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("desktop"))
            .collect();
        files.sort(); // deterministic within a directory
        for file in files {
            let Some(id) = file.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if out.iter().any(|b| b.choice.id == id) {
                continue; // shadowed by a higher-precedence directory
            }
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            if let Some(browser) = browser_from_desktop_entry(&text, id, probe) {
                out.push(browser);
            }
        }
    }
    out
}

/// The `applications` directories, in XDG precedence order.
fn linux_desktop_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    };
    match std::env::var("XDG_DATA_HOME") {
        Ok(v) if !v.is_empty() => push(PathBuf::from(v).join("applications")),
        _ => {
            if let Some(home) = home_dir() {
                push(home.join(".local/share/applications"));
            }
        }
    }
    if let Some(home) = home_dir() {
        push(home.join(".local/share/flatpak/exports/share/applications"));
    }
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    for d in data_dirs.split(':').filter(|d| !d.is_empty()) {
        push(PathBuf::from(d).join("applications"));
    }
    // Snap and system flatpak are usually already in XDG_DATA_DIRS; added
    // explicitly because a desktop session that forgot them is common enough.
    push(PathBuf::from("/var/lib/snapd/desktop/applications"));
    push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    dirs
}

/// The desktop id `xdg-settings get default-web-browser` printed.
///
/// Refuses anything that is not a single `*.desktop` token, because the value is
/// about to select which program we start.
pub fn parse_xdg_default_browser(stdout: &str) -> Option<String> {
    let line = stdout.lines().find(|l| !l.trim().is_empty())?.trim();
    if !line.ends_with(".desktop") || line.contains(char::is_whitespace) || line.contains('/') {
        return None;
    }
    Some(line.to_string())
}

/// Mark the entry whose id matches `default_id`, and re-sort default-first.
pub fn mark_linux_default(browsers: &mut [Browser], default_id: Option<&str>) {
    if let Some(id) = default_id {
        for b in browsers.iter_mut() {
            b.choice.is_default = b.choice.id == id;
        }
    }
    sort_default_first(browsers);
}

fn xdg_settings_default_browser() -> Option<String> {
    let program = if Path::new("/usr/bin/xdg-settings").is_file() {
        "/usr/bin/xdg-settings"
    } else {
        "xdg-settings"
    };
    let out = Command::new(program)
        .args(["get", "default-web-browser"])
        .no_window()
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_xdg_default_browser(&String::from_utf8_lossy(&out.stdout))
}

pub fn linux_browsers() -> Vec<Browser> {
    let probe = |p: &Path| p.is_file();
    let mut browsers = browsers_from_desktop_dirs(&linux_desktop_dirs(), &probe);
    mark_linux_default(&mut browsers, xdg_settings_default_browser().as_deref());
    browsers
}

// ---------------------------------------------------------------------------
// Windows — REASONED, NOT MEASURED (see the module header)
// ---------------------------------------------------------------------------

/// The registry key every installed browser registers itself under.
pub const WIN_START_MENU_INTERNET: &str = r"SOFTWARE\Clients\StartMenuInternet";

/// Where the per-user default browser's ProgId lives.
pub const WIN_USER_CHOICE: &str =
    r"HKCU\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice";

/// The registry value types `reg.exe` prints. Matching against this set (rather
/// than against the bare prefix `REG_`) is what stops a value *named*
/// `My REG_THING` from being mistaken for the type column.
const REG_TYPES: &[&str] = &[
    "REG_SZ",
    "REG_EXPAND_SZ",
    "REG_MULTI_SZ",
    "REG_DWORD",
    "REG_QWORD",
    "REG_BINARY",
    "REG_NONE",
    "REG_LINK",
    "REG_RESOURCE_LIST",
    "REG_FULL_RESOURCE_DESCRIPTOR",
];

/// One `reg query` output line split as `(name, type, data)`.
///
/// 🔴 Split on the type **token**, never on column positions: `reg.exe` pads with
/// a variable number of spaces, and a value's data may itself contain runs of
/// spaces (`C:\Program Files\…`) or the literal text `REG_SZ`.
pub fn split_reg_line(line: &str) -> Option<(String, String, String)> {
    for (i, _) in line.match_indices("REG_") {
        // The type is its own whitespace-delimited token.
        if i == 0 || !line.as_bytes()[i - 1].is_ascii_whitespace() {
            continue;
        }
        let rest = &line[i..];
        let (typ, data) = match rest.find(char::is_whitespace) {
            Some(j) => (&rest[..j], rest[j..].trim()),
            None => (rest, ""),
        };
        if !REG_TYPES.contains(&typ) {
            continue;
        }
        let name = line[..i].trim();
        if name.is_empty() {
            continue;
        }
        return Some((name.to_string(), typ.to_string(), data.to_string()));
    }
    None
}

/// A named value's data from a `reg query … /v <name>` (or `/ve`) block.
///
/// Accepts `REG_SZ` and `REG_EXPAND_SZ` — `shell\open\command` is written as
/// either depending on the installer.
pub fn parse_reg_value(stdout: &str, name: &str) -> Option<String> {
    stdout.lines().find_map(|line| {
        let (n, typ, data) = split_reg_line(line)?;
        (n.eq_ignore_ascii_case(name)
            && (typ == "REG_SZ" || typ == "REG_EXPAND_SZ")
            && !data.is_empty())
        .then_some(data)
    })
}

/// The **direct** child key names under `parent` in a `reg query <parent>` block.
///
/// `reg.exe` prints the queried key, its values, then one full path per subkey;
/// grandchildren never appear, but the parent's own line does and must not be
/// mistaken for a child.
pub fn parse_reg_subkeys(stdout: &str, parent: &str) -> Vec<String> {
    // `to_ascii_lowercase`, never `to_lowercase`: the latter can change a
    // string's BYTE length (İ → i̇), and the tail is sliced back out of the
    // original line by length.
    let prefix = format!("{}\\", parent.trim_end_matches('\\')).to_ascii_lowercase();
    stdout
        .lines()
        .map(str::trim)
        .filter_map(|line| {
            let remainder = line.to_ascii_lowercase().strip_prefix(&prefix)?.len();
            let tail = &line[line.len() - remainder..];
            (!tail.is_empty() && !tail.contains('\\')).then(|| tail.to_string())
        })
        .collect()
}

/// The executable out of a `shell\open\command` value.
///
/// `"C:\Program Files\Google\Chrome\Application\chrome.exe" -- "%1"` → the quoted
/// path. An unquoted value is taken whole (`StartMenuInternet`'s own command is
/// usually a bare path), which is correct precisely *because* we never hand it to
/// a shell: it is argv[0] of a direct spawn, so embedded spaces are not a split.
pub fn command_executable(command: &str) -> Option<String> {
    let command = command.trim();
    let exe = if let Some(rest) = command.strip_prefix('"') {
        rest.split('"').next().unwrap_or_default()
    } else {
        // Unquoted: everything up to a ` -`/` /` switch, else the whole value.
        command
            .split_once(" -")
            .or_else(|| command.split_once(" /"))
            .map_or(command, |(head, _)| head)
    }
    .trim();
    (!exe.is_empty()).then(|| exe.to_string())
}

/// One browser from its `StartMenuInternet` subkey name plus the two value
/// blocks `reg query` returned for it.
///
/// 🔴 The launch is the browser `.exe` **directly**, never through `cmd`: Rust's
/// `Command` quotes an argument only for space, tab or emptiness — not for `&` —
/// so `cmd /c start "" C:\p\R&Dreport.html` would run `Dreport.html` as a second
/// command. Avoiding `cmd` entirely is the rule: `url_open` uses `ShellExecuteW`, not
/// `cmd /c start`, for the same reason (cmd expanded a link's `%VAR%`).
pub fn browser_from_reg_key(
    key_name: &str,
    name_block: &str,
    command_block: &str,
) -> Option<Browser> {
    let command = parse_reg_value(command_block, "(Default)")?;
    let exe = command_executable(&command)?;
    let name = parse_reg_value(name_block, "(Default)").unwrap_or_else(|| key_name.to_string());
    Some(Browser {
        choice: BrowserChoice {
            id: key_name.to_string(),
            name,
            is_default: false,
        },
        launch: Launch {
            program: exe,
            args: Vec::new(),
        },
    })
}

/// Assemble the Windows list from already-captured `reg query` output.
///
/// `blocks` is `(subkey name, name block, command block)` per candidate, in the
/// order they were queried (HKLM then HKCU); `default_exe` is what the
/// `UserChoice` ProgId resolved to. Pure, so the whole Windows shape is tested
/// from a Mac; only the `reg.exe` invocations are glue.
///
/// Dedupe is on the subkey name, case-insensitively: HKLM and HKCU routinely
/// carry the same browser, and the two would otherwise appear twice in the menu.
pub fn browsers_from_reg_output(
    blocks: &[(String, String, String)],
    default_exe: Option<&str>,
) -> Vec<Browser> {
    let mut out: Vec<Browser> = Vec::new();
    for (key, name_block, command_block) in blocks {
        if out.iter().any(|b| b.choice.id.eq_ignore_ascii_case(key)) {
            continue;
        }
        let Some(mut browser) = browser_from_reg_key(key, name_block, command_block) else {
            continue;
        };
        if let Some(def) = default_exe {
            // Registry paths differ in case and in separator runs between the
            // two hives; a case-insensitive compare is the honest match here.
            browser.choice.is_default = browser.launch.program.eq_ignore_ascii_case(def);
        }
        out.push(browser);
    }
    sort_default_first(&mut out);
    out
}

/// `reg.exe`, absolute where `%SystemRoot%` tells us where it is.
pub fn reg_exe_path(system_root: Option<&str>) -> String {
    match system_root {
        Some(root) if !root.is_empty() => {
            format!(r"{}\System32\reg.exe", root.trim_end_matches('\\'))
        }
        // Lenient fallback, like `url_open`'s `xdg-open`: a failure is reported.
        _ => "reg.exe".to_string(),
    }
}

/// Run one `reg query`. **A non-zero exit is normal** — `reg.exe` returns 1 for
/// "the key does not exist", which is the ordinary state of the HKCU hive on a
/// machine where no browser installed per-user. Treated as empty output.
fn reg_query(args: &[&str]) -> String {
    let program = reg_exe_path(std::env::var("SystemRoot").ok().as_deref());
    Command::new(program)
        .args(args)
        .no_window()
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

pub fn windows_browsers() -> Vec<Browser> {
    let mut blocks: Vec<(String, String, String)> = Vec::new();
    for hive in ["HKLM", "HKCU"] {
        let root = format!(r"{hive}\{WIN_START_MENU_INTERNET}");
        for key in parse_reg_subkeys(&reg_query(&[&root]), &root) {
            let key_path = format!(r"{root}\{key}");
            let command_path = format!(r"{key_path}\shell\open\command");
            blocks.push((
                key,
                reg_query(&[&key_path, "/ve"]),
                reg_query(&[&command_path, "/ve"]),
            ));
        }
    }
    browsers_from_reg_output(&blocks, windows_default_exe().as_deref())
}

/// The default browser's executable, via `UserChoice` → ProgId → `HKCR`.
fn windows_default_exe() -> Option<String> {
    let prog_id = parse_reg_value(&reg_query(&[WIN_USER_CHOICE, "/v", "ProgId"]), "ProgId")?;
    let command = parse_reg_value(
        &reg_query(&[&format!(r"HKCR\{prog_id}\shell\open\command"), "/ve"]),
        "(Default)",
    )?;
    command_executable(&command)
}

// ---------------------------------------------------------------------------
// The per-OS glue (the only `cfg`'d code in the module)
// ---------------------------------------------------------------------------

fn home_dir() -> Option<PathBuf> {
    // Read-only env, never set (setting one races parallel tests).
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn enumerate_browsers() -> Vec<Browser> {
    macos_browsers()
}

#[cfg(target_os = "linux")]
fn enumerate_browsers() -> Vec<Browser> {
    linux_browsers()
}

#[cfg(target_os = "windows")]
fn enumerate_browsers() -> Vec<Browser> {
    windows_browsers()
}

/// An OS we have not taught to enumerate returns an empty list, not an error —
/// `browserIpc.ts` shows the single "system default" leaf for that case.
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn enumerate_browsers() -> Vec<Browser> {
    Vec::new()
}

/// The launch to use when the caller named no browser.
///
/// macOS can answer this **without** the enumeration — LaunchServices records the
/// default directly — so "Open in Browser" keeps working even if the app scan
/// finds nothing. Linux and Windows have no such independent route, so they fall
/// back to the enumerated list's first entry and, failing that, to a loud
/// `spawn-failed`.
#[cfg(target_os = "macos")]
fn default_launch(browsers: &[Browser]) -> Result<Launch, String> {
    // The list is already default-first and already marked from LaunchServices,
    // so the common path costs no extra subprocess. Asking LaunchServices again
    // is the fallback for the case the enumeration came back empty — which is
    // exactly when `browserIpc.ts` shows its single "system default" leaf.
    resolve_requested(browsers, None).or_else(|_| Ok(macos_launch(&macos_default_bundle_id())))
}

#[cfg(not(target_os = "macos"))]
fn default_launch(browsers: &[Browser]) -> Result<Launch, String> {
    // Deliberately NOT `xdg-open <file>`: that consults the `text/html`
    // association, which is an editor on plenty of developer machines — the exact
    // bug measured on macOS. Fail loudly instead (module header).
    resolve_requested(browsers, None)
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/// `list_browsers` — every browser installed on this machine, **default first**.
///
/// `async` + `spawn_blocking` because a synchronous `#[tauri::command]` runs on
/// the **main/event-loop thread**, and this walks directories and starts small
/// subprocesses (`fs_tree::read_file` carries the same note and the same fix).
#[tauri::command]
pub async fn list_browsers() -> Result<Vec<BrowserChoice>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        enumerate_browsers()
            .into_iter()
            .map(|b| b.choice)
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("unknown: browser enumeration failed: {e}"))
}

/// `open_in_browser` — open the local `.html` file at `path` in a browser.
#[tauri::command]
pub async fn open_in_browser(
    app: tauri::AppHandle,
    path: String,
    browser_id: Option<String>,
) -> Result<(), String> {
    // Resolved here and moved in: the scope is server-authoritative and the check
    // is not skippable.
    let roots = allowed_roots(&app);
    tauri::async_runtime::spawn_blocking(move || {
        open_scoped(Path::new(&path), browser_id.as_deref(), &roots)
    })
    .await
    .unwrap_or_else(|e| Err(format!("unknown: open task failed: {e}")))
}

/// Every decision `open_in_browser` makes, **with nothing spawned**: the scope
/// check, the type checks, the id re-resolution and the final argv.
///
/// The order is the security property: **scope → type → browser → argv.** Every
/// refusal happens before [`open_scoped`] has a program name to run, and because
/// the browser list is a parameter, the whole chain — including the success path
/// that produces a real command line — is unit-tested without a browser ever
/// being launched. That seam is deliberate: the two halves (a correct argv, a
/// correct enumeration) are each covered, and this is what proves they add up.
pub(crate) fn plan_open(
    requested: &Path,
    browser_id: Option<&str>,
    roots: &[PathBuf],
    browsers: &[Browser],
) -> Result<(String, Vec<String>), String> {
    // 1. Scope first, and the CANONICAL path is what gets opened. A path that does
    //    not exist reports the same code as one outside the roots: the caller is
    //    the webview, and it must not learn from the error which of the two it hit.
    let real = resolve_in_scope(requested, roots).map_err(|e| format!("out-of-scope: {e}"))?;

    // 2. A directory (including a macOS `.app` bundle) is never opened.
    let meta = std::fs::metadata(&real).map_err(|e| format!("not-a-file: cannot stat: {e}"))?;
    if !meta.is_file() {
        return Err("not-a-file: only a regular file can be opened in a browser".to_string());
    }
    // 3. Defence in depth — the frontend is the primary gate (module header).
    if !is_html_path(&real) {
        return Err("not-a-file: only .html and .htm files open in a browser".to_string());
    }

    // 4. The id is re-resolved against OUR enumeration; it is never a program.
    let launch = match browser_id {
        Some(id) => resolve_requested(browsers, Some(id))?,
        None => default_launch(browsers)?,
    };

    Ok(open_argv(
        &launch,
        &launch_path_arg(&real.to_string_lossy()),
    ))
}

/// The whole of `open_in_browser` with the roots injected — no `AppHandle`, so
/// the refusals are testable directly.
pub(crate) fn open_scoped(
    requested: &Path,
    browser_id: Option<&str>,
    roots: &[PathBuf],
) -> Result<(), String> {
    let (program, args) = plan_open(requested, browser_id, roots, &enumerate_browsers())?;
    spawn_detached(&program, &args)
}

/// Start the opener detached, and reap it so no zombie lingers — the
/// `url_open::url_open` discipline.
fn spawn_detached(program: &str, args: &[String]) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .no_window()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn-failed: could not start the browser: {e}"))?;
    // A throwaway thread collects the exit without blocking the command. On macOS
    // `open` exits in milliseconds; on Linux/Windows the spawned browser hands off
    // to an already-running instance and exits just as fast in the common case.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── fixtures ──────────────────────────────────────────────────────────────

    /// The real shape of `plutil -convert json -o -` on
    /// `com.apple.launchservices.secure.plist`, trimmed to the entries that matter.
    /// Note `com.google.chrome`
    /// is **lowercased** — that is what LaunchServices stores.
    const LS_SECURE_JSON: &str = r#"{"LSHandlers":[
      {"LSHandlerContentType":"com.apple.ical.backup-package","LSHandlerRoleAll":"com.apple.ical"},
      {"LSHandlerContentType":"com.apple.default-app.web-browser","LSHandlerRoleAll":"com.google.chrome"},
      {"LSHandlerRoleAll":"com.google.chrome","LSHandlerURLScheme":"https"},
      {"LSHandlerRoleAll":"com.googlecode.iterm2","LSHandlerURLScheme":"iterm2"},
      {"LSHandlerRoleAll":"com.google.chrome","LSHandlerURLScheme":"http"},
      {"LSHandlerContentType":"public.html","LSHandlerRoleAll":"com.google.chrome"}
    ]}"#;

    /// The real shape of `plutil -convert json -o - "/Applications/Google Chrome.app/Contents/Info.plist"`,
    /// trimmed. `CFBundleName` is "Chrome" and `CFBundleDisplayName` is "Google
    /// Chrome" — the reason the display name wins.
    const CHROME_INFO_JSON: &str = r#"{"CFBundleIdentifier":"com.google.Chrome",
      "CFBundleName":"Chrome","CFBundleDisplayName":"Google Chrome",
      "NSUserActivityTypes":["NSUserActivityTypeBrowsingWeb"]}"#;

    /// Firefox's, which has **no** `CFBundleDisplayName` (measured).
    const FIREFOX_INFO_JSON: &str =
        r#"{"CFBundleIdentifier":"org.mozilla.firefox","CFBundleName":"Firefox"}"#;

    const FIREFOX_DESKTOP: &str = "\
[Desktop Entry]
Version=1.0
Name=Firefox Web Browser
Name[es]=Navegador web Firefox
Comment=Browse the World Wide Web
Exec=firefox %u
Terminal=false
Type=Application
Icon=firefox
Categories=Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
StartupNotify=true

[Desktop Action new-window]
Name=Open a New Window
Exec=firefox --new-window %u
";

    /// A `reg query HKLM\SOFTWARE\Clients\StartMenuInternet` block: the queried
    /// key's own line, then one line per subkey.
    const REG_SUBKEYS: &str = "\r
HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\r
\r
HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\r
HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox-308046B0AF4A39CB\r
HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\Capabilities\r
";

    fn reg_value_block(name: &str, data: &str) -> String {
        format!(
            "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Some\\Key\r\n    {name}    REG_SZ    {data}\r\n\r\n"
        )
    }

    /// A throwaway directory tree, the `fs_tree` test idiom.
    struct TempTree {
        root: PathBuf,
    }
    impl TempTree {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("agentstudio-browser-{label}-{}", ulid::Ulid::new()));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }
        fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
            let p = self.root.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&p, bytes).unwrap();
            p
        }
        fn canon_root(&self) -> PathBuf {
            std::fs::canonicalize(&self.root).unwrap()
        }
    }
    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn browser(id: &str, name: &str, is_default: bool, program: &str) -> Browser {
        Browser {
            choice: BrowserChoice {
                id: id.to_string(),
                name: name.to_string(),
                is_default,
            },
            launch: Launch {
                program: program.to_string(),
                args: Vec::new(),
            },
        }
    }

    // ── the wire type ─────────────────────────────────────────────────────────

    /// The frontend reads `isDefault`; serde must emit camelCase or the menu can
    /// never mark the default. (`browserIpc.ts`'s `BrowserChoice`.)
    #[test]
    fn browser_choice_serializes_camel_case() {
        let json = serde_json::to_string(&BrowserChoice {
            id: "com.apple.Safari".to_string(),
            name: "Safari".to_string(),
            is_default: true,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"id":"com.apple.Safari","name":"Safari","isDefault":true}"#
        );
    }

    // ── open_argv: the argv shape, pinned POSITIONALLY, per OS ────────────────

    /// 🔴 macOS: `-b <bundle id>` must come BEFORE the path, and the path must be
    /// a plain path — not `file://…`, whose default handler is the Finder, and not
    /// a bare `open <path>`, which resolves `public.html` by content type (an
    /// editor on a typical dev machine).
    #[test]
    fn macos_argv_is_open_dash_b_then_the_plain_path() {
        let launch = macos_launch("com.google.Chrome");
        let (program, args) = open_argv(&launch, "/Users/sam/site/index.html");
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(
            args,
            vec![
                "-b".to_string(),
                "com.google.Chrome".to_string(),
                "/Users/sam/site/index.html".to_string(),
            ]
        );
        // Specifically not a URL, and specifically last.
        assert_eq!(args[2], "/Users/sam/site/index.html");
        assert!(!args[2].starts_with("file://"));
    }

    /// A `#` or `?` in a filename survives because `open` builds the URL itself —
    /// the reason a path beats a hand-built `file://` URL.
    #[test]
    fn macos_argv_passes_hash_and_query_characters_through_untouched() {
        let launch = macos_launch("com.apple.Safari");
        let (_, args) = open_argv(&launch, "/w/notes #1 & drafts?.html");
        assert_eq!(args.last().unwrap(), "/w/notes #1 & drafts?.html");
    }

    /// Linux: the `.desktop` `Exec` program and its surviving args, then the path.
    #[test]
    fn linux_argv_is_the_desktop_exec_with_the_path_last() {
        let launch = Launch {
            program: "/usr/bin/firefox".to_string(),
            args: vec!["--new-window".to_string()],
        };
        assert_eq!(
            open_argv(&launch, "/w/site/index.html"),
            (
                "/usr/bin/firefox".to_string(),
                vec!["--new-window".to_string(), "/w/site/index.html".to_string()]
            )
        );
    }

    /// 🔴 Windows: the browser `.exe` **directly**, never `cmd /c start`. Rust's
    /// `Command` quotes an argument for space/tab/empty but NOT for `&`, so a path
    /// like `C:\p\R&Dreport.html` through `cmd` would run `Dreport.html` as a
    /// second command. Here it is argv[1] of the exe and nothing parses it.
    #[test]
    fn windows_argv_spawns_the_exe_directly_and_never_cmd() {
        let launch = Launch {
            program: r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string(),
            args: Vec::new(),
        };
        let (program, args) = open_argv(&launch, r"C:\p\R&Dreport.html");
        assert_eq!(
            program,
            r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        );
        assert_eq!(args, vec![r"C:\p\R&Dreport.html".to_string()]);
        assert!(!program.eq_ignore_ascii_case("cmd"));
        assert!(!args.iter().any(|a| a == "start" || a == "/c"));
    }

    /// The `\\?\` verbatim prefix `canonicalize` returns on Windows is stripped
    /// for the launch argument only; a verbatim UNC path is left alone.
    #[test]
    fn windows_verbatim_prefix_is_stripped_from_the_launch_argument() {
        assert_eq!(
            launch_path_arg(r"\\?\C:\site\index.html"),
            r"C:\site\index.html"
        );
        assert_eq!(
            launch_path_arg(r"\\?\UNC\server\share\index.html"),
            r"\\?\UNC\server\share\index.html"
        );
        assert_eq!(
            launch_path_arg("/Users/sam/site/index.html"),
            "/Users/sam/site/index.html"
        );
    }

    // ── resolve_requested: the id is never a program ──────────────────────────

    #[test]
    fn a_known_id_resolves_to_its_own_launch() {
        let list = vec![
            browser("com.google.Chrome", "Google Chrome", true, "/usr/bin/open"),
            browser("org.mozilla.firefox", "Firefox", false, "/usr/bin/open"),
        ];
        assert_eq!(
            resolve_requested(&list, Some("org.mozilla.firefox")).unwrap(),
            list[1].launch
        );
    }

    /// An id we did not produce is refused — including one that *looks* like a
    /// program, which is the attack this check exists for.
    #[test]
    fn an_unrecognised_id_is_unknown_browser() {
        let list = vec![browser("com.apple.Safari", "Safari", true, "/usr/bin/open")];
        for id in [
            "com.evil.nope",
            "/bin/sh",
            "/usr/bin/osascript",
            "",
            "com.apple.safari", // case differs: ids round-trip verbatim
        ] {
            let err = resolve_requested(&list, Some(id)).unwrap_err();
            assert!(
                err.starts_with("unknown-browser"),
                "{id:?} must be unknown-browser, got {err:?}"
            );
        }
    }

    #[test]
    fn no_id_takes_the_first_entry_and_an_empty_list_fails_loudly() {
        let list = vec![
            browser("a", "A", true, "/usr/bin/open"),
            browser("b", "B", false, "/usr/bin/open"),
        ];
        assert_eq!(resolve_requested(&list, None).unwrap(), list[0].launch);
        let err = resolve_requested(&[], None).unwrap_err();
        assert!(err.starts_with("spawn-failed"), "{err:?}");
    }

    #[test]
    fn the_default_sorts_first_then_alphabetically() {
        let mut list = vec![
            browser("z", "Zebra", false, "x"),
            browser("a", "Arc", false, "x"),
            browser("f", "firefox", true, "x"),
            browser("m", "Midori", false, "x"),
        ];
        sort_default_first(&mut list);
        assert_eq!(
            list.iter()
                .map(|b| b.choice.name.as_str())
                .collect::<Vec<_>>(),
            vec!["firefox", "Arc", "Midori", "Zebra"]
        );
    }

    // ── is_html_path: the defence-in-depth gate ───────────────────────────────

    #[test]
    fn only_html_and_htm_are_openable() {
        for ok in ["/w/index.html", "/w/a.HTM", "/w/A.Html", "/w/x.htm"] {
            assert!(is_html_path(Path::new(ok)), "{ok} must be openable");
        }
        for no in [
            "/w/.env",
            "/w/id_rsa",
            "/w/notes.md",
            "/w/index.html.bak",
            "/w/Makefile",
            "/w/App.app",
            "/w/index.xhtml",
        ] {
            assert!(!is_html_path(Path::new(no)), "{no} must be refused");
        }
    }

    // ── macOS: parse_default_handler over the real plist JSON shape ────────────

    #[test]
    fn the_http_scheme_handler_is_the_default_browser() {
        assert_eq!(
            parse_default_handler(LS_SECURE_JSON),
            // Lowercased, exactly as LaunchServices stores it.
            Some("com.google.chrome".to_string())
        );
    }

    /// The `http` scheme wins over every other entry — `https`, `public.html` and
    /// the terminals that register their own schemes must not be picked up.
    #[test]
    fn a_non_http_scheme_is_never_mistaken_for_the_default() {
        let json = r#"{"LSHandlers":[
          {"LSHandlerRoleAll":"com.googlecode.iterm2","LSHandlerURLScheme":"iterm2"},
          {"LSHandlerRoleAll":"com.cmuxterm.app","LSHandlerURLScheme":"cmux"},
          {"LSHandlerRoleAll":"com.microsoft.VSCode","LSHandlerContentType":"public.html"}
        ]}"#;
        assert_eq!(parse_default_handler(json), None);

        // 🔴 `http` and `https` are SEPARATE LaunchServices entries and a user can
        // point them at different apps. On the captured Mac both happen to say
        // Chrome, so the real fixture cannot tell the two arms apart — this
        // constructed pair is what pins that we read the `http` one.
        let split = r#"{"LSHandlers":[
          {"LSHandlerRoleAll":"org.mozilla.firefox","LSHandlerURLScheme":"https"},
          {"LSHandlerRoleAll":"com.google.chrome","LSHandlerURLScheme":"http"},
          {"LSHandlerContentType":"com.apple.default-app.web-browser","LSHandlerRoleAll":"com.apple.Safari"}
        ]}"#;
        assert_eq!(
            parse_default_handler(split),
            Some("com.google.chrome".to_string()),
            "the http scheme handler is the authority, ahead of https and of the content type"
        );
    }

    /// Recent macOS also writes `com.apple.default-app.web-browser`; it answers
    /// when the scheme entry is missing.
    #[test]
    fn the_web_browser_content_type_answers_when_the_scheme_entry_is_absent() {
        let json = r#"{"LSHandlers":[
          {"LSHandlerContentType":"com.apple.default-app.web-browser","LSHandlerRoleAll":"org.mozilla.firefox"}
        ]}"#;
        assert_eq!(
            parse_default_handler(json),
            Some("org.mozilla.firefox".to_string())
        );
    }

    /// The whole domain is absent on a machine that never chose a browser — and
    /// so is the file. Both must fall back, not error.
    #[test]
    fn an_absent_domain_yields_no_default_and_the_fallback_is_safari() {
        assert_eq!(parse_default_handler("{}"), None);
        assert_eq!(parse_default_handler(r#"{"LSHandlers":[]}"#), None);
        assert_eq!(parse_default_handler("not json at all"), None);
        assert_eq!(parse_default_handler(r#"{"LSHandlers":{}}"#), None);
        // An entry with an empty role is not a default either.
        assert_eq!(
            parse_default_handler(
                r#"{"LSHandlers":[{"LSHandlerURLScheme":"http","LSHandlerRoleAll":""}]}"#
            ),
            None
        );
        assert_eq!(MAC_DEFAULT_FALLBACK, "com.apple.Safari");
    }

    // ── macOS: the Info.plist parse ───────────────────────────────────────────

    /// 🔴 `CFBundleDisplayName` beats `CFBundleName`: Chrome's short name is
    /// "Chrome", and the menu must read like the Dock.
    #[test]
    fn the_display_name_wins_over_the_short_bundle_name() {
        assert_eq!(
            browser_from_info_plist_json(CHROME_INFO_JSON, "Google Chrome.app"),
            Some(("com.google.Chrome".to_string(), "Google Chrome".to_string()))
        );
    }

    /// No display name → the `.app` basename, which is what Finder shows.
    #[test]
    fn without_a_display_name_the_app_basename_is_the_name() {
        assert_eq!(
            browser_from_info_plist_json(FIREFOX_INFO_JSON, "Firefox.app"),
            Some(("org.mozilla.firefox".to_string(), "Firefox".to_string()))
        );
    }

    /// No bundle id → no entry: `open -b` has nothing to name, so offering it in
    /// the menu would be offering a button that cannot work.
    #[test]
    fn an_app_without_a_bundle_id_is_dropped() {
        assert_eq!(
            browser_from_info_plist_json(r#"{"CFBundleName":"Weird"}"#, "Weird.app"),
            None
        );
        assert_eq!(
            browser_from_info_plist_json(r#"{"CFBundleIdentifier":""}"#, "Weird.app"),
            None
        );
        assert_eq!(browser_from_info_plist_json("<xml/>", "Weird.app"), None);
    }

    // ── macOS: the marker scan (fs, host-independent) ─────────────────────────

    #[test]
    fn the_browsing_marker_is_found_in_xml_and_in_binary_plist_bytes() {
        assert!(plist_declares_browser(CHROME_INFO_JSON.as_bytes()));
        // A binary plist stores its strings raw, which is why a byte scan works
        // on both without parsing either.
        let mut binary = b"bplist00\xd1\x01\x02".to_vec();
        binary.extend_from_slice(MAC_BROWSER_MARKER);
        binary.extend_from_slice(b"\x08\x00\x00");
        assert!(plist_declares_browser(&binary));
        assert!(!plist_declares_browser(FIREFOX_INFO_JSON.as_bytes()));
        assert!(!plist_declares_browser(b""));
    }

    /// The scan finds `.app` bundles at the top level AND one folder deep, and
    /// ignores apps that do not declare browsing — the property that excludes
    /// iTerm2 and cmux, which both register the `http:` scheme.
    #[test]
    fn the_app_scan_finds_nested_bundles_and_skips_non_browsers() {
        let t = TempTree::new("app-scan");
        t.write(
            "Safari.app/Contents/Info.plist",
            CHROME_INFO_JSON.as_bytes(),
        );
        t.write(
            "Web/Firefox.app/Contents/Info.plist",
            CHROME_INFO_JSON.as_bytes(),
        );
        t.write(
            "iTerm.app/Contents/Info.plist",
            FIREFOX_INFO_JSON.as_bytes(),
        );
        t.write("NotAnApp/Contents/Info.plist", CHROME_INFO_JSON.as_bytes());

        let hits = scan_app_dirs_for_browser_plists(std::slice::from_ref(&t.root));
        let names: Vec<String> = hits
            .iter()
            .filter_map(|p| {
                p.parent()?
                    .parent()?
                    .file_name()?
                    .to_str()
                    .map(str::to_string)
            })
            .collect();
        // Deterministic order: the hit list is sorted by path, and "Safari.app"
        // sorts before the "Web/" folder that holds the nested bundle.
        assert_eq!(
            names,
            vec!["Safari.app".to_string(), "Firefox.app".to_string()]
        );
    }

    #[test]
    fn the_app_scan_tolerates_a_missing_directory() {
        assert!(scan_app_dirs_for_browser_plists(&[PathBuf::from(
            "/definitely/not/here/agentstudio"
        )])
        .is_empty());
    }

    // ── Linux: Exec parsing (REASONED — no Linux host has run this) ───────────

    #[test]
    fn exec_field_codes_are_stripped_and_double_percent_survives() {
        assert_eq!(exec_argv("firefox %u"), vec!["firefox".to_string()]);
        assert_eq!(
            exec_argv("/usr/bin/brave-browser-stable --profile %U"),
            vec![
                "/usr/bin/brave-browser-stable".to_string(),
                "--profile".to_string()
            ]
        );
        for code in [
            "%f", "%F", "%u", "%U", "%d", "%D", "%n", "%N", "%i", "%c", "%k", "%v", "%m",
        ] {
            assert_eq!(
                exec_argv(&format!("firefox {code}")),
                vec!["firefox".to_string()],
                "{code} must be stripped"
            );
        }
        // `%%` is a literal percent and must NOT be read as a field code.
        assert_eq!(
            exec_argv("firefox --tag=100%%u"),
            vec!["firefox".to_string(), "--tag=100%u".to_string()]
        );
        // An embedded code is expanded away; a token that becomes empty is dropped.
        assert_eq!(
            exec_argv("firefox --url=%u %U"),
            vec!["firefox".to_string(), "--url=".to_string()]
        );
    }

    #[test]
    fn exec_quoting_follows_the_desktop_entry_spec() {
        assert_eq!(
            exec_argv(r#""/opt/Google Chrome/chrome" --flag %U"#),
            vec![
                "/opt/Google Chrome/chrome".to_string(),
                "--flag".to_string()
            ]
        );
        assert_eq!(
            split_exec(r#""a\"b" c"#),
            vec!["a\"b".to_string(), "c".to_string()]
        );
        assert_eq!(
            split_exec("  spaced   out  "),
            vec!["spaced".to_string(), "out".to_string()]
        );
        assert!(split_exec("").is_empty());
        // An empty quoted token is a real token, not whitespace.
        assert_eq!(
            split_exec(r#"a "" b"#),
            vec!["a".to_string(), String::new(), "b".to_string()]
        );
    }

    #[test]
    fn a_bare_exec_name_resolves_to_an_absolute_path_when_one_exists() {
        let seen = |p: &Path| p == Path::new("/usr/bin/firefox");
        assert_eq!(resolve_linux_program("firefox", &seen), "/usr/bin/firefox");
        // Already absolute → untouched.
        assert_eq!(
            resolve_linux_program("/opt/brave/brave", &seen),
            "/opt/brave/brave"
        );
        // Nowhere on the known list → the lenient bare name, and the spawn
        // failure surfaces as `spawn-failed` rather than silence.
        assert_eq!(
            resolve_linux_program("nope-browser", &|_: &Path| false),
            "nope-browser"
        );
    }

    // ── Linux: the .desktop entry → Browser ───────────────────────────────────

    #[test]
    fn a_desktop_entry_declaring_the_http_scheme_becomes_a_browser() {
        let found = |p: &Path| p == Path::new("/usr/bin/firefox");
        let b = browser_from_desktop_entry(FIREFOX_DESKTOP, "firefox.desktop", &found).unwrap();
        assert_eq!(b.choice.id, "firefox.desktop");
        // The unlocalized `Name`, not `Name[es]`.
        assert_eq!(b.choice.name, "Firefox Web Browser");
        assert_eq!(b.launch.program, "/usr/bin/firefox");
        // 🔴 The `[Desktop Action new-window]` group's `Exec` must NOT leak in.
        assert!(
            b.launch.args.is_empty(),
            "action-group args leaked: {:?}",
            b.launch.args
        );
    }

    #[test]
    fn an_entry_that_does_not_handle_http_is_not_a_browser() {
        let no = |_: &Path| false;
        // An editor bound to text/html — the exact thing macOS's content-type
        // lookup gets wrong.
        let editor = "[Desktop Entry]\nType=Application\nName=Code\nExec=code %F\nMimeType=text/html;text/plain;\n";
        assert!(browser_from_desktop_entry(editor, "code.desktop", &no).is_none());
        // No MimeType at all.
        let plain = "[Desktop Entry]\nType=Application\nName=Thing\nExec=thing\n";
        assert!(browser_from_desktop_entry(plain, "thing.desktop", &no).is_none());
        // A Link/Directory type is not launchable.
        let link = "[Desktop Entry]\nType=Link\nName=L\nExec=x\nMimeType=x-scheme-handler/http;\n";
        assert!(browser_from_desktop_entry(link, "l.desktop", &no).is_none());
        // Hidden / NoDisplay entries are not shown by the desktop, nor by us.
        let hidden = "[Desktop Entry]\nType=Application\nName=H\nExec=h\nNoDisplay=true\nMimeType=x-scheme-handler/http;\n";
        assert!(browser_from_desktop_entry(hidden, "h.desktop", &no).is_none());
        // An empty Exec leaves nothing to run.
        let empty =
            "[Desktop Entry]\nType=Application\nName=E\nExec=%u\nMimeType=x-scheme-handler/http;\n";
        assert!(browser_from_desktop_entry(empty, "e.desktop", &no).is_none());
    }

    /// A MimeType that merely CONTAINS the string must not match — only a whole
    /// `;`-separated entry counts, or `x-scheme-handler/httpx` would pass.
    #[test]
    fn the_http_handler_must_be_a_whole_mime_entry() {
        let no = |_: &Path| false;
        let near =
            "[Desktop Entry]\nType=Application\nName=N\nExec=n\nMimeType=x-scheme-handler/httpx;\n";
        assert!(browser_from_desktop_entry(near, "n.desktop", &no).is_none());
    }

    /// Basename shadowing: the first directory in precedence order that provides
    /// an id wins, exactly as the XDG menu spec says.
    #[test]
    fn a_user_desktop_file_shadows_the_system_one_of_the_same_name() {
        let user = TempTree::new("xdg-user");
        let system = TempTree::new("xdg-system");
        user.write(
            "firefox.desktop",
            "[Desktop Entry]\nType=Application\nName=Firefox (user build)\nExec=/opt/ff/firefox %u\nMimeType=x-scheme-handler/http;\n".as_bytes(),
        );
        system.write("firefox.desktop", FIREFOX_DESKTOP.as_bytes());
        system.write(
            "chromium.desktop",
            "[Desktop Entry]\nType=Application\nName=Chromium\nExec=/usr/bin/chromium %U\nMimeType=x-scheme-handler/http;\n".as_bytes(),
        );
        system.write("notes.txt", b"not a desktop file");

        let got =
            browsers_from_desktop_dirs(&[user.root.clone(), system.root.clone()], &|_: &Path| {
                false
            });
        assert_eq!(
            got.iter()
                .map(|b| b.choice.name.as_str())
                .collect::<Vec<_>>(),
            // chromium sorts after firefox within the system dir; the user's
            // firefox shadows the system's.
            vec!["Firefox (user build)", "Chromium"]
        );
        assert_eq!(got[0].launch.program, "/opt/ff/firefox");
    }

    #[test]
    fn the_xdg_default_browser_output_is_a_single_desktop_id() {
        assert_eq!(
            parse_xdg_default_browser("firefox.desktop\n"),
            Some("firefox.desktop".to_string())
        );
        // Anything that is not a plain desktop id is refused — this value decides
        // which program we start.
        for bad in [
            "",
            "\n",
            "firefox",
            "/usr/bin/firefox.desktop",
            "firefox.desktop extra",
            "ERROR: no method available",
        ] {
            assert_eq!(parse_xdg_default_browser(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_linux_default_is_marked_and_sorted_to_the_front() {
        let mut list = vec![
            browser("chromium.desktop", "Chromium", false, "x"),
            browser("firefox.desktop", "Firefox", false, "x"),
        ];
        mark_linux_default(&mut list, Some("firefox.desktop"));
        assert_eq!(list[0].choice.id, "firefox.desktop");
        assert!(list[0].choice.is_default);
        assert!(!list[1].choice.is_default);
        // No default resolvable → nothing is marked, order stays alphabetical.
        let mut none = vec![
            browser("b.desktop", "Bravo", false, "x"),
            browser("a.desktop", "Alpha", false, "x"),
        ];
        mark_linux_default(&mut none, None);
        assert_eq!(none[0].choice.name, "Alpha");
        assert!(!none.iter().any(|b| b.choice.is_default));
    }

    // ── Windows: reg.exe output parsing (REASONED — untested on Windows) ──────

    /// 🔴 Split on the `REG_SZ` token, never on columns: `reg.exe` pads with a
    /// variable number of spaces and the data contains spaces of its own.
    #[test]
    fn a_reg_line_splits_on_the_type_token_not_on_columns() {
        assert_eq!(
            split_reg_line(
                r"    (Default)    REG_SZ    C:\Program Files\Mozilla Firefox\firefox.exe"
            ),
            Some((
                "(Default)".to_string(),
                "REG_SZ".to_string(),
                r"C:\Program Files\Mozilla Firefox\firefox.exe".to_string()
            ))
        );
        assert_eq!(
            split_reg_line("    ProgId REG_SZ ChromeHTML"),
            Some((
                "ProgId".to_string(),
                "REG_SZ".to_string(),
                "ChromeHTML".to_string()
            ))
        );
        // A key path line has no type token.
        assert_eq!(split_reg_line(r"HKEY_LOCAL_MACHINE\SOFTWARE\Clients"), None);
        assert_eq!(split_reg_line(""), None);
        // A value whose DATA mentions REG_ must not be mistaken for the type.
        let (name, typ, data) =
            split_reg_line(r"    Path    REG_SZ    C:\REG_SZ tools\x.exe").unwrap();
        assert_eq!((name.as_str(), typ.as_str()), ("Path", "REG_SZ"));
        assert_eq!(data, r"C:\REG_SZ tools\x.exe");
    }

    #[test]
    fn a_named_value_is_read_out_of_a_reg_query_block() {
        let block = reg_value_block("ProgId", "ChromeHTML");
        assert_eq!(
            parse_reg_value(&block, "ProgId"),
            Some("ChromeHTML".to_string())
        );
        assert_eq!(parse_reg_value(&block, "Missing"), None);
        // REG_EXPAND_SZ is accepted — some installers write the command that way.
        let expand = "    (Default)    REG_EXPAND_SZ    %ProgramFiles%\\x\\y.exe\r\n";
        assert_eq!(
            parse_reg_value(expand, "(Default)"),
            Some(r"%ProgramFiles%\x\y.exe".to_string())
        );
        // A DWORD is not a string value we can use.
        assert_eq!(
            parse_reg_value("    Flag    REG_DWORD    0x1\r\n", "Flag"),
            None
        );
    }

    /// Only DIRECT children, and never the queried key's own line.
    #[test]
    fn reg_subkeys_are_the_direct_children_only() {
        assert_eq!(
            parse_reg_subkeys(
                REG_SUBKEYS,
                r"HKEY_LOCAL_MACHINE\SOFTWARE\Clients\StartMenuInternet"
            ),
            vec![
                "Google Chrome".to_string(),
                "Firefox-308046B0AF4A39CB".to_string()
            ]
        );
        // `reg.exe` exits 1 and prints nothing when the key does not exist — the
        // NORMAL state of the HKCU hive. Empty, not an error.
        assert!(parse_reg_subkeys("", r"HKCU\SOFTWARE\Clients\StartMenuInternet").is_empty());
    }

    #[test]
    fn the_executable_is_extracted_from_a_shell_open_command() {
        assert_eq!(
            command_executable(
                r#""C:\Program Files\Google\Chrome\Application\chrome.exe" -- "%1""#
            ),
            Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe".to_string())
        );
        assert_eq!(
            command_executable(r"C:\Program Files\Mozilla Firefox\firefox.exe"),
            Some(r"C:\Program Files\Mozilla Firefox\firefox.exe".to_string())
        );
        assert_eq!(
            command_executable(r"C:\browsers\b.exe -osint -url %1"),
            Some(r"C:\browsers\b.exe".to_string())
        );
        assert_eq!(command_executable(""), None);
        assert_eq!(command_executable(r#""""#), None);
    }

    #[test]
    fn the_windows_list_dedupes_hives_and_marks_the_userchoice_default() {
        let chrome_exe = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
        let blocks = vec![
            (
                "Google Chrome".to_string(),
                reg_value_block("(Default)", "Google Chrome"),
                reg_value_block("(Default)", &format!("\"{chrome_exe}\"")),
            ),
            (
                "Firefox-308046B0AF4A39CB".to_string(),
                reg_value_block("(Default)", "Mozilla Firefox"),
                reg_value_block("(Default)", r"C:\Program Files\Mozilla Firefox\firefox.exe"),
            ),
            // The same browser again from the other hive — one menu row, not two.
            (
                "google chrome".to_string(),
                reg_value_block("(Default)", "Google Chrome"),
                reg_value_block("(Default)", &format!("\"{chrome_exe}\"")),
            ),
            // No command value → not launchable → dropped.
            (
                "Broken".to_string(),
                reg_value_block("(Default)", "Broken"),
                String::new(),
            ),
        ];
        // The ProgId resolves to Chrome's exe, in the registry's own casing.
        let got = browsers_from_reg_output(&blocks, Some(&chrome_exe.to_uppercase()));
        assert_eq!(
            got.iter()
                .map(|b| (b.choice.name.as_str(), b.choice.is_default))
                .collect::<Vec<_>>(),
            vec![("Google Chrome", true), ("Mozilla Firefox", false)]
        );
        assert_eq!(got[0].launch.program, chrome_exe);
        assert!(
            got[0].launch.args.is_empty(),
            "no cmd, no start, no title slot"
        );
        // The subkey name falls back as the display name when the block is empty.
        let fallback = browsers_from_reg_output(
            &[(
                "Opera".to_string(),
                String::new(),
                reg_value_block("(Default)", r"C:\o\opera.exe"),
            )],
            None,
        );
        assert_eq!(fallback[0].choice.name, "Opera");
    }

    #[test]
    fn reg_exe_is_absolute_when_system_root_is_known() {
        assert_eq!(
            reg_exe_path(Some(r"C:\Windows")),
            r"C:\Windows\System32\reg.exe"
        );
        assert_eq!(
            reg_exe_path(Some(r"C:\Windows\")),
            r"C:\Windows\System32\reg.exe"
        );
        assert_eq!(reg_exe_path(None), "reg.exe");
        assert_eq!(reg_exe_path(Some("")), "reg.exe");
    }

    // ── the command refuses BEFORE anything is spawned ────────────────────────
    //
    // These call `open_scoped` directly (no `AppHandle`), the way
    // `url_open::url_open_refuses_a_bad_url_without_spawning` does. Each refusal
    // returns before `enumerate_browsers`/`spawn_detached` is reached, so no
    // browser can be launched by the suite.

    /// A file OUTSIDE every allowed root is refused — the clone of
    /// `fs_tree::read_file_rejects_a_path_outside_the_root` for this command.
    #[test]
    fn open_refuses_a_path_outside_the_allowed_roots() {
        let root = TempTree::new("open-scope-root");
        let other = TempTree::new("open-scope-other");
        let outside = other.write("secret.html", b"<h1>loot</h1>");
        let roots = vec![root.canon_root()];
        let err = open_scoped(&outside, None, &roots).unwrap_err();
        assert!(
            err.starts_with("out-of-scope"),
            "out-of-root file leaked: {err}"
        );
    }

    /// A symlink INSIDE the root pointing at a file OUTSIDE it is refused: the
    /// request canonicalizes to the out-of-root target. The clone of
    /// `fs_tree::read_file_rejects_a_symlink_escaping_the_root`.
    #[cfg(unix)]
    #[test]
    fn open_refuses_a_symlink_escaping_the_root() {
        let root = TempTree::new("open-esc-root");
        let outside = TempTree::new("open-esc-outside");
        let target = outside.write("loot.html", b"<h1>secret</h1>");
        std::os::unix::fs::symlink(&target, root.root.join("link.html")).unwrap();
        let roots = vec![root.canon_root()];
        let err = open_scoped(&root.root.join("link.html"), None, &roots).unwrap_err();
        assert!(
            err.starts_with("out-of-scope"),
            "a symlink escaping the root must be rejected, got: {err}"
        );
    }

    /// `..` is resolved before the prefix check, so it cannot climb out.
    #[test]
    fn open_refuses_a_dot_dot_traversal_out_of_the_root() {
        let root = TempTree::new("open-dots-root");
        let other = TempTree::new("open-dots-other");
        other.write("loot.html", b"<h1>x</h1>");
        root.write("page.html", b"<h1>ok</h1>");
        let escape = root
            .root
            .join("..")
            .join(other.root.file_name().unwrap())
            .join("loot.html");
        let err = open_scoped(&escape, None, &[root.canon_root()]).unwrap_err();
        assert!(err.starts_with("out-of-scope"), "{err}");
    }

    #[test]
    fn open_refuses_a_directory_and_a_non_html_file() {
        let t = TempTree::new("open-type");
        t.write("site/index.html", b"<h1>ok</h1>");
        t.write("secrets.env", b"TOKEN=1");
        let roots = vec![t.canon_root()];

        let err = open_scoped(&t.root.join("site"), None, &roots).unwrap_err();
        assert!(
            err.starts_with("not-a-file"),
            "a directory was accepted: {err}"
        );

        let err = open_scoped(&t.root.join("secrets.env"), None, &roots).unwrap_err();
        assert!(
            err.starts_with("not-a-file"),
            "a non-html file was accepted: {err}"
        );

        // A path that does not exist reports the scope code, deliberately: the
        // webview must not learn which of the two it hit.
        let err = open_scoped(&t.root.join("ghost.html"), None, &roots).unwrap_err();
        assert!(err.starts_with("out-of-scope"), "{err}");
    }

    /// An id we never produced is refused on a real, in-scope `.html` file — the
    /// case that proves the id check happens and no browser is started.
    #[test]
    fn open_refuses_an_unknown_browser_id_without_launching_anything() {
        let t = TempTree::new("open-unknown-id");
        let page = t.write("index.html", b"<h1>hi</h1>");
        let roots = vec![t.canon_root()];
        for id in ["/bin/sh", "com.evil.nope", "not-a-browser.desktop"] {
            let err = open_scoped(&page, Some(id), &roots).unwrap_err();
            assert!(
                err.starts_with("unknown-browser"),
                "{id:?} must be unknown-browser, got {err:?}"
            );
        }
    }

    /// The SUCCESS path, end to end, with the browser list injected and nothing
    /// spawned: an in-scope `.html` file plus an id the enumeration produced
    /// yields the exact command line that would run.
    ///
    /// This is the seam test. Without it every refusal is proven
    /// and the working case is not — and a `plan_open` that resolved nothing at
    /// all would still pass every other test in this module.
    #[test]
    fn plan_open_builds_the_real_command_line_for_a_valid_request() {
        let t = TempTree::new("plan-ok");
        let page = t.write("site/index.html", b"<h1>hi</h1>");
        let roots = vec![t.canon_root()];
        let list = vec![
            Browser {
                choice: BrowserChoice {
                    id: "com.google.Chrome".to_string(),
                    name: "Google Chrome".to_string(),
                    is_default: true,
                },
                launch: macos_launch("com.google.Chrome"),
            },
            Browser {
                choice: BrowserChoice {
                    id: "org.mozilla.firefox".to_string(),
                    name: "Firefox".to_string(),
                    is_default: false,
                },
                launch: macos_launch("org.mozilla.firefox"),
            },
        ];
        // The CANONICAL path is what gets opened, not the spelling we were given.
        let canonical = std::fs::canonicalize(&page).unwrap();
        let canonical = launch_path_arg(&canonical.to_string_lossy());

        let (program, args) = plan_open(&page, Some("org.mozilla.firefox"), &roots, &list).unwrap();
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(
            args,
            vec![
                "-b".to_string(),
                "org.mozilla.firefox".to_string(),
                canonical.clone(),
            ]
        );

        // No id → the default, which is the first entry of a default-first list.
        let (_, args) = plan_open(&page, None, &roots, &list).unwrap();
        assert_eq!(
            args,
            vec!["-b".to_string(), "com.google.Chrome".to_string(), canonical]
        );

        // A non-canonical spelling of the same file lands on the same command.
        let noisy = t.root.join("site").join(".").join("index.html");
        let (_, noisy_args) = plan_open(&noisy, Some("com.google.Chrome"), &roots, &list).unwrap();
        assert_eq!(noisy_args.last(), args.last());
    }

    /// Every error this module can return is in the documented vocabulary the
    /// frontend switches on.
    #[test]
    fn every_error_code_is_in_the_published_vocabulary() {
        let t = TempTree::new("open-vocab");
        let page = t.write("index.html", b"<h1>hi</h1>");
        t.write("x.txt", b"x");
        let other = TempTree::new("open-vocab-other");
        let outside = other.write("o.html", b"x");
        let roots = vec![t.canon_root()];

        let errors = vec![
            open_scoped(&outside, None, &roots).unwrap_err(),
            open_scoped(&t.root.join("x.txt"), None, &roots).unwrap_err(),
            open_scoped(&t.root, None, &roots).unwrap_err(),
            open_scoped(&page, Some("nope"), &roots).unwrap_err(),
            resolve_requested(&[], None).unwrap_err(),
        ];
        for err in errors {
            let code = err.split(':').next().unwrap_or_default();
            assert!(
                ERROR_CODES.contains(&code),
                "{code:?} is not in ERROR_CODES ({err})"
            );
        }
    }

    // ── the live enumeration (ignored by design: `cargo test` stays hermetic) ──

    /// Enumerates the browsers on THIS machine. 🔴 Launches nothing.
    ///
    /// `#[ignore]`d because it reads the real `/Applications` (or the real XDG
    /// dirs): `cargo test` must stay hermetic. `npm run verify` runs it by name.
    ///
    /// A verification chain is platform-specific evidence: the
    /// non-empty assertion is made only on macOS, where Safari is part of the OS.
    /// On Linux the list is printed and not asserted, because a headless box with
    /// no browser installed is a legitimate state, not a regression.
    #[test]
    #[ignore = "reads the real machine's installed applications; run via npm run verify"]
    fn live_enumerates_the_browsers_installed_on_this_machine() {
        let browsers = enumerate_browsers();
        for b in &browsers {
            println!(
                "  {} {:<24} {}  →  {} {:?}",
                if b.choice.is_default { "*" } else { " " },
                b.choice.name,
                b.choice.id,
                b.launch.program,
                b.launch.args
            );
        }
        assert!(
            browsers.iter().filter(|b| b.choice.is_default).count() <= 1,
            "at most one browser may be the default"
        );
        if cfg!(target_os = "macos") {
            assert!(
                !browsers.is_empty(),
                "macOS always ships Safari, so the scan must find at least one browser"
            );
            assert!(
                browsers[0].choice.is_default,
                "the list must be default-first, got {:?}",
                browsers.iter().map(|b| &b.choice).collect::<Vec<_>>()
            );
            for b in &browsers {
                assert_eq!(b.launch.program, "/usr/bin/open");
                assert_eq!(b.launch.args.first().map(String::as_str), Some("-b"));
            }
            // Resolvable with no enumeration at all — the "system default" leaf
            // `browserIpc.ts` falls back to when the list comes back empty.
            let fallback = default_launch(&[]).unwrap();
            assert_eq!(fallback.program, "/usr/bin/open");
            println!("  default (LaunchServices): {:?}", fallback.args);
        }

        // The seam, live and still spawning nothing: an id this machine's own
        // enumeration produced must plan a command line, never `unknown-browser`.
        if let Some(first) = browsers.first() {
            let t = TempTree::new("live-plan");
            let page = t.write("index.html", b"<h1>hi</h1>");
            let planned = plan_open(&page, Some(&first.choice.id), &[t.canon_root()], &browsers)
                .expect("an id from list_browsers must be accepted by open_in_browser");
            println!("  would run: {} {:?}", planned.0, planned.1);
            // The CANONICAL path — on macOS `/var/folders/…` really is
            // `/private/var/folders/…`, and the canonical one is what is opened.
            let canonical = std::fs::canonicalize(&page).unwrap();
            assert_eq!(
                planned.1.last().map(String::as_str),
                Some(launch_path_arg(&canonical.to_string_lossy()).as_str())
            );
        }
    }
}
