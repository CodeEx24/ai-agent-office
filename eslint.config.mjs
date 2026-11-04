// Root flat config shared by every workspace. Each package runs `eslint .` from its own folder
// and ESLint walks up to this file. Stack: Next.js core-web-vitals (includes React and
// React Hooks 7 with the React Compiler rules) + typescript-eslint strict (type-aware).
import path from "node:path";
import js from "@eslint/js";
import nextVitals from "eslint-config-next/core-web-vitals";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/next-env.d.ts",
      "packages/shared/src/db/database.types.ts",
      "supabase/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  ...nextVitals,
  {
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.mjs", "*.config.ts", "*.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Invariant (CLAUDE.md section 4): strict types, no `any`.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // React Compiler compatibility: surface rule violations as errors.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    settings: {
      next: { rootDir: path.join(import.meta.dirname, "apps/web") },
      react: { version: "19.2" },
    },
    // App Router only: there is no pages/ directory for this rule to check.
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
  {
    // Plain JS/ESM scripts and config files: no type information available.
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["scripts/**/*.mjs", "*.config.{js,mjs,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
