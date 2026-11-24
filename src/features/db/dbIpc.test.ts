/**
 * `dbIpc` — the database client's wire. Thin wrappers, so the command **name**, the
 * **argument shape**, and the **rejection passthrough** are the whole contract, and all
 * three are the kind of thing that fails as silence rather than as an error.
 *
 * Why every argument is asserted BY NAME: Tauri deserialises a command's arguments by key
 * (`connection_id` in Rust ⇄ `connectionId` in JS). A renamed or misspelled key does not
 * throw — serde fills the field from its `#[serde(default)]`, or the command rejects with a
 * message about a field the caller never mentioned. So `sessionId` vs `session_id` vs
 * `sessionID` is exactly one keystroke away from a feature that silently does nothing, and
 * the only defence is a test that spells the key out. Same reason `usageIpc.test.ts` asserts
 * its *empty* args object rather than shrugging at `undefined`.
 *
 * Every expectation here is written LITERALLY rather than derived from the wrapper's own
 * input: an assertion computed from the value under test can only catch
 * plumbing, never a wrong name.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTauriMock, type TauriMock } from "../../test/tauri-mock";
import {
  connectionAsInput,
  connectionInput,
  dbCancel,
  dbChildren,
  dbClose,
  dbConnectionDelete,
  dbConnectionUpsert,
  dbConnectionsLoad,
  dbEngines,
  dbOpen,
  dbQuery,
  dbSavedQueries,
  dbSavedQueryDelete,
  dbTreeOrder,
  dbTreeOrderSet,
  dbSavedQueryUpsert,
  dbTestConnection,
  dbUrlBuild,
  dbUrlParse,
} from "./dbIpc";
import { POSTGRES_ENGINE } from "./dbFixtures";
import type { DbConnection, DbConnectionDraft } from "./types";

/** A draft with no secret in it — which is the point: `DbConnectionDraft` has no field
 *  that could hold one. */
const DRAFT: DbConnectionDraft = {
  name: "Prod Postgres",
  engine: "postgres",
  family: "postgres",
  host: "db.internal",
  port: 5432,
  database: "maestro",
  user: "ro",
  passwordRef: "",
  savePassword: "forever",
  url: null,
  srv: false,
  passwordParam: null,
  sslMode: "prefer",
  caSummary: null,
  options: {},
  readOnly: true,
  rowLimit: 500,
  timeoutMs: 30_000,
  allowMultiStatement: false,
};

/** A saved record, as `db_connections_load` hands one back. */
const SAVED: DbConnection = {
  ...DRAFT,
  id: "01J000000000000000000000",
  createdAt: 1_783_000_000_000,
  updatedAt: 1_783_000_000_001,
};

