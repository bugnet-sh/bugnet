import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: [
            "**/node_modules/**",
            "**/dist/**",
            "**/src/gen/**",
            "plugin/hooks/bugnet-hook.mjs",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
        },
    },
    {
        files: ["packages/*/src/**/*.ts"],
        ignores: ["**/*.test.ts", "packages/*/src/testing/**"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        { group: ["**/testing/*"], message: "The test harness is for tests only." },
                    ],
                },
            ],
        },
    },
    {
        files: ["packages/secret-page/src/**/*.ts"],
        ignores: ["**/*.test.ts", "packages/secret-page/src/testing/**"],
        rules: {
            "no-restricted-properties": [
                "error",
                ...["innerHTML", "outerHTML", "insertAdjacentHTML"].map((property) => ({
                    property,
                    message: "The entry page sets text only, so nothing it shows is HTML.",
                })),
                ...["write", "writeln"].map((property) => ({
                    object: "document",
                    property,
                    message: "The entry page sets text only, so nothing it shows is HTML.",
                })),
            ],
        },
    },
);
