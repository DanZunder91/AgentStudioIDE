//! The reply shapes: caps that say they cut, order-preserving JSON, redaction of substituted
//! values and credential-looking URL parts, and the compare diff.
use super::*;

fn header(name: &str, value: &str) -> HttpHeader {
    HttpHeader {
        name: name.into(),
        value: value.into(),
    }
}

fn response(status: u16, headers: Vec<HttpHeader>, body: &str) -> HttpResponse {
    HttpResponse {
        status,
        status_text: if status == 200 {
            "OK".into()
        } else {
            "Other".into()
        },
        headers,
        body: body.into(),
        duration_ms: 12,
        size_bytes: body.len(),
        truncated: false,
    }
}

#[test]
fn cutting_respects_character_boundaries_and_numbers_read_well() {
    assert_eq!(cut("abc", 3), ("abc", false));
    assert_eq!(cut("abcd", 3), ("abc", true));
    assert_eq!(cut("aé", 2), ("a", true), "never splits a character");
    assert_eq!(thousands(0), "0");
    assert_eq!(thousands(65_536), "65,536");
    assert_eq!(thousands(1_234_567), "1,234,567");
    assert_eq!(human_size(10), "10 B");
    assert_eq!(human_size(1536), "1.5 KB");
    assert_eq!(human_size(3 * 1024 * 1024), "3.0 MB");
    assert_eq!(short("a\nb\rc"), "a b c");
    let long = "x".repeat(VALUE_CAP + 5);
    assert_eq!(short(&long).chars().count(), VALUE_CAP + 1);
    assert!(short(&long).ends_with('…'));
}

#[test]
fn json_is_reindented_in_the_servers_key_order_and_text_is_left_alone() {
    let text =
        r#"{"z":1,"a":{"q":[1, 2,{}],"e":[]},"s":"x, {y}: \"q\" \\","n":12345678901234567890}"#;
    let pretty = pretty_json(text).unwrap();
    assert_eq!(
        pretty,
        "{\n  \"z\": 1,\n  \"a\": {\n    \"q\": [\n      1,\n      2,\n      {}\n    ],\n    \
         \"e\": []\n  },\n  \"s\": \"x, {y}: \\\"q\\\" \\\\\",\n  \"n\": 12345678901234567890\n}"
    );
    assert_eq!(pretty_json("[]").as_deref(), Some("[]"));
    assert_eq!(pretty_json("plain text"), None);
    assert_eq!(pretty_json("{not json"), None);
    assert_eq!(pretty_json("42"), None, "a bare scalar is shown as it came");
}

