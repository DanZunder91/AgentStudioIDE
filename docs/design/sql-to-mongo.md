# SQL → MongoDB translation — design

> **Status:** Design for `src-tauri/src/db/sqlmongo.rs`. It records the **decisions and
> the contract**, not the shipped code: the module is the source of truth for function
> signatures and test counts, and nothing here claims a passing gate. Where a claim was
> not verified, the sentence says so.
>
> **Builds on:** the database client's `mongodb` driver, what "Run" means per engine,
> the row cap, the Mongo read-only allowlist, and DynamoDB (the precedent for "this
> engine is genuinely different"); the testing rules this repo applies everywhere — a
> table-driven test must not read its expectations from the table under test, a live
> test only ever touches the local fixture, the seam between two halves gets its own
> test, a lossy mapping says so in the output, and `serde_json::Value` re-orders keys;
> and two product constraints — zero-install, and one crypto provider.
>
> **Source of record for MongoDB's own SQL support:**
> <https://www.mongodb.com/docs/atlas/data-federation/supported-unsupported/pipeline/sql/>

---

## 1. The problem, and what MongoDB actually supports

A user coming from SQL tools types this into a MongoDB console:

```sql
select * from ARCHIVEDB.items LIMIT 10;
```

Without translation it is refused — `mongo.rs::sql_hint` recognises the SQL opener and
answers *"that is SQL, and this console speaks MongoDB's own command language"*. The
expectation behind the statement is that `select * from` is something MongoDB can do.

**That is half right, and the half that is right is the reason this document
exists.** Checked against MongoDB's own documentation rather than from memory:

| Claim | Verdict |
|---|---|
| MongoDB's wire protocol accepts SQL | **No.** Every operation is a BSON **command document** in an OP_MSG body. There is no SQL parser anywhere in `mongod`. |
| Atlas can run `SELECT` | **Yes** — through the **`$sql` aggregation stage**, `SELECT` and `UNION` only. |
| …against any cluster | **No.** `$sql` is only valid against an **Atlas Data Federation federated database instance**. A normal replica set or Atlas cluster rejects it. |

So a console pointed at an ordinary cluster genuinely cannot send SQL, and the
refusal is factually correct. It is also not what SQL-first database tools visibly do.

**Translation resolves it.** A tool can run that exact statement against an ordinary
cluster and return rows without sending SQL to MongoDB at all: it **translates SQL into
MongoDB operations client-side**, and the server never sees a `SELECT`. The expectation
is true about the *tool* and the refusal is true about the *protocol*, and both
statements can be true at once because the translation happens in between.

**So this console translates**: it parses the SQL in Rust and emits a MongoDB command
document. `src-tauri/src/db/sqlmongo.rs`.

---

## 2. The approach: translate client-side, and own the mapping

Two halves, split deliberately along the line of "who should be trusted with this".

**`sqlparser` 0.62 does the parsing.** There is no trustworthy Rust "SQL → MongoDB"
crate; the equivalents in other ecosystems are unmaintained toys, and a translator you
cannot read is a translator that can be wrong without telling you. Parsing, on the
other hand, is exactly the part a library should own. Hand-rolling a `WHERE` parser is
the classic way a translator produces a *different query* silently — operator
precedence between `AND` and `OR`, a quoted identifier containing a space, a string
literal containing a `)`. `sqlparser` is Apache-2.0, is what DataFusion parses with,
and produces a typed AST we can pattern-match exhaustively.

**The mapping to a command document is ours**, in this repo, under test. That is where
every decision lives (§4–§7), and a decision made inside someone else's crate is a
decision nobody here reviewed.

The output is an ordinary command document — the same thing a user can type into the
console by hand:

```
select * from ARCHIVEDB.items limit 10;

  →  { "find": "items", "filter": {}, "limit": 10, "$db": "ARCHIVEDB" }
```

This has a consequence worth naming: **the translator adds no new execution path.**
The document it produces goes through `parse_command`'s successors exactly like a
hand-typed one — `take_db_override` (§7), the read-only guard (`find` is on the
read-only allowlist), `with_cursor_defaults`, the cap+1 cursor read behind the row cap,
and the absence notice. A translated query cannot bypass a guard, because after
translation there is nothing left that knows it was ever SQL.

It also means the translated document is **showable**, and it should be shown. A user
who can see `{ "find": …, "filter": … }` next to their SQL can tell whether the
translation understood them. A translator that hides its output is asking to be
trusted; one that prints it is checkable. (The exact surface — a notice, a toggle, an
echo above the grid — is a UI decision that belongs to the console, not to this
module.)

---

## 3. The dependency measurement

Measured against a **608-package** `src-tauri/Cargo.lock`:

| Configuration | Packages added | What arrives |
|---|---|---|
| `sqlparser = "0.62"` (default features **on**) | **+7** | includes `recursive` → `stacker` → **`psm`, which compiles C** |
| `default-features = false, features = ["std"]` | **+1** (608 → 609) | `sqlparser` alone; its only dependency, `log`, was already in the tree |

**We took the second, and the reason is the vendored-C gate, not tidiness.** `psm`
runs a C/assembly compiler at build time, which means `scripts/audit.mjs`'s
`classifyVendoredC` would fail the audit as *UNREVIEWED* until someone wrote a dated
entry with a CVE review for it — a permanent new line in the native-code watch list,
acquired for the benefit of a **parser**. The watch list is small on purpose; the
things on it (libgit2, zlib, ring) are there because we need them, and each one is a
standing obligation to re-read on every version bump. A SQL parser is not a reason to
grow it.

**The cost, stated rather than glossed:** `default-features = false` turns off
`recursive-protection`, so `sqlparser` no longer grows the stack on deeply nested
input. Deeply nested SQL could therefore overflow the stack instead of returning a
parse error, and a stack overflow in the Tauri core aborts the process. **So
`sqlmongo` refuses over-long input** — a length bound applied before the parser is
called, rather than relying on the crate to survive whatever arrives. This is the
right shape anyway: the supported grammar (§4) has no construct that needs a long
statement, so a bound that a legitimate query cannot reach is free.

With this configuration **`npm run audit` passes and the vendored-C count stays at
7**; `npm run verify` re-checks both on every run.

`Cargo.lock` pins `sqlparser 0.62.0` with `log` as its only dependency, and
`grep -c '^name = '` reported **609** packages when it was added.

---

## 4. The supported grammar

The scope is deliberately tiny:

```
SELECT * FROM [database.]collection [WHERE <predicate>] [LIMIT <n>]
```

| SQL | MongoDB | Notes |
|---|---|---|
| `SELECT *` | no `projection` | `*` is the **only** select list. See §5. |
| `FROM collection` | `{"find": "collection"}` | Runs against the connection's database. |
| `FROM db.collection` | `{"find": "collection", "$db": "db"}` | §7 — this is load-bearing. |
| `WHERE a = 1` | `{"filter": {"a": 1}}` | |
| `WHERE a <> 1` | `{"a": {"$ne": 1}}` | ⚠️ §6 |
| `WHERE a < / <= / > / >=` | `$lt` / `$lte` / `$gt` / `$gte` | |
| `WHERE a IN (…)` | `{"a": {"$in": […]}}` | |
| `WHERE a IS NULL` | `{"a": null}` | ⚠️ §6 — **not** the same set of documents |
| `WHERE a IS NOT NULL` | `{"a": {"$ne": null}}` | ⚠️ §6, same mechanism |
| `WHERE a LIKE 'x%'` | `{"a": {"$regex": "^x"}}` | ⚠️ §6 — metacharacters escaped |
| `… AND …` / `… OR …` | `$and` / `$or` | Precedence comes from the AST, not from us |
| `LIMIT n` | `{"limit": n}` | Interacts with the row cap — see below |

**On `LIMIT` and the row cap.** The translated `limit` is sent to the server, and the
session's own cap still applies independently: `MongoSession::execute` reads `cap + 1`
documents from the cursor and treats the extra one as the truncation signal. So
`LIMIT 10` on a connection whose `rowLimit` is 500 returns at most 10; `LIMIT 100000`
on the same connection returns 500 rows with `truncated: true`. The smaller of the two
wins, which is the behaviour a user would guess, and the truncation is already
reported by the existing grid.

**The exact operator set is the module's to fix, not this document's.** The table
above is the contract this design asks for; if the implementation supports fewer
operators, the rule in §5 makes that safe — the ones it does not support are refused
by name rather than approximated. What is **not** negotiable is the direction: adding
an operator is a change with a test, and no operator may be handled by falling through
to a default.

---

## 5. 🔴 The rule everything else follows from: never guess

**Anything outside the subset is refused, with a message naming the construct.**

This is the whole design in one sentence, and it is worth being explicit about why,
because the tempting alternative always looks helpful. A translator that approximates
— that drops an `ORDER BY` it cannot express, that turns `COUNT(*)` into a `find` and
counts the rows it happened to fetch, that ignores an `OFFSET` — **returns wrong data
with no error**. The user gets a grid full of plausible rows and no indication that
the question they asked is not the question that was answered. That is strictly worse
than a refusal, and it is also worse than the SQL simply not being accepted at all:
before this feature, `select * from …` failed loudly and the user knew where they
stood.

A refusal costs the user one round trip and a sentence. A silent approximation costs
them a decision made on wrong data, and they will never know to check.

So: **the translator has no default branch.** Every AST node it does not explicitly
handle produces a refusal that names it.

### The refusal list

| Construct | Why it is refused rather than approximated |
|---|---|
| A projection — `SELECT a, b` | Expressible (`projection`), but out of scope, and half-implementing a select list is how `SELECT a, count(*)` becomes wrong. |
| `SELECT DISTINCT` | MongoDB's `distinct` is a different command with a different reply shape, not an option on `find`. |
| `ORDER BY` | Not in scope for now. Expressible as `sort`; deliberately not built yet. |
| `COUNT(*)` and any aggregate | A different command (`count`/`aggregate`) with a different result shape. Faking it from a capped `find` would count **the rows the cap let through**, which is a wrong number that looks right. |
| `GROUP BY` / `HAVING` | `$group` in an aggregation pipeline — a whole second translator. |
| `OFFSET` / `SKIP` | Expressible (`skip`), out of scope; and an offset silently dropped is the exact silent-wrong-data case. |
| `JOIN` (any kind) | `$lookup`, with semantics that do not match SQL joins. |
| A subquery, anywhere | Requires executing one query to build another. |
| `UNION` / `INTERSECT` / `EXCEPT` | Not a `find`. (Note Atlas `$sql` supports `UNION`; we do not — see §9.) |
| `INSERT` / `UPDATE` / `DELETE` / any DDL | Out of scope. Also the highest-consequence thing a wrong translation could do. |
| More than one statement | The Mongo console runs exactly one command document per run; that does not change because the input is SQL. |
| A `WHERE` operator outside §4 | Named individually. |
| Input past the length bound | §3 — the `recursive-protection` track. |

Each of these is a **named** refusal. *"Unsupported SQL"* is not an acceptable
message: the user needs to know which word to delete.

### And the seam this creates

`mongo.rs::sql_hint` currently refuses **every** statement beginning with a SQL opener
— `select`, `insert`, `update`, `with`, `show`, … — with a message pointing at command
documents. Once translation lands, a supported `SELECT` must reach the translator and
not `sql_hint`, while `insert`/`update`/DDL must still land on a refusal. That is a
routing change across two modules, which is precisely the shape that fails quietly:
two 100%-covered halves and nothing exercising the join. One test must own it, drive
`parse_command`-and-onward end to end, and be **seen to fail** when the routing is
removed.

`sql_hint`'s existing sentence about Atlas Data Federation stays useful for the
statements that are still refused, and its second half — *"only against a federated
database instance, not a cluster like this one"* — becomes more important once part of
SQL works, not less: the boundary between "we translate this" and "MongoDB genuinely
cannot do this" is now something the user has to be able to find.

---

## 6. The semantic gaps, which are reported and not smoothed

SQL and MongoDB do not agree about missing data, and the disagreement is not a corner
case — it is the second query anyone writes. When the mapping cannot
preserve a distinction, **the loss goes in the output**, in the result's `notice`,
where the person looking at the data will see it. Not only here.

**`IS NULL` matches more documents in MongoDB than in SQL.** `{"a": null}` matches a
document whose `a` is an explicit BSON Null **and** a document that has no `a` field
at all. SQL has no third state: a column that is not in the row does not exist as a
concept. So `WHERE tag IS NULL` translated faithfully returns a strict superset of
what a SQL user expects, and the fixture is built to prove it — `maestro.tracks`
document 2 has `tag: null`, document 3 has `tag: ""`, and document 6 omits fields
entirely (`docker/db-fixtures/seed/mongo.js`). This is the same three-versus-two-states
problem the Mongo engine already documents at module level for *rendering*; here it
appears in *matching*.

**The same mechanism affects `<>` and `IS NOT NULL`,** and this is reasoned from the
two documented semantics rather than measured: `{"a": {"$ne": 1}}`
matches documents with no `a` at all, whereas SQL's `a <> 1` evaluates to UNKNOWN when
`a` is NULL and the row is excluded. Any predicate whose SQL meaning depends on
three-valued logic will differ. Whichever of these the implementation supports must
carry the notice; whichever it does not support must be refused by name (§5). What is
not acceptable is supporting it quietly.

**`LIKE` becomes a `$regex`, and every metacharacter in the literal is escaped.**
`LIKE '50%_off'` is a pattern with two SQL wildcards; `.` `*` `+` `?` `(` `)` `[` `]`
`{` `}` `^` `$` `|` `\` are *not* wildcards in SQL but are in a regex. Translating
without escaping turns `50%_off` into a regular expression that means something else
entirely — the silent-different-query failure this whole document is about. So the
mapping is: escape every regex metacharacter in the literal, **then** rewrite SQL's
own wildcards, `%` → `.*` and `_` → `.`, and anchor the result with `^`…`$` so `LIKE`
keeps SQL's whole-string semantics rather than becoming a substring search. `LIKE`
with an `ESCAPE` clause is a separate construct and is refused unless explicitly
implemented.

Case sensitivity is the residual: SQL `LIKE` is case-insensitive on many engines and
case-sensitive on others, and a MongoDB regex is case-sensitive unless given the `i`
option. We do not guess — the translation is case-**sensitive**, matching MongoDB's
own default, and that is stated in the notice rather than assumed to be obvious.

---

## 7. How it reaches the right database

`FROM db.collection` maps the qualifier to **`$db`**, and this is not a nicety.

`$db` is MongoDB's own field: every command carries it in the OP_MSG body, normally
supplied by the driver from whichever `Database` handle you called. `mongo.rs`
supports it explicitly — `take_db_override` pulls `$db` out of the user's document,
validates it is a non-empty string, and passes it as the target database, stripping it
before the driver adds its own (a duplicate is a protocol error).

**That function exists because of this exact bug.** For an Atlas connection made from
a pasted `mongodb+srv://` URI with **no `/dbname`**, `DbConnection.database`
was empty, so `MongoSession::command_database()` fell back to **`admin`** — and every
`find` went to a database nobody had named. MongoDB returns an empty
cursor for a collection that does not exist, with **no error at all**, so the console
said *"No rows"* while the tree beside it showed `ARCHIVEDB.items` sitting
there. A fallback that is sensible for `buildInfo` is silently wrong for `find`.

So a statement written as `from ARCHIVEDB.items` names the database — and the
qualifier is the only thing in that statement that can rescue it. The
translator must carry it. Note that the pre-existing `collection_from_sql` helper
(which builds the *suggestion* inside a refusal message) deliberately drops the
qualifier, keeping only the last dotted segment, because in that context it is
producing a collection name. The translator must **not** copy that behaviour: for
translation, `ARCHIVEDB` is the answer to the question the user actually got wrong.

Unqualified `FROM collection` emits no `$db` and inherits the session's database,
which is the correct behaviour and also the one that reproduces the original bug when
the connection has no database — so the empty-result diagnosis already in `execute`
(*which database did this run against, and is the collection there*) remains the
backstop, not the translator.

---

## 8. Out of scope, and what would have to be true to extend it

Everything in §5's refusal list is out of scope **for now**, not forever. What would
have to be true to move an item out of that list, in the order that makes them
cheapest:

* **`ORDER BY` → `sort`.** Needs only a decision to want it — it is excluded by
  scope, not by difficulty. Watch the
  interaction with the row cap: sorting after truncation is a different answer from
  sorting before it, and MongoDB sorts server-side, so a `sort` + `limit` is correct
  while a `sort` applied to already-capped rows would not be.
* **A projection → `projection`.** Needs a decision about `_id`, which MongoDB returns
  unless excluded and which SQL's `SELECT a, b` would not include. That decision has to
  be made and stated, not defaulted.
* **`COUNT(*)` → the `count` command.** Needs a second result *shape* — one row, one
  column — and a rule for how the row cap does not apply to it. It is the item most
  likely to be needed and the one where an approximation would be most damaging.
* **`OFFSET` → `skip`.** Trivial mechanically; only in the list because it is out of scope so far.
* **`GROUP BY` / `JOIN` → an aggregation pipeline.** A different translator with a
  different output command, and the point at which "we translate a subset of SQL"
  becomes "we implement SQL". Not a feature; a project.

Also out of scope and worth naming so it is not assumed: this translator is
**MongoDB-only**. It is not a general SQL front-end for the other engines, and it must
not become one. Redis and DynamoDB have their own languages, and the SQL engines
already speak SQL.

---

## 9. The alternative we did not take: Atlas `$sql`

It is real, and it is worth recording precisely so nobody re-proposes it as the
"proper" answer:

* Atlas Data Federation provides a **`$sql` aggregation stage** that runs `SELECT` and
  `UNION`.
* It is valid **only against a federated database instance**. Not a replica set, not a
  standard Atlas cluster.

That last line is the whole verdict. An ordinary Atlas cluster is not a federated
database instance, and neither is our Docker fixture, so `$sql` cannot run SQL against
the clusters this console normally connects to. It is not a substitute for translation;
it is a different product with an overlapping name.

**And a user who does have a federated instance can already use it today, with no code
change from us.** `$sql` is an aggregation stage, and our console runs arbitrary
command documents — so this works right now:

```json
{ "aggregate": "<collection>", "pipeline": [ { "$sql": { "statement": "SELECT …" } } ], "cursor": {} }
```

`aggregate` is on the read-only allowlist and `with_cursor_defaults` already supplies
the `cursor` option. That is the honest position: we support Atlas `$sql` exactly as
much as we support every other MongoDB command, which is completely — and it does not
help on an ordinary cluster, which is why we translate.

---

## 10. Testing

### 10.1 The translator is pure, so it is tested in the default gates

`sqlmongo` takes a `&str` and returns either a command `Document` or a typed refusal.
No I/O, no driver, no network — so it is unit-tested by `cargo test` with no fixture
and no `#[ignore]`, which is where the coverage requirement and the hermetic-test rule
both want it.

**Expectations are literal.** The trap that rule exists for is exactly available
here: a loop over a table of `(sql, expected)` pairs that builds the
expected document from the same operator map the translator uses would pass, would
read like thorough coverage, and **could not fail on a wrong mapping** — flipping
`$lt` to `$lte` in the map would flip it in the expectation too. So the value tests
are hand-written documents:

```rust
assert_eq!(
    translate("select * from ARCHIVEDB.items limit 10").unwrap(),
    doc! { "find": "items", "filter": {}, "limit": 10_i64, "$db": "ARCHIVEDB" },
);
```

A routing loop over the operator table is still worth having — it proves every
declared operator is reachable and none is dead — and it must carry the comment saying
it does **not** pin values.

Note also, while asserting on documents, that `serde_json::Value` re-orders keys and
key order is semantics in a command document. The **first key must be `find`**, and a
test that compares documents without pinning that has not tested what matters most.

### 10.2 Every refusal names its construct, and there is a test per construct

One test per row of §5's table, asserting both that it refuses **and** that the message
contains the construct's name. A refusal test that only checks `is_err()` would pass
for a translator that refuses everything, including the queries that are supposed to
work — the negative case has to be specific: a result that would also appear if the
mechanism were disconnected is not evidence.

The most important single test in the file is the one that proves there is **no
default branch**: a construct nobody thought about must refuse rather than translate.

### 10.3 The seam

One test owns the path from console text to executed command — SQL in, the right
command document reaching the Mongo engine, `$db` applied, the read-only guard
consulted, a result set out — with only the driver mocked or the fixture at the far
end. It must be **seen to fail**: delete the routing that sends `SELECT` to the
translator, watch it go red, restore it. §5 explains why this seam in particular is
where the bug will be.

### 10.4 The live test runs against the fixture, and never against a real cluster

**The live tier only ever touches the local fixture**, and this feature is where it
would be most tempting to break that rule: the database-selection failure in §7 only
shows up on a real Atlas cluster. It is still not ours to test against. Tests never use
real user credentials,
so the live tier runs `select * from maestro.tracks where ...` against
`docker/db-fixtures/` on `127.0.0.1:57017`, `#[ignore]`d, in `db_live.rs`, with the
published fixture password.

The fixture is already the right test bed for the parts that matter: `tracks` contains
an explicit `tag: null` (doc 2), a `tag: ""` (doc 3) and a document missing fields
entirely (doc 6), which is precisely §6's `IS NULL` gap made concrete — a query that
returns doc 2 and doc 6 for `WHERE tag IS NULL` demonstrates the superset behaviour
against real data instead of asserting it.

Two constraints on those tests:

* **Assert on named rows, never on a count**. `cargo test` parallelises
  over one shared mutable fixture, so `LIMIT 10 → 10 rows` is a flake waiting for a
  busy machine. Assert that document `oid(2)` is present and `oid(1)` is not.
* **Do not add a collection**. The Mongo healthcheck asserts exactly six
  collections; a test that creates a seventh breaks `up --wait` for everything, not
  just itself.

What the fixture **cannot** prove is the Atlas-specific half — an SRV URI with no
`/dbname`, and therefore the `admin` fallback that made this bug invisible. That half
can only be confirmed by driving the app by hand against a real cluster, which is the
documented route when only a user's own server can prove something, and it is the only
route this design permits.
