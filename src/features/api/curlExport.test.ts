/** "Copy as cURL" builder: quoting is the risky part, verified by round-trip through the REAL
 * `parseCurl`. Output can carry RESOLVED secrets: clipboard only, never a persistence path. */

import { describe, expect, it } from "vitest";

import { buildCurl, type CurlableRequest } from "./curlExport";
import { isCurlCommand, parseCurl } from "./curlParse";

/** Identity resolver — most tests want the text untouched. */
const id = (t: string) => t;

/** A baseline request; override per test. */
const req = (over: Partial<CurlableRequest> = {}): CurlableRequest => ({
  method: "GET",
  url: "https://a.test/things",
  headers: [],
  body: null,
  ...over,
});

describe("buildCurl — canonical shape", () => {
  it("emits the one-line Postman shape: -X, quoted url, -H, --data", () => {
    const cmd = buildCurl(
      req({
        method: "POST",
        headers: [{ name: "content-type", value: "application/json" }],
        body: '{"a":1}',
      }),
      id,
    );
    expect(cmd).toBe(
      "curl -X POST 'https://a.test/things' -H 'content-type: application/json' --data '{\"a\":1}'",
    );
    expect(isCurlCommand(cmd)).toBe(true); // pasting our own output back auto-converts
  });

  it("omits -X for a plain GET (curl's default), and the round-trip still says GET", () => {
    const cmd = buildCurl(req(), id);
    expect(cmd).toBe("curl 'https://a.test/things'");
    expect(parseCurl(cmd)).toMatchObject({ method: "GET", url: "https://a.test/things" });
  });

  it("uppercases a stored lowercase method (matches curl convention and the parser)", () => {
    expect(buildCurl(req({ method: "post", body: null }), id)).toBe(
      "curl -X POST 'https://a.test/things'",
    );
  });

  it("quotes a method that is not a bare token — no shell syntax rides on -X", () => {
    const cmd = buildCurl(req({ method: "weird; rm -rf /" }), id);
    expect(cmd).toBe("curl -X 'WEIRD; RM -RF /' 'https://a.test/things'");
  });
});

describe("buildCurl — headers", () => {
  it("omits disabled headers, keeps enabled and unmarked ones, in order", () => {
    const cmd = buildCurl(
      req({
        headers: [
          { name: "A", value: "1" }, // enabled undefined → included
          { name: "B", value: "2", enabled: false }, // unticked → omitted
          { name: "C", value: "3", enabled: true },
        ],
      }),
      id,
    );
    expect(cmd).toBe("curl 'https://a.test/things' -H 'A: 1' -H 'C: 3'");
  });

  it("omits headers with empty or whitespace-only names", () => {
    const cmd = buildCurl(
      req({
        headers: [
          { name: "", value: "orphan" },
          { name: "   ", value: "orphan" },
          { name: "Real", value: "kept" },
        ],
      }),
      id,
    );
    expect(cmd).toBe("curl 'https://a.test/things' -H 'Real: kept'");
  });

  it("round-trips a header VALUE containing colons (parser splits on the FIRST :)", () => {
    const cmd = buildCurl(req({ headers: [{ name: "X-Window", value: "09:30-17:00" }] }), id);
    expect(cmd).toBe("curl 'https://a.test/things' -H 'X-Window: 09:30-17:00'");
    expect(parseCurl(cmd)!.headers).toEqual([{ name: "X-Window", value: "09:30-17:00" }]);
  });
});

describe("buildCurl — body", () => {
  it("emits no --data for a null or empty body", () => {
    expect(buildCurl(req({ body: null }), id)).toBe("curl 'https://a.test/things'");
    expect(buildCurl(req({ body: "" }), id)).toBe("curl 'https://a.test/things'");
  });

  it("a GET with a body says -X GET out loud — --data would otherwise flip it to POST", () => {
    const cmd = buildCurl(req({ method: "GET", body: "q=1" }), id);
    expect(cmd).toBe("curl -X GET 'https://a.test/things' --data 'q=1'");
    // Without the explicit -X, curl (and parseCurl's inference) would send POST.
    expect(parseCurl(cmd)).toMatchObject({ method: "GET", body: "q=1" });
  });
});

