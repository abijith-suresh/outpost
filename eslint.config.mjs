import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist", "coverage"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["tests/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: false,
      },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
      "no-empty": "off",
    },
  },
);
