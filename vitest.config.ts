import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: { preserveSymlinks: true },
    test: {
        include: ["packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
        testTimeout: 20_000,
    },
});
