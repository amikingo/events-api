import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/** Layer boundaries from the module standard, enforced by the linter instead of by review. */
const restrict = (patterns) => ({
  "@typescript-eslint/no-restricted-imports": ["error", { patterns }],
});

const PERSISTENCE = ["**/repositories/*", "**/models/*", "**/db.js", "sequelize"];

export default defineConfig(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "docs/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-console": "error",
    },
  },
  {
    files: ["src/routes/**/*.ts"],
    rules: restrict([{ group: [...PERSISTENCE, "**/services/*"], message: "Routes compose middleware + one controller handler." }]),
  },
  {
    files: ["src/controllers/**/*.ts"],
    rules: restrict([{ group: PERSISTENCE, message: "Controllers call one service; they never touch persistence." }]),
  },
  {
    files: ["src/services/**/*.ts"],
    ignores: ["src/services/helpers.ts"], // owns runTransaction()
    rules: restrict([
      { group: ["express", "**/controllers/*", "**/routes/*"], message: "Services are HTTP-agnostic." },
      { group: ["**/models/*", "**/db.js", "sequelize"], message: "Services reach persistence through repositories (type imports allowed).", allowTypeImports: true },
      { group: ["**/validators/*"], message: "Services may import validator *types* only.", allowTypeImports: true },
    ]),
  },
  {
    files: ["src/repositories/**/*.ts"],
    rules: restrict([
      { group: ["express", "zod", "**/services/*", "**/controllers/*", "**/routes/*", "**/validators/*", "**/middleware/*"], message: "Repositories are persistence-only." },
      { group: ["**/models/*", "!**/models/index.js"], message: "Import model classes from models/index.js (associations initialized).", allowTypeImports: true },
    ]),
  },
  {
    files: ["src/mappers/**/*.ts"],
    rules: restrict([{ group: [...PERSISTENCE, "**/services/*", "express"], message: "Mappers are pure functions (type imports allowed).", allowTypeImports: true }]),
  },
  {
    files: ["src/scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "no-console": "off",
      // node:test's test()/describe() return promises the runner awaits; everything else must be awaited.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] }] },
      ],
      "@typescript-eslint/require-await": "off", // async mock implementations
      "@typescript-eslint/no-explicit-any": "off", // JSON response bodies
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
