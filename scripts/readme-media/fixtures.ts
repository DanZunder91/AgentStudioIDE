/** Fictional projects for the README screenshots: no real paths, people, hosts or secrets. */
import type { FsEntry } from "../../src/app/types";

export const HOME = "/home/dev/projects";
export const TODO = `${HOME}/todo-api`;
export const PAY = `${HOME}/payments-service`;

const dir = (parent: string, name: string): FsEntry => ({ name, path: `${parent}/${name}`, isDir: true });
const file = (parent: string, name: string): FsEntry => ({ name, path: `${parent}/${name}`, isDir: false });

export const TREE: Record<string, FsEntry[]> = {
  [TODO]: [
    dir(TODO, ".claude"),
    dir(TODO, "src"),
    dir(TODO, "tests"),
    file(TODO, ".env.example"),
    file(TODO, "package.json"),
    file(TODO, "README.md"),
    file(TODO, "tsconfig.json"),
  ],
  [`${TODO}/.claude`]: [file(`${TODO}/.claude`, "settings.json")],
  [`${TODO}/src`]: [
    dir(`${TODO}/src`, "middleware"),
    dir(`${TODO}/src`, "routes"),
    file(`${TODO}/src`, "db.ts"),
    file(`${TODO}/src`, "server.ts"),
  ],
  [`${TODO}/src/middleware`]: [
    file(`${TODO}/src/middleware`, "auth.ts"),
    file(`${TODO}/src/middleware`, "rateLimit.ts"),
  ],
  [`${TODO}/src/routes`]: [
    file(`${TODO}/src/routes`, "health.ts"),
    file(`${TODO}/src/routes`, "todos.ts"),
    file(`${TODO}/src/routes`, "users.ts"),
  ],
  [`${TODO}/tests`]: [
    file(`${TODO}/tests`, "rateLimit.test.ts"),
    file(`${TODO}/tests`, "todos.test.ts"),
  ],
  [PAY]: [
    dir(PAY, "migrations"),
    dir(PAY, "src"),
    file(PAY, "Cargo.lock"),
    file(PAY, "Cargo.toml"),
    file(PAY, "README.md"),
  ],
  [`${PAY}/src`]: [
    file(`${PAY}/src`, "ledger.rs"),
    file(`${PAY}/src`, "main.rs"),
    file(`${PAY}/src`, "retry.rs"),
  ],
  [`${PAY}/migrations`]: [file(`${PAY}/migrations`, "0001_init.sql")],
};

export const RATE_LIMIT_TS = `import type { Request, Response, NextFunction } from "express";

/**
 * Token-bucket rate limiter, keyed by API key (or client IP for anonymous calls).
 * Buckets live in memory; swap \`store\` for Redis when running more than one node.
 */
export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  store?: Map<string, Bucket>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function rateLimit({ limit, windowMs, store = new Map() }: RateLimitOptions) {
  const refillPerMs = limit / windowMs;

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("x-api-key") ?? req.ip ?? "anonymous";
    const now = Date.now();
    const bucket = store.get(key) ?? { tokens: limit, updatedAt: now };

    // Refill proportionally to the time since the last request.
    bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;

    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, Math.floor(bucket.tokens - 1))));

    if (bucket.tokens < 1) {
      const retryAfter = Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      store.set(key, bucket);
      return res.status(429).json({ error: "rate_limited", retryAfter });
    }

    bucket.tokens -= 1;
    store.set(key, bucket);
    next();
  };
}
`;

export const SERVER_TS = `import express from "express";
import { rateLimit } from "./middleware/rateLimit";
import { todos } from "./routes/todos";
import { health } from "./routes/health";

const app = express();
app.use(express.json());
app.use("/health", health);
app.use("/api", rateLimit({ limit: 100, windowMs: 60_000 }));
app.use("/api/todos", todos);

app.listen(3000, () => console.log("todo-api listening on :3000"));
`;

export const FILES: Record<string, string> = {
  [`${TODO}/src/middleware/rateLimit.ts`]: RATE_LIMIT_TS,
  [`${TODO}/src/server.ts`]: SERVER_TS,
  [`${TODO}/README.md`]: "# todo-api\n\nA tiny example REST service.\n",
};

/** ANSI helpers for the fake terminal output. */
const esc = "\x1b[";
export const c = {
  dim: (s: string) => `${esc}2m${s}${esc}0m`,
  bold: (s: string) => `${esc}1m${s}${esc}0m`,
  green: (s: string) => `${esc}32m${s}${esc}0m`,
  red: (s: string) => `${esc}31m${s}${esc}0m`,
  yellow: (s: string) => `${esc}33m${s}${esc}0m`,
  blue: (s: string) => `${esc}34m${s}${esc}0m`,
  magenta: (s: string) => `${esc}35m${s}${esc}0m`,
  cyan: (s: string) => `${esc}36m${s}${esc}0m`,
  orange: (s: string) => `${esc}38;5;209m${s}${esc}0m`,
  gray: (s: string) => `${esc}38;5;245m${s}${esc}0m`,
};

const nl = (lines: string[]) => lines.join("\r\n") + "\r\n";

