import type { Classification, SessionContext } from "./types.ts";

export type * from "./types.ts";

const none: Classification = {
    suggest: false,
    score: 0,
    category: null,
    signals: [],
    subject: null,
};

export function classifyPrompt(_text: string, _ctx: SessionContext = {}): Classification {
    return none;
}

export function classifyCommand(_command: string, _ctx: SessionContext = {}): Classification {
    return none;
}

// A local command that failed, read with its error output
export function classifyFailure(
    _command: string,
    _error: string,
    _ctx: SessionContext = {},
): Classification {
    return none;
}

// Factual context for the agent, never an order, since hook text phrased as commands trips injection defenses
export function hintFor(_c: Classification, _kind: "prompt" | "command" | "failure"): string {
    return "";
}
