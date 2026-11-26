/** The pure cURL import parser; shell quoting and flags are the risky logic, tested hardest. */

import { describe, expect, it } from "vitest";

import {
  detectCurlDialect,
  isCurlCommand,
  isPowerShellWebRequest,
  parseCurl,
  tokenizeCurl,
} from "./curlParse";

describe("isCurlCommand", () => {
  it("is true only for a leading `curl` followed by whitespace", () => {
    expect(isCurlCommand("curl https://a.test")).toBe(true);
    expect(isCurlCommand("  CURL\n-X POST https://a.test")).toBe(true); // case + leading ws
    expect(isCurlCommand("https://a.test")).toBe(false); // a real URL
    expect(isCurlCommand("curl")).toBe(false); // no args yet — don't hijack
    expect(isCurlCommand("curlhttps://a.test")).toBe(false); // not the word `curl`
    expect(isCurlCommand("")).toBe(false);
  });
});

describe("tokenizeCurl", () => {
  it("splits on whitespace and strips single/double quotes", () => {
    expect(tokenizeCurl("curl 'https://a.test' -H \"K: v\"")).toEqual([
      "curl",
      "https://a.test",
      "-H",
      "K: v",
    ]);
  });

  it("honors backslash line-continuations and bare escapes", () => {
    expect(tokenizeCurl("curl \\\n  https://a.test")).toEqual(["curl", "https://a.test"]);
    expect(tokenizeCurl("a\\ b")).toEqual(["a b"]); // escaped space stays in one token
  });

  it("keeps escapes inside double quotes but treats single quotes as literal", () => {
    expect(tokenizeCurl('"a\\"b"')).toEqual(['a"b']);
    expect(tokenizeCurl("'a\\b'")).toEqual(["a\\b"]); // backslash literal in single quotes
  });

  it("preserves an explicitly empty quoted token", () => {
    expect(tokenizeCurl("-d ''")).toEqual(["-d", ""]);
  });

  it("returns no tokens for blank input", () => {
    expect(tokenizeCurl("   ")).toEqual([]);
  });
});