/** A Claude-Code-like session transcript, as an agent terminal would show it. */
export const AGENT_SESSION = nl([
  c.orange("╭" + "─".repeat(50) + "╮"),
  c.orange("│ ") + c.bold("✻ Claude Code".padEnd(49)) + c.orange("│"),
  c.orange("│ ") + c.gray("  cwd: ~/projects/todo-api".padEnd(49)) + c.orange("│"),
  c.orange("╰" + "─".repeat(50) + "╯"),
  "",
  c.gray("> ") + "Add per-key rate limiting to the /api routes, with tests.",
  "",
  c.green("⏺") + " I'll map the routes first, then add a token-bucket middleware.",
  "",
  c.green("⏺") + " " + c.bold("Task") + c.gray("(explore-codebase)"),
  c.gray("  ⎿  Found 3 routers under src/routes, mounted in src/server.ts"),
  "",
  c.green("⏺") + " " + c.bold("Write") + c.gray("(src/middleware/rateLimit.ts)"),
  c.gray("  ⎿  Wrote 52 lines"),
  "",
  c.green("⏺") + " " + c.bold("Update") + c.gray("(src/server.ts)"),
  c.gray("  ⎿  ") + c.green("+ app.use(\"/api\", rateLimit({ limit: 100, windowMs: 60_000 }));"),
  "",
  c.green("⏺") + " " + c.bold("Task") + c.gray("(write-tests)") + "  " + c.yellow("running…"),
  c.green("⏺") + " " + c.bold("Task") + c.gray("(review-security)") + "  " + c.yellow("waiting for permission"),
  "",
  c.orange("✻ Orchestrating… ") + c.gray("(2m 41s · ↓ 8.2k tokens · esc to interrupt)"),
]);

/** A plain shell running the test suite. */
export const SHELL_TESTS = nl([
  c.green("dev@laptop") + ":" + c.blue("~/projects/todo-api") + "$ npm test -- rateLimit",
  "",
  c.gray("> todo-api@1.4.0 test"),
  c.gray("> vitest run rateLimit"),
  "",
  " " + c.bold(c.cyan("RUN")) + "  v3.2.4 ~/projects/todo-api",
  "",
  " " + c.green("✓") + " tests/rateLimit.test.ts " + c.gray("(6 tests) 41ms"),
  "   " + c.green("✓") + " allows requests under the limit",
  "   " + c.green("✓") + " returns 429 with Retry-After once the bucket is empty",
  "   " + c.green("✓") + " refills tokens proportionally over time",
  "   " + c.green("✓") + " keys buckets by x-api-key, falling back to IP",
  "   " + c.green("✓") + " sets X-RateLimit-* headers on every response",
  "   " + c.green("✓") + " does not limit /health",
  "",
  c.gray(" Test Files  ") + c.green("1 passed") + c.gray(" (1)"),
  c.gray("      Tests  ") + c.green("6 passed") + c.gray(" (6)"),
  c.gray("   Duration  ") + "412ms",
  "",
  c.green("dev@laptop") + ":" + c.blue("~/projects/todo-api") + "$ ",
]);

/** The payments agent, blocked on a permission prompt. */
export const PAY_SESSION = nl([
  c.orange("╭" + "─".repeat(50) + "╮"),
  c.orange("│ ") + c.bold("✻ Claude Code".padEnd(49)) + c.orange("│"),
  c.orange("│ ") + c.gray("  cwd: ~/projects/payments-service".padEnd(49)) + c.orange("│"),
  c.orange("╰" + "─".repeat(50) + "╯"),
  "",
  c.gray("> ") + "The retry test is flaky in CI. Find out why and fix it.",
  "",
  c.green("⏺") + " " + c.bold("Task") + c.gray("(reproduce-flake)") + "  " + c.yellow("running…"),
  c.green("⏺") + " " + c.bold("Task") + c.gray("(bench-backoff)") + "  " + c.red("failed: cargo bench exited 101"),
  "",
  c.green("⏺") + " The jitter uses the wall clock, so two retries can fire in the same tick.",
  "  I want to switch " + c.cyan("retry.rs") + " to a seeded RNG and a monotonic clock.",
  "",
  c.green("⏺") + " " + c.bold("Bash") + c.gray("(cargo test retry -- --test-threads=1)"),
  "",
  c.yellow("╭" + "─".repeat(58) + "╮"),
  c.yellow("│ ") + c.bold("Bash command".padEnd(57)) + c.yellow("│"),
  c.yellow("│ ") + "  cargo test retry -- --test-threads=1".padEnd(57) + c.yellow("│"),
  c.yellow("│ ") + "".padEnd(57) + c.yellow("│"),
  c.yellow("│ ") + "Do you want to proceed?".padEnd(57) + c.yellow("│"),
  c.yellow("│ ") + c.cyan("❯ 1. Yes".padEnd(57)) + c.yellow("│"),
  c.yellow("│ ") + "  2. Yes, and don't ask again for cargo test".padEnd(57) + c.yellow("│"),
  c.yellow("│ ") + "  3. No, and tell Claude what to do differently".padEnd(57) + c.yellow("│"),
  c.yellow("╰" + "─".repeat(58) + "╯"),
]);
