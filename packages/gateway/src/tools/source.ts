import { Code, ConnectError } from "@connectrpc/connect";
import { z } from "zod";
import { BootstrapState, type Bootstrap } from "../gen/bugnet/router/v1/router_pb.ts";
import { GatewayError, reasonOf, retryDelayMs } from "../router.ts";
import {
    failure,
    handleInput,
    handleTag,
    ok,
    sandboxFailure,
    type Deps,
    type Register,
} from "./common.ts";

export interface SourceView {
    state: "pending" | "fetching" | "done" | "failed" | "needs_secret" | "not_fetched";
    path?: string;
    revision?: string;
    jobId?: string;
    failure?: string;
    // What the state means for the next step, in plain words
    note: string;
}

const stateName: Partial<Record<BootstrapState, SourceView["state"]>> = {
    [BootstrapState.PENDING]: "pending",
    [BootstrapState.RUNNING]: "fetching",
    [BootstrapState.DONE]: "done",
    [BootstrapState.FAILED]: "failed",
    [BootstrapState.NEEDS_SECRET]: "needs_secret",
};

const failureCode = /^[A-Z][A-Z0-9_]{0,39}$/;
const pathShape = /^~\/[A-Za-z0-9._/-]{1,300}$/;
const revisionShape = /^[0-9a-f]{4,64}$/;

export const needsSecretNote =
    "the repo is private or missing, so the fetch needs a GitHub token. bugnet_secret_link with " +
    "name GITHUB_TOKEN adds one, then bugnet_fetch_source fetches it";

const notFetching =
    "Bugnet does not fetch repos yet, so a retry now or later gets the same answer. Cloning by " +
    "hand with bugnet_exec works";

const byHand = "so the choices left are cloning it by hand with bugnet_exec or stopping";

// Bootstrap.failure_reason, the only way a fetch's failure arrives
const failureWords: Record<string, string> = {
    ATTEMPTS_SPENT: `the fetch has used all its attempts, ${byHand}`,
    BUDGET_SPENT: `the sandbox's network allowance for the fetch is spent, ${byHand}`,
    TOOL_MISSING: `the sandbox lacks git or tar, which the fetch needs, ${byHand}`,
    TOO_LARGE:
        "the repo is over the fetch's size limit, a shallow clone by hand with bugnet_exec " +
        "may work",
    CLONE_FAILED: "git could not clone the repo, bugnet_fetch_source tries again",
    FETCH_FAILED: "the repo's download failed, bugnet_fetch_source tries again",
    INTERRUPTED: "the fetch stopped before it finished, bugnet_fetch_source starts it again",
};

function failedNote(reason: string): string {
    if (Object.hasOwn(failureWords, reason)) return failureWords[reason] as string;
    return "the fetch failed, bugnet_fetch_source tries again";
}

// Router fields enter the result only in the shapes the contract gives them
export function sourceView(b: Bootstrap | undefined): SourceView | null {
    const state = b ? stateName[b.state] : undefined;
    if (!b || !state) return null;
    const path = pathShape.test(b.path) && !b.path.includes("..") ? b.path : "";
    const where = path || "~/src";
    const revision = revisionShape.test(b.revision) ? b.revision.slice(0, 12) : "";
    const failure = failureCode.test(b.failureReason) ? b.failureReason : "";
    const jobId = /^[A-Za-z0-9._:-]{1,200}$/.test(b.jobId) ? b.jobId : "";
    const notes: Record<SourceView["state"], string> = {
        pending: "the repo is not fetched yet, bugnet_fetch_source puts it in the sandbox",
        fetching:
            `the repo is being fetched into ${where}` +
            (jobId ? `, bugnet_job with jobId ${jobId} follows it` : ""),
        done: `the repo is in ${where}${revision ? ` at commit ${revision}` : ""}`,
        failed: failedNote(failure),
        needs_secret: needsSecretNote,
        not_fetched: "",
    };
    return {
        state,
        ...(path ? { path } : {}),
        ...(revision ? { revision } : {}),
        ...(jobId ? { jobId } : {}),
        ...(failure ? { failure } : {}),
        note: notes[state],
    };
}

// A token the repo needs is a state for the agent to act on, the fetch's failures come as states
function refusalView(err: unknown): SourceView | null {
    if (reasonOf(err) === "SECRET_REQUIRED")
        return { state: "needs_secret", note: needsSecretNote };
    return null;
}

export const unplacedNote =
    "Bugnet did not place the quoted repo in this sandbox, cloning it by hand with bugnet_exec " +
    "works";

// The fetch bugnet_start and bugnet_status make once the sandbox is ready, which never fails them
export async function fetchAfterStart(
    deps: Deps,
    handle: string,
    timeoutMs = 5_000,
): Promise<SourceView> {
    let later = "";
    try {
        const res = await deps.router.fetchSource(
            { handle },
            { signal: AbortSignal.timeout(timeoutMs) },
        );
        const view = sourceView(res.bootstrap);
        if (view) return view;
    } catch (e) {
        const refusal = refusalView(e);
        if (refusal) return refusal;
        const code = e instanceof ConnectError ? Code[e.code] : "unknown";
        deps.log.warn("fetch source failed", {
            handle: handleTag(handle),
            code,
            reason: reasonOf(e),
        });
        if (e instanceof ConnectError && e.code === Code.Unimplemented) {
            return { state: "not_fetched", note: notFetching };
        }
        if (reasonOf(e) === "NO_SOURCE") return { state: "not_fetched", note: unplacedNote };
        const wait = e instanceof ConnectError ? retryDelayMs(e) : null;
        if (wait !== null) later = ` after ${Math.max(1, Math.ceil(wait / 1000))} s`;
    }
    return {
        state: "not_fetched",
        note: `the repo is not fetched yet, bugnet_fetch_source tries again${later}`,
    };
}

export function sentence(note: string): string {
    return `${note.charAt(0).toUpperCase()}${note.slice(1)}.`;
}

export const fetchSourceDescription =
    "Puts the GitHub repo from the quote's source into the sandbox at ~/src/<repo>, the fetch " +
    "bugnet_start makes once the sandbox is ready. Safe to call again: it reports the fetch's " +
    "state, path and job, and starts a failed fetch again while attempts are left. A private " +
    "repo needs a GitHub token added with bugnet_secret_link first. Free, it charges nothing.";

export const registerSourceTool: Register = (server, deps) => {
    server.registerTool(
        "bugnet_fetch_source",
        {
            title: "Fetch the quoted repo into a Bugnet sandbox",
            description: fetchSourceDescription,
            inputSchema: z.object({
                handle: handleInput,
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (args) => {
            try {
                const res = await deps.router.fetchSource({ handle: args.handle });
                const view = sourceView(res.bootstrap) ?? {
                    state: "not_fetched" as const,
                    note: "this sandbox has no GitHub repo to fetch",
                };
                return ok(sentence(view.note), { source: view });
            } catch (e) {
                const refusal = refusalView(e);
                if (refusal) return ok(sentence(refusal.note), { source: refusal });
                if (e instanceof ConnectError && e.code === Code.Unimplemented) {
                    return failure(
                        new GatewayError("unsupported", `fetch source: ${notFetching}`),
                        "",
                    );
                }
                return sandboxFailure(deps, args.handle, e, "fetch source");
            }
        },
    );
};
