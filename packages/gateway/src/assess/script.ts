import type { Finding } from "./assessor.ts";
import { bodyText, type Fetcher } from "./fetch.ts";
import { evidence, fileKind, hostOf, isBareIp, isPasteHost, scanText } from "./scan.ts";

export interface ScriptReport {
    checked: boolean;
    complete: boolean;
    facts: Record<string, string | number | boolean>;
    findings: Finding[];
}

const binaryName =
    /\.(?:exe|dll|scr|msi|bat|cmd|ps1|vbs|jar|apk|so|dylib|bin|appimage|deb|rpm|pkg|dmg|zip|rar|7z|tar|tgz|gz|xz)$/i;

// Findings about the link itself, before anything is fetched
export function urlFindings(url: string): Finding[] {
    const out: Finding[] = [];
    const host = hostOf(url) ?? "";
    const path = new URL(url).pathname;
    if (isBareIp(host) || isPasteHost(host)) {
        out.push({
            id: "suspicious_url",
            severity: "medium",
            title: `The link points at ${isBareIp(host) ? "a bare IP address" : "a paste or file-drop site"}`,
            evidence: evidence(host),
        });
    }
    if (binaryName.test(path)) {
        out.push({
            id: "binary_download",
            severity: "medium",
            title: "The link is a prebuilt binary or archive, not a readable script",
            evidence: evidence(path.split("/").pop() ?? path),
        });
    }
    return out;
}

export async function readScript(
    env: { fetch: Fetcher; maxFileBytes: number },
    url: string,
    signal: AbortSignal,
): Promise<ScriptReport> {
    const findings = urlFindings(url);
    const res = await env.fetch(url, { signal, maxBytes: env.maxFileBytes });
    const facts: ScriptReport["facts"] = { host: hostOf(res.url) ?? "", status: res.status };
    if (res.url !== url) facts.redirectedTo = hostOf(res.url) ?? "";
    if (res.status !== 200) {
        findings.push({
            id: "script_unread",
            severity: "info",
            title: `The script could not be fetched, the server answered ${res.status}`,
        });
        return {
            checked: false,
            complete: res.status === 404 || res.status === 410,
            facts,
            findings,
        };
    }
    facts.bytes = res.body.length;
    if (res.truncated) facts.truncated = true;
    // Git's test for binary content, a NUL byte early in the file
    if (res.body.subarray(0, 8000).includes(0)) {
        findings.push({
            id: "binary_download",
            severity: "medium",
            title: "The link serves a binary file, not a readable script",
            evidence: evidence(res.headers["content-type"] ?? "unknown content type"),
        });
        return { checked: true, complete: true, facts, findings };
    }
    const text = bodyText(res);
    const shebang = /^#!\s*(\S+)/.exec(text);
    if (shebang) facts.interpreter = evidence(shebang[1] as string);
    facts.lines = text.split("\n").length;
    const name = new URL(res.url).pathname.split("/").pop() || "script";
    const kind = fileKind(name) === "docs" ? "docs" : "code";
    findings.push(...scanText(text, { path: evidence(name), kind, trust: "normal" }));
    return { checked: true, complete: true, facts, findings };
}