describe("dbIpc — command names and argument shapes", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  /**
   * The args of the last `cmd` call, asserted to exist first.
   *
   * `lastCall` is `… | undefined` for a command never invoked, and an `expect(x).toEqual()`
   * on `undefined` would pass for the wrong reason if the wrapper called nothing at all.
   * The `toBeDefined` is the assertion that makes every `args(...)` below meaningful.
   */
  const args = (cmd: string): Record<string, unknown> => {
    const call = ipc.lastCall(cmd);
    expect(call).toBeDefined();
    return call as Record<string, unknown>;
  };

  it("db_engines takes an empty args object and resolves the registry untouched", async () => {
    ipc.handle("db_engines", () => [POSTGRES_ENGINE]);

    await expect(dbEngines()).resolves.toEqual([POSTGRES_ENGINE]);
    // `{}`, not `undefined`: the command takes no arguments, and sending a key Rust does
    // not read would fail as silence rather than as an error.
    expect(args("db_engines")).toEqual({});
  });

  it("db_connections_load takes an empty args object", async () => {
    ipc.handle("db_connections_load", () => ({ connections: [SAVED], version: 1 }));

    await expect(dbConnectionsLoad()).resolves.toEqual({
      connections: [SAVED],
      version: 1,
    });
    expect(args("db_connections_load")).toEqual({});
  });

  it("db_connection_upsert sends `input` and `password` as SEPARATE keys", async () => {
    ipc.handle("db_connection_upsert", () => SAVED);

    await expect(
      dbConnectionUpsert(connectionInput(DRAFT, null), "hunter2"),
    ).resolves.toEqual(SAVED);

    const sent = args("db_connection_upsert");
    expect(Object.keys(sent).sort()).toEqual(["input", "password"]);
    expect(sent.password).toBe("hunter2");
    // The secret is NOT inside the record. Asserted on the serialised object rather than
    // on the type, because the type is what a future edit would change first.
    expect(JSON.stringify(sent.input)).not.toContain("hunter2");
    expect(sent.input).toEqual({ ...DRAFT, id: null });
  });

  it("normalises an absent password to null, in both shapes that mean it", async () => {
    ipc.handle("db_connection_upsert", () => SAVED);
    ipc.handle("db_test_connection", () => ({
      ok: true,
      serverVersion: "PostgreSQL 17.2",
      latencyMs: 3,
      error: null,
    }));
    ipc.handle("db_open", () => "sess-1");

    // `""` and `null` both mean "the user typed none". Rust already treats them
    // identically (`filter(|s| !s.is_empty())`), so the wire carries one shape.
    await dbConnectionUpsert(connectionInput(DRAFT, null), "");
    expect(args("db_connection_upsert").password).toBeNull();
    await dbConnectionUpsert(connectionInput(DRAFT, null), null);
    expect(args("db_connection_upsert").password).toBeNull();
    await dbTestConnection(connectionInput(DRAFT, null), "");
    expect(args("db_test_connection").password).toBeNull();
    await dbOpen("c1", "");
    expect(args("db_open").password).toBeNull();
  });

  it("db_connection_upsert carries an id when it is EDITING, not creating", async () => {
    ipc.handle("db_connection_upsert", () => SAVED);

    await dbConnectionUpsert(connectionInput(DRAFT, "01J000000000000000000000"), null);
    expect(args("db_connection_upsert").input).toEqual({
      ...DRAFT,
      id: "01J000000000000000000000",
    });
  });

  it("db_connection_delete sends `id`", async () => {
    ipc.handle("db_connection_delete", () => ({ removed: true, savedQueriesRemoved: 0 }));

    await expect(dbConnectionDelete("c1")).resolves.toEqual({
      removed: true,
      savedQueriesRemoved: 0,
    });
    expect(args("db_connection_delete")).toEqual({ id: "c1" });
  });

  it("db_url_build sends `input` and has NO password key at all", async () => {
    ipc.handle("db_url_build", () => "postgresql://ro@db.internal:5432/maestro");

    await expect(dbUrlBuild(connectionInput(DRAFT, null))).resolves.toBe(
      "postgresql://ro@db.internal:5432/maestro",
    );
    // The absence is the assertion: this command's output goes to a clipboard, so there
    // is no argument it could put a literal password into.
    expect(Object.keys(args("db_url_build"))).toEqual(["input"]);
  });

  it("db_url_parse sends `text`", async () => {
    const parsed = {
      engine: "postgres" as const,
      family: "postgres" as const,
      host: "db.internal",
      port: 5432,
      database: "maestro",
      user: "ro",
      hadPassword: true,
      passwordParam: "password",
      sslMode: null,
      url: "postgresql://ro@db.internal:5432/maestro",
      options: {},
    };
    ipc.handle("db_url_parse", () => parsed);

    await expect(dbUrlParse("postgresql://ro@db.internal:5432/maestro?password=x"))
      .resolves.toEqual(parsed);
    expect(args("db_url_parse")).toEqual({
      text: "postgresql://ro@db.internal:5432/maestro?password=x",
    });
  });

  it("db_test_connection sends `input` + `password` and resolves a FAILURE, not a rejection", async () => {
    const failure = {
      ok: false,
      serverVersion: null,
      latencyMs: null,
      error: "Could not reach db.internal:5432.",
    };
    ipc.handle("db_test_connection", () => failure);

    // An unreachable server is a RESULT (the `http_send` contract). A wrapper that turned
    // this into a rejection would make the dialog's whole pending/error model wrong.
    await expect(
      dbTestConnection(connectionAsInput(SAVED), "hunter2"),
    ).resolves.toEqual(failure);
    const sent = args("db_test_connection");
    expect(Object.keys(sent).sort()).toEqual(["input", "password"]);
    expect(sent.password).toBe("hunter2");
  });

  it("db_open sends `connectionId` (camelCase) + `password`, and returns a session id", async () => {
    ipc.handle("db_open", () => "01SESSION");

    await expect(dbOpen("01CONN", null)).resolves.toBe("01SESSION");
    // camelCase, matching Rust's `connection_id`. `connection_id` here would be silently
    // ignored and the command would reject about a missing field.
    expect(args("db_open")).toEqual({
      connectionId: "01CONN",
      password: null,
    });
  });

  it("db_close sends `sessionId`", async () => {
    ipc.handle("db_close", () => undefined);

    await expect(dbClose("01SESSION")).resolves.toBeUndefined();
    expect(args("db_close")).toEqual({ sessionId: "01SESSION" });
  });

  it("db_cancel sends `sessionId`", async () => {
    ipc.handle("db_cancel", () => undefined);

    await expect(dbCancel("01SESSION")).resolves.toBeUndefined();
    expect(args("db_cancel")).toEqual({ sessionId: "01SESSION" });
  });

  it("db_cancel PASSES A REFUSAL THROUGH — three engines have no server-side cancel", async () => {
    // 🔴 The rejection is the informative case, not the exceptional one: MongoDB, Redis and
    // DynamoDB answer structurally (`cancel_handle()` is `None`) with no round trip. Swallowing it
    // here would give the console a Stop button that quietly did nothing — and the string must
    // arrive UNMODIFIED, because the caller parses the `<code>: <detail>` wire shape out of it.
    ipc.handle("db_cancel", () => {
      throw new Error("unknown: This engine has no server-side cancel.");
    });

    await expect(dbCancel("01SESSION")).rejects.toThrow(/no server-side cancel/);
  });

  it("db_query sends sessionId, sql, mode and rowLimit — all four, by name", async () => {
    ipc.handle("db_query", () => []);

    await dbQuery("01SESSION", "select 1", "statement", 500);
    expect(args("db_query")).toEqual({
      sessionId: "01SESSION",
      sql: "select 1",
      mode: "statement",
      rowLimit: 500,
    });
  });

  it("db_query sends explicit nulls for the optional pair rather than omitting them", async () => {
    ipc.handle("db_query", () => []);

    // Rust's defaults are the safe ones (`statement`, the connection's row limit), and a
    // caller that means "the default" says so on the wire — an omitted key is
    // indistinguishable from a renamed one.
    await dbQuery("01SESSION", "select 1", null, null);
    expect(args("db_query")).toEqual({
      sessionId: "01SESSION",
      sql: "select 1",
      mode: null,
      rowLimit: null,
    });
  });

  it("passes `script` mode through verbatim — the kebab-case spelling Rust expects", async () => {
    ipc.handle("db_query", () => []);
    await dbQuery("01SESSION", "select 1; select 2", "script", null);
    expect(args("db_query").mode).toBe("script");
  });

  /* ───────────── the tree and the saved queries ───────────── */

  it("🔴 db_children sends sessionId and the ref UNTOUCHED, tag included", async () => {
    ipc.handle("db_children", () => []);
    await dbChildren("01SESSION", {
      kind: "group",
      database: "maestro",
      schema: "public",
      group: "tables",
    });
    // The ref goes back exactly as Rust sent it — `tree.rs` asserts the round trip on its
    // side, and a dropped `kind` here would fail as an unreadable deserialisation error
    // (serde's tag is what selects the variant).
    expect(args("db_children")).toEqual({
      sessionId: "01SESSION",
      node: { kind: "group", database: "maestro", schema: "public", group: "tables" },
    });
  });

  it("db_children keeps a null schema, which is a real shape and not an absence", async () => {
    ipc.handle("db_children", () => []);
    await dbChildren("01SESSION", { kind: "table", database: "shop", schema: null, name: "o" });
    expect(args("db_children")).toEqual({
      sessionId: "01SESSION",
      node: { kind: "table", database: "shop", schema: null, name: "o" },
    });
  });

  it("db_children resolves the node list with Rust's OWN field names", async () => {
    // `nodeRef`, not `ref`, and `subLabel`, not `sub_label`. `types.ts` says `ref`, which is
    // wrong — this assertion is what pins which of the two the app actually reads.
    ipc.handle("db_children", () => [
      {
        nodeRef: { kind: "database", name: "maestro" },
        label: "maestro",
        subLabel: "the connected database",
        kind: "database",
        expandable: true,
      },
    ]);
    const nodes = await dbChildren("01SESSION", { kind: "root" });
    expect(nodes[0].nodeRef).toEqual({ kind: "database", name: "maestro" });
    expect(nodes[0].subLabel).toBe("the connected database");
  });

  it("🔴 db_tree_order takes a CONNECTION id — not a session id", async () => {
    ipc.handle("db_tree_order", () => []);
    await dbTreeOrder("01CONNECTION");
    // Same distinction as the saved queries: a hand-arranged order belongs to the user, not
    // to the server, so it must be readable with no session — including while the database
    // is unreachable, which is exactly when someone opens the tree to look at it.
    expect(args("db_tree_order")).toEqual({ connectionId: "01CONNECTION" });
  });

  it("db_tree_order resolves levels with Rust's camelCase field names", async () => {
    // A snake_case slip here would surface as `undefined` keys — every level silently
    // rendering alphabetically, with no error anywhere.
    ipc.handle("db_tree_order", () => [
      { connectionId: "c1", parentKey: '["group","g","public","tables"]', keys: ["c", "a"] },
    ]);
    const [level] = await dbTreeOrder("c1");
    expect(level.parentKey).toBe('["group","g","public","tables"]');
    expect(level.keys).toEqual(["c", "a"]);
  });

  it("db_tree_order_set sends the connection, the parent key and the order", async () => {
    ipc.handle("db_tree_order_set", () => null);
    await dbTreeOrderSet("c1", "LVL", ["c", "b", "a"]);
    expect(args("db_tree_order_set")).toEqual({
      connectionId: "c1",
      parentKey: "LVL",
      keys: ["c", "b", "a"],
    });
  });

  it("db_tree_order_set carries an EMPTY order — that is how a reset is expressed", async () => {
    ipc.handle("db_tree_order_set", () => null);
    await dbTreeOrderSet("c1", "LVL", []);
    // Two gestures, one command, so "no custom order" has exactly one representation on
    // disk. A separate clear command would be a second chance to disagree about that.
    expect(args("db_tree_order_set")).toEqual({ connectionId: "c1", parentKey: "LVL", keys: [] });
  });

  it("🔴 db_saved_queries takes a CONNECTION id — not a session id", async () => {
    ipc.handle("db_saved_queries", () => []);
    await dbSavedQueries("01CONNECTION");
    // The distinction matters: the list must be readable with no session at all, so
    // sending `sessionId` here would be a feature that only works while connected.
    expect(args("db_saved_queries")).toEqual({ connectionId: "01CONNECTION" });
  });

  it("db_saved_queries resolves records with Rust's `sql` / `…Ms` names", async () => {
    // `types.ts` calls these `text` / `createdAt` / `updatedAt`. Reading THOSE would have made
    // every saved query's SQL `undefined` — silence, not an error.
    ipc.handle("db_saved_queries", () => [
      {
        id: "Q1",
        connectionId: "c1",
        name: "Recent tracks",
        sql: "SELECT 1",
        createdAtMs: 10,
        updatedAtMs: 20,
      },
    ]);
    const [q] = await dbSavedQueries("c1");
    expect(q.sql).toBe("SELECT 1");
    expect(q.createdAtMs).toBe(10);
    expect(q.updatedAtMs).toBe(20);
  });

  it("db_saved_query_upsert nests the record under `input`, with a null id to create", async () => {
    ipc.handle("db_saved_query_upsert", () => ({
      id: "Q1",
      connectionId: "c1",
      name: "A",
      sql: "SELECT 1",
      createdAtMs: 1,
      updatedAtMs: 1,
    }));
    await dbSavedQueryUpsert({ id: null, connectionId: "c1", name: "A", sql: "SELECT 1" });
    // One `input` key, not four top-level ones: Rust's parameter is a single struct.
    expect(args("db_saved_query_upsert")).toEqual({
      input: { id: null, connectionId: "c1", name: "A", sql: "SELECT 1" },
    });
  });

  it("db_saved_query_upsert sends a ULID to update in place", async () => {
    ipc.handle("db_saved_query_upsert", () => ({
      id: "Q1",
      connectionId: "c1",
      name: "A",
      sql: "SELECT 2",
      createdAtMs: 1,
      updatedAtMs: 9,
    }));
    const saved = await dbSavedQueryUpsert({
      id: "Q1",
      connectionId: "c1",
      name: "A",
      sql: "SELECT 2",
    });
    expect(args("db_saved_query_upsert")).toEqual({
      input: { id: "Q1", connectionId: "c1", name: "A", sql: "SELECT 2" },
    });
    // And the creation time Rust preserved comes back — the record is the server's, not ours.
    expect(saved.createdAtMs).toBe(1);
    expect(saved.updatedAtMs).toBe(9);
  });

  it("db_saved_query_delete sends the id and resolves the boolean verbatim", async () => {
    ipc.handle("db_saved_query_delete", () => false);
    // `false` is not an error — it means our list was stale, and the caller says so rather
    // than letting it look identical to a successful delete.
    await expect(dbSavedQueryDelete("Q1")).resolves.toBe(false);
    expect(args("db_saved_query_delete")).toEqual({ id: "Q1" });
  });
});

