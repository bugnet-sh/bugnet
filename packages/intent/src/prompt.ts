/**
 * Weighted keyword families for a user's prompt.
 *
 * A subject (a model name, a repo URL, a lure, an exploit, a destructive step) only scores fully
 * next to an intent to run, set up or try it. Signs of the user's own work, such as docs, tests or
 * edits to their project, cancel subjects in their own clause only, so a risky step buried in a
 * list of chores still counts. Questions, hosted APIs and read-only requests count against the
 * whole prompt.
 */
import { classifyCommand } from "./command.ts";
import * as L from "./lexicon.ts";
import { find, findAll } from "./lexicon.ts";
import { norm } from "./normalize.ts";
import { signatures } from "./failure.ts";
import { finish, hit, none, refuse, type Hit } from "./score.ts";
import type { Classification, SessionContext } from "./types.ts";

interface Located {
    at: number;
    hit: Hit;
}

interface Clause {
    pos: number;
    heavy: number;
    ownWork: number;
    writing: number;
    negs: Hit[];
}

const clauseBreak =
    /[.!?;]+(?=\s|$)|\n|,? (?:and )?then |,? after that |,? also |(?<=^|\s)\d[.)](?=\s)|\s[-*](?=\s)/g;

// Fetch-and-run and system commands typed into prose, and anything in backticks
const commandStart =
    /(?<![\w-])(?:curl|wget|iwr|irm|invoke-webrequest|sudo|git clone|docker run|dd|rm -rf|xattr)\s[^\n]*?(?=[.!?](?:\s|$)|\n|$)|`[^`\n]+`/g;

// Words that every local failure signature contains one of, so most prompts skip them all
const errorLike =
    /cuda|nvidia|nvcc|libcud|memory|space|errno|quota|killed|kill|137|sigkill|alloc|externally|wheel|requirement|exec format|cpu type|binary file|instruction|architecture|platform|linux|command not found|docker/;

// Pasted logs can hold thousands of commands, and the first few say what the paste is
const maxPasted = 8;

function clauseStarts(t: string): number[] {
    const starts = [0];
    for (const m of findAll(clauseBreak, t)) starts.push(m.index + m[0].length);
    return starts;
}

function clauseOf(starts: number[], at: number): number {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] as number) <= at) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

// URLs become spaces of the same length, so indices stay valid and words inside them do not match
function blank(t: string, spans: RegExpExecArray[]): string {
    const ranges = spans
        .map((m) => [m.index as number, (m.index as number) + m[0].length] as const)
        .sort((a, b) => a[0] - b[0]);
    const parts: string[] = [];
    let at = 0;
    for (const [from, to] of ranges) {
        if (to <= at) continue;
        const start = Math.max(from, at);
        parts.push(t.slice(at, start), " ".repeat(to - start));
        at = to;
    }
    parts.push(t.slice(at));
    return parts.join("");
}

// Widens a match that starts at a file extension to the whole file name before it
function named(t: string, m: RegExpExecArray | null): RegExpExecArray | null {
    if (!m) return null;
    let at = m.index;
    while (at > 0 && /[\w-]/.test(t[at - 1] as string)) at--;
    const out = [t.slice(at, m.index + m[0].length)] as unknown as RegExpExecArray;
    out.index = at;
    return out;
}

function before(t: string, at: number, chars = 40): string {
    return t.slice(Math.max(0, at - chars), at);
}

function repoShort(url: string): string {
    return url
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/^git@([^:]+):/, "$1/")
        .replace(/\.git$/, "")
        .split("/")
        .slice(0, 3)
        .join("/");
}

function isFamous(url: string): boolean {
    const owner = repoShort(url).split("/")[1] ?? "";
    return /^(?:facebook|facebookresearch|meta-llama|microsoft|google|vercel|openai|huggingface|pytorch|tensorflow|torvalds|rust-lang|golang|nodejs|python|apple|kubernetes|docker|hashicorp|ggerganov|ggml-org|ollama|comfyanonymous|automatic1111|lllyasviel|oobabooga|coqui-ai|hexgrad|suno-ai|mozilla|apache|nvidia)$/.test(
        owner,
    );
}

export function classifyPrompt(text: string, ctx: SessionContext = {}): Classification {
    const t = norm(text);
    if (t === "") return none;

    const repos = findAll(L.repoUrl, t);
    const hfs = findAll(L.hfUrl, t);
    const urls = findAll(L.anyUrl, t);
    const bare = blank(t, [...urls, ...repos, ...hfs]);

    const act = find(L.action, bare);
    const verb = find(L.taskVerb, bare);
    const doing = act !== null || verb !== null;
    const isLocal = find(L.local, bare) !== null;
    const mac = ctx.os === "macos" || (ctx.os !== "windows" && find(L.macText, bare) !== null);
    const win = !mac && (ctx.os === "windows" || (!ctx.os && find(L.windowsText, bare) !== null));
    const notLinux = mac || win;

    const starts = clauseStarts(t);
    const located: Located[] = [];
    const global: Hit[] = [];
    const put = (at: number, h: Hit) => located.push({ at, hit: h });

    /* Heavy local AI */
    const names = findAll(L.aiName, t);
    if (find(L.aiContext, bare)) names.push(...findAll(L.aiWeakName, t));
    names.sort((a, b) => (a.index as number) - (b.index as number));
    const tasks = findAll(L.aiTask, bare);
    const ai = names[0] ?? tasks[0];
    if (ai) {
        const named = names.length > 0;
        const w = named ? (doing ? 4 : isLocal ? 3 : 1) : doing ? 3 : 0;
        const at = ai.index as number;
        if (w > 0) {
            put(at, hit(named ? "ai_model" : "ai_task", "local_ai_model", w, ai[0], ai[0]));
        }
        if (w >= 3) {
            if (isLocal && doing) put(at, hit("runs_locally", "local_ai_model", 1, "locally"));
            const big = findAll(L.paramSize, t).find((m) => Number(m[1]) >= 13);
            if (big) put(at, hit("large_model", "local_ai_model", 2, big[0]));
            const video = find(L.videoName, t);
            if (video) put(at, hit("video_model", "local_ai_model", 1, video[0]));
            const weights = find(L.weightsCue, bare);
            if (weights) put(at, hit("model_weights", "local_ai_model", 1, weights[0]));
        }
    }

    /* Code the user has not vetted */
    let externalRepo = false;
    for (const m of repos) {
        const at = m.index as number;
        if (find(L.ownRepoBefore, before(t, at)) || isFamous(m[0])) continue;
        externalRepo = true;
        put(at, hit("unfamiliar_repo", "untrusted_code", act ? 4 : 1, m[0], repoShort(m[0])));
        break;
    }
    const hf = hfs[0];
    if (hf && act) {
        put(hf.index as number, hit("model_repo", "local_ai_model", 4, hf[0], repoShort(hf[0])));
    }
    const script = findAll(L.scriptUrl, t)[0];
    if (script && act && !externalRepo) {
        put(script.index as number, hit("script_url", "untrusted_code", 4, script[0], script[0]));
    }

    const file = named(bare, find(L.receivedFile, bare));
    const fileContext = find(L.receivedContext, bare);
    const from = find(L.origin, bare);
    if (from) {
        const code = file !== null || repos.length > 0 || find(L.repoWord, bare) !== null;
        const w = doing && code ? 4 : doing || code ? 3 : 1;
        global.push(hit("origin", "untrusted_code", w, from[0]));
    }
    const strongFile = named(bare, find(L.disguisedFile, bare)) ?? find(L.enableMacros, bare);
    if (strongFile) {
        put(
            strongFile.index as number,
            hit("disguised_file", "untrusted_code", 4, strongFile[0], strongFile[0]),
        );
    } else if (file) {
        const w = act ? (fileContext || from ? 4 : 2) : 1;
        put(file.index as number, hit("received_file", "untrusted_code", w, file[0], file[0]));
    }
    const av = find(L.avOff, bare);
    if (av) put(av.index as number, hit("security_bypass", "untrusted_code", 4, av[0]));

    for (const m of findAll(L.lure, t)) {
        const at = m.index as number;
        const pre = before(t, at, 30);
        if (L.ownBefore.test(pre) || L.createBefore.test(pre)) continue;
        put(at, hit("lure", "untrusted_code", doing ? 4 : 2, m[0], m[0]));
        break;
    }
    const exploit = find(L.poc, bare);
    if (exploit && act) {
        put(exploit.index as number, hit("exploit", "untrusted_code", 4, exploit[0], exploit[0]));
    }
    const doubt = find(L.safety, bare);
    if (doubt) {
        const about =
            urls.length > 0 || repos.length > 0 || file !== null || find(L.repoWord, bare);
        global.push(hit("safety_doubt", "untrusted_code", about ? 3 : 1, doubt[0]));
    }

    /* The user asks for isolation */
    const iso = find(L.explicit, bare);
    if (iso) {
        const around = t.slice(Math.max(0, (iso.index as number) - 30), (iso.index as number) + 40);
        if (!find(L.notIsolation, around)) global.push(hit("asks_isolation", null, 6, iso[0]));
    }
    const away = find(L.notMine, bare);
    if (away) global.push(hit("not_on_my_machine", null, 4, away[0]));

    /* Setups that do not fit this machine */
    const nv = mac ? find(L.nvidiaOnly, bare) : null;
    const need = mac ? find(L.nvidiaNeed, bare) : null;
    const gap = find(L.hardwareGap, bare);
    if (mac && (need || (nv && gap))) {
        const m = (need ?? nv) as RegExpExecArray;
        put(m.index, hit("needs_nvidia", "environment", act ? 4 : 3, m[0]));
    } else if (mac && nv) {
        put(nv.index, hit("mentions_nvidia", "environment", 2, nv[0]));
    }
    if (gap && (nv || ai || act)) put(gap.index, hit("hardware_gap", "environment", 2, gap[0]));
    const linux = notLinux ? find(L.linuxOnly, bare) : null;
    if (linux) {
        put(linux.index as number, hit("needs_linux", "environment", act ? 4 : 3, linux[0]));
    }
    const x86 = mac ? find(L.x86Only, bare) : null;
    if (x86) put(x86.index as number, hit("needs_x86", "environment", act ? 4 : 3, x86[0]));
    const driver = find(L.driverText, bare);
    if (driver && act)
        put(driver.index as number, hit("driver_setup", "environment", 4, driver[0]));
    for (const s of errorLike.test(t) ? signatures : []) {
        const m = s.re.exec(t);
        if (m) {
            put(m.index, hit(`pasted_${s.id}`, s.category, 3, m[0]));
            break;
        }
    }

    /* Experiments that can break the machine */
    const wreck = find(L.destructive, t);
    if (wreck)
        put(
            wreck.index as number,
            hit("destructive", "risky_experiment", act ? 4 : 2, wreck[0], wreck[0]),
        );
    const device = find(L.rawDevice, t);
    if (device && !wreck) put(device.index, hit("raw_device", "risky_experiment", 2, device[0]));
    const kern = find(L.kernelText, bare);
    if (kern)
        put(
            kern.index as number,
            hit("kernel_change", "risky_experiment", act ? 3 : 1, kern[0], kern[0]),
        );

    /* Long, heavy jobs */
    // Time phrases alone describe a wait, so a heavy job also needs something that computes
    let time = 0;
    let work = 0;
    let heavyAt = -1;
    let heavyWhat = "";
    const cue = (m: RegExpExecArray | null | undefined, w: number, isWork: boolean) => {
        if (!m) return;
        if (isWork) work += w;
        else time += w;
        if (heavyAt === -1 || (m.index as number) < heavyAt) {
            heavyAt = m.index as number;
            heavyWhat = m[0];
        }
    };
    const atLeast = (re: RegExp, n: number) => findAll(re, bare).find((m) => Number(m[1]) >= n);
    for (const m of findAll(L.heavyPhrase, bare).slice(0, 2)) cue(m, 2, false);
    cue(atLeast(L.hours, 1), 2, false);
    cue(atLeast(L.minutes, 30), 2, false);
    cue(find(L.heavyTask, bare), 1, true);
    cue(find(L.longBuild, bare), 2, true);
    for (const m of findAll(L.loadTest, bare).slice(0, 2)) cue(m, 2, true);
    cue(find(L.heat, bare), 1, true);
    cue(atLeast(L.repeats, 10), 1, true);
    cue(
        findAll(L.batch, bare).find((m) => m[2] === "k" || Number(m[1]) >= 50),
        1,
        true,
    );
    cue(find(L.wholeBatch, bare), 1, true);
    cue(atLeast(L.epochs, 20), 2, true);
    const heavy = work > 0 ? work + time : Math.min(time, 2);
    if (heavy > 0) {
        const w = doing ? Math.min(heavy, 5) : heavy >= 4 ? 4 : Math.min(heavy, 2);
        put(heavyAt, hit("heavy_job", "heavy_compute", w, heavyWhat, heavyWhat));
    }

    /* Commands pasted into the prompt */
    // A fetch command mentioned in prose without a URL is talk about it, not a command
    const typed = (x: RegExpExecArray) =>
        x[0].startsWith("`") || /:\/\//.test(x[0]) || !/^(?:curl|wget|iwr|irm|invoke)/.test(x[0]);
    for (const m of findAll(commandStart, t).filter(typed).slice(0, maxPasted)) {
        const c = classifyCommand(m[0].replace(/^`|`$/g, ""), ctx);
        if (c.suggest && c.category) {
            const pts = Math.min(Math.round(c.score * 8), 6);
            put(
                m.index as number,
                hit("pasted_command", c.category, pts, m[0], c.subject ?? undefined),
            );
            break;
        }
    }

    const stop = find(L.abuse, t);
    const lan = find(L.lanScan, t);
    if (located.length === 0 && !global.some((h) => h.weight > 0)) {
        if (stop) return refuse([], hit("abuse", null, -10, stop[0]));
        return lan ? refuse([], hit("lan_scan", null, -10, lan[0])) : none;
    }

    /* Clause-local signs of the user's own work */
    const negatives: Located[] = [];
    const negate = (re: RegExp, id: string, weight: number) => {
        const seen = new Set<number>();
        for (const m of findAll(re, bare)) {
            const c = clauseOf(starts, m.index);
            if (seen.has(c)) continue;
            seen.add(c);
            negatives.push({ at: m.index, hit: hit(id, null, weight, m[0]) });
        }
    };
    negate(L.own, "own_project", -3);
    negate(L.docs, "writing_docs", -5);
    negate(L.tests, "writing_tests", -3);
    negate(L.edit, "editing_code", -2);

    /* Whole-prompt signals against an offer */
    // A question that opens the prompt stays a question even when it mentions running something
    const question = find(L.concept, bare);
    if (question) {
        const firm = !act || (question.index === 0 && !iso && !away);
        global.push(hit("concept_question", null, firm ? -5 : -2, question[0]));
    }
    if (!iso && !away) {
        const ro = find(L.readOnly, bare);
        if (ro) global.push(hit("read_only", null, -6, ro[0]));
    }
    const api = findAll(L.hosted, bare).find(
        (m) => !L.notHostedBefore.test(before(bare, m.index as number, 30)),
    );
    if (api) {
        const unvetted = located.some(
            (l) => l.hit.category === "untrusted_code" && l.hit.weight >= 4,
        );
        global.push(hit("hosted_api", null, unvetted ? -2 : -6, api[0]));
    }
    const remote = find(L.remoteTarget, bare);
    if (remote) global.push(hit("remote_target", null, -3, remote[0]));
    const plane = find(L.offline, bare);
    if (plane) global.push(hit("offline_use", null, -4, plane[0]));

    /* Clause sums never go below zero, so chores elsewhere cannot cancel a risky step */
    const perClause = new Map<number, Clause>();
    for (const l of located) {
        const c = clauseOf(starts, l.at);
        const e = perClause.get(c) ?? { pos: 0, heavy: 0, ownWork: 0, writing: 0, negs: [] };
        if (l.hit.category === "heavy_compute") e.heavy += l.hit.weight;
        else e.pos += l.hit.weight;
        perClause.set(c, e);
    }
    for (const n of negatives) {
        const e = perClause.get(clauseOf(starts, n.at));
        if (!e) continue;
        if (n.hit.id === "writing_docs" || n.hit.id === "writing_tests") e.writing += n.hit.weight;
        else e.ownWork += n.hit.weight;
        e.negs.push(n.hit);
    }
    let points = global.reduce((s, h) => s + h.weight, 0);
    const kept: Hit[] = [...located.map((l) => l.hit), ...global];
    for (const e of perClause.values()) {
        // Heavy jobs on the user's own code are the point, so only docs or tests cancel them
        points += Math.max(0, e.pos + e.ownWork + e.writing);
        points += e.writing < 0 ? 0 : e.heavy;
        kept.push(...e.negs);
    }

    if (stop) return refuse(kept, hit("abuse", null, -10, stop[0]));
    if (lan) return refuse(kept, hit("lan_scan", null, -10, lan[0]));
    return finish(kept, points);
}
