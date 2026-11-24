import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  // ---------------------------------------------------------------------------
  // Ignores. Generated / vendored output never gets linted.
  // ---------------------------------------------------------------------------
  {
    ignores: [
      "dist/",
      "dist-ssr/",
      "coverage/",
      "node_modules/",
      "src-tauri/target/",
      "src-tauri/gen/",
      "public/",
      "examples/",
    ],
  },

  // ---------------------------------------------------------------------------
  // Base: ESLint + typescript-eslint recommended, applied to all TS/JS we own.
  // ---------------------------------------------------------------------------
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },

  // ---------------------------------------------------------------------------
  // Frontend source: browser globals + React 19 hooks rules.
  // ---------------------------------------------------------------------------
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Root-level build/config files (eslint.config.js, vite.config.ts,
  // vitest.config.ts) run in Node, not the browser. So do the gate scripts in
  // `scripts/` (e.g. the dependency audit) — a flat-config `*` never crosses a
  // `/`, so they need their own pattern or `no-undef` fires on `process`.
  // ---------------------------------------------------------------------------
  {
    files: ["*.{js,mjs,ts}", "scripts/**/*.{js,mjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },

  // ---------------------------------------------------------------------------
  // Project rules. Goal: catch real bugs, stay quiet otherwise.
  // ---------------------------------------------------------------------------
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    rules: {
      // `_`-prefixed args/vars/caught-errors are an intentional "unused" marker.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Two overrides used to live here. Both are GONE because the
  // CAUSES were fixed rather than suppressed:
  //   1. `react-hooks/refs` was downgraded to warn for a render-phase ref write
  //      in useTerminal.ts. That write was a REAL defect (impure,
  //      and provably unobservable given useLayoutEffect + [terminalId] deps) —
  //      it was deleted, not silenced.
  //   2. `rules-of-hooks` was off for renderer.ts because a local helper named
  //      `useWebgl` tripped the `use`-prefix heuristic. It was renamed to
  //      `loadWebgl`.
  // Both rules therefore stay at `error` everywhere. Do NOT re-add a suppression
  // here without first trying to fix the cause — that is the whole point.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Tests. Vitest runs with `globals: true` (see vitest.config.ts), and test
  // doubles legitimately need `any` — a Tauri IPC mock has no honest type.
  // Downgraded, not disabled: `any` in a test is still worth seeing.
  // ---------------------------------------------------------------------------
  {
    files: [
      "**/*.{test,spec}.{ts,tsx}",
      "src/**/__tests__/**/*.{ts,tsx}",
      "src/test/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
