/**
 * Risk scanner for bugnet_assess, pure functions over repo facts, file text and commands.
 *
 * Every rule returns findings whose evidence is a cleaned excerpt of at most 120 characters.
 * Contextual rules match patterns that healthy projects use too, such as curl piped to sh in an
 * install guide, so their severity moves with the repo's standing, one level down for an old,
 * popular repo and one level up for a new or barely used one. Hard signals, such as decoded data
 * fed to eval or a hardcoded webhook, keep their severity everywhere.
 */
import { isIP } from "node:net";
import { cleanText } from "../sanitize.ts";
import type { Finding, Severity } from "./assessor.ts";
import { isPublicAddress } from "./fetch.ts";
import type { RepoFile, RepoInfo, RepoSnapshot, TreeEntry } from "./github.ts";
import { popular } from "./popular.ts";

export type Trust = "established" | "normal" | "unknown";
export type TextKind = "docs" | "code" | "workflow" | "command";

export interface TextContext {
    path: string;
    kind: TextKind;
    trust: Trust;
}

const day = 86_400_000;
const levels: Severity[] = ["info", "low", "medium", "high"];

export function severityRank(s: Severity): number {
    return levels.indexOf(s);
}

export function shift(s: Severity, trust: Trust): Severity {
    const step = trust === "established" ? -1 : trust === "unknown" ? 1 : 0;
    const i = Math.max(0, Math.min(levels.length - 1, levels.indexOf(s) + step));
    return levels[i] as Severity;
}

/* Evidence */

