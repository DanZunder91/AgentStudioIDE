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

  // Node files: root configs and scripts/ (a flat-config `*` never crosses `/`, hence the glob).
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

  // No react-hooks overrides: those rules stay `error` everywhere. Fix the cause before adding one.

  // Tests: vitest globals; `any` is downgraded, not disabled: IPC mocks have no honest type.
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
