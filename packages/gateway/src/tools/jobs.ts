import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JobState } from "../gen/bugnet/router/v1/router_pb.ts";
import { GatewayError } from "../router.ts";
import { tail, untrustedLabel } from "../sanitize.ts";
import {
    failure,
    handlePattern,
    ok,
    toolUseId,
    waitMs,
    withProgress,
    type Register,
} from "./common.ts";

const jobStateName: Record<JobState, string> = {
    [JobState.UNSPECIFIED]: "unknown",
    [JobState.RUNNING]: "running",
    [JobState.EXITED]: "exited",
    [JobState.CANCELLED]: "cancelled",
    [JobState.LOST]: "lost",
};

const handleInput = z.string().regex(handlePattern, "a sandbox handle starting with sbx_");

// Values shaped like well-known API tokens, which belong in bugnet_secret_link instead
const secretShapes = [
    /^sk-[A-Za-z0-9_-]{20,}$/,
    /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    /^gh[pousr]_[A-Za-z0-9]{30,}$/,
    /^github_pat_[A-Za-z0-9_]{40,}$/,
    /^hf_[A-Za-z0-9]{30,}$/,
    /^xox[abpr]-[A-Za-z0-9-]{20,}$/,
    /^AKIA[0-9A-Z]{16}$/,
    /^glpat-[A-Za-z0-9_-]{20,}$/,
    /^r8_[A-Za-z0-9]{30,}$/,
];

export function secretLooking(env: Record<string, string>): string | null {
    for (const [k, v] of Object.entries(env)) {
        if (secretShapes.some((re) => re.test(v.trim()))) return k;
    }
    return null;
}

function outputBlock(label: string, text: string, truncated: boolean): string {
    if (!text) return "";
    return `${label}${truncated ? " (last part)" : ""}:\n${text}`;
}

const execInput = z
    .object({
        handle: handleInput,
        cmd: z.string().max(100_000).optional().describe("Shell command, run with sh -c"),
        argv: z.array(z.string().max(100_000)).max(1000).optional(),
        cwd: z.string().max(4096).optional(),
        env: z
            .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32_768))
            .optional()
            .describe("Non-secret environment variables"),
        timeoutSeconds: z
            .number()
            .int()
            .min(1)
            .max(86_400)
            .optional()
            .describe("Kill the command after this many seconds"),
        waitSeconds: z
            .number()
            .int()
            .min(0)
            .max(45)
            .optional()
            .describe("How long to wait for output before returning, default 25"),
    })
    .refine((a) => (a.cmd === undefined) !== (a.argv === undefined), {
        message: "give exactly one of cmd or argv",
    });

