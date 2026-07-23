// Flat config (ESLint 9), resolved from each workspace's `npm run lint` since
// ESLint searches upward for this file by default. Kept intentionally minimal —
// this is a scaffold, not a finished lint policy; tighten as real code lands.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/build/**", "**/node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Stub route handlers and shared types intentionally use `any` in a few
      // narrow spots (e.g. parsing query params) — warn, don't fail the build,
      // until real implementations replace the stubs.
      "@typescript-eslint/no-explicit-any": "warn",
      // Underscore-prefixed params mark intentionally unused arguments
      // (e.g. interface implementations that ignore their input).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  }
);
