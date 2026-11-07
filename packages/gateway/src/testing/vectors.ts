// Test-only reader of the shared vectors in the bugnet-proto checkout next to this repo
import { readFileSync } from "node:fs";

export type X402VectorFile = "paths.json" | "service-ids.json" | "shared-hosting-suffixes.json";

export function x402Vector(file: X402VectorFile): unknown {
    const url = new URL(`../../../../../bugnet-proto/vectors/x402/${file}`, import.meta.url);
    let text: string;
    try {
        text = readFileSync(url, "utf8");
    } catch {
        throw new Error(
            `bugnet-proto/vectors/x402/${file} is missing: check out bugnet-proto (feat/router-v1-rest) next to bugnet-gateway`,
        );
    }
    const parsed = JSON.parse(text) as { v?: unknown };
    if (parsed.v !== 1) {
        throw new Error(
            `bugnet-proto/vectors/x402/${file} has v ${parsed.v}, this gateway reads v 1`,
        );
    }
    return parsed;
}