describe("buildCurl — shell safety (the whole job)", () => {
  it("escapes an embedded single quote with the '\\'' idiom, and it round-trips", () => {
    const body = '{"note":"it\'s fine"}';
    const cmd = buildCurl(req({ method: "POST", body }), id);
    expect(cmd).toBe(
      "curl -X POST 'https://a.test/things' --data '{\"note\":\"it'\\''s fine\"}'",
    );
    expect(parseCurl(cmd)!.body).toBe(body);
  });

  it("keeps $, backticks and ! literal — they never leave the single quotes", () => {
    const url = "https://a.test/$(whoami)/`id`/!!?q=$HOME";
    const body = "value with $VAR and `cmd` and !bang";
    const cmd = buildCurl(req({ method: "POST", url, body }), id);
    expect(cmd).toBe(
      "curl -X POST 'https://a.test/$(whoami)/`id`/!!?q=$HOME' --data 'value with $VAR and `cmd` and !bang'",
    );
    expect(parseCurl(cmd)).toMatchObject({ url, body });
  });

  it("keeps a multiline body's newlines verbatim inside the quotes — legal shell", () => {
    const body = '{\n  "a": 1,\n  "b": "two"\n}';
    const cmd = buildCurl(req({ method: "POST", body }), id);
    expect(cmd).toBe(`curl -X POST 'https://a.test/things' --data '${body}'`);
    // One logical command: the newlines are the BODY's, never a `\`-continuation
    // added by us (those get mangled by chat windows and some terminals).
    expect(cmd).not.toContain("\\\n");
    expect(parseCurl(cmd)!.body).toBe(body);
  });

  it("passes unicode through untouched", () => {
    const body = '{"name":"héllo — 世界 🚀"}';
    const cmd = buildCurl(req({ method: "POST", url: "https://a.test/π", body }), id);
    expect(cmd).toBe(`curl -X POST 'https://a.test/π' --data '${body}'`);
    expect(parseCurl(cmd)).toMatchObject({ url: "https://a.test/π", body });
  });

  it("escapes a single quote in a header value and in the url", () => {
    const cmd = buildCurl(
      req({ url: "https://a.test/o'brien", headers: [{ name: "X-Note", value: "it's" }] }),
      id,
    );
    expect(cmd).toBe("curl 'https://a.test/o'\\''brien' -H 'X-Note: it'\\''s'");
    expect(parseCurl(cmd)).toMatchObject({
      url: "https://a.test/o'brien",
      headers: [{ name: "X-Note", value: "it's" }],
    });
  });
});

describe("buildCurl — {{VAR}} resolution", () => {
  const vars: Record<string, string> = {
    HOST: "https://real.test",
    // The resolved secret contains a single quote AND a ! — proves the order is
    // resolve FIRST, quote SECOND, or the secret would break out of the quotes.
    TOKEN: "s3cr'et!",
  };
  const fakeResolve = (t: string) => t.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? "");

  it("resolves url, header values and body — quoting the RESOLVED text", () => {
    const cmd = buildCurl(
      req({
        method: "POST",
        url: "{{HOST}}/v1/send",
        headers: [{ name: "Authorization", value: "Bearer {{TOKEN}}" }],
        body: '{"t":"{{TOKEN}}"}',
      }),
      fakeResolve,
    );
    expect(cmd).toBe(
      "curl -X POST 'https://real.test/v1/send' -H 'Authorization: Bearer s3cr'\\''et!' --data '{\"t\":\"s3cr'\\''et!\"}'",
    );
    expect(parseCurl(cmd)).toMatchObject({
      url: "https://real.test/v1/send",
      headers: [{ name: "Authorization", value: "Bearer s3cr'et!" }],
      body: '{"t":"s3cr\'et!"}',
    });
  });

  it("leaves a {{VAR}} header NAME literal — a config error stays visible, not resolved", () => {
    const cmd = buildCurl(req({ headers: [{ name: "{{HOST}}", value: "{{HOST}}" }] }), fakeResolve);
    expect(cmd).toBe("curl 'https://a.test/things' -H '{{HOST}}: https://real.test'");
  });
});