describe("parseCurl", () => {
  it("parses a typical example (GET→POST inference, header, body)", () => {
    const parsed = parseCurl(
      "curl --location 'https://api.test/v1/widgets/search' \\\n" +
        "--header 'Content-Type: application/json' \\\n" +
        '--data \'{   "filter": {} }\'',
    );
    expect(parsed).toEqual({
      method: "POST", // no -X but --data present → POST
      url: "https://api.test/v1/widgets/search",
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: '{   "filter": {} }',
    });
  });

  it("treats -L/--location as a boolean flag (URL is positional after it)", () => {
    const parsed = parseCurl("curl -L https://a.test");
    expect(parsed).toMatchObject({ method: "GET", url: "https://a.test", body: null });
  });

  it("defaults to GET with no body and no explicit method", () => {
    expect(parseCurl("curl https://a.test")).toMatchObject({ method: "GET", body: null });
  });

  it("honors an explicit -X even with a body", () => {
    const parsed = parseCurl("curl -X PUT https://a.test -d 'x=1'");
    expect(parsed).toMatchObject({ method: "PUT", url: "https://a.test", body: "x=1" });
  });

  it("uppercases the method and accepts --request", () => {
    expect(parseCurl("curl --request post https://a.test")).toMatchObject({ method: "POST" });
  });

  it("collects repeated -H headers and --url", () => {
    const parsed = parseCurl(
      "curl --url https://a.test -H 'A: 1' -H 'B: 2'",
    );
    expect(parsed!.url).toBe("https://a.test");
    expect(parsed!.headers).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ]);
  });

  it("joins multiple --data with & and infers POST", () => {
    const parsed = parseCurl("curl https://a.test -d a=1 --data b=2");
    expect(parsed).toMatchObject({ method: "POST", body: "a=1&b=2" });
  });

  it("maps -u/--user to a Basic Authorization header", () => {
    const parsed = parseCurl("curl -u alice:secret https://a.test");
    expect(parsed!.headers).toEqual([
      { name: "Authorization", value: `Basic ${btoa("alice:secret")}` },
    ]);
  });

  it("skips a header with no colon separator", () => {
    const parsed = parseCurl("curl https://a.test -H 'NoColonHere'");
    expect(parsed!.headers).toEqual([]);
  });

  it("works without a leading `curl` token", () => {
    expect(parseCurl("https://a.test")).toMatchObject({ url: "https://a.test" });
  });

  it("ignores unknown boolean flags and keeps the first positional as the URL", () => {
    const parsed = parseCurl("curl --compressed -k https://a.test https://second.test");
    expect(parsed!.url).toBe("https://a.test"); // first positional wins
  });

  it("parses a multi-line request: --request GET, two headers, multi-line --data", () => {
    const parsed = parseCurl(
      "curl --location --request GET 'https://api.test/v1/orders/ORDER-1/history' \\\n" +
        "--header 'x-api-key: 00000000-0000-0000-0000-000000000000' \\\n" +
        "--header 'Content-Type: application/json' \\\n" +
        "--data '{\n  \"code\": \"x\"\n}'",
    );
    expect(parsed!.method).toBe("GET"); // explicit --request GET wins over the body's POST-inference
    expect(parsed!.url).toContain("/orders/ORDER-1/history");
    expect(parsed!.headers).toEqual([
      { name: "x-api-key", value: "00000000-0000-0000-0000-000000000000" },
      { name: "Content-Type", value: "application/json" },
    ]);
    // The single-quoted JSON body keeps its internal newlines verbatim.
    expect(parsed!.body).toBe('{\n  "code": "x"\n}');
  });

  it("honors each explicit method (GET/POST/PUT/PATCH/DELETE) via -X/--request", () => {
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(parseCurl(`curl -X ${m} https://a.test`)!.method).toBe(m);
      expect(parseCurl(`curl --request ${m.toLowerCase()} https://a.test`)!.method).toBe(m);
    }
  });

  it("returns null when there is no URL", () => {
    expect(parseCurl("curl -X POST -H 'A: 1'")).toBeNull();
    expect(parseCurl("")).toBeNull();
  });

  /* ──────────────────── bundled / attached / = flag forms ──────────────────── */

  it("parses a typical paste verbatim — bundled -sX must not donate POST to the URL", () => {
    // The symptom: the paste only put the word POST in the URL. `-sX` is `-s` + `-X`;
    // the old parser skipped it whole, so `POST` became the first non-flag token
    // and won the positional-URL slot while the real URL was dropped.
    const parsed = parseCurl(
      `curl -sX POST http://127.0.0.1:3000/auth/login \\
` +
        `  -H 'content-type: application/json' -d '{"email":"max@example.com"}'`,
    )!;
    expect(parsed.url).toBe("http://127.0.0.1:3000/auth/login");
    expect(parsed.method).toBe("POST");
    expect(parsed.headers).toEqual([{ name: "content-type", value: "application/json" }]);
    expect(parsed.body).toBe('{"email":"max@example.com"}');
  });

  it("expands a bundle whatever its length, and wherever the value-taking flag sits", () => {
    // -s -S -L -X POST : booleans then a value-taker that claims the next token.
    expect(parseCurl("curl -sSLX POST https://a.test")).toMatchObject({
      method: "POST",
      url: "https://a.test",
    });
    // Pure boolean bundle — no value-taker, nothing claimed.
    expect(parseCurl("curl -sSL https://a.test")).toMatchObject({
      method: "GET",
      url: "https://a.test",
    });
  });

  it("reads a value attached to its flag, with no space", () => {
    expect(parseCurl("curl -XDELETE https://a.test")).toMatchObject({ method: "DELETE" });
    expect(parseCurl("curl https://a.test -H'Accept: text/plain'")!.headers).toEqual([
      { name: "Accept", value: "text/plain" },
    ]);
    expect(parseCurl("curl -sXPUT https://a.test")).toMatchObject({ method: "PUT" });
  });

  it("splits --flag=value on the FIRST = so a value containing = survives", () => {
    expect(parseCurl("curl --request=POST https://a.test")).toMatchObject({ method: "POST" });
    expect(parseCurl("curl --url=https://a.test")).toMatchObject({ url: "https://a.test" });
    expect(parseCurl("curl https://a.test --data=a=1&b=2")).toMatchObject({ body: "a=1&b=2" });
    // Quoted, because that is what a real shell requires for a value with a
    // space — unquoted, `--header=X-Token:` and `abc=def` are two arguments and
    // the empty header is the honest reading.
    expect(parseCurl("curl https://a.test --header='X-Token: abc=def'")!.headers).toEqual([
      { name: "X-Token", value: "abc=def" },
    ]);
  });

  it("consumes an unmodelled value flag's value instead of reading it as the URL", () => {
    // The same defect class as the `-sX` paste: `out.json` must not become the URL.
    expect(parseCurl("curl -o out.json https://a.test")).toMatchObject({
      url: "https://a.test",
    });
    expect(parseCurl("curl -A 'Mozilla/5.0' https://a.test")).toMatchObject({
      url: "https://a.test",
    });
    // Two-sided: a boolean flag next to a bare word leaves that word alone, so
    // the consuming above is doing real work rather than swallowing everything.
    expect(parseCurl("curl -k https://a.test")).toMatchObject({ url: "https://a.test" });
  });

  it("prefers a token that names a scheme over an earlier bare word", () => {
    // Belt-and-braces for any flag form still unknown to us: a real URL wins.
    expect(parseCurl("curl --some-future-flag POST https://a.test")).toMatchObject({
      url: "https://a.test",
    });
  });

  it("tolerates a value-flag left dangling at the end", () => {
    expect(parseCurl("curl https://a.test -H")).toMatchObject({ url: "https://a.test" });
    expect(parseCurl("curl https://a.test -X")).toMatchObject({ method: "GET" });
    expect(parseCurl("curl https://a.test -d")).toMatchObject({ body: null, method: "GET" });
    expect(parseCurl("curl https://a.test --url")).toMatchObject({ url: "https://a.test" });
    expect(parseCurl("curl https://a.test -u")).toMatchObject({ url: "https://a.test" });
  });
});

