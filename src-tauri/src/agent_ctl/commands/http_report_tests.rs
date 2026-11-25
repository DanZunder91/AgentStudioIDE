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

#[test]
fn url_credentials_and_secret_named_parameters_are_masked_but_references_stay() {
    assert_eq!(
        redact_url("https://ada:hunter2@api.example.com/x?api_key=abc&page=2&token={{TOKEN}}#frag"),
        "https://ada:***@api.example.com/x?api_key=***&page=2&token={{TOKEN}}#frag"
    );
    assert_eq!(
        redact_url("{{BASE}}/users?X-Amz-Signature=deadbeef&sig=1&q=a=b"),
        "{{BASE}}/users?X-Amz-Signature=***&sig=***&q=a=b"
    );
    assert_eq!(
        redact_url("https://ada:{{PW}}@h/?password="),
        "https://ada:{{PW}}@h/?password="
    );
    assert_eq!(redact_url("https://ada@h/p"), "https://ada@h/p");
    assert_eq!(redact_url("https://h/a@b"), "https://h/a@b");
    assert_eq!(redact_url("not a url"), "not a url");
    assert_eq!(
        redact_url("http://h/?access_token=x&session_id=y&monkey=z"),
        "http://h/?access_token=***&session_id=***&monkey=***",
        "a name ending in key is a key"
    );
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

    let mut engine_cut = response(200, vec![], "partial");
    engine_cut.truncated = true;
    engine_cut.size_bytes = 9_000_000;
    let (message, data) = response_report(&engine_cut, "GET https://h/", "");
    assert!(message.contains("Body:\npartial"));
    assert!(message.contains("truncated by the API client at 8.0 MB; the response was 9,000,000"));
    assert_eq!(data["bodyTruncated"], true);
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
