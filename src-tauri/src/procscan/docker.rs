//! Docker containers as dev apps, passively: only if a `docker` CLI already exists at an
//! absolute candidate path (GUI `PATH` is minimal); run only from `procs_list`, never at startup
//! or in tests. Docker down or hanging → `containers: []` plus a `reason`, never an error.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::spawn::NoWindow as _;
use serde::Deserialize;

/// Where a `docker` CLI may be on macOS and Linux, in order. `~` is the user's home.
pub const UNIX_CANDIDATES: &[&str] = &[
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "~/.docker/bin/docker",
    "/usr/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
];

// Never one list for every OS: on Windows `/usr/local/bin/docker` is drive-relative, a folder
// any user can create. Unix list only off Windows; Windows accepts only drive or UNC paths.

/// `docker ps` gets this long before we say it did not answer.
pub const PS_TIMEOUT: Duration = Duration::from_secs(3);

/// One running container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    /// Host ports published (`0.0.0.0:5432->5432/tcp` → 5432), ascending.
    pub ports: Vec<u16>,
    /// The compose project's working dir (label `com.docker.compose.project.working_dir`).
    pub working_dir: Option<String>,
    pub status: String,
}

/// Windows install folders of a `docker.exe`, as `(environment variable, path under it)`:
/// Docker Desktop (under `%ProgramFiles%`, and `%ProgramW6432%` for the 64-bit folder when the
/// variable is the x86 one), Rancher Desktop (per-user and machine-wide).
pub const WINDOWS_DOCKER_DIRS: &[(&str, &str)] = &[
    ("ProgramFiles", r"Docker\Docker\resources\bin\docker.exe"),
    ("ProgramW6432", r"Docker\Docker\resources\bin\docker.exe"),
    (
        "LOCALAPPDATA",
        r"Programs\Rancher Desktop\resources\resources\win32\bin\docker.exe",
    ),
    (
        "ProgramFiles",
        r"Rancher Desktop\resources\resources\win32\bin\docker.exe",
    ),
];

/// Docker Desktop's default CLI, for a machine whose `%ProgramFiles%` is not even set.
pub const WINDOWS_DOCKER_DEFAULT: &str = r"C:\Program Files\Docker\Docker\resources\bin\docker.exe";

/// An absolute Windows path: `C:\…`/`C:/…`, or a UNC `\\server\share…`. Never `bin`, `.`, or an
/// unexpanded `%VAR%\bin`.
fn windows_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    p.starts_with(r"\\")
        || (b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'\\' | b'/'))
}

/// Where a `docker` CLI may be, in order (Windows: absolute `PATH` entries, then
/// [`WINDOWS_DOCKER_DIRS`], then Docker Desktop's default). `windows` picks the list (both tested
/// everywhere); `home` expands `~`; `var` reads an env var. Paths are built as strings.
pub fn candidates(
    windows: bool,
    home: Option<&Path>,
    var: &dyn Fn(&str) -> Option<String>,
) -> Vec<PathBuf> {
    if !windows {
        // `/`-rooted only: a relative home (`home/d`) must not turn `~/…` into a path that
        // resolves against the app's cwd. (POSIX rooted, not `Path::is_absolute`, so this list
        // is testable on every OS — it is never consulted on Windows.)
        return UNIX_CANDIDATES
            .iter()
            .filter_map(|c| match c.strip_prefix("~/") {
                Some(rest) => home.map(|h| h.join(rest)),
                None => Some(PathBuf::from(c)),
            })
            .filter(|p| p.to_string_lossy().starts_with('/'))
            .collect();
    }
    let join = |dir: &str, rest: &str| format!(r"{}\{rest}", dir.trim_end_matches(['\\', '/']));
    let mut out: Vec<String> = Vec::new();
    if let Some(path) = var("PATH") {
        for entry in path.split(';') {
            let dir = entry.trim().trim_matches('"');
            if windows_absolute(dir) {
                out.push(join(dir, "docker.exe"));
            }
        }
    }
    for (name, rest) in WINDOWS_DOCKER_DIRS {
        if let Some(base) = var(name).filter(|b| windows_absolute(b)) {
            out.push(join(&base, rest));
        }
    }
    out.push(WINDOWS_DOCKER_DEFAULT.to_string());
    let mut seen: Vec<String> = Vec::new();
    out.retain(|p| {
        let key = p.to_ascii_lowercase().replace('/', "\\");
        let new = !seen.contains(&key);
        seen.push(key);
        new
    });
    out.into_iter().map(PathBuf::from).collect()
}