/* ─────────────────────────── Windows pastes ─────────────────────────── */

/** DevTools-exact "Copy as cURL (cmd)" output from Chromium's `escapeStringWin`: V3 writes `"`
 * as `\"`, V4 (newer) as `""` with `(` `)` careted. String.raw keeps every caret and backslash. */
const DEVTOOLS_GET_V3 = String.raw`curl --url ^"https://api.example.com/v1/items?a=1^&b=2^&filter^\[status^\]=open^" ^
  -H ^"accept: application/json, text/plain, */*^" ^
  -H ^"accept-language: en-US,en;q=0.9^" ^
  -b ^"session=abc^%^3D123; theme=dark^" ^
  -H ^"user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0^"`;
const DEVTOOLS_GET_V4 = String.raw`curl --url ^"https://api.example.com/v1/items?a=1^&b=2^&filter^\[status^\]=open^" ^
  -H ^"accept: application/json, text/plain, */*^" ^
  -H ^"accept-language: en-US,en;q=0.9^" ^
  -b ^"session=abc^%^3D123; theme=dark^" ^
  -H ^"user-agent: Mozilla/5.0 ^(Windows NT 10.0; Win64; x64^) Chrome/131.0.0.0^"`;
const DEVTOOLS_POST_V3 = String.raw`curl --url ^"https://api.example.com/v1/notes?draft=1^" ^
  -H ^"content-type: application/json^" ^
  --data-raw ^"^{^\^"title^\^":^\^"say ^\^\^\^"hi^\^\^\^" ^& 100^% ^^ off^\^",^\^"path^\^":^\^"C:^\^\^\^\temp^\^\^\^\^\^",^\^"nl^\^":^\^"a^\^\nb^\^",^\^"env^\^":^\^"^%^PATH^%^\^"^}^"`;
const DEVTOOLS_POST_V4 = String.raw`curl --url ^"https://api.example.com/v1/notes?draft=1^" ^
  -H ^"content-type: application/json^" ^
  --data-raw ^"^{^"^"title^"^":^"^"say ^\^\^"^"hi^\^\^"^" ^& 100^% ^^ off^"^",^"^"path^"^":^"^"C:^\^\^\^\temp^\^\^\^\^"^",^"^"nl^"^":^"^"a^\^\nb^"^",^"^"env^"^":^"^"^%^PATH^%^"^"^}^"`;