#[test]
fn the_redactor_puts_names_back_for_every_spelling_of_a_substituted_value() {
    let r = Redactor::new(&[
        ("TOKEN".into(), "s3cr3t-tok/en+1".into()),
        ("SHORT".into(), "ab".into()),
        ("HOST".into(), "api.internal.example".into()),
    ]);
    assert!(!r.is_empty());
    let echoed = "auth=s3cr3t-tok/en+1 link=https://api.internal.example/x?t=s3cr3t-tok%2Fen%2B1 \
                  path=/s3cr3t-tok/en+1 ab stays";
    let out = r.apply(echoed);
    assert!(!out.contains("s3cr3t"), "{out}");
    assert!(!out.contains("api.internal.example"), "{out}");
    assert!(out.contains("auth={{TOKEN}}"), "{out}");
    assert!(out.contains("https://{{HOST}}/x?t={{TOKEN}}"), "{out}");
    assert!(
        out.contains("ab stays"),
        "short values are not redacted: {out}"
    );

    let resp = r.response(response(
        200,
        vec![header("location", "https://api.internal.example/next")],
        "{\"echo\":\"Bearer s3cr3t-tok/en+1\"}",
    ));
    assert_eq!(resp.headers[0].value, "https://{{HOST}}/next");
    assert_eq!(resp.body, "{\"echo\":\"Bearer {{TOKEN}}\"}");
    // A value with a quote comes back JSON-escaped from an echo endpoint.
    let quoted = Redactor::new(&[("PW".into(), "pa\"ss\\word".into())]);
    assert_eq!(
        quoted.apply(r#"{"pw":"pa\"ss\\word"}"#),
        r#"{"pw":"{{PW}}"}"#
    );
    // Nothing to redact: the response comes back untouched.
    let plain = Redactor::default().response(response(200, vec![], "s3cr3t"));
    assert_eq!(plain.body, "s3cr3t");
    assert!(Redactor::new(&[("A".into(), "xyz".into())]).is_empty());
}

/// The spellings servers really echo: a form-decoded query reads `+` as a space, PHP-style JSON
/// escapes `/` as `\/`, percent-escapes come in lowercase hex too, a form encoder writes a
/// space as `+`. Falsify: drop any one of those forms in `Redactor::forms` — its row goes red.
#[test]
fn the_redactor_catches_form_decoded_slash_escaped_and_lowercase_hex_echoes() {
    let r = Redactor::new(&[
        ("TOKEN".into(), "s3cr3t-tok/en+1".into()),
        ("PW".into(), "pa ss/wörd".into()),
    ]);
    for echoed in [
        "s3cr3t-tok/en 1",
        "s3cr3t-tok\\/en+1",
        "s3cr3t-tok%2fen%2b1",
        "\"t\":\"s3cr3t-tok\\/en 1\"",
        "pa+ss%2Fw%C3%B6rd",
        "pa+ss%2fw%c3%b6rd",
        "pa ss\\/wörd",
    ] {
        let out = r.apply(echoed);
        assert!(!out.contains("s3cr3t"), "{echoed} → {out}");
        assert!(
            !out.contains("ss/w") && !out.contains("ss%2"),
            "{echoed} → {out}"
        );
        assert!(
            out.contains("{{TOKEN}}") || out.contains("{{PW}}"),
            "{echoed} → {out}"
        );
    }
}

/// A literal credential reads as `***`, a substituted value as its name, and where both know one
/// spelling the name wins.
#[test]
fn a_substituted_value_keeps_its_name_over_the_mask() {
    let used = Redactor::new(&[("TOKEN".into(), "tok_shared_123".into())]);
    let r = used.masking(&["tok_shared_123".into(), "literal-pass".into(), "ab".into()]);
    assert_eq!(
        r.apply("a=tok_shared_123 b=literal-pass c=ab"),
        "a={{TOKEN}} b=*** c=ab",
        "the name wins over the mask; a two-letter value is left alone"
    );
}

/// reqwest's WHATWG parser reads a userinfo after any run of `/` and `\` behind a special scheme,
/// in any case, with tabs/newlines dropped and ends trimmed, and sends it as Basic auth.
#[test]
fn userinfo_is_masked_in_every_spelling_the_url_parser_reads() {
    let cases = [
        (
            "https:///sk_live_TRIPLE:@api.stripe.com/v1",
            "https:///***:@api.stripe.com/v1",
        ),
        (
            "https:/sk_live_SINGLE:@api.stripe.com/v1",
            "https:/***:@api.stripe.com/v1",
        ),
        (
            "https:sk_live_NOSLASH:@api.stripe.com/v1",
            "https:***:@api.stripe.com/v1",
        ),
        (
            "https:\\\\sk_live_BACK:@api.stripe.com/v1",
            "https:\\\\***:@api.stripe.com/v1",
        ),
        (
            "HTTPS:/\\ghp_MIXED@github.com/o/r",
            "HTTPS:/\\***@github.com/o/r",
        ),
        ("wss:////u:pw@h/socket", "wss:////***:***@h/socket"),
        (" https:/\t/tab_user:tab_pw@h/x\n", "https://***:***@h/x"),
        ("https:/{{U}}:{{P}}@h/", "https:/{{U}}:{{P}}@h/"),
        // A `\` ends a special URL's authority: this `@` is in the path.
        ("https:\\\\h\\a@b", "https:\\\\h\\a@b"),
        // Not special: `///` leaves an empty authority, and the `@` is in the path.
        ("postgres:///u:pw@h/db", "postgres:///u:pw@h/db"),
    ];
    for (url, want) in cases {
        assert_eq!(redact_url(url), want, "{url:?}");
    }
    assert_eq!(
        url_secrets("https:///sk_live_TRIPLE:@api.stripe.com/v1"),
        vec!["sk_live_TRIPLE"]
    );
    assert_eq!(
        url_secrets("https:/sk_live_SINGLE:pw_SINGLE@api.stripe.com/v1"),
        vec!["sk_live_SINGLE", "pw_SINGLE"]
    );
    assert_eq!(
        redact_urls_in("for url (https:///sk_live_X:@h/v1)"),
        "for url (https:///***:@h/v1)"
    );

    // Every spelling the parser reads a userinfo from is masked: schemes in any case, every run
    // of slashes and backslashes, tabs and newlines inside, spaces around.
    let mut parsed_with_userinfo = 0;
    for scheme in ["http", "HTTPS", "wss", "Ftp"] {
        for slashes in [
            "", "/", "//", "///", "////", "\\", "\\\\", "/\\", "\\/", "/\t/", "\n//",
        ] {
            for (before, after) in [("", ""), ("  ", " "), ("\t", "\r\n")] {
                let url = format!(
                    "{before}{scheme}:{slashes}usr_SECRET1:pw_SECRET2@h.example/p?q=1{after}"
                );
                let Ok(u) = reqwest::Url::parse(&url) else {
                    continue;
                };
                if u.username().is_empty() && u.password().is_none() {
                    continue;
                }
                parsed_with_userinfo += 1;
                let out = redact_url(&url);
                for secret in ["usr_SECRET1", "pw_SECRET2"] {
                    assert!(!out.contains(secret), "{url:?} → {out:?}");
                    assert!(url_secrets(&url).iter().any(|s| s == secret), "{url:?}");
                }
            }
        }
    }
    assert!(parsed_with_userinfo >= 100, "{parsed_with_userinfo}");
}

/// Slack/Discord webhook URLs and Telegram bot tokens carry a credential in their path.
#[test]
fn credentials_in_well_known_webhook_and_bot_paths_are_masked() {
    let cases = [
        (
            "https://hooks.slack.com/services/T000/B000/SLACKPATHSECRET",
            "https://hooks.slack.com/services/***/***/***",
        ),
        (
            "https://hooks.slack.com/workflows/T1/A2/333/WFSECRET",
            "https://hooks.slack.com/workflows/***/***/***/***",
        ),
        (
            "https://HOOKS.Slack.com:443/services/T/B/XSECRET",
            "https://HOOKS.Slack.com:443/services/***/***/***",
        ),
        (
            "https://discord.com/api/webhooks/123456/DISCORDTOKEN?wait=true",
            "https://discord.com/api/webhooks/***/***?wait=true",
        ),
        (
            "https://discordapp.com/api/v10/webhooks/1/DTOK",
            "https://discordapp.com/api/v10/webhooks/***/***",
        ),
        (
            "https://canary.discord.com/api/webhooks/1/DTOK",
            "https://canary.discord.com/api/webhooks/***/***",
        ),
        (
            "https://api.telegram.org/bot123456:ABC-DEF/sendMessage?chat_id=1",
            "https://api.telegram.org/bot***/sendMessage?chat_id=1",
        ),
        (
            "https://api.telegram.org/file/bot123456:ABC/photos/p.jpg",
            "https://api.telegram.org/file/bot***/photos/p.jpg",
        ),
        (
            "https://hooks.slack.com/services/{{SLACK_HOOK}}",
            "https://hooks.slack.com/services/{{SLACK_HOOK}}",
        ),
        (
            "https://api.telegram.org/bot{{TG_TOKEN}}/getMe",
            "https://api.telegram.org/bot{{TG_TOKEN}}/getMe",
        ),
        (
            "https://discord.com/channels/1/2",
            "https://discord.com/channels/1/2",
        ),
        (
            "https://notdiscord.com/api/webhooks/1/x",
            "https://notdiscord.com/api/webhooks/1/x",
        ),
        (
            "https://example.com/services/T/B/X",
            "https://example.com/services/T/B/X",
        ),
        ("https://api.telegram.org/", "https://api.telegram.org/"),
        ("{{BASE}}/services/T/B/X", "{{BASE}}/services/T/B/X"),
    ];
    for (url, want) in cases {
        assert_eq!(redact_url(url), want, "{url}");
    }
    assert_eq!(
        url_secrets("https://hooks.slack.com/services/T000/B000/SLACKPATHSECRET"),
        vec!["T000", "B000", "SLACKPATHSECRET"]
    );
    assert_eq!(
        url_secrets("https://api.telegram.org/bot123%3AABC/getMe"),
        vec!["123%3AABC", "123:ABC"]
    );
    assert_eq!(
        redact_urls_in("posting to https://hooks.slack.com/services/T/B/XYZSECRET failed"),
        "posting to https://hooks.slack.com/services/***/***/*** failed"
    );
}

/// A recorded failure is named by the fixed words the engines start their errors with, never
/// from the rest; a status reason comes from the number alone.
#[test]
fn a_failure_kind_and_a_status_reason_come_from_fixed_words_and_numbers() {
    for (error, kind) in [
        ("request timed out after 30s", "timeout"),
        ("request timed out after 300 ms", "timeout"),
        ("could not connect: corpdb-prod.invalid", "connection error"),
        ("could not connect", "connection error"),
        (
            "could not connect to https://u:p@h:443: transport error",
            "connection error",
        ),
        (
            "gRPC channel not ready: transport error",
            "connection error",
        ),
        ("TLS configuration failed: bad certificate", "TLS error"),
        (
            "too many redirects: error following redirect",
            "redirect error",
        ),
        ("invalid request: error sending request", "send error"),
        ("invalid request: builder error", "invalid request"),
        ("invalid HTTP method: BOGUS METHOD", "invalid request"),
        (
            "invalid URL: relative URL without a base",
            "invalid request",
        ),
        ("invalid header value for \"X\"", "invalid request"),
        ("error decoding response body", "response error"),
        ("request or response body error", "response error"),
        ("Unauthenticated: token tok_123 rejected", "request failed"),
        ("timeout talking to request timed out", "request failed"),
        ("", "request failed"),
    ] {
        assert_eq!(failure_kind(error), kind, "{error}");
    }
    assert_eq!(status_reason(false, 200), Some("OK"));
    assert_eq!(status_reason(false, 404), Some("Not Found"));
    assert_eq!(status_reason(false, 799), None);
    assert_eq!(status_reason(true, 0), Some("OK"));
    assert_eq!(status_reason(true, 16), Some("Unauthenticated"));
    assert_eq!(status_reason(true, 99), Some("Unknown"));
}

/// A token as user name and a key with an empty password (Stripe's form) are credentials too;
/// references only name a secret, so they stay.
#[test]
fn url_credentials_and_secret_named_parameters_are_masked_but_references_stay() {
    let cases = [
        (
            "https://ada:hunter2@api.example.com/x?api_key=abc&page=2&token={{TOKEN}}#frag",
            "https://***:***@api.example.com/x?api_key=***&page=2&token={{TOKEN}}#frag",
        ),
        (
            "{{BASE}}/users?X-Amz-Signature=deadbeef&sig=1&q=a=b",
            "{{BASE}}/users?X-Amz-Signature=***&sig=***&q=a=b",
        ),
        (
            "https://ada:{{PW}}@h/?password=",
            "https://***:{{PW}}@h/?password=",
        ),
        ("https://{{U}}:{{P}}@h/", "https://{{U}}:{{P}}@h/"),
        ("https://ada@h/p", "https://***@h/p"),
        (
            "https://sk_live_not-a-real-key:@api.stripe.com/v1/charges",
            "https://***:@api.stripe.com/v1/charges",
        ),
        (
            "https://ghp_16C7e42F292c6912E7710c838347Ae178B4a@github.com/o/r.git",
            "https://***@github.com/o/r.git",
        ),
        ("https://u:p@ss@h/x", "https://***:***@h/x"),
        (
            "https://app.example/cb#access_token=eyJhbGci&token_type=bearer&state=xyz",
            "https://app.example/cb#access_token=***&token_type=***&state=xyz",
        ),
        (
            "https://app.example/#/route?id_token=abc&page=2",
            "https://app.example/#/route?id_token=***&page=2",
        ),
        (
            "https://h/?code=c&client_secret=s&refresh_token=r&apikey=k&passwd=p&pwd=q\
             &authorization=a&session=s1&key=k2&secret=s2&signature=g&auth=x&page=1",
            "https://h/?code=***&client_secret=***&refresh_token=***&apikey=***&passwd=***\
             &pwd=***&authorization=***&session=***&key=***&secret=***&signature=***&auth=***\
             &page=1",
        ),
        ("https://h/?a=1;sid=xyz;b=2", "https://h/?a=1;sid=***;b=2"),
        (
            "https://h.example/x?pass=PASSVALUE1&pw=PWVALUE22&passphrase=PHRASE333\
             &private_key=PK4&credentials=CR5&page=2",
            "https://h.example/x?pass=***&pw=***&passphrase=***&private_key=***\
             &credentials=***&page=2",
        ),
        ("https://h/?%74oken=abc", "https://h/?%74oken=***"),
        ("https://h/docs#section-2", "https://h/docs#section-2"),
        ("https://h/a@b", "https://h/a@b"),
        ("tok_grpc_1@grpc.example:443", "***@grpc.example:443"),
        ("u:pw@db.internal:5432/x", "***:***@db.internal:5432/x"),
        ("localhost:50051", "localhost:50051"),
        (
            "{{BASE}}/users/ada@example.com",
            "{{BASE}}/users/ada@example.com",
        ),
        ("not a url", "not a url"),
        (
            "http://h/?access_token=x&session_id=y&monkey=z&zipcode=1",
            "http://h/?access_token=***&session_id=***&monkey=***&zipcode=1",
        ),
    ];
    for (url, want) in cases {
        assert_eq!(redact_url(url), want, "{url}");
    }
}

#[test]
fn the_credentials_in_a_url_are_listed_as_written_and_decoded() {
    assert_eq!(
        url_secrets("https://ad%40a:pw@h/x?api_key=a%2Fb&page=2&t={{T}}#access_token=frag-tok"),
        vec!["ad%40a", "ad@a", "pw", "a%2Fb", "a/b", "frag-tok"]
    );
    assert_eq!(url_secrets("https://ghp_x@h/"), vec!["ghp_x"]);
    assert!(url_secrets("{{BASE}}/x?q=1#top").is_empty());
}

/// 🔴 Free text that names a URL — an engine error's ` for url (…)` — gets every URL in it
/// redacted, and the rest of the text left alone. Falsify: make `redact_urls_in` return its
/// input — the secret rows go red.
#[test]
fn every_url_inside_free_text_is_redacted() {
    let err = "invalid request: error sending request for url \
               (https://u:pw-live-1@api.x/v1?api_key=REALKEY&page=2)";
    let out = redact_urls_in(err);
    assert_eq!(
        out,
        "invalid request: error sending request for url (https://***:***@api.x/v1?api_key=***&page=2)"
    );
    // A Vault value that is the URL's base still leaves a literal credential in its query
    // masked: the URL is found before the base reads `{{BASE}}`.
    let base = Redactor::new(&[("BASE".into(), "https://api.internal:8443".into())]);
    assert_eq!(
        scrub(
            "error following redirect for url (https://api.internal:8443/next?sig=OTHER-SIG.)",
            &base
        ),
        "error following redirect for url ({{BASE}}/next?sig=***.)"
    );
    assert_eq!(
        redact_urls_in("see https://h/x?token=ab, then https://h/y."),
        "see https://h/x?token=***, then https://h/y."
    );
    assert_eq!(
        redact_urls_in("a \"wss://h/s?token=abc\" and ftp+x://ghp_t@h/ and http://h/ok"),
        "a \"wss://h/s?token=***\" and ftp+x://***@h/ and http://h/ok"
    );
    assert_eq!(redact_urls_in("no urls :// here"), "no urls :// here");
    assert_eq!(redact_urls_in("://x?token=a"), "://x?token=***");
    // Both passes: values the redactor knows first, then URLs.
    let r = Redactor::new(&[("KEY".into(), "REALKEY".into())]);
    assert_eq!(
        scrub(err, &r),
        "invalid request: error sending request for url \
         (https://***:***@api.x/v1?api_key={{KEY}}&page=2)"
    );
}

#[test]
fn credential_names_are_read_through_case_punctuation_and_escapes() {
    for name in [
        "Authorization",
        "X-Api-Key",
        "Cookie",
        "x-amz-security-token",
        "%41pi_Key",
        "CODE",
        "jwt",
        "pass",
        "PASS",
        "db_pass",
        "pw",
        "adminPw",
        "passphrase",
        "key_passphrase",
        "passcode",
        "private_key",
        "privateKeyId",
        "credential",
        "credentials",
        "X-Credentials",
    ] {
        assert!(secret_param(name), "{name}");
    }
    for name in [
        "page",
        "zipcode",
        "content-type",
        "accept",
        "q",
        "barcode",
        "passenger",
        "pwa",
        "passage_id",
    ] {
        assert!(!secret_param(name), "{name}");
    }
}

#[test]
fn a_response_report_says_what_it_cut() {
    let body = format!("{{\"items\":[\"{}\"]}}", "x".repeat(BODY_CAP));
    let r = response(200, vec![header("Content-Type", "application/json")], &body);
    let (message, data) = response_report(&r, "GET https://h/", "note line");
    assert!(message.starts_with("200 OK in 12 ms, "), "{message}");
    assert!(message.contains("(application/json)"));
    assert!(message.contains("GET https://h/\nnote line"));
    assert!(message.contains("Body (JSON, re-indented):"));
    assert!(
        message.contains("[Body truncated: showing the first 65,536 of"),
        "{message}"
    );
    assert_eq!(data["bodyTruncated"], true);
    assert_eq!(data["bodyFormat"], "json");
    assert_eq!(data["body"].as_str().unwrap().len(), BODY_CAP);

    let many: Vec<HttpHeader> = (0..HEADER_CAP + 3)
        .map(|i| header(&format!("x-{i}"), "v"))
        .collect();
    let (message, data) = response_report(&response(204, many, ""), "DELETE https://h/", "");
    assert!(message.contains("[3 more headers not shown.]"), "{message}");
    assert!(message.contains("No body."));
    assert_eq!(data["headersTruncated"], true);
    assert_eq!(data["headers"].as_array().unwrap().len(), HEADER_CAP);

    // The engine stopped reading at its cap: the real size is unknown, and the reply says so
    // rather than quoting the bytes read as the response's size.
    let mut engine_cut = response(200, vec![], "partial");
    engine_cut.truncated = true;
    engine_cut.size_bytes = 9_000_000;
    let (message, data) = response_report(&engine_cut, "GET https://h/", "");
    assert!(message.contains("Body:\npartial"));
    assert!(
        message.starts_with("200 OK in 12 ms, over 8.0 MB"),
        "{message}"
    );
    assert!(
        message.contains(
            "[Body truncated by the API client: the response is over 8.0 MB and the API \
             client read no further.]"
        ),
        "{message}"
    );
    assert!(!message.contains("9,000,000"), "{message}");
    assert_eq!(data["bodyTruncated"], true);

    let mut both = response(200, vec![], &"y".repeat(BODY_CAP + 10));
    both.truncated = true;
    let (message, _) = response_report(&both, "GET https://h/", "");
    assert!(
        message.contains(
            "[Body truncated: showing the first 65,536 of 65,546 bytes; the response is over \
             8.0 MB and the API client read no further.]"
        ),
        "{message}"
    );
    let (message, _) = compare_report(
        &Side {
            label: "A".into(),
            outcome: Ok(engine_cut),
        },
        &Side {
            label: "B".into(),
            outcome: Ok(response(200, vec![], "x")),
        },
    );
    assert!(
        message.contains("A: 200 OK in 12 ms, over 8.0 MB"),
        "{message}"
    );
}

#[test]
fn a_json_diff_walks_sorted_keys_and_array_indexes() {
    let a = serde_json::json!({"b": 1, "a": {"x": [1, 2], "gone": true}, "k-y": "s", "t": {}});
    let b = serde_json::json!({"a": {"x": [1, 3, 4]}, "b": 1, "k-y": "S", "new": null, "t": []});
    assert_eq!(
        json_diff(&a, &b, 10),
        vec![
            Diff::OnlyA("$.a.gone".into(), serde_json::json!(true)),
            Diff::Changed(
                "$.a.x[1]".into(),
                serde_json::json!(2),
                serde_json::json!(3)
            ),
            Diff::OnlyB("$.a.x[2]".into(), serde_json::json!(4)),
            Diff::Changed(
                "$[\"k-y\"]".into(),
                serde_json::json!("s"),
                serde_json::json!("S")
            ),
            Diff::OnlyB("$.new".into(), serde_json::json!(null)),
            Diff::Changed("$.t".into(), serde_json::json!({}), serde_json::json!([])),
        ]
    );
    assert!(json_diff(&a, &a, 10).is_empty());
    let big_a = serde_json::Value::Array((0..500).map(serde_json::Value::from).collect());
    let big_b = serde_json::Value::Array((1..501).map(serde_json::Value::from).collect());
    assert_eq!(
        json_diff(&big_a, &big_b, 5).len(),
        6,
        "stops one past the cap"
    );
}

fn side(label: &str, outcome: Result<HttpResponse, String>) -> Side {
    Side {
        label: label.into(),
        outcome,
    }
}

#[test]
fn a_compare_reports_status_timing_headers_and_json_differences() {
    let mut fast = response(
        200,
        vec![
            header("Content-Type", "application/json"),
            header("X-A", "1"),
        ],
        r#"{"id":1,"name":"Ada","tags":["a"]}"#,
    );
    fast.duration_ms = 10;
    let mut slow = response(
        404,
        vec![
            header("content-type", "application/json"),
            header("X-B", "2"),
        ],
        r#"{"id":1,"name":"Grace"}"#,
    );
    slow.duration_ms = 25;
    let (message, data) = compare_report(&side("A: GET a", Ok(fast)), &side("B: GET b", Ok(slow)));
    assert!(message.starts_with("A: GET a\nB: GET b\n"), "{message}");
    assert!(message.contains("Different status: 200 vs 404."));
    assert!(message.contains("A was 15 ms faster than B."));
    assert!(message.contains("Headers: 2 differ."));
    assert!(message.contains("  - x-a: 1 (only in A)"));
    assert!(message.contains("  + x-b: 2 (only in B)"));
    assert!(
        message.contains("Body (JSON, keys sorted): 2 differences."),
        "{message}"
    );
    assert!(message.contains("  ~ $.name: \"Ada\" → \"Grace\""));
    assert!(message.contains("  - $.tags: [\"a\"] (only in A)"));
    assert_eq!(data["body"]["same"], false);
    assert_eq!(data["body"]["diffs"].as_array().unwrap().len(), 2);
    assert_eq!(data["headers"]["diffs"].as_array().unwrap().len(), 2);
    assert_eq!(data["a"]["status"], 200);
    assert_eq!(data["b"]["status"], 404);
}

#[test]
fn a_compare_of_identical_text_bodies_and_of_a_failed_side() {
    let one = response(
        200,
        vec![header("A", "1"), header("a", "2")],
        "hello\nworld",
    );
    let (message, data) = compare_report(&side("A", Ok(one.clone())), &side("B", Ok(one.clone())));
    assert!(message.contains("Same status (200)."));
    assert!(message.contains("Headers: the same."));
    assert!(message.contains("Body: identical."));
    assert_eq!(data["headers"]["same"], true);
    assert_eq!(data["body"]["same"], true);

    let other = response(200, vec![], "hello\nthere");
    let (message, data) = compare_report(&side("A", Ok(one.clone())), &side("B", Ok(other)));
    assert!(message.contains("Body (text): differs"), "{message}");
    assert!(message.contains("First difference at line 2:\n  A: world\n  B: there"));
    assert_eq!(data["body"]["firstDifference"]["line"], 2);

    let json_b = response(200, vec![], "{\"a\":1}");
    let (message, _) = compare_report(&side("A", Ok(one.clone())), &side("B", Ok(json_b)));
    assert!(message.contains("B is JSON, A is not"), "{message}");

    let (message, data) = compare_report(
        &side("A", Ok(one)),
        &side("B", Err("could not connect: h".into())),
    );
    assert!(message.contains("B: failed: could not connect: h"));
    assert!(message.contains("a side did not get a response"));
    assert_eq!(data["b"]["error"], "could not connect: h");
    assert!(data["body"].is_null());
}

#[test]
fn a_compare_lists_at_most_the_cap_and_says_there_are_more() {
    let a_body = serde_json::to_string(&(0..300).collect::<Vec<i32>>()).unwrap();
    let b_body = serde_json::to_string(&(1..301).collect::<Vec<i32>>()).unwrap();
    let a_headers: Vec<HttpHeader> = (0..DIFF_CAP + 2)
        .map(|i| header(&format!("x-{i:03}"), "a"))
        .collect();
    let (message, data) = compare_report(
        &side("A", Ok(response(200, a_headers, &a_body))),
        &side("B", Ok(response(200, vec![], &b_body))),
    );
    assert!(message.contains(&format!(
        "Body (JSON, keys sorted): {DIFF_CAP}+ differences."
    )));
    assert!(message.contains(&format!(
        "[Stopped after {DIFF_CAP} differences; there are more.]"
    )));
    assert!(
        message.contains("[2 more header differences not shown.]"),
        "{message}"
    );
    assert_eq!(data["body"]["truncated"], true);
    assert_eq!(data["body"]["diffs"].as_array().unwrap().len(), DIFF_CAP);
    assert_eq!(data["headers"]["truncated"], true);
    assert_eq!(data["headers"]["diffs"].as_array().unwrap().len(), DIFF_CAP);
}