export const registerJobTools: Register = (server, deps) => {
    const cap = deps.config.limits.output_tail_bytes;

    server.registerTool(
        "bugnet_exec",
        {
            title: "Run a command in a Bugnet sandbox",
            description:
                "Runs a shell command in the user's sandbox. Waits up to waitSeconds and " +
                "returns the exit code and the last 8 KiB of stdout and stderr. A command still " +
                "running returns a jobId and cursor for bugnet_job. Never pass secrets in cmd or env.",
            inputSchema: execInput,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (args, ctx) => {
            try {
                if (args.env) {
                    const key = secretLooking(args.env);
                    if (key) {
                        throw new GatewayError(
                            "invalid",
                            `env ${key} looks like a secret, use bugnet_secret_link instead`,
                        );
                    }
                }
                let argv = args.argv ?? ["sh", "-c", args.cmd as string];
                if (args.timeoutSeconds) {
                    argv = ["timeout", "-k", "5", String(args.timeoutSeconds), ...argv];
                }
                const wait = waitMs(deps, args.waitSeconds);
                const res = await withProgress(ctx, "running the command", (signal) =>
                    deps.router.exec(
                        {
                            handle: args.handle,
                            argv,
                            cwd: args.cwd ?? "",
                            env: args.env ?? {},
                            idempotencyKey: toolUseId(ctx) ?? randomUUID(),
                            // The router reads 0 as its 25 s default, so no wait asks for 1 ms
                            waitMs: wait === 0 ? 1 : wait,
                        },
                        { signal, timeoutMs: wait + 15_000 },
                    ),
                );
                const out = tail(res.stdoutTail, cap);
                const err = tail(res.stderrTail, cap);
                const state = jobStateName[res.state];
                const done = res.state !== JobState.RUNNING;
                const head = done
                    ? `Command ${state}${res.exitCode !== undefined ? ` with exit code ${res.exitCode}` : ""}.`
                    : `Command still running as job ${res.jobId}. Follow it with bugnet_job ` +
                      `(jobId ${res.jobId}, cursor ${res.cursor}).`;
                const text = [
                    head,
                    res.truncated ? "Earlier output was dropped from the stream." : "",
                    out.text || err.text ? untrustedLabel : "",
                    outputBlock("stdout", out.text, out.truncated),
                    outputBlock("stderr", err.text, err.truncated),
                ]
                    .filter(Boolean)
                    .join("\n");
                return ok(text, {
                    jobId: res.jobId,
                    state,
                    exitCode: res.exitCode ?? null,
                    stdout: out.text,
                    stderr: err.text,
                    cursor: res.cursor,
                    truncated: res.truncated || out.truncated || err.truncated,
                });
            } catch (e) {
                return failure(e, "exec");
            }
        },
    );

    server.registerTool(
        "bugnet_job",
        {
            title: "Follow a Bugnet command",
            description:
                "New output of a running or finished command since the cursor, its state and " +
                "exit code. Pass the cursor it returns to the next call.",
            inputSchema: z.object({
                handle: handleInput,
                jobId: z.string().max(200),
                cursor: z.string().max(500).optional(),
                waitSeconds: z.number().int().min(0).max(45).optional(),
            }),
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args, ctx) => {
            try {
                const wait = waitMs(deps, args.waitSeconds);
                const chunks: Record<"stdout" | "stderr", Uint8Array[]> = {
                    stdout: [],
                    stderr: [],
                };
                let cursor = args.cursor ?? "";
                let exit: { code: number } | null = null;
                let skipped = false;
                await withProgress(ctx, "following the command", async (signal) => {
                    const stop = AbortSignal.any([signal, AbortSignal.timeout(Math.max(wait, 1))]);
                    try {
                        const stream = deps.router.watchJob(
                            {
                                handle: args.handle,
                                jobId: args.jobId,
                                cursor,
                                until: { exit: true },
                            },
                            { signal: stop },
                        );
                        for await (const f of stream) {
                            if (f.cursor) cursor = f.cursor;
                            const fr = f.frame;
                            if (fr.case === "output") {
                                const which = fr.value.stream === 2 ? "stderr" : "stdout";
                                chunks[which].push(fr.value.data);
                            } else if (fr.case === "exit") {
                                exit = { code: fr.value.exitCode };
                                break;
                            } else if (fr.case === "skip") {
                                skipped = true;
                            }
                        }
                    } catch (e) {
                        if (!stop.aborted) throw e;
                    }
                });
                const join = (parts: Uint8Array[]) => tail(Buffer.concat(parts), cap);
                const out = join(chunks.stdout);
                const err = join(chunks.stderr);
                const finished = exit as { code: number } | null;
                const state = finished ? "exited" : "running";
                const text = [
                    finished
                        ? `Command exited with code ${finished.code}.`
                        : `Command still running. Next cursor: ${cursor}.`,
                    skipped ? "Some output was skipped, the full log stays in the sandbox." : "",
                    out.text || err.text ? untrustedLabel : "No new output.",
                    outputBlock("stdout", out.text, out.truncated),
                    outputBlock("stderr", err.text, err.truncated),
                ]
                    .filter(Boolean)
                    .join("\n");
                return ok(text, {
                    jobId: args.jobId,
                    state,
                    exitCode: finished ? finished.code : null,
                    stdout: out.text,
                    stderr: err.text,
                    cursor,
                    truncated: skipped || out.truncated || err.truncated,
                });
            } catch (e) {
                return failure(e, "job");
            }
        },
    );

    server.registerTool(
        "bugnet_cancel_job",
        {
            title: "Cancel a Bugnet command",
            description: "Stops a running command in the sandbox.",
            inputSchema: z.object({ handle: handleInput, jobId: z.string().max(200) }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (args) => {
            try {
                const res = await deps.router.cancelJob({ handle: args.handle, jobId: args.jobId });
                const state = jobStateName[res.state];
                return ok(`Job ${args.jobId} is ${state}.`, { jobId: args.jobId, state });
            } catch (e) {
                return failure(e, "cancel");
            }
        },
    );
};
