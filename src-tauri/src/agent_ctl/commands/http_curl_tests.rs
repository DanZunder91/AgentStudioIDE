//! The curl reader: the cases the API client's import is tested on (`curlParse.test.ts`), and
//! the refusals an agent gets instead of a quietly different request.
use super::*;

fn h(name: &str, value: &str) -> (String, String) {
    (name.to_string(), value.to_string())
}

#[test]
fn a_plain_get_and_a_post_with_headers_and_a_json_body() {
    let p = parse("curl https://api.example.com/users").unwrap();
    assert_eq!(p.method, "GET");
    assert_eq!(p.url, "https://api.example.com/users");
    assert!(p.headers.is_empty() && p.body.is_none() && p.timeout_ms.is_none());

    let p = parse(
        "curl -X POST 'https://api.example.com/users' \\\n  -H 'Content-Type: application/json' \
         -H \"Accept: */*\" --data '{\"name\":\"Ada\"}'",
    )
    .unwrap();
    assert_eq!(p.method, "POST");
    assert_eq!(
        p.headers,
        vec![h("Content-Type", "application/json"), h("Accept", "*/*")]
    );
    assert_eq!(p.body.as_deref(), Some("{\"name\":\"Ada\"}"));
}

#[test]
fn a_body_implies_post_and_several_data_flags_join_with_ampersands() {
    let p = parse("curl https://h/x -d a=1 --data-binary b=2 --data-raw @literal").unwrap();
    assert_eq!(p.method, "POST");
    assert_eq!(p.body.as_deref(), Some("a=1&b=2&@literal"));
}

#[test]
fn bundled_attached_and_equals_forms_reach_the_right_flag() {
    let p = parse("curl -sX POST http://h/a").unwrap();
    assert_eq!((p.method.as_str(), p.url.as_str()), ("POST", "http://h/a"));
    let p = parse("curl -XPUT -H'X-A: 1' --url=http://h/b --request=patch").unwrap();
    assert_eq!(p.method, "PATCH");
    assert_eq!(p.url, "http://h/b");
    assert_eq!(p.headers, vec![h("X-A", "1")]);
    assert_eq!(
        normalize_flags(vec!["-sLk".into(), "-".into()]),
        vec!["-s", "-L", "-k", "-"]
    );
}

#[test]
fn a_value_taking_flag_never_donates_its_value_to_the_url() {
    let p =
        parse("curl -o out.json -w '%{http_code}' --output x --retry 3 https://h/real").unwrap();
    assert_eq!(p.url, "https://h/real");
    // A later word with a scheme beats an earlier bare word.
    let p = parse("curl stray https://h/real").unwrap();
    assert_eq!(p.url, "https://h/real");
    let p = parse("curl https://h/first https://h/second").unwrap();
    assert_eq!(p.url, "https://h/first");
}

#[test]
fn quoting_follows_bash() {
    assert_eq!(
        tokenize(r#"a 'b c' "d \"e\"" f\ g $'it\'s\n' $'\x41é\q' '' x"#),
        vec!["a", "b c", "d \"e\"", "f g", "it's\n", "Aé\\q", "", "x"]
    );
    let p = parse("curl $'https://h/x' --data-raw $'{\"note\":\"it\\'s\"}'").unwrap();
    assert_eq!(p.body.as_deref(), Some("{\"note\":\"it's\"}"));
    // Windows line endings still continue a line.
    let p = parse("curl https://h/x \\\r\n -H 'A: 1'").unwrap();
    assert_eq!(p.headers, vec![h("A", "1")]);
    assert!(is_curl_command("  curl -s x") && is_curl_command("CURL.exe x"));
    assert!(!is_curl_command("curl") && !is_curl_command("curly x") && !is_curl_command("x"));
}

#[test]
fn user_cookie_and_header_shorthands_become_headers() {
    let p = parse(
        "curl -u ada:pw -b 'a=1' -b b=2 -b cookies.txt -A agent/1 -e https://ref/ \
         --oauth2-bearer tok -H 'X-Empty;' -H 'nocolon' https://h/",
    )
    .unwrap();
    assert_eq!(
        p.headers,
        vec![
            h("Authorization", "Basic YWRhOnB3"),
            h("Cookie", "a=1; b=2"),
            h("User-Agent", "agent/1"),
            h("Referer", "https://ref/"),
            h("Authorization", "Bearer tok"),
            h("X-Empty", ""),
        ]
    );
}

#[test]
fn json_get_head_and_max_time_are_read() {
    let p = parse("curl --json '{\"a\":1}' https://h/").unwrap();
    assert_eq!(p.method, "POST");
    assert_eq!(p.body.as_deref(), Some("{\"a\":1}"));
    assert_eq!(
        p.headers,
        vec![
            h("Content-Type", "application/json"),
            h("Accept", "application/json")
        ]
    );
    let p = parse("curl --json '{}' -H 'content-type: text/x' -H 'ACCEPT: y' https://h/").unwrap();
    assert_eq!(p.headers.len(), 2, "set headers are kept, not doubled");

    let p = parse("curl -G https://h/s?x=1 -d q=a --data-urlencode 'name=hello world'").unwrap();
    assert_eq!(p.method, "GET");
    assert!(p.body.is_none());
    assert_eq!(p.url, "https://h/s?x=1&q=a&name=hello%20world");
    let p = parse("curl --get https://h/s --data-urlencode '=a&b' --data-urlencode c~d").unwrap();
    assert_eq!(p.url, "https://h/s?a%26b&c~d");

    let p = parse("curl -I https://h/").unwrap();
    assert_eq!(p.method, "HEAD");
    let p = parse("curl -m 2.5 https://h/").unwrap();
    assert_eq!(p.timeout_ms, Some(2500));
    assert!(parse("curl -m soon https://h/")
        .unwrap_err()
        .contains("seconds"));
}

#[test]
fn glob_escapes_are_stripped_unless_globbing_is_off() {
    let p = parse(r"curl 'https://h/x?f\[a\]=1&g\{b\}=2'").unwrap();
    assert_eq!(p.url, "https://h/x?f[a]=1&g{b}=2");
    let p = parse(r"curl -g 'https://h/x?f\[a\]=1'").unwrap();
    assert_eq!(p.url, r"https://h/x?f\[a\]=1");
}

#[test]
fn uploads_files_stdin_and_config_are_refused_not_dropped() {
    for cmd in [
        "curl -d @body.json https://h/",
        "curl --data-binary @- https://h/",
        "curl --json @x.json https://h/",
        "curl --data-urlencode @f https://h/",
        "curl --data-urlencode name@f https://h/",
    ] {
        let err = parse(cmd).unwrap_err();
        assert!(err.contains("from a file or stdin"), "{cmd}: {err}");
    }
    assert!(parse("curl -F a=@f https://h/")
        .unwrap_err()
        .contains("form"));
    assert!(parse("curl -T f https://h/")
        .unwrap_err()
        .contains("uploads a file"));
    assert!(parse("curl -K cfg https://h/")
        .unwrap_err()
        .contains("config file"));
    assert_eq!(
        parse("curl -s -L").unwrap_err(),
        "That curl command has no URL."
    );
    assert_eq!(
        parse("curl -X").unwrap_err(),
        "That curl command has no URL."
    );
}
