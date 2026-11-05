import { Code } from "@connectrpc/connect";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
    JobState,
    OutputStream,
    PlacementState,
    type ExecRequest,
    type WatchJobRequest,
} from "../gen/bugnet/router/v1/router_pb.ts";
import {
    callTool,
    connectTools,
    fakeRouter,
    placement,
    routerError,
    testDeps,
    testHandle,
    type RouterImpl,
} from "../testing/harness.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

function connect(impl: RouterImpl): Promise<Client> {
    return connectTools(testDeps({ router: fakeRouter(impl) }));
}

interface JobResult {
    message: string;
    jobId: string;
    state: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    cursor: string;
    truncated: boolean;
}

describe("bugnet_exec", () => {
    it("runs the command and returns its cleaned output and exit code", async () => {
        let asked: ExecRequest | undefined;
        const client = await connect({
            exec(req) {
                asked = req;
                return {
                    jobId: "j1",
                    state: JobState.EXITED,
                    exitCode: 3,
                    stdoutTail: bytes("hello\n\u001b[31mred\u001b[0m\n"),
                    stderrTail: bytes("oops\n"),
                    cursor: "c1",
                };
            },
        });
        const r = await callTool<JobResult>(
            client,
            "bugnet_exec",
            { handle: testHandle, cmd: "echo hello", timeoutSeconds: 60, waitSeconds: 0 },
            { toolUseId: "toolu_exec" },
        );
        expect(r.structured).toEqual(
            expect.objectContaining({
                state: "exited",
                exitCode: 3,
                stdout: "hello\nred\n",
                stderr: "oops\n",
                truncated: false,
            }),
        );
        expect(r.structured.message).toMatch(/^Command exited with exit code 3\.\nOutput from/);
        expect(asked?.argv).toEqual(["timeout", "-k", "5", "60", "sh", "-c", "echo hello"]);
        expect(asked?.idempotencyKey).toBe("toolu_exec");
        expect(asked?.waitMs).toBe(1);
    });

    it("hands back a job id and cursor for a command still running", async () => {
        const client = await connect({
            exec: () => ({ jobId: "j2", state: JobState.RUNNING, cursor: "c7" }),
        });
        const r = await callTool<JobResult>(client, "bugnet_exec", {
            handle: testHandle,
            argv: ["sleep", "100"],
        });
        expect(r.structured).toEqual(
            expect.objectContaining({
                jobId: "j2",
                state: "running",
                exitCode: null,
                cursor: "c7",
            }),
        );
        expect(r.structured.message).toMatch(/bugnet_job \(jobId j2, cursor c7\)/);
    });

    it("refuses env values shaped like tokens before calling the router", async () => {
        let called = false;
        const client = await connect({
            exec: () => {
                called = true;
                return {};
            },
        });
        const r = await callTool(client, "bugnet_exec", {
            handle: testHandle,
            cmd: "true",
            env: { HF: "hf_" + "a".repeat(34) },
        });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/env HF looks like a secret/);
        expect(called).toBe(false);
    });

    it("reports NOT_READY on an ended sandbox as expired", async () => {
        const client = await connect({
            exec() {
                throw routerError(Code.FailedPrecondition, "NOT_READY");
            },
            getPlacement: () => ({ placement: placement(PlacementState.TERMINATED) }),
        });
        const r = await callTool(client, "bugnet_exec", { handle: testHandle, cmd: "true" });
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
            "exec: this sandbox has ended and everything in it was deleted. Quote and start a " +
                "new one.",
        );
    });

    it("reports NOT_READY on a starting sandbox as still starting", async () => {
        const client = await connect({
            exec() {
                throw routerError(Code.FailedPrecondition, "NOT_READY");
            },
            getPlacement: () => ({ placement: placement(PlacementState.PLACING) }),
        });
        const r = await callTool(client, "bugnet_exec", { handle: testHandle, cmd: "true" });
        expect(r.text).toBe("exec: the sandbox is still starting, wait with bugnet_status.");
    });

    it("keeps the NOT_READY wording when the placement lookup fails too", async () => {
        const client = await connect({
            exec() {
                throw routerError(Code.FailedPrecondition, "NOT_READY");
            },
        });
        const r = await callTool(client, "bugnet_exec", { handle: testHandle, cmd: "true" });
        expect(r.text).toBe("exec: the sandbox is not ready, bugnet_status shows its state.");
    });

    it("reports a rate limit with its RetryInfo delay", async () => {
        const client = await connect({
            exec() {
                throw routerError(Code.ResourceExhausted, "RATE_LIMITED", { retryAfterMs: 2500 });
            },
        });
        const r = await callTool(client, "bugnet_exec", { handle: testHandle, cmd: "true" });
        expect(r.isError).toBe(true);
        expect(r.text).toBe("exec: too many requests for now. Retry after 3 s.");
    });

    it("says an unknown handle is unknown", async () => {
        const client = await connect({
            exec() {
                throw routerError(Code.NotFound);
            },
            getPlacement() {
                throw routerError(Code.NotFound);
            },
        });
        const r = await callTool(client, "bugnet_exec", { handle: testHandle, cmd: "true" });
        expect(r.text).toMatch(/^exec: no sandbox has this handle/);
    });
});