const redactions: [RegExp, string][] = [
    [/(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/gi, "$1[redacted]"],
    [/(\bbot\d{5,}:)[\w-]+/g, "$1[redacted]"],
    [/\b(gh[pousr]_|github_pat_|hf_|sk-|xox[abpr]-|glpat-|AKIA)[A-Za-z0-9_-]{8,}/g, "$1[redacted]"],
];
const invisible = /[\u200b-\u200f\u2060-\u2064\ufeff]/g;

export function evidence(text: string): string {
    let s = cleanText(text).replace(invisible, "").replace(/\s+/g, " ").trim();
    for (const [re, to] of redactions) s = s.replace(re, to);
    if (s.length <= 120) return s;
    return `${s.slice(0, 117).replace(/[\ud800-\udbff]$/, "")}...`;
}

function excerpt(text: string, index: number, prefix?: string): string {
    const start = text.lastIndexOf("\n", index - 1) + 1;
    let end = text.indexOf("\n", index);
    if (end < 0) end = text.length;
    const from = Math.max(start, index - 30);
    const line = text.slice(from, Math.min(end, from + 240));
    return evidence(prefix ? `${prefix}: ${line}` : line);
}

function where(ctx: TextContext): string {
    return ctx.kind === "command" ? "The command" : ctx.path;
}

function pick(findings: Finding[]): Finding[] {
    if (findings.length === 0) return [];
    const top = findings.reduce((a, b) =>
        severityRank(b.severity) > severityRank(a.severity) ? b : a,
    );
    return [top];
}

/* URLs */

const pasteHosts = [
    "pastebin.com",
    "paste.ee",
    "hastebin.com",
    "rentry.co",
    "rentry.org",
    "ghostbin.com",
    "termbin.com",
    "controlc.com",
    "dpaste.org",
    "dpaste.com",
    "paste.rs",
    "0x0.st",
    "transfer.sh",
    "temp.sh",
    "file.io",
    "gofile.io",
    "anonfiles.com",
    "catbox.moe",
    "justpaste.it",
    "privatebin.net",
    "bashupload.com",
    "oshi.at",
    "filebin.net",
    "pixeldrain.com",
    "ufile.io",
];

const urlPattern = /\b(?:https?|ftp):\/\/[^\s'"<>`)\]}|\\]+/gi;

export function hostOf(url: string): string | null {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    } catch {
        return null;
    }
}

export function isPasteHost(host: string): boolean {
    return pasteHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

export function isBareIp(host: string): boolean {
    return isIP(host) !== 0 && isPublicAddress(host);
}

function urlsIn(text: string): { url: string; index: number; host: string }[] {
    const out: { url: string; index: number; host: string }[] = [];
    for (const m of text.matchAll(urlPattern)) {
        const host = hostOf(m[0]);
        if (host) out.push({ url: m[0], index: m.index, host });
    }
    return out;
}

function shadyHost(host: string): boolean {
    return isBareIp(host) || isPasteHost(host);
}

/* Text rules */

const pipeShell: RegExp[] = [
    /\b(?:curl|wget)\b[^\n|;&]{0,400}\|[ \t]*(?:sudo[ \t]+(?:-\S{1,20}[ \t]+){0,4})?(?:ba|z|k|da|fi)?sh\b/gi,
    /\b(?:curl|wget)\b[^\n|;&]{0,400}\|[ \t]*(?:sudo[ \t]+)?(?:python(?:\d(?:\.\d+)?)?|perl|ruby|node)\b(?![ \t]+-m[ \t]+json)/gi,
    /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]{0,400}\|[ \t]*(?:iex|Invoke-Expression)\b/gi,
    /\b(?:iex|Invoke-Expression)\b[\s(]{0,10}(?:New-Object\s+(?:System\.)?Net\.WebClient\)?\.DownloadString|(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b)/gi,
    /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/gi,
    /\b(?:ba|z)?sh\s+-c\s+["']\$\(\s*(?:curl|wget)\b/gi,
];

export function pipeToShell(text: string, ctx: TextContext): Finding[] {
    const hits: Finding[] = [];
    for (const re of pipeShell) {
        let seen = 0;
        for (const m of text.matchAll(re)) {
            if (++seen > 50) break;
            const end = m.index + m[0].length;
            const near = m[0] + (text.slice(end, end + 300).split("\n")[0] ?? "");
            const shady = urlsIn(near).some((u) => shadyHost(u.host));
            hits.push({
                id: "pipe_to_shell",
                severity: shady ? "high" : shift("medium", ctx.trust),
                title: `${where(ctx)} pipes a downloaded script straight into a shell`,
                evidence: excerpt(text, m.index, ctx.kind === "command" ? undefined : ctx.path),
            });
        }
    }
    return pick(hits);
}

const decodeExec =
    /\b(?:eval|exec|Function|Invoke-Expression|iex)\s*\(\s*(?:(?:[\w$]{1,40}\.){0,4}(?:atob|b64decode|b32decode|b85decode|a85decode|unhexlify|fromhex|decompress|loads|FromBase64String)\s*\(|Buffer\.from\s*\(|__import__\s*\(\s*['"](?:base64|zlib|marshal|codecs|binascii)['"])/i;
const encodedPowershell =
    /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]{0,80}?\s-e(?:nc(?:odedcommand)?)?\s+[A-Za-z0-9+/=]{40,}/i;
const longBlob = /[A-Za-z0-9+/]{200,}={0,2}|(?:[0-9a-fA-F]{2}){100,}|(?:\\x[0-9a-fA-F]{2}){40,}/g;
const decodeSink =
    /\b(?:eval|exec|Function|atob|b64decode|b32decode|b85decode|unhexlify|fromhex|FromBase64String|decompress|loads|Invoke-Expression|iex)\b|Buffer\.from|\bbase64\s+(?:-d|--decode|-D)\b/;

export function obfuscatedExec(text: string, ctx: TextContext): Finding[] {
    const title = `${where(ctx)} decodes hidden data and runs it`;
    const prefix = ctx.kind === "command" ? undefined : ctx.path;
    for (const re of [decodeExec, encodedPowershell]) {
        const m = re.exec(text);
        if (m)
            return [
                {
                    id: "obfuscated_exec",
                    severity: "high",
                    title,
                    evidence: excerpt(text, m.index, prefix),
                },
            ];
    }
    for (const m of text.matchAll(longBlob)) {
        const before = text.slice(Math.max(0, m.index - 300), m.index);
        if (/data:[^\s,;]+;base64,\s*$/.test(before.slice(-100))) continue;
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 100);
        if (decodeSink.test(before) || decodeSink.test(after)) {
            const at = Math.max(0, m.index - 40);
            return [
                {
                    id: "obfuscated_exec",
                    severity: "high",
                    title,
                    evidence: excerpt(text, at, prefix),
                },
            ];
        }
    }
    return [];
}

export function hiddenWhitespace(text: string, ctx: TextContext): Finding[] {
    if (ctx.kind !== "code") return [];
    for (const m of text.matchAll(/[ \t]+/g)) {
        const next = text.charAt(m.index + m[0].length);
        if (m[0].length < 300 || next === "" || /\s/.test(next)) continue;
        return [
            {
                id: "hidden_whitespace",
                severity: "high",
                title: `${ctx.path} hides code after a long run of blank space`,
                evidence: excerpt(text, m.index, ctx.path),
            },
        ];
    }
    return [];
}

const webhookPatterns = [
    /https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,}\/[\w-]{20,}/i,
    /api\.telegram\.org\/bot\d{5,}:[\w-]{20,}/i,
];

export function webhooks(text: string, ctx: TextContext): Finding[] {
    for (const re of webhookPatterns) {
        const m = re.exec(text);
        if (m) {
            return [
                {
                    id: "webhook",
                    severity: "high",
                    title: `${where(ctx)} has a hardcoded Discord or Telegram webhook, a common way to send stolen data`,
                    evidence: excerpt(text, m.index, ctx.kind === "command" ? undefined : ctx.path),
                },
            ];
        }
    }
    return [];
}

export function suspiciousUrls(text: string, ctx: TextContext): Finding[] {
    const hit = urlsIn(text).find((u) => shadyHost(u.host));
    if (!hit) return [];
    const kind = isBareIp(hit.host) ? "a bare IP address" : "a paste or file-drop site";
    return [
        {
            id: "suspicious_url",
            severity: shift("medium", ctx.trust),
            title: `${where(ctx)} links to ${kind}`,
            evidence: excerpt(text, hit.index, ctx.kind === "command" ? undefined : ctx.path),
        },
    ];
}

const passwordHint =
    /\b(?:password|passwd|passcode|pass|pwd)\b\s*(?:is\b|:|=|-|\u2013)\s*[`'"*]*[\w@#$%!.-]{2,40}/i;
const archiveWord = /\b(?:zip|rar|7z|7-zip|archive|extract|unzip|unrar|unpack|winrar)\b|\.exe\b/i;

export function passwordArchive(text: string, ctx: TextContext): Finding[] {
    if (ctx.kind === "command" || ctx.kind === "workflow") return [];
    let offset = 0;
    for (const line of text.split("\n")) {
        const probe = line.slice(0, 2000);
        const m = passwordHint.exec(probe);
        if (m && archiveWord.test(probe)) {
            return [
                {
                    id: "password_archive",
                    severity: "high",
                    title: `${ctx.path} hands out a password for an archive, a way to slip malware past scanners`,
                    evidence: excerpt(text, offset + m.index, ctx.path),
                },
            ];
        }
        offset += line.length + 1;
    }
    return [];
}

const avOff = [
    /\b(?:disable|turn\s+off|deactivate|pause|switch\s+off)\b[^\n.]{0,40}\b(?:anti-?virus|defender|windows\s+security|smartscreen|real-?time\s+protection)\b/i,
    /\b(?:add|create)\b[^\n.]{0,30}\b(?:exclusion|exception)\b[^\n.]{0,40}\b(?:defender|anti-?virus)\b/i,
    /\brun\s+anyway\b/i,
];

export function disableAntivirus(text: string, ctx: TextContext): Finding[] {
    if (ctx.kind === "workflow") return [];
    for (const re of avOff) {
        const m = re.exec(text);
        if (m) {
            return [
                {
                    id: "disable_antivirus",
                    severity: shift("medium", ctx.trust),
                    title: `${where(ctx)} asks to switch off or bypass antivirus protection`,
                    evidence: excerpt(text, m.index, ctx.kind === "command" ? undefined : ctx.path),
                },
            ];
        }
    }
    return [];
}

const walletTerm =
    /\b(?:seed[\s_-]?phrase|mnemonic|private[\s_-]?key|wallet\.dat|keystore|metamask|phantom|Login\s+Data|Local\s+State|cookies\.sqlite|logins\.json|key4\.db)\b|solana\/id\.json|\.ethereum\/keystore|Exodus\/|Electrum\//gi;
const sendPatterns = [
    /\brequests\.(?:post|put)\s*\(/i,
    /\bhttpx\.(?:post|put)\s*\(/i,
    /\burlopen\s*\(/i,
    /\bfetch\s*\(/i,
    /\baxios(?:\.(?:post|put))?\s*\(/i,
    /\bhttps?\.request\s*\(/i,
    /\bXMLHttpRequest\b/,
    /\bsendMessage\b/,
    /\bsmtplib\b/,
    /\bsocket\.send/i,
    /\bUpload(?:String|File|Data)\b/,
    /\bInvoke-(?:RestMethod|WebRequest)\b/i,
    /\bcurl\b[^\n]{0,300}\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)\s/i,
    /api\/webhooks\//i,
];

export function walletTheft(text: string, ctx: TextContext): Finding[] {
    const window = ctx.kind === "docs" ? 300 : 1500;
    let seen = 0;
    for (const m of text.matchAll(walletTerm)) {
        if (++seen > 50) break;
        const around = text.slice(Math.max(0, m.index - window), m.index + window);
        if (!sendPatterns.some((re) => re.test(around))) continue;
        return [
            {
                id: "wallet_theft",
                severity: ctx.kind === "docs" ? shift("medium", ctx.trust) : "high",
                title: `${where(ctx)} handles wallet keys, seed phrases or browser logins next to code that sends data out`,
                evidence: excerpt(text, m.index, ctx.kind === "command" ? undefined : ctx.path),
            },
        ];
    }
    return [];
}

export function scanText(text: string, ctx: TextContext): Finding[] {
    return [
        ...pipeToShell(text, ctx),
        ...obfuscatedExec(text, ctx),
        ...hiddenWhitespace(text, ctx),
        ...webhooks(text, ctx),
        ...suspiciousUrls(text, ctx),
        ...passwordArchive(text, ctx),
        ...disableAntivirus(text, ctx),
        ...walletTheft(text, ctx),
    ];
}

/* Manifest and workflow rules */

const lifecycleFetch =
    /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|bitsadmin|certutil)\b|https?:\/\//i;
const lifecycleBinary =
    /\.(?:exe|dll|scr|msi|bat|cmd|ps1|vbs)\b|\b(?:powershell|pwsh|node\s+-e|python3?\s+-c|eval|base64|sh\s+-c|bash\s+-c)\b|\bchmod\s+\+x\b/i;

export function npmLifecycle(file: RepoFile, trust: Trust): Finding[] {
    let pkg: unknown;
    try {
        pkg = JSON.parse(file.text);
    } catch {
        return [];
    }
    const scripts = (pkg as { scripts?: unknown } | null)?.scripts;
    if (!scripts || typeof scripts !== "object") return [];
    const out: Finding[] = [];
    for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
        const cmd = (scripts as Record<string, unknown>)[hook];
        if (typeof cmd !== "string") continue;
        const ev = evidence(`${hook}: ${cmd}`);
        if (lifecycleFetch.test(cmd) || lifecycleBinary.test(cmd)) {
            out.push({
                id: "npm_lifecycle",
                severity: "high",
                title: `package.json has a ${hook} script that downloads or runs code on npm install`,
                evidence: ev,
            });
        } else {
            out.push({
                id: "npm_lifecycle",
                severity: shift(hook === "prepare" ? "info" : "low", trust),
                title: `package.json runs a ${hook} script on npm install`,
                evidence: ev,
            });
        }
    }
    return pick(out);
}

const pyNetwork =
    /\b(?:urllib\.request|urlopen|urlretrieve|requests\.(?:get|post|put)|httpx\.(?:get|post|Client)|http\.client|socket\.socket|urllib3\.|aiohttp\.)/;
const pyShellNet =
    /\b(?:os\.system|os\.popen|subprocess\.\w+|check_output|check_call|Popen)\s*\([^\n]{0,300}\b(?:curl|wget|powershell|Invoke-WebRequest|bitsadmin|certutil)\b/;
const pyDecode =
    /\b(?:b64decode|b32decode|b85decode|a85decode|unhexlify|fromhex|marshal\.loads|zlib\.decompress)\s*\(/;
const pyExec = /\b(?:exec|eval)\s*\(/g;
const pyLocalExec =
    /^\s*(?:compile\s*\()?\s*(?:open|read|Path|pathlib|f\.read|fp\.read|io\.open)\b|version/;
const pyInstallHook =
    /cmdclass\s*=\s*\{[^}]{0,500}['"](?:install|develop|egg_info|bdist_wheel|build_py)['"]|class\s+\w+\s*\(\s*(?:install|develop|_install)\s*\)/;

export function setupPy(file: RepoFile, trust: Trust): Finding[] {
    const t = file.text;
    const out: Finding[] = [];
    const net = pyNetwork.exec(t) ?? pyShellNet.exec(t);
    if (net) {
        out.push({
            id: "setup_py_network",
            severity: trust === "established" ? "medium" : "high",
            title: "setup.py makes network calls when the package installs",
            evidence: excerpt(t, net.index, file.path),
        });
    }
    const dec = pyDecode.exec(t);
    if (dec) {
        out.push({
            id: "setup_py_decode",
            severity: "high",
            title: "setup.py decodes hidden data when the package installs",
            evidence: excerpt(t, dec.index, file.path),
        });
    }
    for (const m of t.matchAll(pyExec)) {
        if (pyLocalExec.test(t.slice(m.index + m[0].length, m.index + m[0].length + 80))) continue;
        out.push({
            id: "setup_py_exec",
            severity: shift("medium", trust),
            title: "setup.py runs exec or eval on something other than a local file",
            evidence: excerpt(t, m.index, file.path),
        });
        break;
    }
    const hook = pyInstallHook.exec(t);
    if (hook) {
        out.push({
            id: "setup_py_install_hook",
            severity: shift("low", trust),
            title: "setup.py replaces the install step with its own code",
            evidence: excerpt(t, hook.index, file.path),
        });
    }
    return out;
}

const pyprojectHook =
    /^\s*\[tool\.hatch\.build(?:\.targets\.[\w.-]+)?\.hooks\.custom\]|^\s*backend-path\s*=|^\s*\[tool\.setuptools\.cmdclass\]/m;

export function pyprojectHooks(file: RepoFile, trust: Trust): Finding[] {
    const m = pyprojectHook.exec(file.text);
    if (!m) return [];
    return [
        {
            id: "build_hook",
            severity: shift("low", trust),
            title: "pyproject.toml runs a custom build hook when the package installs",
            evidence: excerpt(file.text, m.index, file.path),
        },
    ];
}

const githubHost =
    /(?:^|\.)(?:github\.com|githubusercontent\.com|ghcr\.io|github\.io|githubassets\.com)$/i;
const sender =
    /\b(?:curl|wget|nc|ncat|Invoke-WebRequest|Invoke-RestMethod|requests\.post|fetch)\b/i;

export function workflowSecrets(file: RepoFile, trust: Trust): Finding[] {
    const dump = /toJSON\s*\(\s*secrets\s*\)/i.exec(file.text);
    if (dump) {
        return [
            {
                id: "workflow_secrets",
                severity: "high",
                title: `${file.path} dumps every repository secret`,
                evidence: excerpt(file.text, dump.index, file.path),
            },
        ];
    }
    const lines = file.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const secret = /\$\{\{\s*secrets\.(\w+)/.exec(lines[i] as string);
        if (!secret) continue;
        const win = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
        if (!sender.test(win)) continue;
        const outside = urlsIn(win).filter((u) => !githubHost.test(u.host));
        const first = outside[0];
        if (!first) continue;
        const bad = outside.some(
            (u) =>
                shadyHost(u.host) || /(?:^|\.)discord(?:app)?\.com$|telegram\.org$/i.test(u.host),
        );
        return [
            {
                id: "workflow_secrets",
                severity: bad ? "high" : shift("low", trust),
                title: `${file.path} sends a repository secret to an outside host`,
                evidence: evidence(`${file.path}: secrets.${secret[1]} to ${first.host}`),
            },
        ];
    }
    return [];
}

/* Repo facts and file list */

export function trustOf(info: RepoInfo | null, ownerCreatedAt: string | null, now: number): Trust {
    if (!info) return "normal";
    const age = (now - Date.parse(info.createdAt)) / day;
    const ownerAge = ownerCreatedAt ? (now - Date.parse(ownerCreatedAt)) / day : Infinity;
    if (info.stars >= 1000 && age >= 365 && ownerAge >= 365 && !info.fork) return "established";
    if (info.stars < 50 || !(age >= 90) || ownerAge < 90) return "unknown";
    return "normal";
}

function norm(s: string): string {
    return s.toLowerCase().replace(/[-_.]/g, "");
}

function oneSubstitution(a: string, b: string): boolean {
    if (a.length !== b.length || a.length < 7) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff === 1;
}

export function lookalike(info: RepoInfo, ownerCreatedAt: string | null, now: number): Finding[] {
    const name = norm(info.repo);
    const owner = info.owner.toLowerCase();
    const same = popular.filter((p) => norm(p.repo) === name);
    const match = same[0] ?? popular.find((p) => oneSubstitution(norm(p.repo), name));
    if (!match) return [];
    if (same.some((p) => p.owners.some((o) => o.toLowerCase() === owner))) return [];
    const age = (now - Date.parse(info.createdAt)) / day;
    const ownerAge = ownerCreatedAt ? (now - Date.parse(ownerCreatedAt)) / day : Infinity;
    const young = !(age >= 180) || ownerAge < 180;
    if (!young && info.stars >= 100) return [];
    return [
        {
            id: "lookalike_name",
            severity: info.fork ? "medium" : "high",
            title: `Named like the popular ${match.owners[0]}/${match.repo} but owned by ${info.owner}`,
            evidence: evidence(
                `${info.owner}/${info.repo}: ${info.stars} stars, created ${info.createdAt.slice(0, 10)}${info.fork ? ", a fork" : ""}`,
            ),
        },
    ];
}

const lure =
    /\b(?:crack(?:ed)?|keygen|cheats?|aimbot|wallhack|triggerbot|hwid[\s-]?spoofer|spoofer|free[\s-]?(?:robux|v-?bucks|nitro)|drainer|token[\s-]?grabber|stealer|unlocker)\b(?![\s-]?sheet)/i;

export function repoFindings(
    info: RepoInfo,
    ownerCreatedAt: string | null,
    now: number,
    trust: Trust,
): Finding[] {
    const out: Finding[] = [];
    const age = Math.floor((now - Date.parse(info.createdAt)) / day);
    if (age < 30) {
        out.push({
            id: "young_repo",
            severity: info.stars < 50 ? "medium" : "low",
            title: `Repo created ${age} days ago`,
            evidence: `created ${info.createdAt.slice(0, 10)}, ${info.stars} stars`,
        });
    }
    if (ownerCreatedAt) {
        const ownerAge = Math.floor((now - Date.parse(ownerCreatedAt)) / day);
        if (ownerAge < 180) {
            out.push({
                id: "young_owner",
                severity: ownerAge < 30 ? "medium" : "low",
                title: `Owner account ${info.owner} is ${ownerAge} days old`,
                evidence: `account created ${ownerCreatedAt.slice(0, 10)}`,
            });
        }
    }
    if (info.stars < 10) {
        out.push({
            id: "few_stars",
            severity: "low",
            title: "Very few people have starred this repo",
            evidence: `${info.stars} stars, ${info.forks} forks`,
        });
    }
    if (info.archived) {
        out.push({
            id: "archived",
            severity: "low",
            title: "Repo is archived and no longer maintained",
        });
    }
    if (!info.license) {
        out.push({ id: "no_license", severity: "low", title: "Repo has no license" });
    }
    out.push(...lookalike(info, ownerCreatedAt, now));
    const blurb = `${info.repo} ${info.description} ${info.topics.join(" ")}`;
    const l = lure.exec(blurb);
    if (l) {
        out.push({
            id: "lure_terms",
            severity: shift("medium", trust),
            title: "Repo is described as a crack, cheat or similar tool, the usual bait for malware",
            evidence: excerpt(blurb, l.index),
        });
    }
    return out;
}

const binaryClasses: { re: RegExp; base: Severity; title: string }[] = [
    {
        re: /\.(?:exe|dll|scr|msi|cpl|sys)$/i,
        base: "medium",
        title: "Repo contains Windows executables",
    },
    {
        re: /\.(?:vbs|vbe|wsf|hta|lnk)$/i,
        base: "medium",
        title: "Repo contains Windows script or shortcut files often used as lures",
    },
    {
        re: /\.(?:bat|cmd|ps1)$/i,
        base: "low",
        title: "Repo contains Windows batch or PowerShell scripts",
    },
    {
        re: /\.(?:so|dylib)(?:\.\d+)*$/i,
        base: "low",
        title: "Repo contains prebuilt native libraries",
    },
    {
        re: /\.(?:jar|apk)$/i,
        base: "low",
        title: "Repo contains prebuilt Java or Android packages",
    },
    { re: /\.(?:zip|rar|7z)$/i, base: "low", title: "Repo contains archives" },
];
const binaryExempt =
    /(?:^|\/)gradle-wrapper\.jar$|(?:^|\/)gradlew\.bat$|(?:^|\/)(?:tests?|testdata|test_data|fixtures|__tests__|spec)\//i;

export function committedBinaries(tree: TreeEntry[], trust: Trust): Finding[] {
    const out: Finding[] = [];
    const blobs = tree.filter((e) => e.type === "blob" && !binaryExempt.test(e.path));
    for (const c of binaryClasses) {
        const hits = blobs.filter((e) => c.re.test(e.path));
        if (hits.length === 0) continue;
        const shown = hits.slice(0, 3).map((e) => e.path);
        const more = hits.length > 3 ? ` and ${hits.length - 3} more` : "";
        out.push({
            id: "committed_binaries",
            severity: shift(c.base, trust),
            title: c.title,
            evidence: evidence(`${shown.join(", ")}${more}`),
        });
    }
    return out;
}

/* Whole repo */

const docsFile = /(?:^|\/)readme(?:\.[a-z]+)?$|\.(?:md|markdown|rst|txt|adoc)$/i;
const workflowFile = /^\.github\/workflows\/[^/]+\.ya?ml$/i;

export function fileKind(path: string): TextKind {
    if (workflowFile.test(path)) return "workflow";
    if (docsFile.test(path)) return "docs";
    return "code";
}

// Names from repos and model cards end up in titles and facts, so they get the same cleaning as evidence
export function safePath(path: string): string {
    const clean = evidence(path);
    return clean.length <= 60 ? clean : `${clean.slice(0, 57)}...`;
}

export function scanFile(f: RepoFile, trust: Trust): Finding[] {
    const kind = fileKind(f.path);
    const shown = { ...f, path: safePath(f.path) };
    const out = scanText(f.text, { path: shown.path, kind, trust });
    const lower = f.path.toLowerCase();
    if (lower === "package.json") out.push(...npmLifecycle(shown, trust));
    if (lower === "setup.py") out.push(...setupPy(shown, trust));
    if (lower === "pyproject.toml") out.push(...pyprojectHooks(shown, trust));
    if (kind === "workflow") out.push(...workflowSecrets(shown, trust));
    return out;
}

const mlPackages = new Set([
    "torch",
    "torchaudio",
    "torchvision",
    "tensorflow",
    "tensorflow-gpu",
    "jax",
    "jaxlib",
    "diffusers",
    "transformers",
    "accelerate",
    "xformers",
    "vllm",
    "llama-cpp-python",
    "ctranslate2",
    "faster-whisper",
    "openai-whisper",
    "ultralytics",
    "keras",
    "onnxruntime",
    "onnxruntime-gpu",
    "mlx",
    "sentence-transformers",
    "bitsandbytes",
    "flash-attn",
    "deepspeed",
    "tts",
    "coqui-tts",
    "kokoro",
    "@xenova/transformers",
    "@huggingface/transformers",
    "onnxruntime-node",
    "@tensorflow/tfjs-node",
    "@tensorflow/tfjs-node-gpu",
    "node-llama-cpp",
]);
const cudaPackages = new Set([
    "vllm",
    "xformers",
    "flash-attn",
    "onnxruntime-gpu",
    "tensorflow-gpu",
    "cupy",
    "deepspeed",
    "tensorrt",
    "@tensorflow/tfjs-node-gpu",
]);

export interface RepoNeeds {
    ml: boolean;
    gpu: boolean;
    cuda: boolean;
    packages: string[];
}

function dependencyNames(f: RepoFile): string[] {
    const lower = f.path.toLowerCase();
    const names: string[] = [];
    if (/(?:^|\/)requirements[\w.-]*\.txt$/.test(lower)) {
        for (const line of f.text.split("\n")) {
            const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line.replace(/#.*/, ""));
            if (m) names.push(m[1] as string);
        }
    } else if (lower === "package.json") {
        try {
            const pkg = JSON.parse(f.text) as Record<string, unknown>;
            for (const k of ["dependencies", "optionalDependencies", "peerDependencies"]) {
                const deps = pkg[k];
                if (deps && typeof deps === "object") names.push(...Object.keys(deps));
            }
        } catch {
            return [];
        }
    } else if (lower === "pyproject.toml" || lower === "setup.py") {
        for (const m of f.text.matchAll(
            /["']([A-Za-z0-9][A-Za-z0-9._-]{0,100})[ \t]*(?:\[[^\]\n]{0,100}\])?[ \t]*(?:[<>=!~;@]|["'])/g,
        )) {
            names.push(m[1] as string);
        }
    }
    return names.map((n) => n.toLowerCase().replace(/_/g, "-"));
}

const cudaBase =
    /^\s*FROM\s+(?:--platform=\S+\s+)?(?:nvidia\/cuda|nvcr\.io\/nvidia|pytorch\/pytorch:\S*cuda)/i;

// Multi-stage builds often compile a CUDA variant, only the image that ships says what it needs
function finalStage(dockerfile: string): string {
    const froms = dockerfile.split("\n").filter((l) => /^\s*FROM\s/i.test(l));
    return froms[froms.length - 1] ?? "";
}

export function repoNeeds(files: RepoFile[]): RepoNeeds {
    const deps = new Set(files.flatMap(dependencyNames));
    const packages = [...deps].filter(
        (d) => mlPackages.has(d) || d.startsWith("nvidia-") || d.startsWith("cupy"),
    );
    let cuda = packages.some(
        (d) => cudaPackages.has(d) || d.startsWith("nvidia-") || d.startsWith("cupy"),
    );
    let gpu = cuda;
    for (const f of files) {
        const lower = f.path.toLowerCase();
        if (lower === "dockerfile" && cudaBase.test(finalStage(f.text))) cuda = gpu = true;
        if (lower === ".devcontainer/devcontainer.json" && /--gpus/.test(f.text)) cuda = gpu = true;
        if (fileKind(f.path) === "docs") {
            if (/\b(?:requires?|needs?|must\s+have)\b[^\n.]{0,60}\b(?:NVIDIA|CUDA)\b/i.test(f.text))
                cuda = gpu = true;
            if (/\b\d{1,3}\s?GB\s+(?:of\s+)?VRAM\b/i.test(f.text)) gpu = true;
        }
    }
    return { ml: packages.length > 0, gpu, cuda, packages };
}

export interface RepoScan {
    trust: Trust;
    findings: Finding[];
    facts: Record<string, string | number | boolean>;
    needs: RepoNeeds;
}

export function scanRepo(snap: RepoSnapshot, now: number): RepoScan {
    const findings: Finding[] = [...snap.notes];
    const info = snap.info;
    const needs = repoNeeds(snap.files);
    if (!info) return { trust: "normal", findings, facts: {}, needs };
    const trust = trustOf(info, snap.ownerCreatedAt, now);
    findings.push(...repoFindings(info, snap.ownerCreatedAt, now, trust));
    findings.push(...committedBinaries(snap.tree, trust));
    for (const f of snap.files) findings.push(...scanFile(f, trust));
    const facts: RepoScan["facts"] = {
        repo: `${info.owner}/${info.repo}`,
        stars: info.stars,
        forks: info.forks,
        createdAt: info.createdAt.slice(0, 10),
        pushedAt: info.pushedAt.slice(0, 10),
        ageDays: Math.max(0, Math.floor((now - Date.parse(info.createdAt)) / day)),
        sizeMiB: Math.round((info.sizeKiB / 1024) * 10) / 10,
        archived: info.archived,
        fork: info.fork,
        license: info.license ? safePath(info.license) : "none",
        language: info.language ? safePath(info.language) : "unknown",
        defaultBranch: safePath(info.defaultBranch),
        files: snap.tree.filter((e) => e.type === "blob").length,
        filesChecked: evidence(snap.files.map((f) => f.path).join(", ")),
    };
    if (snap.ownerType) facts.ownerType = snap.ownerType;
    if (snap.ownerCreatedAt) facts.ownerCreatedAt = snap.ownerCreatedAt.slice(0, 10);
    if (snap.treeTruncated) facts.treeTruncated = true;
    if (snap.files.some((f) => f.truncated)) facts.filesTruncated = true;
    if (needs.packages.length > 0) facts.aiPackages = evidence(needs.packages.join(", "));
    return { trust, findings, facts, needs };
}

/* Commands */

const rmSystem =
    /\brm\s+(?:-[a-zA-Z]{1,10}\s+|--[a-z-]{1,30}\s+){0,6}-[a-zA-Z]{0,10}[rR][a-zA-Z]{0,10}\s+(?:-[a-zA-Z]{1,10}\s+|--[a-z-]{1,30}\s+){0,6}["']?(?:\/\*?|~\/?\*?|\$HOME\/?\*?|\$\{HOME\}\/?\*?|\/(?:usr|etc|var|bin|sbin|lib|lib64|boot|opt|System|Library|Applications|home|Users|root|private)\/?\*?)["']?(?=\s|$|;|&|\|)|\b(?:rmdir|rd)\s+\/s\b[^\n]*\b[A-Za-z]:\\(?:Windows|Users)?\\?(?=\s|$|["'])/i;

const commandRules: { id: string; severity: Severity; title: string; re: RegExp }[] = [
    {
        id: "cmd_decode_shell",
        severity: "high",
        title: "The command decodes hidden data and runs it",
        re: /\bbase64\s+(?:-d|--decode|-D)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b|\becho\s+["']?[A-Za-z0-9+/=]{40,}["']?\s*\|\s*base64\b/i,
    },
    {
        id: "cmd_rm_system",
        severity: "high",
        title: "The command deletes system or home folders",
        re: rmSystem,
    },
    {
        id: "cmd_chmod_run",
        severity: "medium",
        title: "The command marks a file executable and runs it",
        re: /\bchmod\s+(?:-\w{1,10}\s+){0,4}(?:[ugoa]{0,4}\+x|[0-7]{0,3}[1357][0-7]{0,2})\s+[^\s;&]{1,200}[^\n]{0,200}?(?:&&|;)\s*(?:sudo\s+)?\.{0,2}\/\S*/i,
    },
    {
        id: "cmd_persistence",
        severity: "medium",
        title: "The command makes something start automatically or adds login keys",
        re: /\bcrontab\b|\bsystemctl\s+(?:--user\s+)?enable\b|\blaunchctl\s+(?:load|bootstrap|submit)\b|>>?\s*\S*\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b|\/etc\/rc\.local|\bschtasks\b[^\n]*\/create|\breg\s+add\b[^\n]*\\Run\b|>>?\s*\S*\.ssh\/authorized_keys/i,
    },
    {
        id: "cmd_docker_privileged",
        severity: "medium",
        title: "The command gives a container full access to this machine",
        re: /\bdocker\s+run\b[^\n]*(?:--privileged|--pid[=\s]host|-v\s+\/:\/|--volume[=\s]\/:\/|\/var\/run\/docker\.sock)/i,
    },
    {
        id: "cmd_sudo",
        severity: "low",
        title: "The command uses sudo to change the system",
        re: /(?:^|[;&|(]\s*)sudo\b/,
    },
];

const secretPath =
    /\.ssh\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.aws\/credentials|\.config\/gcloud|\.kube\/config|\.docker\/config\.json|\.npmrc|\.pypirc|\.netrc|\.git-credentials|solana\/id\.json|\.ethereum\/keystore|wallet\.dat|Exodus\/|Electrum\/|\.electrum\b|Login Data|Local State|cookies\.sqlite|logins\.json|key4\.db|\bKeychains\b/i;
const secretReader =
    /\b(?:cat|cp|scp|rsync|curl|wget|nc|ncat|tar|zip|7z|base64|xxd|od|strings|less|more|head|tail|python3?|node|perl|ruby|Get-Content|type|security\s+find-\w+)\b/i;
const secretBenign = /^\s*(?:ssh-keygen|ssh-add|ssh|chmod|chown|ls|mkdir|touch)\b/i;

export function readsSecrets(cmd: string): Finding[] {
    const tokens = cmd.split(/\s+/).filter((t) => secretPath.test(t));
    const sensitive = tokens.filter((t) => !/\.pub["']?$|known_hosts|authorized_keys/.test(t));
    if (sensitive.length === 0 || !secretReader.test(cmd) || secretBenign.test(cmd)) return [];
    return [
        {
            id: "cmd_reads_secrets",
            severity: "high",
            title: "The command reads SSH keys, cloud credentials, wallet files or browser logins",
            evidence: evidence(cmd),
        },
    ];
}

export function scanCommand(cmd: string): Finding[] {
    const ctx: TextContext = { path: "command", kind: "command", trust: "normal" };
    const out: Finding[] = [
        ...pipeToShell(cmd, ctx),
        ...obfuscatedExec(cmd, ctx),
        ...webhooks(cmd, ctx),
        ...suspiciousUrls(cmd, ctx),
        ...walletTheft(cmd, ctx),
        ...readsSecrets(cmd),
    ];
    for (const r of commandRules) {
        const m = r.re.exec(cmd);
        if (m)
            out.push({
                id: r.id,
                severity: r.severity,
                title: r.title,
                evidence: excerpt(cmd, m.index),
            });
    }
    return out;
}

/* Lists */

export function sortFindings(findings: Finding[]): Finding[] {
    const seen = new Set<string>();
    const perId = new Map<string, number>();
    const out: Finding[] = [];
    const ordered = findings
        .map((f, i) => ({ f, i }))
        .sort((a, b) => severityRank(b.f.severity) - severityRank(a.f.severity) || a.i - b.i);
    for (const { f } of ordered) {
        const key = `${f.id}\u0000${f.title}\u0000${f.evidence ?? ""}`;
        const count = perId.get(f.id) ?? 0;
        if (seen.has(key) || count >= 3) continue;
        seen.add(key);
        perId.set(f.id, count + 1);
        out.push(f);
    }
    return out;
}