describe("dbIpc — rejections are passed through untouched", () => {
  let ipc: TauriMock;

  beforeEach(() => {
    ipc = installTauriMock();
  });
  afterEach(() => {
    ipc.reset();
  });

  // The whole point of not swallowing: the caller classifies the code out of the string
  // (`parseDbError`), which only works if the string arrives byte-for-byte.
  it("keeps the stable `<code>: <detail>` string on every fallible command", async () => {
    const cases: Array<[string, string, () => Promise<unknown>]> = [
      ["db_engines", "unknown: registry", () => dbEngines()],
      ["db_connections_load", "unknown: io", () => dbConnectionsLoad()],
      [
        "db_connection_upsert",
        "invalid-config: Host is required.",
        () => dbConnectionUpsert(connectionInput(DRAFT, null), null),
      ],
      ["db_connection_delete", "not-found", () => dbConnectionDelete("c1")],
      ["db_url_build", "invalid-config: no host", () => dbUrlBuild(connectionInput(DRAFT, null))],
      ["db_url_parse", "invalid-config: No scheme", () => dbUrlParse("nonsense")],
      [
        "db_test_connection",
        "network: refused",
        () => dbTestConnection(connectionInput(DRAFT, null), null),
      ],
      ["db_open", "secret-missing: {{PG}}", () => dbOpen("c1", null)],
      ["db_close", "unknown", () => dbClose("s1")],
      ["db_query", "blocked: read-only", () => dbQuery("s1", "drop table t", null, null)],
      // The tree renders a failed expand as an inline note, which it can only
      // do if the code survives the wrapper.
      ["db_children", "not-found: session gone", () => dbChildren("s1", { kind: "root" })],
      ["db_saved_queries", "unknown: io", () => dbSavedQueries("c1")],
      [
        "db_saved_query_upsert",
        "invalid-config: A saved query needs a name.",
        () => dbSavedQueryUpsert({ id: null, connectionId: "c1", name: "", sql: "SELECT 1" }),
      ],
      ["db_saved_query_delete", "unknown: io", () => dbSavedQueryDelete("Q1")],
    ];

    for (const [cmd, wire, call] of cases) {
      ipc.handle(cmd, () => Promise.reject(wire));
      // `toBe`, not `toEqual`: Rust rejects with a STRING, never an `Error`, and a wrapper
      // that wrapped it would break `parseDbError`'s `typeof raw === "string"` path.
      await expect(call()).rejects.toBe(wire);
    }
  });
});