/** What the browser actually sent for the GET fixtures. */
const BROWSER_GET = {
  method: "GET",
  url: "https://api.example.com/v1/items?a=1&b=2&filter[status]=open",
  headers: [
    { name: "accept", value: "application/json, text/plain, */*" },
    { name: "accept-language", value: "en-US,en;q=0.9" },
    { name: "Cookie", value: "session=abc%3D123; theme=dark" },
    { name: "user-agent", value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0" },
  ],
  body: null,
};

/** …and the POST body: quotes, &, %, ^, a JSON \n escape, an escaped backslash pair. */
const BROWSER_POST_BODY = String.raw`{"title":"say \"hi\" & 100% ^ off","path":"C:\\temp\\","nl":"a\nb","env":"%PATH%"}`;

describe("parseCurl — DevTools' Copy as cURL (cmd)", () => {
  it("reads a GET with several headers, a -b cookie and ?a=1&b=2 — both generations, CRLF or LF", () => {
    for (const cmd of [DEVTOOLS_GET_V3, DEVTOOLS_GET_V4]) {
      expect(parseCurl(cmd)).toEqual(BROWSER_GET);
      expect(parseCurl(cmd.replace(/\n/g, "\r\n"))).toEqual(BROWSER_GET); // the Windows clipboard
    }
  });

  it('reads a --data-raw JSON body with ", %, &, ^ and backslashes as the BROWSER sent it', () => {
    for (const cmd of [DEVTOOLS_POST_V3, DEVTOOLS_POST_V4]) {
      expect(parseCurl(cmd)).toEqual({
        method: "POST",
        url: "https://api.example.com/v1/notes?draft=1",
        headers: [{ name: "content-type", value: "application/json" }],
        // Not `a\\nb` / `C:\\\\temp`: DevTools doubles every backslash, and real
        // cmd + curl.exe would send them doubled (measured) — the paste undoes it.
        body: BROWSER_POST_BODY,
      });
    }
  });

  it("reads a newline in a value (^ LF LF) and an explicit -X", () => {
    const cmd =
      'curl --url ^"https://api.example.com/v1/notes?draft=1^" ^\n  -X ^"PUT^" ^\n' +
      '  -H ^"content-type: application/json^" ^\n  --data-raw ^"^{^\n\n  ^"^"a^"^": 1^\n\n^}^"';
    expect(parseCurl(cmd)).toMatchObject({ method: "PUT", body: '{\n  "a": 1\n}' });
  });

  it("reads the older plain-quoted form — positional URL, ^ continuations, --compressed", () => {
    // Chromium ≤ 2024 quoted with plain "…" when nothing needed a caret, and
    // still sent --compressed; the trailing ` ^` is the only sign it is cmd.
    const cmd =
      'curl "https://a.test/api?x=1" ^\n  -H "accept: */*" ^\n  -H "x-note: a & b" ^\n  --compressed';
    expect(parseCurl(cmd)).toEqual({
      method: "GET",
      url: "https://a.test/api?x=1",
      headers: [
        { name: "accept", value: "*/*" },
        { name: "x-note", value: "a & b" },
      ],
      body: null,
    });
  });
});

describe("parseCurl — PowerShell-shaped curl.exe", () => {
  it("reads backtick continuations, single quotes ('' for ') and double quotes", () => {
    const cmd =
      "curl.exe -X POST 'https://a.test/v1' `\n" +
      '  -H "Authorization: Bearer $TOKEN" `\n' +
      "  -H 'X-Note: it''s' `\n" +
      `  --data-raw '{"name": "two words"}'`;
    expect(parseCurl(cmd)).toEqual({
      method: "POST",
      url: "https://a.test/v1",
      headers: [
        // $TOKEN is left as typed — a paste never expands a variable.
        { name: "Authorization", value: "Bearer $TOKEN" },
        { name: "X-Note", value: "it's" },
      ],
      // Plain quotes are taken as written — what the author meant (and what
      // PowerShell 7.3+ sends), not 5.1's quote-eating.
      body: '{"name": "two words"}',
    });
  });

  it('applies 5.1\'s C-runtime reading to a word written the 5.1 way (\\")', () => {
    expect(parseCurl(String.raw`curl.exe https://a.test --data-raw '{\"a\":1}'`)).toMatchObject({
      body: '{"a":1}',
    });
  });

  it("reads our own legacy-passing wrapper by 5.1's rules exactly", () => {
    const cmd =
      "& { $PSNativeCommandArgumentPassing = 'Legacy'; curl.exe -X POST 'https://a.test' " +
      `-H 'content-type: application/json' --data-raw '"{""a"":""x y""}"' }`;
    expect(parseCurl(cmd)).toEqual({
      method: "POST",
      url: "https://a.test",
      headers: [{ name: "content-type", value: "application/json" }],
      body: '{"a":"x y"}',
    });
  });

  it("stops at the end of the statement", () => {
    expect(parseCurl("curl.exe 'https://a.test' | ConvertFrom-Json")).toMatchObject({
      url: "https://a.test",
    });
  });
});

describe("detectCurlDialect", () => {
  it('names cmd from ^"…^" in the first or second argument, or a ` ^` continuation', () => {
    expect(detectCurlDialect('curl ^"https://a.test^"')).toBe("cmd");
    expect(detectCurlDialect('curl.exe -X ^"POST^" ^"https://a.test^"')).toBe("cmd");
    expect(detectCurlDialect('curl "https://a.test" ^\n  -H "a: b"')).toBe("cmd");
  });

  it("does not trust a ` ^` ending a first line that holds a ' — that is a bash body", () => {
    expect(detectCurlDialect("curl -X POST 'https://a.test' --data 'x ^\ny'")).toBe("bash");
  });

  it("names PowerShell from our wrapper, a backtick continuation, or curl.exe", () => {
    expect(detectCurlDialect("& { $PSNativeCommandArgumentPassing = 'Legacy'; curl.exe 'x' }")).toBe(
      "powershell",
    );
    expect(detectCurlDialect("curl 'https://a.test' `\n  -H 'a: b'")).toBe("powershell");
    expect(detectCurlDialect("curl.exe https://a.test")).toBe("powershell");
  });

  it("keeps everything else bash — every pre-Windows paste reads as it always did", () => {
    expect(detectCurlDialect("curl -X POST 'https://a.test' \\\n  -H 'a: b'")).toBe("bash");
    expect(detectCurlDialect("curl https://a.test")).toBe("bash");
  });
});

describe("isCurlCommand / isPowerShellWebRequest — Windows spellings", () => {
  it("accepts curl.exe and our PowerShell wrapper", () => {
    expect(isCurlCommand("curl.exe https://a.test")).toBe(true);
    expect(isCurlCommand("& { $PSNativeCommandArgumentPassing = 'Legacy'; curl.exe 'x' }")).toBe(true);
    expect(isCurlCommand("curl.exe")).toBe(false);
  });

  it("recognises DevTools' Copy as PowerShell, with or without its session block", () => {
    expect(
      isPowerShellWebRequest(
        "$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession\n" +
          '$session.UserAgent = "Mozilla/5.0"\nInvoke-WebRequest -UseBasicParsing -Uri "https://a.test"',
      ),
    ).toBe(true);
    expect(isPowerShellWebRequest('Invoke-WebRequest -UseBasicParsing -Uri "https://a.test"')).toBe(true);
    expect(isPowerShellWebRequest('Invoke-RestMethod -Uri "https://a.test"')).toBe(true);
    expect(isPowerShellWebRequest("curl https://a.test")).toBe(false);
    expect(isPowerShellWebRequest("https://a.test/Invoke-WebRequest x")).toBe(false);
  });
});

describe("parseCurl — what DevTools' bash form and curl itself add", () => {
  it("reads bash's $'…' form, which DevTools uses for any ' or !", () => {
    expect(
      parseCurl(String.raw`curl 'https://a.test' --data-raw $'{"note":"it\'s \\ ok!\n"}'`),
    ).toMatchObject({ body: '{"note":"it\'s \\ ok!\n"}' });
    expect(tokenizeCurl(String.raw`$'\x41\u00e9\U0001F680\t\"\?\a\b\e\E\f\r\v'`)).toEqual([
      "Aé🚀\t\"?\x07\b\x1b\x1b\f\r\v",
    ]);
    // An escape bash does not define stays as typed; so does \x with no digits.
    expect(tokenizeCurl(String.raw`$'\q\x' x`)).toEqual(["\\q\\x", "x"]);
    expect(tokenizeCurl("$'a\\")).toEqual(["a\\"]); // unterminated, trailing backslash
  });

  it("turns -b/--cookie name=value into ONE Cookie header, and ignores a cookie FILE", () => {
    expect(parseCurl("curl https://a.test -b 'a=1' -H 'X: y' --cookie b=2")!.headers).toEqual([
      { name: "Cookie", value: "a=1; b=2" },
      { name: "X", value: "y" },
    ]);
    expect(parseCurl("curl https://a.test -b cookies.txt")!.headers).toEqual([]);
    expect(parseCurl("curl https://a.test -b")!.headers).toEqual([]);
  });

  it("strips curl's glob escapes from the URL — unless -g turned globbing off", () => {
    expect(parseCurl(String.raw`curl 'https://a.test/?f\[a\]=\{x\}'`)!.url).toBe(
      "https://a.test/?f[a]={x}",
    );
    expect(parseCurl(String.raw`curl -g 'https://a.test/?f\[a\]=1'`)!.url).toBe(
      String.raw`https://a.test/?f\[a\]=1`,
    );
    expect(parseCurl(String.raw`curl --globoff 'https://a.test/?f\[a\]=1'`)!.url).toBe(
      String.raw`https://a.test/?f\[a\]=1`,
    );
  });

  it("reads curl's `Name;` as a header with an empty value", () => {
    expect(parseCurl("curl https://a.test -H 'X-Empty;' -H ';'")!.headers).toEqual([
      { name: "X-Empty", value: "" },
    ]);
  });

  it("continues a bash line across a CRLF (a paste from a Windows editor)", () => {
    expect(parseCurl("curl -X PUT \\\r\n  'https://a.test' \\\r\n  -H 'A: 1'")).toEqual({
      method: "PUT",
      url: "https://a.test",
      headers: [{ name: "A", value: "1" }],
      body: null,
    });
  });
});