/// The first candidate that exists ([`candidates`] for this OS and environment).
pub fn find_docker(home: Option<&Path>, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    find_docker_with(cfg!(windows), home, &|k| std::env::var(k).ok(), exists)
}

/// [`find_docker`] with the OS and the environment explicit.
pub fn find_docker_with(
    windows: bool,
    home: Option<&Path>,
    var: &dyn Fn(&str) -> Option<String>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    candidates(windows, home, var)
        .into_iter()
        .find(|p| exists(p))
}

#[derive(Deserialize)]
struct PsRow {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Names", default)]
    names: String,
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "Ports", default)]
    ports: String,
    #[serde(rename = "Labels", default)]
    labels: String,
    #[serde(rename = "State", default)]
    state: String,
    #[serde(rename = "Status", default)]
    status: String,
}

/// Host ports from `docker ps`'s `Ports` column.
pub fn host_ports(s: &str) -> Vec<u16> {
    let mut out: Vec<u16> = s
        .split(',')
        .filter_map(|m| {
            let (host, _) = m.trim().split_once("->")?;
            host.rsplit(':').next()?.parse().ok()
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// Is `id` shaped like a container id or name (so it can never be read as a flag)?
pub fn valid_container_ref(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        && id.len() <= 128
}

/// `docker ps --format '{{json .}}'` → running containers. A line that does not parse, or
/// a container that is not `running`, is skipped.
pub fn parse_ps(text: &str) -> Vec<Container> {
    let mut out: Vec<Container> = text
        .lines()
        .filter_map(|l| serde_json::from_str::<PsRow>(l.trim()).ok())
        .filter(|r| r.state.is_empty() || r.state == "running")
        .filter(|r| valid_container_ref(&r.id))
        .map(|r| {
            let working_dir = r.labels.split(',').find_map(|kv| {
                kv.strip_prefix("com.docker.compose.project.working_dir=")
                    .map(str::to_string)
            });
            Container {
                name: r
                    .names
                    .split(',')
                    .next()
                    .filter(|n| !n.is_empty())
                    .unwrap_or(&r.id)
                    .to_string(),
                ports: host_ports(&r.ports),
                id: r.id,
                image: r.image,
                working_dir,
                status: r.status,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The reason line for a failed `docker ps`, from its stderr.
pub fn ps_failure_reason(stderr: &str) -> String {
    let first = stderr.lines().map(str::trim).find(|l| !l.is_empty());
    match first {
        Some(l)
            if l.contains("Cannot connect to the Docker daemon")
                || l.contains("daemon running")
                // Windows, Docker Desktop stopped: the CLI cannot open the engine's named pipe
                // (`error during connect: … open //./pipe/dockerDesktopLinuxEngine: The system
                // cannot find the file specified.`).
                || (l.contains("error during connect") && l.contains("pipe")) =>
        {
            "Docker is not running".to_string()
        }
        Some(l) => format!("docker ps failed: {}", crate::logstream::cap_text(l, 200)),
        None => "docker ps failed".to_string(),
    }
}

/// Run `docker ps` (the view is open). `Ok(containers)` or `Err(reason)`.
pub async fn list(docker: &Path) -> Result<Vec<Container>, String> {
    let mut cmd = tokio::process::Command::new(docker);
    cmd.args(["ps", "--no-trunc", "--format", "{{json .}}"])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .no_window();
    match tokio::time::timeout(PS_TIMEOUT, cmd.output()).await {
        Err(_) => Err(format!(
            "docker ps did not answer within {} s",
            PS_TIMEOUT.as_secs()
        )),
        Ok(Err(e)) => Err(format!("docker could not be run: {e}")),
        Ok(Ok(out)) if !out.status.success() => {
            Err(ps_failure_reason(&String::from_utf8_lossy(&out.stderr)))
        }
        Ok(Ok(out)) => Ok(parse_ps(&String::from_utf8_lossy(&out.stdout))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn candidates_in_order_with_home_expanded() {
        let home = Path::new("/Users/me");
        let found = find_docker_with(false, Some(home), &no_env, |p| {
            p == Path::new("/Users/me/.docker/bin/docker") || p == Path::new("/usr/bin/docker")
        });
        assert_eq!(found, Some(PathBuf::from("/Users/me/.docker/bin/docker")));
        assert_eq!(find_docker_with(false, None, &no_env, |_| false), None);
        assert_eq!(
            find_docker_with(false, None, &no_env, |p| p == Path::new("/usr/bin/docker")),
            Some(PathBuf::from("/usr/bin/docker")),
            "no home: the ~ candidate is skipped, not an error"
        );
        // The unix list ignores PATH (a GUI app's PATH is the system's).
        let with_path = |k: &str| (k == "PATH").then(|| "/opt/x/bin".to_string());
        assert!(!candidates(false, Some(home), &with_path)
            .iter()
            .any(|p| p.starts_with("/opt/x")));
    }

    /// Hand-written expectations: PATH entries first (absolute ones only, quotes
    /// and blanks trimmed, once each in any case), then the install folders, then the default.
    #[test]
    fn windows_candidates_are_path_then_install_folders_then_the_default() {
        let env = |k: &str| -> Option<String> {
            match k {
                "PATH" => Some(
                    r#"C:\Windows\system32;.;bin;%USERPROFILE%\bin; "C:\Tools\Docker" ;C:\Program Files\Docker\Docker\resources\bin\;\\srv\tools;D:/scoop/shims;;c:\tools\docker"#
                        .to_string(),
                ),
                "ProgramFiles" => Some(r"C:\Program Files".to_string()),
                "ProgramW6432" => Some(r"C:\Program Files".to_string()),
                "LOCALAPPDATA" => Some(r"C:\Users\me\AppData\Local".to_string()),
                _ => None,
            }
        };
        let got: Vec<String> = candidates(true, None, &env)
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            got,
            vec![
                r"C:\Windows\system32\docker.exe",
                r"C:\Tools\Docker\docker.exe",
                r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
                r"\\srv\tools\docker.exe",
                r"D:/scoop/shims\docker.exe",
                r"C:\Users\me\AppData\Local\Programs\Rancher Desktop\resources\resources\win32\bin\docker.exe",
                r"C:\Program Files\Rancher Desktop\resources\resources\win32\bin\docker.exe",
            ]
        );
        // Nothing in the environment: Docker Desktop's default folder alone.
        assert_eq!(
            candidates(true, None, &no_env),
            vec![PathBuf::from(WINDOWS_DOCKER_DEFAULT)]
        );
        assert_eq!(
            find_docker_with(true, None, &env, |p| p
                .to_string_lossy()
                .contains("Rancher Desktop")),
            Some(PathBuf::from(
                r"C:\Users\me\AppData\Local\Programs\Rancher Desktop\resources\resources\win32\bin\docker.exe"
            )),
            "the first that exists"
        );
    }

    /// On Windows itself: a `docker.exe` in a PATH folder is found through the real file system.
    /// (Docker is not installed on the test VM — this proves the lookup, not Docker.)
    #[cfg(windows)]
    #[test]
    fn windows_a_docker_exe_on_path_is_found_on_disk() {
        let dir = std::env::temp_dir().join(format!("agentstudio-docker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = crate::paths::canonicalize(&dir).unwrap();
        std::fs::write(dir.join("docker.exe"), b"MZ").unwrap();
        let path = format!(r"C:\nowhere-{};{}", std::process::id(), dir.display());
        let env = move |k: &str| (k == "PATH").then(|| path.clone());
        assert_eq!(
            find_docker_with(true, None, &env, |p| p.is_file()),
            Some(dir.join("docker.exe"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The per-OS lookup list's guard, on this lookup: a relative home never turns `~/…` into a
    /// path that resolves against the app's cwd.
    #[test]
    fn a_path_that_is_not_absolute_is_never_picked() {
        let relative_home = candidates(false, Some(Path::new("home/me")), &no_env);
        assert!(
            relative_home
                .iter()
                .all(|p| p.to_string_lossy().starts_with('/')),
            "a relative home does not make an absolute path: {relative_home:?}"
        );
        assert!(!relative_home.iter().any(|p| p.starts_with("home")));
        assert!(UNIX_CANDIDATES
            .iter()
            .all(|c| c.starts_with('/') || c.starts_with("~/")));
    }

    /// On Windows no candidate is drive-less (not the unix list, a rooted `\usr\…` PATH entry or a
    /// relative install variable): such folders can be created by any standard user.
    #[test]
    fn every_windows_candidate_has_a_drive_or_is_unc() {
        let env = |k: &str| -> Option<String> {
            match k {
                "PATH" => Some(r"\usr\local\bin;/usr/local/bin;bin;C:\Tools".to_string()),
                "ProgramFiles" => Some("Program Files".to_string()),
                "LOCALAPPDATA" => Some(r"\Users\me\AppData\Local".to_string()),
                _ => None,
            }
        };
        let got = candidates(true, None, &env);
        assert_eq!(
            got,
            vec![
                PathBuf::from(r"C:\Tools\docker.exe"),
                PathBuf::from(WINDOWS_DOCKER_DEFAULT)
            ]
        );
        for p in &got {
            assert!(windows_absolute(&p.to_string_lossy()), "{p:?} has no drive");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_never_picks_a_unix_path() {
        let found = find_docker(None, |_| true).expect("Docker Desktop's default at least");
        let s = found.to_string_lossy();
        assert!(windows_absolute(&s), "{s}");
        assert!(!UNIX_CANDIDATES.iter().any(|u| s.contains(u)), "{s}");
    }

    #[test]
    fn ports_are_the_host_side() {
        assert_eq!(
            host_ports("0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 127.0.0.1:8080->80/tcp"),
            vec![5432, 8080]
        );
        assert_eq!(
            host_ports("6379/tcp"),
            Vec::<u16>::new(),
            "exposed, not published"
        );
        assert_eq!(host_ports(""), Vec::<u16>::new());
    }

    #[test]
    fn container_refs() {
        assert!(valid_container_ref("3f2a9c1b0d4e"));
        assert!(valid_container_ref("db-fixtures-postgres-1"));
        assert!(!valid_container_ref("-f"));
        assert!(!valid_container_ref("a b"));
        assert!(!valid_container_ref(""));
        assert!(!valid_container_ref("../x"));
    }

    #[test]
    fn failure_reasons() {
        assert_eq!(
            ps_failure_reason(
                "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n"
            ),
            "Docker is not running"
        );
        assert_eq!(
            ps_failure_reason(
                "error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/json\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.\n"
            ),
            "Docker is not running",
            "Windows, Docker Desktop stopped"
        );
        assert_eq!(ps_failure_reason("\n  boom\n"), "docker ps failed: boom");
        assert_eq!(ps_failure_reason(""), "docker ps failed");
    }
}