describe("bugnet_job", () => {
    it("collects new output up to the exit and returns the last cursor", async () => {
        let asked: WatchJobRequest | undefined;
        const client = await connect({
            async *watchJob(req) {
                asked = req;
                yield {
                    cursor: "c2",
                    frame: {
                        case: "output",
                        value: { stream: OutputStream.STDOUT, data: bytes("tick 1\n") },
                    },
                };
                yield {
                    cursor: "c3",
                    frame: {
                        case: "output",
                        value: { stream: OutputStream.STDERR, data: bytes("warn\n") },
                    },
                };
                yield { cursor: "c4", frame: { case: "exit", value: { exitCode: 0 } } };
            },
        });
        const r = await callTool<JobResult>(client, "bugnet_job", {
            handle: testHandle,
            jobId: "j1",
            cursor: "c1",
            waitSeconds: 5,
        });
        expect(r.structured).toEqual(
            expect.objectContaining({
                state: "exited",
                exitCode: 0,
                stdout: "tick 1\n",
                stderr: "warn\n",
                cursor: "c4",
                truncated: false,
            }),
        );
        expect(asked).toEqual(
            expect.objectContaining({ jobId: "j1", cursor: "c1", until: expect.anything() }),
        );
    });

    it("stays running when the stream ends before the exit, and marks skipped output", async () => {
        const client = await connect({
            async *watchJob() {
                yield { cursor: "c9", frame: { case: "skip", value: { stdoutOffset: 10n } } };
            },
        });
        const r = await callTool<JobResult>(client, "bugnet_job", {
            handle: testHandle,
            jobId: "j1",
        });
        expect(r.structured).toEqual(
            expect.objectContaining({ state: "running", cursor: "c9", truncated: true }),
        );
        expect(r.structured.message).toMatch(/Next cursor: c9/);
        expect(r.structured.message).toMatch(/Some output was skipped/);
    });

    it("tells an unknown job from an unknown sandbox", async () => {
        const client = await connect({
            // eslint-disable-next-line require-yield
            async *watchJob() {
                throw routerError(Code.NotFound);
            },
            getPlacement: () => ({ placement: placement() }),
        });
        const r = await callTool(client, "bugnet_job", { handle: testHandle, jobId: "nope" });
        expect(r.isError).toBe(true);
        expect(r.text).toBe("job: the sandbox has no job or file by that name.");
    });
});

describe("bugnet_cancel_job", () => {
    it("cancels the job and reports its state", async () => {
        const client = await connect({ cancelJob: () => ({ state: JobState.CANCELLED }) });
        const r = await callTool(client, "bugnet_cancel_job", { handle: testHandle, jobId: "j1" });
        expect(r.structured).toEqual({
            message: "Job j1 is cancelled.",
            jobId: "j1",
            state: "cancelled",
        });
    });

    it("reports NOT_READY on an ended sandbox as expired", async () => {
        const client = await connect({
            cancelJob() {
                throw routerError(Code.FailedPrecondition, "NOT_READY");
            },
            getPlacement: () => ({ placement: placement(PlacementState.FAILED) }),
        });
        const r = await callTool(client, "bugnet_cancel_job", { handle: testHandle, jobId: "j1" });
        expect(r.text).toMatch(/^cancel: this sandbox has ended/);
    });
});
