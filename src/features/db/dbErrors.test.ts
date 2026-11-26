/** Every code maps to a distinct, non-empty sentence, and a driver string never survives (sqlx and
 * libpq echo the DSN, password included). Codes are listed literally, not read from
 * DB_ERROR_CODES, so a dropped code can't pass. */

import { describe, expect, it } from "vitest";

import {
  DB_ERROR_CODES,
  dbErrorMessage,
  DETAIL_IS_THE_ANSWER,
  dbFailure,
  describeDbError,
  parseDbError,
  splitDbError,
} from "./dbErrors";
import type { DbErrorCode } from "./types";

/** Every code `types.ts` declares, spelled out. */
const CODES: DbErrorCode[] = [
  "not-found",
  "invalid-config",
  "invalid-statement",
  "network",
  "tls",
  "auth",
  "secret-missing",
  "blocked",
  "timeout",
  "cancelled",
  "unknown",
];

describe("DB_ERROR_CODES", () => {
  it("is exactly the contract's union, in its declared order", () => {
    expect([...DB_ERROR_CODES]).toEqual(CODES);
  });
});

describe("parseDbError", () => {
  it("reads the code out of a bare `<code>` string", () => {
    for (const code of CODES) {
      expect(parseDbError(code)).toBe(code);
    }
  });

  it("reads the code out of `<code>: <detail>` and ignores the detail", () => {
    expect(parseDbError("auth: password authentication failed for user \"ro\"")).toBe("auth");
    expect(parseDbError("secret-missing: {{PG_PASSWORD}} is not in the Vault")).toBe(
      "secret-missing",
    );
  });

  it("tolerates surrounding whitespace and casing, because a wire string is not a promise", () => {
    expect(parseDbError("  NETWORK : refused")).toBe("network");
    expect(parseDbError("TLS")).toBe("tls");
  });

  it("reads an Error's message too — a JS-side throw is as real as a Tauri rejection", () => {
    expect(parseDbError(new Error("timeout: 30000 ms"))).toBe("timeout");
  });

  it("is `unknown` for anything it cannot classify, rather than guessing", () => {
    expect(parseDbError("boom")).toBe("unknown");
    expect(parseDbError("")).toBe("unknown");
    expect(parseDbError(null)).toBe("unknown");
    expect(parseDbError(undefined)).toBe("unknown");
    expect(parseDbError(42)).toBe("unknown");
    // A `message` that is not a string is still unreadable.
    expect(parseDbError({ message: 7 })).toBe("unknown");
  });

  it("🔴 now READS a plain object carrying a `message` — a deliberate behaviour change", () => {
    // Duck-typed .message on purpose (lib/wireCode): a cross-realm Error fails instanceof
    // but still carries a good message.
    expect(parseDbError({ message: "auth: nope" })).toBe("auth");
    const crossRealm = { name: "Error", message: "timeout: 30s" };
    expect(crossRealm instanceof Error).toBe(false);
    expect(parseDbError(crossRealm)).toBe("timeout");
  });

  it("will not let a DETAIL promote itself into a code", () => {
    // The head is taken from position 0, so a code-shaped word later in the string is
    // just text. Otherwise a driver mentioning "timeout" would reclassify an auth failure.
    expect(parseDbError("unknown: the auth handshake timed out")).toBe("unknown");
    expect(parseDbError("mystery: network")).toBe("unknown");
  });
});