describe("round-trip against the real parser", () => {
  it("a representative request survives buildCurl → parseCurl unchanged", () => {
    const request = req({
      method: "PUT",
      url: "https://api.test/v1/items?id=a&b=2",
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "X-Debug", value: "1", enabled: false }, // must NOT reappear
        { name: "X-Time", value: "12:30:00", enabled: true },
      ],
      // Newlines, a single quote, unicode and shell metachars, all at once.
      body: '{\n  "name": "O\'Brien — ✓",\n  "cmd": "$(echo `id`) !!"\n}',
    });
    expect(parseCurl(buildCurl(request, id))).toEqual({
      method: "PUT",
      url: request.url,
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "X-Time", value: "12:30:00" },
      ],
      body: request.body,
    });
  });
});


describe("degenerate inputs", () => {
  const asIs = (t: string) => t;

  it("an all-blank method reads as GET rather than emitting `-X ''`", () => {
    const cmd = buildCurl(
      { method: "   ", url: "https://api.example.com", headers: [], body: null },
      asIs,
    );
    expect(cmd).toBe("curl 'https://api.example.com'");
  });

  it("an EMPTY-string body is no body at all — `--data ''` would change curl's verb", () => {
    const cmd = buildCurl(
      { method: "GET", url: "https://api.example.com", headers: [], body: "" },
      asIs,
    );
    expect(cmd).not.toContain("--data");
    expect(cmd).not.toContain("-X");
  });
});

/* ─────────────── Windows: cmd and PowerShell forms ─────────────── */

/** Every exact string here was also run via real cmd.exe and Windows PowerShell 5.1 to curl.exe
 * against a loopback echo server, arriving byte for byte; these pin shape and round-trip. */
describe("buildCurl — cmd", () => {
  const post = req({
    method: "POST",
    headers: [{ name: "content-type", value: "application/json" }],
    body: '{"a":1}',
  });

  it("writes every argument as ^\"…^\", with the method quoted the way DevTools does", () => {
    expect(buildCurl(post, id, "cmd")).toBe(
      'curl -X ^"POST^" ^"https://a.test/things^" -H ^"content-type: application/json^" --data-raw ^"^{\\^"a\\^":1^}^"',
    );
    expect(buildCurl(req(), id, "cmd")).toBe('curl ^"https://a.test/things^"');
  });

  it("carets cmd's operators, defuses %VAR%, and keeps backslashes bare", () => {
    expect(buildCurl(req({ method: "POST", body: "a&b|c<d>e^f (%PATH%) C:\\x\\" }), id, "cmd")).toBe(
      'curl -X ^"POST^" ^"https://a.test/things^" --data-raw ^"a^&b^|c^<d^>e^^f ^(^%^PATH^%^) C:\\x\\\\^"',
    );
  });

  it("writes a newline as ^ LF LF — and a CR, which cmd cannot carry, as that newline", () => {
    const cmd = buildCurl(req({ method: "POST", body: "a\r\nb\rc\nd" }), id, "cmd");
    expect(cmd).toBe('curl -X ^"POST^" ^"https://a.test/things^" --data-raw ^"a^\n\nb^\n\nc^\n\nd^"');
    expect(parseCurl(cmd)!.body).toBe("a\nb\nc\nd");
  });

  it("escapes curl's URL globs, which the parser strips again", () => {
    const cmd = buildCurl(req({ url: "https://a.test/?f[x]={{VAR}}" }), id, "cmd");
    expect(cmd).toBe('curl ^"https://a.test/?f\\^[x\\^]=\\^{\\^{VAR\\^}\\^}^"');
    expect(parseCurl(cmd)!.url).toBe("https://a.test/?f[x]={{VAR}}");
  });
});

