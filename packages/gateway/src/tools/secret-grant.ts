import { timestampDate } from "@bufbuild/protobuf/wkt";
import { z } from "zod";
import { GatewayError } from "../router.ts";
import { handlePattern, handleTag, ok, sandboxFailure, type Register } from "./common.ts";

export const putGrantToolName = "bugnet_secret_put_grant";

const handleInput = z.string().regex(handlePattern, "a sandbox handle starting with sbx_");
const grantPattern = /^bnsp_[A-Za-z0-9_-]{16,200}$/;

// Data-plane 8.4, so the bridge never sends the handle, the sandbox's whole credential, elsewhere
export const registerSecretGrantTool: Register = (server, deps) => {
    server.registerTool(
        putGrantToolName,
        {
            title: "Secret put grant for the Bugnet bridge",
            description:
                "Used by the local Bugnet bridge (npx @bugnet/mcp) for bugnet_secret_from_env. " +
                "Returns a grant, valid about 10 minutes, that only stores secrets for this " +
                "sandbox at secrets.bugnet.sh. It cannot run commands or read files. Other " +
                "clients have no use for it.",
            inputSchema: z.object({ handle: handleInput }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (args) => {
            try {
                const res = await deps.router.createSecretPutGrant({ handle: args.handle });
                if (!grantPattern.test(res.putGrant)) {
                    throw new GatewayError("internal", "secret grant: the router gave no grant");
                }
                const expiresAt = res.expiresAt ? timestampDate(res.expiresAt).toISOString() : null;
                deps.log.info("put grant issued", { handle: handleTag(args.handle) });
                return ok(`Put grant ready${expiresAt ? `, valid until ${expiresAt}` : ""}.`, {
                    putGrant: res.putGrant,
                    expiresAt,
                });
            } catch (e) {
                return sandboxFailure(deps, args.handle, e, "secret grant");
            }
        },
    );
};