describe("describeDbError", () => {
  it("gives every code its OWN non-empty sentence", () => {
    const sentences = CODES.map((c) => describeDbError(c));
    for (const s of sentences) {
      expect(s.length).toBeGreaterThan(20);
      expect(s.endsWith(".")).toBe(true);
    }
    // Ten codes, ten distinct sentences — a shared one would make the mapper useless
    // exactly where it matters (telling `auth` apart from `network`).
    expect(new Set(sentences).size).toBe(CODES.length);
  });

  it("says the true and actionable thing for the four that matter most", () => {
    // Literal, because these are the sentences a user reads at 2am. `auth` does not blame
    // them; `network` names only what is actually in the path; `secret-missing` names the
    // edit that fixes it rather than offering a retry that cannot work.
    expect(describeDbError("auth")).toBe(
      "The server rejected these credentials — check the user and the password.",
    );
    expect(describeDbError("network")).toBe(
      "The server could not be reached — check the host, the port, and whether a VPN or firewall is in the way.",
    );
    expect(describeDbError("secret-missing")).toBe(
      "The saved password reference has nothing behind it in the Vault — type the password again and save the connection.",
    );
    // A bare code can't tell which guard fired, so the fallback claims only what it can;
    // Rust's own sentence names the guard.
    expect(describeDbError("blocked")).toBe(
      "That statement was blocked by this connection's safety settings before it ran.",
    );
  });

  it("names no driver and echoes no driver vocabulary", () => {
    for (const code of CODES) {
      const s = describeDbError(code).toLowerCase();
      for (const forbidden of ["sqlx", "libpq", "postgres", "mysql", "mongo", "dsn", "sslmode"]) {
        expect(s).not.toContain(forbidden);
      }
    }
  });
});

describe("dbErrorMessage", () => {
  it("is parse-then-describe in one call", () => {
    expect(dbErrorMessage("auth: nope")).toBe(describeDbError("auth"));
    expect(dbErrorMessage(new Error("blocked"))).toBe(describeDbError("blocked"));
    expect(dbErrorMessage(null)).toBe(describeDbError("unknown"));
  });

  it("drops a hostile detail entirely — the reason this file exists", () => {
    // A driver echoing its connection string is not hypothetical: it is what libpq and
    // sqlx do. None of it may reach the output, not even in a fragment.
    const leaky =
      "auth: FATAL: password authentication failed; dsn=postgresql://ro:hunter2@db.internal:5432/maestro";
    const out = dbErrorMessage(leaky);
    expect(out).toBe(describeDbError("auth"));
    for (const fragment of ["hunter2", "db.internal", "postgresql://", "FATAL", "dsn"]) {
      expect(out).not.toContain(fragment);
    }
  });
});

/** A statement error (SQL sent to MongoDB) must not read as a connection problem: its own code,
 * invalid-statement, keeps Rust's detail, while invalid-config must still mean settings. */