describe("connectionInput / connectionAsInput", () => {
  it("always sends `id` explicitly — null to create, a ULID to update", () => {
    // Present-and-null rather than absent: serde reads the NAME, so an omitted key fails
    // as silence. Same reasoning as `toRecord`'s explicit `caPath: null`.
    expect(connectionInput(DRAFT, null).id).toBeNull();
    expect(connectionInput(DRAFT, "01ABC").id).toBe("01ABC");
    expect("id" in connectionInput(DRAFT, null)).toBe(true);
  });

  it("does not mutate the draft it was handed", () => {
    const draft = { ...DRAFT, options: { applicationName: "Agent Studio" } };
    connectionInput(draft, "01ABC");
    expect(draft).not.toHaveProperty("id");
  });

  it("turns a SAVED record into an input without its Rust-owned timestamps", () => {
    const input = connectionAsInput(SAVED);
    expect(input.id).toBe("01J000000000000000000000");
    // `createdAt`/`updatedAt` belong to Rust, and a spread would have put them (and the
    // next field anyone adds) on the wire by accident.
    expect(input).not.toHaveProperty("createdAt");
    expect(input).not.toHaveProperty("updatedAt");
    // And no `caPath`: private-CA pinning is unimplemented on both sides, so the field was
    // removed rather than sent as a null nobody reads (see `types.ts`). Asserted as an
    // absence so re-adding it on ONE side alone goes red here.
    expect(input).not.toHaveProperty("caPath");
  });

  it("copies the options map rather than aliasing the store's", () => {
    const saved: DbConnection = { ...SAVED, options: { applicationName: "Agent Studio" } };
    const input = connectionAsInput(saved);
    input.options.applicationName = "mutated";
    expect(saved.options.applicationName).toBe("Agent Studio");
  });

  it("carries every guardrail through, so a connection cannot be probed with weaker limits", () => {
    const saved: DbConnection = {
      ...SAVED,
      readOnly: false,
      rowLimit: 12_345,
      timeoutMs: 4_000,
      allowMultiStatement: true,
      sslMode: "verify-full",
      passwordRef: "{{PG_PASSWORD}}",
      url: "postgresql://ro@db.internal:5432/maestro?password={{PG_PASSWORD}}",
    };
    const input = connectionAsInput(saved);
    expect(input.readOnly).toBe(false);
    expect(input.rowLimit).toBe(12_345);
    expect(input.timeoutMs).toBe(4_000);
    expect(input.allowMultiStatement).toBe(true);
    expect(input.sslMode).toBe("verify-full");
    // A `{{VAR}}` is a REFERENCE, not a secret — it must survive, or Rust has nothing to
    // resolve against the Vault.
    expect(input.passwordRef).toBe("{{PG_PASSWORD}}");
    expect(input.url).toBe(
      "postgresql://ro@db.internal:5432/maestro?password={{PG_PASSWORD}}",
    );
  });
});