describe("buildCurl — PowerShell", () => {
  it("is curl.exe with single-quoted arguments, and no wrapper when nothing needs C-runtime quoting", () => {
    expect(
      buildCurl(req({ method: "weird; rm", headers: [{ name: "Accept", value: "it's $HOME `n" }] }), id, "powershell"),
    ).toBe("curl.exe -X 'WEIRD; RM' 'https://a.test/things' -H 'Accept: it''s $HOME `n'");
  });

  it("writes a quote as \"\" inside C-runtime quotes, and wraps the command for PowerShell 7.3+", () => {
    expect(
      buildCurl(
        req({ method: "POST", headers: [{ name: "content-type", value: "application/json" }], body: '{"a":"x y"}' }),
        id,
        "powershell",
      ),
    ).toBe(
      "& { $PSNativeCommandArgumentPassing = 'Legacy'; curl.exe -X POST 'https://a.test/things' " +
        `-H 'content-type: application/json' --data-raw '"{""a"":""x y""}"' }`,
    );
  });

  it("doubles a trailing backslash only where 5.1 adds the closing quote, and wraps then too", () => {
    expect(buildCurl(req({ headers: [{ name: "X-Dir", value: "C:\\dir\\" }] }), id, "powershell")).toBe(
      "& { $PSNativeCommandArgumentPassing = 'Legacy'; curl.exe 'https://a.test/things' -H 'X-Dir: C:\\dir\\\\' }",
    );
    // No whitespace → 5.1 passes it bare, so the backslash needs no doubling.
    expect(buildCurl(req({ url: "https://a.test/x\\" }), id, "powershell")).toBe("curl.exe 'https://a.test/x\\'");
  });

  it("escapes curl's URL globs the same way the cmd form does", () => {
    expect(buildCurl(req({ url: "https://a.test/?f[x]=1" }), id, "powershell")).toBe(
      "curl.exe 'https://a.test/?f\\[x\\]=1'",
    );
  });
});

describe("buildCurl — every shell round-trips through the real parser", () => {
  /** Values that have broken shell quoting somewhere — each one in a header AND the body. */
  const NASTY = [
    "plain",
    "two words",
    "it's",
    'say "hi"',
    '""',
    '"',
    "\\",
    "a\\",
    "a\\ b\\",
    '\\"',
    'x\\\\"y',
    "C:\\dir\\",
    // An EVEN backslash run mid-value: the parser halves careted ones (DevTools'
    // doubling), so this is the case that proves our cmd backslashes stay bare.
    '{"unc":"\\\\\\\\srv\\\\share"}',
    "%PATH% 100% %",
    "a&b|c<d>e^f",
    "!bang! $HOME `id` $(whoami) @(1) ; # ,",
    '{\n  "a": 1,\n  "b": "x\\ny"\n}',
    "tab\there",
    "é 世 🚀",
  ];
  const shells = ["bash", "cmd", "powershell"] as const;

  for (const shell of shells) {
    it(`${shell}: url with globs, headers and body survive buildCurl → parseCurl`, () => {
      for (const v of NASTY) {
        const request = req({
          method: "POST",
          url: "https://a.test/f[x]={y}?q=1&r=2",
          headers: [{ name: "X-V", value: v }],
          body: v,
        });
        expect({ v, parsed: parseCurl(buildCurl(request, id, shell)) }).toEqual({
          v,
          parsed: {
            method: "POST",
            url: request.url,
            headers: [{ name: "X-V", value: v.trim() }], // the parser trims header values
            body: v,
          },
        });
      }
    });

    it(`${shell}: an empty URL is still an argument (5.1 would drop a bare '')`, () => {
      expect(parseCurl(buildCurl(req({ url: "" }), id, shell))).toMatchObject({ url: "" });
    });
  }

  it("bash stays the default — the macOS/Linux output is unchanged", () => {
    const request = req({ method: "POST", body: 'it\'s "x"', headers: [{ name: "A", value: "1" }] });
    expect(buildCurl(request, id)).toBe(buildCurl(request, id, "bash"));
    expect(buildCurl(request, id)).toBe(`curl -X POST 'https://a.test/things' -H 'A: 1' --data 'it'\\''s "x"'`);
  });
});