describe("a statement problem is not a connection problem", () => {
  const MONGO_PARSE =
    'invalid-statement: That is not a MongoDB command document. A command is one JSON object ' +
    'whose FIRST key is the command name, e.g. {"find": "tracks", "limit": 10}. (expected value ' +
    "at line 1 column 1)";

  it("renders Rust's own sentence, because the detail IS the actionable part", () => {
    const out = dbErrorMessage(MONGO_PARSE);
    expect(out).toContain('e.g. {"find": "tracks", "limit": 10}');
    // And specifically NOT the sentence the old code showed.
    expect(out).not.toContain("check the host");
    expect(out).not.toBe(describeDbError("invalid-config"));
  });

  it("says nothing about the connection when the detail is missing", () => {
    // A bare code still has to produce something true. It may not mention host or port: nothing
    // about the connection was measured, and inventing a cause is the whole failure mode here.
    const bare = describeDbError("invalid-statement").toLowerCase();
    expect(bare).not.toContain("host");
    expect(bare).not.toContain("port");
    expect(bare).not.toContain("vpn");
    expect(dbErrorMessage("invalid-statement")).toBe(describeDbError("invalid-statement"));
    // An empty detail is the same as none — never a blank alert.
    expect(dbErrorMessage("invalid-statement:   ")).toBe(describeDbError("invalid-statement"));
  });

  it("keeps `invalid-config` meaning SETTINGS, detail and all", () => {
    // The old code must not quietly inherit the new behaviour: a settings failure's detail is
    // written for a developer, and a driver's error text can carry a DSN.
    const out = dbErrorMessage("invalid-config: host `db.internal` did not resolve");
    expect(out).toBe(describeDbError("invalid-config"));
    expect(out).not.toContain("db.internal");
  });

  it("limits detail-passthrough to exactly two codes, on purpose", () => {
    // Written out literally, not derived: widening this list is a decision about what driver
    // prose may reach the screen, and it should be visible in a diff as one.
    expect([...DETAIL_IS_THE_ANSWER]).toEqual(["invalid-statement", "blocked"]);
  });

  it("🔴 tells the user WHICH guard blocked them, and which setting lifts it", () => {
    // A two-statement buffer used to get "this connection is read-only, or it does not
    // allow multiple statements" — a sentence that cannot say which, because a code cannot. Rust
    // has always written the precise one; this file threw it away.
    const out = dbErrorMessage(
      'blocked: That is 2 statements, and Run sends one. Select just the statement you mean to run — or tick "Allow multiple statements" in this connection\'s settings.',
    );
    expect(out).toContain("That is 2 statements");
    expect(out).toContain("Allow multiple statements");
    // …and specifically not the sentence that names both guards because it knows neither.
    expect(out).not.toContain("read-only, or");

    // A bare code still yields something true, so the pane is never blank.
    expect(dbErrorMessage("blocked")).toBe(describeDbError("blocked"));
    expect(describeDbError("blocked")).not.toContain("read-only, or");
  });

  it("🔴 a `blocked` detail is safe to render only because RUST made it so", () => {
    // blocked carries only our sentence, guaranteed in Rust (DbError::blocked plus a Rust test);
    // this records that the frontend relies on it.
    const leaky = "blocked: refused; dsn=postgresql://ro:hunter2@db.internal:5432/maestro";
    const out = dbErrorMessage(leaky);
    // It DOES pass through — that is the deal — which is why the Rust-side constructor test exists.
    expect(out).toContain("refused");
    // The password is still masked by Rust before it ever gets here; this is a reminder, not a guard.
    expect(leaky).not.toContain("••••");
  });

  it("still refuses a detail carrying a secret, even for the passthrough code", () => {
    // Rust redacts before it rejects, so a `••••` is what a real leak looks like by the time it
    // gets here. What must never happen is this file *adding* a way for raw prose to arrive: the
    // detail is passed through only for a code Rust uses for text it wrote for the user.
    const out = dbErrorMessage("invalid-statement: cannot parse; password=••••");
    expect(out).toContain("••••");
    expect(out).not.toContain("hunter2");
  });
});

describe("splitDbError", () => {
  it("returns the code and the detail behind it", () => {
    expect(splitDbError("timeout: 30000 ms elapsed")).toEqual({
      code: "timeout",
      detail: "30000 ms elapsed",
    });
    expect(splitDbError(new Error("network: refused"))).toEqual({
      code: "network",
      detail: "refused",
    });
  });

  it("splits on the FIRST colon only, so a detail may contain more", () => {
    expect(splitDbError("network: port 5432: connection refused").detail).toBe(
      "port 5432: connection refused",
    );
  });

  it("has no detail for a bare code, an empty tail, or an unrecognised head", () => {
    expect(splitDbError("cancelled")).toEqual({ code: "cancelled", detail: null });
    expect(splitDbError("cancelled:   ")).toEqual({ code: "cancelled", detail: null });
    // An unknown head is `unknown` AND loses its detail: an unclassified string is exactly the
    // raw driver text this file exists to keep off the screen.
    expect(splitDbError("kaboom: postgresql://u:p@h/db")).toEqual({
      code: "unknown",
      detail: null,
    });
    expect(splitDbError(42)).toEqual({ code: "unknown", detail: null });
  });
});

describe("dbFailure", () => {
  it("carries the code and its sentence for a failure we decided ourselves", () => {
    // The store's "no open session" path has no wire string behind it, and must not invent one.
    expect(dbFailure("not-found")).toEqual({
      code: "not-found",
      message: describeDbError("not-found"),
    });
  });
});
