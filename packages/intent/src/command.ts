/**
 * Command grammar for the Bash command an agent is about to run.
 *
 * The command is parsed into simple commands, and each one is matched by its program and
 * arguments, so a grep that mentions torch.cuda stays quiet while pip install xformers does not.
 * Install and build steps only count inside a repository cloned in this session.
 */
import { find } from "./lexicon.ts";
import * as L from "./lexicon.ts";
import { ascii, clip, norm, spaced } from "./normalize.ts";
import { heavyPackage, isLurePackage, typosquatOf } from "./packages.ts";
import { famousOwners, repoOf } from "./repos.ts";
import { parse, type Segment } from "./shell.ts";
import { finish, hit, none, refuse, type Hit } from "./score.ts";
import type { Classification, SessionContext } from "./types.ts";

interface State {
    ctx: SessionContext;
    hits: Hit[];
    cloned: boolean;
    clonedRepo: string | null;
    clonedFamous: boolean;
    ranClonedCode: boolean;
    downloads: Set<string>;
}

const fetchers = new Set([
    "curl",
    "wget",
    "iwr",
    "irm",
    "invoke-webrequest",
    "invoke-restmethod",
    "aria2c",
    "http",
    "xh",
]);
const interpreters = new Set([
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "ash",
    "python",
    "python3",
    "python2",
    "perl",
    "ruby",
    "node",
    "php",
    "iex",
    "invoke-expression",
    "pwsh",
    "powershell",
    "source",
    ".",
    "eval",
]);
const readOnly = new Set([
    "grep",
    "egrep",
    "rg",
    "ag",
    "ls",
    "ll",
    "cat",
    "bat",
    "less",
    "more",
    "head",
    "tail",
    "wc",
    "file",
    "stat",
    "du",
    "df",
    "tree",
    "echo",
    "printf",
    "which",
    "type",
    "whereis",
    "man",
    "diff",
    "jq",
    "yq",
    "awk",
    "sed",
    "sort",
    "uniq",
    "cut",
    "tr",
    "find",
    "fd",
    "pwd",
    "cd",
    "pushd",
    "popd",
    "export",
    "set",
    "unset",
    "alias",
    "history",
    "true",
    "false",
    "test",
    "[",
    "read",
    "sleep",
    "clear",
    "open",
    "code",
    "tee",
    "touch",
    "mkdir",
    "cp",
    "mv",
    "ln",
    "chmod",
    "nvm",
    "pyenv",
    "deactivate",
    "activate",
]);

// Installers people run every day, as an exact host and a path prefix on it
const mainstream = [
    "brew.sh",
    "raw.githubusercontent.com/homebrew/",
    "sh.rustup.rs",
    "rustup.rs",
    "win.rustup.rs",
    "bun.sh/install",
    "get.docker.com",
    "deno.land/install.sh",
    "deno.land/install.ps1",
    "deno.land/x/install/",
    "astral.sh/uv",
    "astral.sh/ruff",
    "raw.githubusercontent.com/nvm-sh/nvm/",
    "raw.githubusercontent.com/ohmyzsh/",
    "get.pnpm.io",
    "fnm.vercel.app",
    "get.volta.sh",
    "starship.rs",
    "claude.ai/install",
    "tailscale.com/install",
    "install.python-poetry.org",
    "pyenv.run",
    "mise.run",
    "get.sdkman.io",
    "install.determinate.systems",
    "nixos.org/nix/install",
    "dot.net/v1/dotnet-install",
    "deb.nodesource.com/",
    "rpm.nodesource.com/",
    "get.scoop.sh",
    "community.chocolatey.org/install",
    "chocolatey.org/install",
    "fly.io/install",
    "cli.github.com",
    "sdk.cloud.google.com",
    "raw.githubusercontent.com/helm/helm/",
    "get.helm.sh",
    "opencode.ai/install",
    "cursor.com/install",
    "gh.io/copilot-install",
];

// Full URLs, host/path forms, and bare hosts such as get.scoop.sh
function looksLikeUrl(w: string): boolean {
    return (
        /^(?:https?|ftp):\/\//i.test(w) ||
        /^[\w-]+(?:\.[\w-]+)+\/\S*/.test(w) ||
        /^[\w-]+\.[\w-]+\.[a-z]{2,}$/i.test(w)
    );
}

function hostPath(url: string): string {
    return url
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, "")
        .replace(/^www\./, "");
}

// Vendors whose every installer host is their own, matched on the host and its subdomains
const mainstreamHosts = [
    "astral.sh",
    "rustup.rs",
    "bun.sh",
    "brew.sh",
    "volta.sh",
    "pnpm.io",
    "docker.com",
    "nodesource.com",
    "tailscale.com",
    "starship.rs",
    "claude.ai",
    "anthropic.com",
    "python-poetry.org",
    "pyenv.run",
    "mise.run",
    "sdkman.io",
    "determinate.systems",
    "nixos.org",
    "scoop.sh",
    "chocolatey.org",
    "fly.io",
    "helm.sh",
    "go.dev",
    "golang.org",
    "nodejs.org",
    "yarnpkg.com",
    "julialang.org",
    "k3s.io",
    "rvm.io",
    "bootstrap.pypa.io",
    "vercel.com",
    "netlify.com",
    "supabase.com",
    "cloud.google.com",
    "dl.google.com",
    "awscli.amazonaws.com",
    "releases.hashicorp.com",
    "packages.microsoft.com",
    "aka.ms",
];

// Hosts compare exactly, so brew.sh-install.com or get.docker.com.evil.ru are not the vendor
function isMainstream(url: string): boolean {
    const hp = hostPath(url);
    const cut = hp.search(/[/?#]/);
    const host = (cut === -1 ? hp : hp.slice(0, cut)).replace(/:\d+$/, "");
    const path = cut === -1 ? "/" : hp.slice(cut);
    return (
        mainstream.some((m) => {
            const slash = m.indexOf("/");
            if (slash === -1) return host === m;
            return host === m.slice(0, slash) && path.startsWith(m.slice(slash));
        }) || mainstreamHosts.some((m) => host === m || host.endsWith(`.${m}`))
    );
}

function urlArg(seg: Segment): string | null {
    return seg.argv.slice(1).find(looksLikeUrl) ?? null;
}

function add(st: State, h: Hit): void {
    st.hits.push(h);
}

function evidence(seg: Segment, words = 4): string {
    return seg.argv.slice(0, words).join(" ");
}

function isLocal(target: string): boolean {
    return L.privateTarget.test(hostPath(target));
}

/* Remote scripts piped into an interpreter */

function remoteExec(segs: Segment[], i: number, st: State): void {
    const seg = segs[i] as Segment;
    let url: string | null = null;
    let how = "";
    let sink: Segment | undefined;
    const last = Math.min(segs.length, i + 6);
    for (
        let j = i + 1;
        fetchers.has(seg.head) && seg.pipesTo && j < last && segs[j]?.pipedFrom;
        j++
    ) {
        if (interpreters.has((segs[j] as Segment).head)) {
            sink = segs[j];
            break;
        }
        if (!(segs[j] as Segment).pipesTo) break;
    }
    if (fetchers.has(seg.head) && sink) {
        url = urlArg(seg);
        how = `${seg.head} | ${sink.head}`;
    } else if (
        fetchers.has(seg.head) &&
        seg.via === "subst" &&
        seg.parent !== null &&
        interpreters.has(seg.parent)
    ) {
        url = urlArg(seg);
        how = `${seg.parent} $(${seg.head})`;
    } else if (seg.head === "iex" || seg.head === "invoke-expression") {
        const m = /(https?:\/\/[^\s'")]+)/i.exec(seg.argv.join(" "));
        if (
            m &&
            /downloadstring|iwr|irm|invoke-web|invoke-rest|webclient/i.test(seg.argv.join(" "))
        ) {
            url = m[1] as string;
            how = "iex download";
        }
    }
    if (how === "") return;
    if (url && isMainstream(url)) {
        add(st, hit("mainstream_installer", null, 0, hostPath(url).slice(0, 60)));
        return;
    }
    if (url && /ollama\.com\/install/i.test(url)) {
        add(st, hit("ai_runtime_install", "local_ai_model", 2, "ollama install script", "Ollama"));
        return;
    }
    const subject = url ? hostPath(url).split("?")[0] : "a script from the internet";
    add(st, hit("pipe_to_shell", "untrusted_code", 6, how, subject));
}

// A base64 or hex payload decoded straight into an interpreter, which hides what runs
function decodedExec(segs: Segment[], i: number, st: State): void {
    const seg = segs[i] as Segment;
    const l = seg.lower;
    const decodes =
        (seg.head === "base64" && l.some((a) => /^(?:-d|--decode|-di)$/.test(a))) ||
        (seg.head === "openssl" && l.includes("base64") && l.includes("-d")) ||
        (seg.head === "xxd" && l.some((a) => /^-r/.test(a)));
    if (!decodes) return;
    let sink: string | null = null;
    const last = Math.min(segs.length, i + 4);
    for (let j = i + 1; seg.pipesTo && j < last && segs[j]?.pipedFrom; j++) {
        if (interpreters.has((segs[j] as Segment).head)) {
            sink = (segs[j] as Segment).head;
            break;
        }
        if (!(segs[j] as Segment).pipesTo) break;
    }
    if (!sink && seg.via === "subst" && seg.parent !== null && interpreters.has(seg.parent))
        sink = seg.parent;
    if (sink) {
        add(
            st,
            hit(
                "decoded_exec",
                "untrusted_code",
                6,
                `${seg.head} -d | ${sink}`,
                "an encoded script",
            ),
        );
    }
}

const scriptHosts = /^(?:python[\d.]*|py|node|deno|bun|perl|ruby|php)$/;

// Inline Python, Node, Perl or Ruby that downloads code and runs it, or runs a decoded payload
function inlineCode(seg: Segment, st: State): void {
    if (!scriptHosts.test(seg.head)) return;
    const flag = seg.lower.findIndex((a, j) => j > 0 && /^-(?:c|e|-eval|r|p)$/.test(a));
    const code = (flag !== -1 ? seg.argv[flag + 1] : seg.stdin)?.toLowerCase();
    if (!code) return;
    const runs =
        /\b(?:exec|eval|system|popen|subprocess|spawn|execsync|child_process|runpy|new function)\b/.test(
            code,
        );
    if (!runs) return;
    const url = /https?:\/\/[^\s'"()]+/.exec(code)?.[0];
    const fetches =
        /\b(?:urlopen|urlretrieve|requests|httpx|urllib|fetch|https?\.get|axios|curl|wget|net::http|open-uri|lwp|file_get_contents)\b/.test(
            code,
        );
    if (url && fetches && !isMainstream(url)) {
        add(
            st,
            hit(
                "inline_remote_exec",
                "untrusted_code",
                6,
                `${seg.head} inline code`,
                hostPath(url),
            ),
        );
    } else if (/b64decode|base64|atob|frombase64string|fromcharcode|codecs\.decode/.test(code)) {
        add(
            st,
            hit(
                "decoded_exec",
                "untrusted_code",
                5,
                `${seg.head} decodes and runs`,
                "an encoded script",
            ),
        );
    }
}

// PowerShell told to skip its script signing policy, which matters most for installers
function policyBypass(seg: Segment, st: State): void {
    const l = seg.lower;
    if (seg.head === "set-executionpolicy") {
        if (l.some((a) => a === "bypass" || a === "unrestricted"))
            add(st, hit("policy_bypass", "untrusted_code", 2, "Set-ExecutionPolicy Bypass"));
        return;
    }
    if (seg.head !== "powershell" && seg.head !== "pwsh") return;
    const at = l.findIndex((a) => /^-(?:executionpolicy|exec\w*|ep|ex)$/.test(a));
    if (at === -1 || !/^(?:bypass|unrestricted)$/.test(l[at + 1] ?? "")) return;
    const fileAt = l.findIndex((a) => a === "-file" || a === "-f");
    const script = fileAt !== -1 ? seg.argv[fileAt + 1] : seg.argv.find((a) => /\.ps1$/i.test(a));
    const risky =
        script !== undefined &&
        (/(?:^|[\\/])(?:install|setup|bootstrap|get)[\w-]*\.ps1$/i.test(script) ||
            /downloads|temp|appdata/i.test(script) ||
            st.cloned ||
            st.ctx.clonedThisSession === true);
    const w = script === undefined ? 2 : risky ? 4 : 3;
    add(st, hit("policy_bypass", "untrusted_code", w, "-ExecutionPolicy Bypass", script));
}

// curl -o x.sh URL followed by bash x.sh or ./x.sh
function downloadThenRun(seg: Segment, st: State): void {
    const file = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
    if (fetchers.has(seg.head)) {
        const url = urlArg(seg);
        const named = (url ?? "").split(/[?#]/)[0]?.split("/").pop() ?? "";
        const flagAt = seg.lower.findIndex((a) =>
            /^(?:-o|--output|--output-document|-outfile)$/.test(a),
        );
        const remoteName = seg.head === "wget" ? flagAt === -1 : seg.argv.includes("-O");
        const out =
            flagAt !== -1 && seg.argv[flagAt] !== "-O" ? seg.argv[flagAt + 1] : seg.redirects[0];
        if (out && !out.startsWith("-")) st.downloads.add(file(out));
        else if (seg.head === "wget" && seg.argv[flagAt] === "-O" && seg.argv[flagAt + 1]) {
            st.downloads.add(file(seg.argv[flagAt + 1] as string));
        } else if (remoteName && named) st.downloads.add(named);
        return;
    }
    if (st.downloads.size === 0) return;
    const runs = interpreters.has(seg.head) ? seg.argv[1] : seg.argv[0];
    if (runs && st.downloads.has(file(runs))) {
        add(st, hit("download_then_run", "untrusted_code", 5, evidence(seg), runs));
    }
}

/* Clones and the code inside them */

const cloneValueFlags =
    /^(?:--depth|-b|--branch|--origin|-o|--filter|--config|-c|--jobs|-j|--reference|--separate-git-dir|--template|--shallow-since|--shallow-exclude|-u|--upload-pack)$/;

// The URL a git clone or gh repo clone fetches, and the directory it creates
function cloneOf(seg: Segment): { url: string; dir: string } | null {
    let url: string | null = null;
    let dir: string | undefined;
    if (seg.head === "git") {
        const at = seg.lower.indexOf("clone");
        if (at === -1) return null;
        const rest: string[] = [];
        for (let j = at + 1; j < seg.argv.length; j++) {
            const a = seg.argv[j] as string;
            if (cloneValueFlags.test(a)) j++;
            else if (!a.startsWith("-")) rest.push(a);
        }
        [url = null, dir] = rest;
    } else if (seg.head === "gh" && seg.lower[1] === "repo" && seg.lower[2] === "clone") {
        const target = seg.argv[3];
        if (target)
            url = target.includes("/") && !target.includes(":") ? `github.com/${target}` : target;
        dir = seg.argv[4];
    }
    if (!url || !/^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/|[\w.-]+\.[a-z]{2,}\/)/i.test(url))
        return null;
    const name = url
        .replace(/\.git$/, "")
        .replace(/\/+$/, "")
        .split(/[/:]/)
        .pop();
    return { url, dir: dir ?? name ?? "" };
}

// Repositories a command clones, for the hook to remember which directories hold them
export function clonesIn(command: string): { repo: string; dir: string }[] {
    const out: { repo: string; dir: string }[] = [];
    for (const seg of parse(ascii(clip(command)).trim())) {
        const c = cloneOf(seg);
        if (c && c.dir) out.push({ repo: repoOf(c.url).short, dir: c.dir });
    }
    return out;
}

function gitClone(seg: Segment, st: State): void {
    const url = cloneOf(seg)?.url;
    if (!url) return;
    const repo = repoOf(url);
    st.cloned = true;
    st.clonedRepo = repo.short;
    st.clonedFamous = famousOwners.has(repo.owner);
    if (repo.host === "huggingface.co") {
        add(
            st,
            hit("model_repo_clone", "local_ai_model", 4, "git clone huggingface.co", repo.short),
        );
        return;
    }
    if (!st.clonedFamous) add(st, hit("git_clone", "untrusted_code", 2, "git clone", repo.short));
}

// Steps that execute the code of the project in the current directory
function projectStep(seg: Segment): string | null {
    const [h, a1 = "", a2 = ""] = [seg.head, seg.lower[1], seg.lower[2]];
    const prog = seg.argv[0] ?? "";
    if (["npm", "pnpm", "yarn", "bun"].includes(h)) {
        if (h === "yarn" && a1 === "") return "yarn";
        if (
            /^(?:install|i|ci|add|start|run|run-script|dev|test|t|exec|build|rebuild|link|x)$/.test(
                a1,
            )
        ) {
            return `${h} ${a1}`;
        }
        return null;
    }
    if (h === "pip" || h === "pip3" || (h === "uv" && a1 === "pip")) {
        const args = h === "uv" ? seg.lower.slice(2) : seg.lower.slice(1);
        if (args[0] !== "install") return null;
        if (
            args.some(
                (a) =>
                    a === "-r" ||
                    a === "-e" ||
                    a === "." ||
                    a === "--editable" ||
                    /^-r\S/.test(a) ||
                    /requirements[\w.-]*\.txt$/.test(a),
            )
        ) {
            return `${h} install -r`;
        }
        return null;
    }
    if (/^python[\d.]*$|^py$/.test(h)) {
        if (a1 === "-m" && /^(?:pip|venv|virtualenv|http\.server|json\.tool)$/.test(a2)) {
            return a2 === "pip" && seg.lower.includes("-r") ? "python -m pip install -r" : null;
        }
        if (a1 && !a1.startsWith("-")) return `python ${seg.argv[1]}`;
        if (a1 === "-m" && a2) return `python -m ${a2}`;
        return null;
    }
    if (["uv", "poetry", "pipenv", "pdm", "rye", "hatch"].includes(h)) {
        return /^(?:sync|install|run|add)$/.test(a1) ? `${h} ${a1}` : null;
    }
    if ((h === "conda" || h === "mamba" || h === "micromamba") && a1 === "env" && a2 === "create") {
        return `${h} env create`;
    }
    if (
        ["node", "deno", "tsx", "ts-node", "bunx", "npx"].includes(h) &&
        a1 !== "" &&
        !a1.startsWith("-v")
    ) {
        return `${h} ${seg.argv[1]}`;
    }
    if (["make", "cmake", "meson", "ninja", "gradle", "mvn", "just", "scons", "bazel"].includes(h))
        return h;
    if (h === "cargo" && /^(?:build|run|install|test|bench)$/.test(a1)) return `cargo ${a1}`;
    if (h === "go" && /^(?:run|build|install|generate|test)$/.test(a1)) return `go ${a1}`;
    if (h === "dotnet" && /^(?:run|build|restore)$/.test(a1)) return `dotnet ${a1}`;
    if (
        (h === "docker" || h === "podman") &&
        (a1 === "build" || (a1 === "compose" && /^(?:up|build|run)$/.test(a2)))
    ) {
        return `${h} ${a1}`;
    }
    if (h === "docker-compose" && /^(?:up|build|run)$/.test(a1)) return "docker-compose up";
    if (/^\.\.?\//.test(prog) || (["sh", "bash", "zsh"].includes(h) && /\.(?:sh|bash)$/.test(a1))) {
        return seg.argv.slice(0, 2).join(" ");
    }
    return null;
}

function clonedCode(seg: Segment, st: State): void {
    if (st.ranClonedCode || !(st.cloned || st.ctx.clonedThisSession)) return;
    const step = projectStep(seg);
    if (!step) return;
    st.ranClonedCode = true;
    const subject = st.clonedRepo ?? undefined;
    const weight = st.cloned && st.clonedFamous ? 2 : 5;
    add(st, hit("runs_cloned_code", "untrusted_code", weight, step, subject));
    if (st.clonedRepo && find(L.aiName, spaced(st.clonedRepo))) {
        add(st, hit("ai_repo", "local_ai_model", 4, step, st.clonedRepo));
    }
}

/* Package installs */

interface Install {
    manager: "pip" | "npm" | "conda" | "brew" | "system";
    names: string[];
    urlDeps: string[];
    indexUrls: string[];
    global: boolean;
    breakSystem: boolean;
}

const pipValueFlags =
    /^(?:-r|--requirement|-c|--constraint|-e|--editable|-i|--index-url|--extra-index-url|-f|--find-links|-t|--target|--prefix|--root|--platform|--python-version|--implementation|--abi|--src|--cache-dir|--log|--trusted-host|--python|-p|--group|--only-binary|--no-binary)$/;

function packageName(spec: string): string {
    return spec
        .replace(/^['"]|['"]$/g, "")
        .split(/[\s;]/)[0]!
        .replace(/\[.*$/, "")
        .split(/(?:===?|>=|<=|~=|!=|<|>)/)[0]!
        .trim();
}

function install(seg: Segment): Install | null {
    const h = seg.head;
    const l = seg.lower;
    let args: string[] | null = null;
    let manager: Install["manager"] = "pip";
    if ((h === "pip" || h === "pip3" || h === "pipx") && l[1] === "install")
        args = seg.argv.slice(2);
    else if (h === "uv" && l[1] === "pip" && l[2] === "install") args = seg.argv.slice(3);
    else if (h === "uv" && (l[1] === "add" || (l[1] === "tool" && l[2] === "install"))) {
        args = seg.argv.slice(l[1] === "add" ? 2 : 3);
    } else if (/^python[\d.]*$/.test(h) && l[1] === "-m" && l[2] === "pip" && l[3] === "install") {
        args = seg.argv.slice(4);
    } else if ((h === "poetry" || h === "pdm") && l[1] === "add") args = seg.argv.slice(2);
    else if (["conda", "mamba", "micromamba"].includes(h) && l[1] === "install") {
        args = seg.argv.slice(2);
        manager = "conda";
    } else if (
        ["npm", "pnpm", "yarn", "bun"].includes(h) &&
        /^(?:install|i|add)$/.test(l[1] ?? "")
    ) {
        args = seg.argv.slice(2);
        manager = "npm";
    } else if (
        ["npx", "bunx", "uvx"].includes(h) ||
        (["pnpm", "yarn"].includes(h) && l[1] === "dlx")
    ) {
        const rest = seg.argv.slice(h === "npx" || h === "bunx" || h === "uvx" ? 1 : 2);
        const first = rest.find((a) => !a.startsWith("-"));
        args = first ? [first] : [];
        manager = h === "uvx" ? "pip" : "npm";
    } else if (h === "brew" && l[1] === "install") {
        args = seg.argv.slice(2);
        manager = "brew";
    } else if (["apt", "apt-get", "dnf", "yum", "zypper", "pacman", "apk"].includes(h)) {
        if (!/^(?:install|-s|-syu|-sy|add)$/.test(l[1] ?? "")) return null;
        args = seg.argv.slice(2);
        manager = "system";
    }
    if (args === null) return null;
    const out: Install = {
        manager,
        names: [],
        urlDeps: [],
        indexUrls: [],
        global: false,
        breakSystem: false,
    };
    for (let j = 0; j < args.length; j++) {
        const a = args[j] as string;
        const la = a.toLowerCase();
        if (la === "-g" || la === "--global" || la === "--user") out.global ||= la !== "--user";
        if (la === "--break-system-packages") out.breakSystem = true;
        if (/^(?:-i|--index-url|--extra-index-url)$/.test(la))
            out.indexUrls.push(args[j + 1] ?? "");
        if (/^--(?:extra-)?index-url=/.test(la)) out.indexUrls.push(a.split("=")[1] ?? "");
        if (manager === "pip" && pipValueFlags.test(la)) {
            j++;
            continue;
        }
        if (a.startsWith("-")) continue;
        if (
            /^(?:git\+|https?:\/\/|github:|gitlab:|file:)/i.test(a) ||
            /\.(?:whl|tar\.gz|zip|tgz)$/i.test(a)
        ) {
            out.urlDeps.push(a);
            continue;
        }
        if (a === "." || a.startsWith("./") || a.startsWith("/")) continue;
        const name =
            manager === "npm"
                ? a.startsWith("@")
                    ? a.split("@").slice(0, 2).join("@")
                    : (a.split("@")[0] as string)
                : packageName(a);
        if (name) out.names.push(name);
    }
    return out;
}

const driverPackage =
    /^(?:[\w.+-]*(?:nvidia|cuda|cudnn)[\w.+-]*|linux-headers[\w.-]*|[\w.-]+-dkms|dkms)$/;

function packages(seg: Segment, st: State): void {
    const inst = install(seg);
    if (!inst) return;
    const ctx = st.ctx;
    const names = inst.names;
    const shown = names.slice(0, 3).join(" ");
    if (inst.manager === "system") {
        const drivers = names.filter((n) => driverPackage.test(n.toLowerCase()));
        if (drivers.length > 0) {
            add(
                st,
                hit(
                    "gpu_driver_install",
                    "environment",
                    5,
                    `${seg.head} install ${drivers.slice(0, 2).join(" ")}`,
                    drivers[0],
                ),
            );
        }
        return;
    }
    if (inst.manager === "brew") {
        const ai = names.find((n) =>
            /^(?:ollama|llama\.cpp|whisper-cpp|lm-studio|comfyui)$/i.test(n),
        );
        if (ai) add(st, hit("ai_runtime_install", "local_ai_model", 2, `brew install ${ai}`, ai));
        return;
    }
    let best: { name: string; weight: number } | null = null;
    const groups = new Set<string>();
    const nvidia: string[] = [];
    for (const n of names) {
        const hp = heavyPackage(n);
        if (hp) {
            groups.add(hp.group);
            if (hp.nvidiaOnly) nvidia.push(n);
            if (!best || hp.weight > best.weight) best = { name: n, weight: hp.weight };
        }
    }
    if (best) {
        let w = best.weight + (groups.size >= 2 ? 1 : 0);
        if (
            groups.has("torch") &&
            ctx.os === "linux" &&
            !inst.indexUrls.some((u) => /\/cpu\b/.test(u))
        )
            w += 1;
        add(
            st,
            hit(
                "heavy_ml_install",
                "local_ai_model",
                Math.min(w, 6),
                `${seg.head} install ${shown}`,
                best.name,
            ),
        );
    }
    if (nvidia.length > 0 && (ctx.os === "macos" || ctx.os === "windows")) {
        add(
            st,
            hit("nvidia_only_package", "environment", 2, nvidia.slice(0, 2).join(" "), nvidia[0]),
        );
    }
    if (inst.indexUrls.some((u) => /download\.pytorch\.org\/whl\/cu\d+/i.test(u))) {
        add(st, hit("cuda_wheels", "environment", 1, "pytorch cuda index"));
    }
    for (const n of names) {
        const squat = typosquatOf(n);
        if (squat) {
            add(st, hit("typosquat_package", "untrusted_code", 5, `${n} looks like ${squat}`, n));
            break;
        }
        if (isLurePackage(n)) {
            add(st, hit("lure_package", "untrusted_code", 5, n, n));
            break;
        }
    }
    const dep = inst.urlDeps[0];
    if (dep) {
        const repo = /github|gitlab|bitbucket|codeberg/i.test(dep)
            ? repoOf(dep.replace(/^git\+/, ""))
            : null;
        const w = repo && famousOwners.has(repo.owner) ? 2 : 4;
        add(st, hit("url_dependency", "untrusted_code", w, dep, repo?.short ?? dep));
    }
    const odd = inst.indexUrls.find(
        (u) => u && !/^https:\/\/(?:pypi\.org|download\.pytorch\.org|test\.pypi\.org)/i.test(u),
    );
    if (odd) add(st, hit("foreign_index", "untrusted_code", 3, odd, odd));
    if (inst.manager === "pip" && seg.sudo) {
        const whole = seg.lower.some((a) => a === "-r" || /requirements[\w.-]*\.txt$/.test(a));
        add(st, hit("sudo_pip", "environment", whole ? 4 : 3, "sudo pip install"));
    }
    if (inst.breakSystem)
        add(st, hit("break_system_packages", "environment", 3, "--break-system-packages"));
    if (inst.manager === "npm" && inst.global && seg.sudo)
        add(st, hit("sudo_global_npm", "environment", 1, "sudo npm -g"));
}

// go install, cargo install --git and deno run of code straight from a remote repository
function remoteBuild(seg: Segment, st: State): void {
    const h = seg.head;
    const l = seg.lower;
    let target: string | undefined;
    if (h === "go" && l[1] === "install") {
        target = seg.argv.slice(2).find((a) => /^[\w.-]+\.[a-z]+\/[\w.-]+\/[\w.-]+/.test(a));
    } else if (h === "cargo" && l[1] === "install" && l.includes("--git")) {
        target = seg.argv[l.indexOf("--git") + 1];
    } else if (h === "deno" && l[1] === "run") {
        target = seg.argv.slice(2).find((a) => /^https?:\/\//i.test(a));
    }
    if (!target) return;
    const repo = repoOf(target.split("@")[0] as string);
    if (famousOwners.has(repo.owner) || isMainstream(target)) return;
    add(st, hit("remote_build", "untrusted_code", 4, evidence(seg, 3), repo.short));
}

/* Model weights and AI runtimes */

function modelWeight(id: string): number {
    const s = spaced(id.toLowerCase());
    const size = /(?<![\w.])(\d{1,3}(?:\.\d)?) ?b(?![a-z])/.exec(s);
    if (size && Number(size[1]) >= 13) return 2;
    if (
        /(?<![a-z])(?:minilm|mpnet|bge|e5|gte|bert|distil\w*|tiny\w*|small|mini|nano|embed\w*|t5 small)(?![a-z])/.test(
            s,
        )
    )
        return 0;
    if (
        /(?<![a-z])(?:flux|stable diffusion|sdxl|sd3|wan2|wan|hunyuan\w*|ltx\w*|cogvideo\w*|mochi|whisper large\w*|large v\d|xtts\w*|bark|llama|mistral|mixtral|qwen\w*|deepseek\w*|gemma|phi|falcon|yi|codellama|starcoder\w*)(?![a-z])/.test(
            s,
        )
    )
        return 1;
    if (size && Number(size[1]) >= 7) return 1;
    return 0;
}

function models(seg: Segment, st: State): void {
    const h = seg.head;
    const l = seg.lower;
    if ((h === "huggingface-cli" || h === "hf") && l[1] === "download" && seg.argv[2]) {
        const id = seg.argv[2] as string;
        add(st, hit("model_download", "local_ai_model", 3 + modelWeight(id), `${h} download`, id));
        return;
    }
    if (h === "ollama" && (l[1] === "pull" || l[1] === "run") && seg.argv[2]) {
        const tag = seg.argv[2] as string;
        const size = /(\d{1,3}(?:\.\d)?)b\b/i.exec(tag);
        const w = size ? (Number(size[1]) >= 13 ? 2 : Number(size[1]) <= 4 ? -1 : 0) : 0;
        add(st, hit("model_download", "local_ai_model", 3 + w, `ollama ${l[1]}`, tag));
        return;
    }
    if (
        h === "git-lfs" ||
        (h === "git" && l[1] === "lfs" && /^(?:pull|fetch|clone)$/.test(l[2] ?? ""))
    ) {
        add(st, hit("lfs_pull", "local_ai_model", 2, "git lfs pull", st.clonedRepo ?? undefined));
        return;
    }
    if (fetchers.has(h)) {
        const url = urlArg(seg) ?? "";
        if (
            /huggingface\.co\/[^\s]+\/(?:resolve|blob)\/|civitai\.com\/api\/download|\.(?:safetensors|gguf|ckpt|pth)(?:\?|$)/i.test(
                url,
            )
        ) {
            add(
                st,
                hit(
                    "weights_download",
                    "local_ai_model",
                    4,
                    `${h} ${hostPath(url).slice(0, 40)}`,
                    hostPath(url).split("/").slice(0, 3).join("/"),
                ),
            );
        }
        return;
    }
    const script = scriptOf(seg);
    if (
        script &&
        /download[\s_-]?(?:all[\s_-]?)?(?:models?|weights|checkpoints?|ckpts?)|(?:get|fetch)[\s_-](?:models?|weights)|download[\s_-]ggml[\s_-]model/i.test(
            script,
        )
    ) {
        add(st, hit("model_download_script", "local_ai_model", 4, evidence(seg), script));
        return;
    }
    const id = hubModelArg(seg);
    if (id) add(st, hit("hub_model", "local_ai_model", 3 + modelWeight(id), `--model ${id}`, id));
}

const modelFlag =
    /^--?(?:model|model[-_]name|model[-_]id|model[-_]path|model[-_]name[-_]or[-_]path|pretrained[-_]model[-_]name[-_]or[-_]path|base[-_]model|repo[-_]id|checkpoint)$/;

// Prefixes that name a hosted provider in tools such as litellm, not a Hugging Face repo
const providerPrefix =
    /^(?:openai|anthropic|gemini|azure|azure_ai|bedrock|vertex_ai|groq|together_ai|openrouter|cohere|replicate|fireworks_ai|perplexity|xai|mistral|deepseek|ollama|ollama_chat|huggingface)\//;

// A Hugging Face repo id given to a program that will download its weights
function hubModelArg(seg: Segment): string | null {
    for (let j = 1; j < seg.argv.length; j++) {
        const a = seg.lower[j] as string;
        const eq = /^(--?[\w-]+)=(.+)$/.exec(a);
        const flag = eq ? eq[1] : a;
        if (!modelFlag.test(flag as string)) continue;
        const raw = eq ? (seg.argv[j] as string).split("=").slice(1).join("=") : seg.argv[j + 1];
        if (
            raw &&
            /^[\w.-]+\/[\w.-]+$/.test(raw) &&
            !raw.startsWith(".") &&
            !providerPrefix.test(raw.toLowerCase()) &&
            !/\.(?:gguf|bin|safetensors|pt|pth|onnx|ckpt|json|ya?ml)$/i.test(raw)
        ) {
            return raw;
        }
    }
    return null;
}

// The file a simple command executes, such as train.py in python3 train.py or ./run.sh
function scriptOf(seg: Segment): string | null {
    const h = seg.head;
    const prog = seg.argv[0] ?? "";
    if (/^(?:python[\d.]*|py|node|deno|bun|ruby|perl|php|bash|sh|zsh|tsx|ts-node)$/.test(h)) {
        const runIdx = h === "deno" || h === "bun" ? (seg.lower[1] === "run" ? 2 : 1) : 1;
        const a = seg.argv.slice(runIdx).find((x) => !x.startsWith("-"));
        return a ?? null;
    }
    if (/^\.\.?\/|^\//.test(prog) || /\.(?:sh|py|exe|bat|cmd|ps1|appimage|run|bin)$/i.test(prog))
        return prog;
    return null;
}

function argNumber(seg: Segment, names: RegExp): number | null {
    for (let j = 0; j < seg.lower.length; j++) {
        const a = seg.lower[j] as string;
        const eq = /^-{0,2}([\w-]+)=(\d+)$/.exec(a);
        if (eq && names.test(eq[1] as string)) return Number(eq[2]);
        if (
            /^--?[\w-]+$/.test(a) &&
            names.test(a.replace(/^-+/, "")) &&
            /^\d+$/.test(seg.lower[j + 1] ?? "")
        ) {
            return Number(seg.lower[j + 1]);
        }
    }
    return null;
}

const aiModule =
    /^(?:mlx_lm|mlx_vlm|mlx_whisper|piper|kokoro|whisper|whisperx|faster_whisper|tts|f5_tts|bark|axolotl|llama_cpp|vllm|sglang|audiocraft|demucs|comfy|fooocus|invokeai|torch\.distributed|deepspeed|unsloth)(?:\.|$)/;

// Script names of well-known local AI apps, curated so API client scripts do not match
const aiAppScript =
    /(?<![a-z])(?:txt2img|img2img|txt2vid|img2vid|facefusion|sadtalker|wav2lip|liveportrait|animatediff|sample video|infer rvc|rvc infer|gpt sovits|so vits|tortoise tts|deep live cam|roop|run swap)(?![a-z])/;

function aiRuns(seg: Segment, st: State): void {
    const h = seg.head;
    const l = seg.lower;
    const script = (scriptOf(seg) ?? "").toLowerCase();
    if (
        /^(?:whisper|whisperx|faster-whisper|whisper-ctranslate2|insanely-fast-whisper|whisper-cli)$/.test(
            h,
        )
    ) {
        const media = l.filter((a) => /\.(?:mp3|wav|m4a|mp4|mkv|flac|ogg|webm|opus|mov)$/.test(a));
        if (media.length === 0) return;
        let w = 3;
        if (l.some((a) => /(?:^|[/_-])(?:large|medium|turbo)/.test(a))) w += 1;
        if (media.length > 1 || media.some((a) => a.includes("*"))) w += 1;
        add(st, hit("speech_model_run", "local_ai_model", w, evidence(seg, 3), h));
        return;
    }
    if (h === "tts" && l.some((a) => /^--(?:text|model_name|list_models)/.test(a))) {
        const model = l[l.indexOf("--model_name") + 1] ?? "";
        add(
            st,
            hit(
                "tts_model_run",
                "local_ai_model",
                /xtts|bark|tortoise/.test(model) ? 4 : 3,
                "tts --text",
                model.split("/").pop() || "Coqui TTS",
            ),
        );
        return;
    }
    if ((h === "accelerate" && l[1] === "launch") || h === "torchrun" || h === "deepspeed") {
        const target = seg.argv.find((a, j) => j > 0 && /\.py$/.test(a)) ?? h;
        add(st, hit("training_launch", "local_ai_model", 4, evidence(seg, 3), target));
        return;
    }
    if (h === "yolo" && /^(?:train|detect|predict|val)$/.test(l[1] ?? "")) {
        const ep = argNumber(seg, /^epochs$/) ?? 0;
        add(
            st,
            hit(
                "vision_model_run",
                ep >= 20 ? "heavy_compute" : "local_ai_model",
                l[1] === "train" ? 4 : 3,
                evidence(seg, 2),
                "yolo",
            ),
        );
        return;
    }
    if (
        (h === "vllm" && l[1] === "serve") ||
        h === "text-generation-launcher" ||
        /^llama-(?:server|cli|run)$/.test(h) ||
        (h === "comfy" && /^(?:install|launch)$/.test(l[1] ?? ""))
    ) {
        add(st, hit("model_server", "local_ai_model", 4, evidence(seg, 3), seg.argv[2] ?? h));
        return;
    }
    const module = /^python[\d.]*$/.test(h) && l[1] === "-m" ? (l[2] ?? "") : "";
    if (aiModule.test(module)) {
        add(st, hit("ai_module", "local_ai_model", 4, evidence(seg, 3), module));
        return;
    }
    if (
        (h === "tune" && l[1] === "run") ||
        (h === "axolotl" && /^(?:train|preprocess|inference)$/.test(l[1] ?? "")) ||
        (h === "autotrain" && l[1] !== undefined && l[1] !== "--help") ||
        /^f5-tts_infer-(?:cli|gradio)$/.test(h) ||
        /\.llamafile$/.test(h)
    ) {
        add(st, hit("model_run", "local_ai_model", 4, evidence(seg, 3), h));
        return;
    }
    if (!script) return;
    const name = spaced(script.split("/").pop() ?? script);
    if (aiAppScript.test(name)) {
        add(st, hit("ai_script", "local_ai_model", 4, evidence(seg, 2), script));
        return;
    }
    const webui = /(?<![a-z])webui(?![a-z])/.test(name);
    const launcher = /(?<![a-z])(?:launch|entry with update)(?![a-z])/.test(name);
    if ((webui || launcher) && /\.(?:py|sh|bat)$/.test(script)) {
        const gpuFlags = l.some((a) =>
            /^--(?:xformers|medvram|lowvram|no-half\S*|opt-sdp-attention|precision)$/.test(a),
        );
        const w = (webui ? 4 : 3) + (gpuFlags ? 1 : 0);
        add(st, hit("ai_webui", "local_ai_model", w, evidence(seg, 2), script));
        return;
    }
    if (
        /(?<![a-z])generate(?![a-z])/.test(name) &&
        l.some((a, j) => a === "--task" && /^(?:t2v|i2v|ti2v|s2v|t2i)/.test(l[j + 1] ?? ""))
    ) {
        add(st, hit("video_model_run", "local_ai_model", 4, evidence(seg, 4), script));
        return;
    }
    if (/(?<![a-z])(?:train|finetune|fine tune|dreambooth)/.test(name)) {
        const epochs = argNumber(seg, /^(?:epochs?|num[-_]train[-_]epochs|n[-_]epochs)$/) ?? 0;
        const steps =
            argNumber(seg, /^(?:max[-_]train[-_]steps|max[-_]steps|steps|iters|iterations)$/) ?? 0;
        if (/dreambooth|lora|sdxl|text to image|network/.test(name)) {
            add(st, hit("diffusion_training", "local_ai_model", 4, evidence(seg, 2), script));
        } else if (epochs >= 20 || steps >= 1000) {
            add(
                st,
                hit(
                    "long_training",
                    "heavy_compute",
                    4,
                    `${script} ${epochs >= 20 ? `${epochs} epochs` : `${steps} steps`}`,
                    script,
                ),
            );
        }
    }
}

/* Containers, drivers, kernels and disks */

function containers(seg: Segment, st: State): void {
    const h = seg.head;
    const l = seg.lower;
    if (h === "nvidia-docker") {
        add(st, hit("gpu_container", "environment", 4, "nvidia-docker"));
        return;
    }
    if (!(["docker", "podman", "nerdctl"].includes(h) && (l[1] === "run" || l[1] === "create")))
        return;
    const image =
        seg.argv
            .slice(2)
            .filter(
                (a, j, arr) =>
                    !a.startsWith("-") &&
                    !/^-[pveiw]$|^--(?:name|env|volume|publish|workdir|network|platform|gpus|runtime|entrypoint|user|mount)$/.test(
                        arr[j - 1] ?? "",
                    ),
            )
            .shift() ?? "";
    const joined = l.join(" ");
    if (/--gpus(?:[= ]|$)|--runtime[= ]nvidia|--device[= ]nvidia/.test(joined)) {
        add(st, hit("gpu_container", "environment", 4, "docker run --gpus", image || undefined));
        if (image && find(L.aiName, spaced(image.toLowerCase()))) {
            add(st, hit("ai_image", "local_ai_model", 1, image));
        }
    }
    let risky = 0;
    if (l.includes("--privileged")) risky += 4;
    if (
        l.some(
            (a, j) =>
                (l[j - 1] === "-v" || l[j - 1] === "--volume") &&
                /^\/(?::|$)|^\/var\/run\/docker\.sock/.test(a),
        ) ||
        /-v[= ]\/:\//.test(joined)
    ) {
        risky += 3;
    }
    if (/--pid[= ]host|--cap-add[= ](?:sys_admin|all)/.test(joined)) risky += 2;
    if (risky > 0) {
        add(
            st,
            hit(
                "host_access_container",
                "untrusted_code",
                Math.min(risky, 5),
                "docker run with host access",
                image || undefined,
            ),
        );
    }
    if (st.ctx.os === "macos" && /--platform[= ]linux\/amd64/.test(joined)) {
        add(st, hit("x86_emulation", "environment", 2, "--platform linux/amd64"));
    }
}

function drivers(seg: Segment, st: State): void {
    const h = seg.head;
    const l = seg.lower;
    if (h === "ubuntu-drivers" && /^(?:autoinstall|install)$/.test(l[1] ?? "")) {
        add(st, hit("gpu_driver_install", "environment", 5, "ubuntu-drivers"));
    } else if (
        /^(?:cuda_[\w.-]+|nvidia-linux-[\w.-]+)\.run$/.test(h) ||
        ((h === "sh" || h === "bash") &&
            /cuda_[\w.-]+\.run|nvidia-linux-[\w.-]+\.run/.test(l[1] ?? ""))
    ) {
        add(st, hit("gpu_driver_install", "environment", 5, evidence(seg, 2)));
    } else if (
        ["modprobe", "insmod", "rmmod", "kextload", "kmutil"].includes(h) ||
        (h === "dkms" && /^(?:install|add|build)$/.test(l[1] ?? ""))
    ) {
        add(st, hit("kernel_module", "environment", 4, evidence(seg, 2), l[1]));
    } else if (
        ["conda", "mamba"].includes(h) &&
        l[1] === "install" &&
        l.some((a) => /^(?:cudatoolkit|cuda|cuda-toolkit|pytorch-cuda)(?:=|$)/.test(a))
    ) {
        add(st, hit("cuda_toolkit_install", "environment", 3, "conda install cuda"));
    }
}

function kernel(seg: Segment, st: State): void {
    const h = seg.head;
    const l = seg.lower;
    const joined = l.join(" ");
    if (
        [
            "grubby",
            "update-grub",
            "grub-mkconfig",
            "grub2-mkconfig",
            "grub-install",
            "efibootmgr",
            "bcdedit",
            "kernelstub",
        ].includes(h)
    ) {
        add(st, hit("boot_config", "risky_experiment", 5, evidence(seg, 3), h));
    } else if (h === "sysctl" && (l.includes("-w") || l.some((a) => /^[\w.]+=\S+$/.test(a)))) {
        add(st, hit("kernel_tuning", "risky_experiment", 3, evidence(seg, 3)));
    } else if (h === "csrutil" && l[1] === "disable") {
        add(st, hit("sip_disable", "risky_experiment", 5, "csrutil disable"));
    }
    if (/mitigations=off/.test(joined))
        add(st, hit("mitigations_off", "risky_experiment", 1, "mitigations=off"));
    const targets = [
        ...seg.redirects,
        ...(h === "tee" ? seg.argv.slice(1).filter((a) => !a.startsWith("-")) : []),
    ];
    const persisted = targets.find((t) => /^\/etc\/(?:sysctl|default\/grub|modprobe)/.test(t));
    const runtime = targets.find((t) => /^\/(?:proc\/sys|sys)\//.test(t));
    if (persisted || runtime) {
        add(
            st,
            hit(
                "kernel_tuning",
                "risky_experiment",
                persisted ? 4 : 3,
                `> ${persisted ?? runtime}`,
            ),
        );
    }
    if (
        l.some(
            (a) =>
                a.includes("/lib/modules/") || a === "modules_install" || a.startsWith("m=$(pwd"),
        )
    ) {
        add(st, hit("kernel_module", "environment", 4, evidence(seg, 3)));
    }
}

const systemPath =
    /^(?:\/|\/\*|~|~\/|~\/\*|\$home|\$\{home\}|\/usr|\/etc|\/bin|\/sbin|\/var|\/boot|\/lib|\/lib64|\/opt|\/system|\/users|\/home|c:\\?)\/?$/;

function destructive(seg: Segment, st: State): void {
    const h = seg.head;
    const l = seg.lower;
    const device = (a: string) =>
        /^\/dev\/(?!null|zero|random|urandom|stdout|stderr|tty|fd)/.test(a);
    if (h === "dd" && l.some((a) => a.startsWith("of=") && device(a.slice(3)))) {
        add(
            st,
            hit(
                "disk_write",
                "risky_experiment",
                5,
                evidence(seg, 4),
                l.find((a) => a.startsWith("of="))?.slice(3),
            ),
        );
    } else if (
        /^mkfs/.test(h) ||
        h === "wipefs" ||
        (["fdisk", "sfdisk", "gdisk", "sgdisk", "parted"].includes(h) &&
            !l.includes("-l") &&
            l.some(device))
    ) {
        add(st, hit("disk_format", "risky_experiment", 5, evidence(seg, 3)));
    } else if (h === "shred" && l.some(device)) {
        add(st, hit("disk_wipe", "risky_experiment", 5, evidence(seg, 3)));
    } else if (
        h === "diskutil" &&
        /^(?:erasedisk|erasevolume|zerodisk|secureerase|partitiondisk|reformat)$/.test(l[1] ?? "")
    ) {
        add(st, hit("disk_format", "risky_experiment", 5, evidence(seg, 3)));
    } else if (
        h === "rm" &&
        l.some((a) => /^-[a-z]*r/.test(a) || a === "--recursive") &&
        l.slice(1).some((a) => !a.startsWith("-") && systemPath.test(a))
    ) {
        add(st, hit("delete_system", "risky_experiment", 5, evidence(seg, 4)));
    } else if (
        (h === "chmod" || h === "chown") &&
        l.includes("-r") &&
        l.some((a) => a === "/" || a === "/usr" || a === "/etc")
    ) {
        add(st, hit("system_permissions", "risky_experiment", 4, evidence(seg, 4)));
    } else if (h === "kill" && l.includes("-9") && l.includes("-1")) {
        add(st, hit("kill_all", "risky_experiment", 4, "kill -9 -1"));
    } else if (h === "format" && /^[c-z]:$/.test(l[1] ?? "")) {
        add(st, hit("disk_format", "risky_experiment", 5, evidence(seg, 2)));
    }
    if (seg.redirects.some((t) => /^\/dev\/(?:sd[a-z]|nvme\d|disk\d|hd[a-z]|mmcblk\d)/.test(t))) {
        add(st, hit("disk_write", "risky_experiment", 5, `> ${seg.redirects[0]}`));
    }
    if (seg.redirects.some((t) => t === "/proc/sysrq-trigger")) {
        add(st, hit("kernel_crash", "risky_experiment", 5, "> /proc/sysrq-trigger"));
    }
}

/* Load, stress and long jobs */

function duration(v: string): number {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(v);
    if (!m) return 0;
    const n = Number(m[1]);
    return n * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? "s"] ?? 1);
}

function load(seg: Segment, st: State): void {
    const h = seg.head;
    const l = seg.lower;
    if (
        ["stress", "stress-ng", "memtester", "s-tui", "y-cruncher", "prime95", "mprime"].includes(h)
    ) {
        add(st, hit("stress_tool", "heavy_compute", 4, evidence(seg, 3), h));
        return;
    }
    if (h === "sysbench") {
        add(st, hit("stress_tool", "heavy_compute", 3, evidence(seg, 3), h));
        return;
    }
    const tools = [
        "wrk",
        "wrk2",
        "ab",
        "hey",
        "oha",
        "bombardier",
        "vegeta",
        "siege",
        "k6",
        "locust",
        "artillery",
        "jmeter",
        "autocannon",
        "loadtest",
        "drill",
        "gatling",
    ];
    if (!tools.includes(h)) return;
    const target = seg.argv.find((a) => /^https?:\/\//i.test(a));
    if (target && isLocal(target)) return;
    let w = 3;
    let secs = 0;
    for (let j = 1; j < l.length; j++) {
        const a = l[j] as string;
        const flag = /^(?:-d|--duration|-t|--time|-z|--run-time|-duration)$/.test(a)
            ? l[j + 1]
            : /^(?:-d|--?duration=|-z|--run-time=)(\d.*)$/.exec(a)?.[1];
        if (flag) secs = Math.max(secs, duration(flag));
    }
    const conns = argNumber(seg, /^(?:c|connections|concurrency|u|users|vus|rate)$/) ?? 0;
    if (secs >= 300) w += 1;
    if (conns >= 500) w += 1;
    add(
        st,
        hit(
            "load_test",
            "heavy_compute",
            w,
            evidence(seg, 4),
            target ? hostPath(target).split("/")[0] : h,
        ),
    );
}

function longJobs(seg: Segment, segs: Segment[], st: State): void {
    const h = seg.head;
    const l = seg.lower;
    const joined = l.join(" ");
    if (h === "bazel" && l[1] === "build" && /\/\/\.\.\./.test(joined)) {
        add(st, hit("long_build", "heavy_compute", 3, "bazel build //..."));
    } else if (h === "docker" && l[1] === "buildx" && /--platform[= ]\S+,\S+/.test(joined)) {
        add(st, hit("long_build", "heavy_compute", 2, "docker buildx multi-platform"));
    } else if (
        h === "ffmpeg" &&
        /libx265|libaom|libsvtav1|-preset (?:slow|slower|veryslow)/.test(joined)
    ) {
        const loop = segs.some((s) => s.head === "for" || s.head === "while");
        const slowest = /-preset (?:veryslow|placebo)|-cpu-used [01]\b/.test(joined);
        add(st, hit("video_encode", "heavy_compute", loop || slowest ? 4 : 3, evidence(seg, 3)));
    } else if (h === "blender" && (l.includes("-b") || l.includes("--background"))) {
        const animation = l.includes("-a") || l.includes("--render-anim");
        add(st, hit("render", "heavy_compute", animation ? 4 : 3, "blender -b"));
    } else if ((h === "gmx" && l[1] === "mdrun") || h === "hashcat" || h === "john") {
        add(st, hit("long_compute", "heavy_compute", 3, evidence(seg, 2), h));
    } else if (/^python[\d.]*$/.test(h)) {
        const epochs = argNumber(seg, /^(?:epochs?|num[-_]train[-_]epochs|n[-_]epochs)$/) ?? 0;
        if (epochs >= 20 && !st.hits.some((x) => x.id === "long_training")) {
            add(
                st,
                hit(
                    "long_training",
                    "heavy_compute",
                    4,
                    `--epochs ${epochs}`,
                    scriptOf(seg) ?? undefined,
                ),
            );
        }
    }
}

/* Lures, exploits and quarantine removal */

const lureName =
    /(?<![a-z])(?:airdrop|drainer|aimbot|wallhack|cheat|cheats|injector|crack|cracked|keygen|stealer|grabber|sniper|mev|activator|spoofer|nitro gen|token grab\w*|seed finder|wallet recover\w*|unlocker)(?![a-z])/;
const pocName =
    /(?<![a-z])(?:poc|exploit|exploits|sploit|cve \d{4} \d+|lpe|privesc|rce|0day|pwn|rootkit)(?![a-z])/;
const walletSecret =
    /\.config\/solana\/[\w.-]+\.json|(?:^|\/)(?:keystore|keypairs?)(?:\/|\.json|$)|wallet\.dat|\.(?:ethereum|bitcoin|electrum)\/|^--(?:private[-_]?key|mnemonic|seed(?:[-_]phrase)?|keypair|wallet(?:[-_]?(?:file|path|key))?)(?:=|$)/;

const disguised =
    /\.(?:pdf|docx?|xlsx?|jpe?g|png|mp4|mp3|txt)\.(?:exe|scr|bat|cmd|js|vbs|lnk|com|pif|app)$/i;

// Checked before read-only programs are skipped, since even open on a .pdf.exe runs it
function disguisedFile(seg: Segment, st: State): void {
    const fake = seg.argv.find((a) => disguised.test(a));
    if (fake) add(st, hit("disguised_file", "untrusted_code", 5, fake, fake));
}

function lures(seg: Segment, st: State): void {
    const script = scriptOf(seg);
    const h = seg.head;

    if (script) {
        const name = spaced((script.split(/[\\/]/).pop() ?? script).toLowerCase());
        if (lureName.test(name))
            add(st, hit("lure_script", "untrusted_code", 4, evidence(seg, 2), script));
        else if (pocName.test(name))
            add(st, hit("exploit_run", "untrusted_code", 5, evidence(seg, 2), script));
        if (/\.(?:exe|msi|bat|scr|cmd)$/i.test(script) && !/^(?:python|node)/.test(h)) {
            add(st, hit("windows_binary", "untrusted_code", 3, script, script));
        }
    }
    if (["gcc", "g++", "cc", "clang", "clang++", "tcc"].includes(h)) {
        const files = seg.lower.slice(1).filter((a) => !a.startsWith("-"));
        const named = files.find((a) => pocName.test(spaced(a.split("/").pop() ?? a)));
        if (named) add(st, hit("exploit_build", "untrusted_code", 4, evidence(seg, 4), named));
    }
    if (h === "wine" && /\.(?:exe|msi)$/i.test(seg.argv[1] ?? "")) {
        add(st, hit("windows_binary", "untrusted_code", 3, evidence(seg, 2), seg.argv[1]));
    }
    if (seg.lower.slice(1).some((a) => walletSecret.test(a))) {
        add(st, hit("wallet_secret", "untrusted_code", 2, "wallet key passed to a script"));
    }
}

function quarantine(seg: Segment, st: State): void {
    const h = seg.head;
    const l = seg.lower;
    const joined = l.join(" ");
    if (
        h === "xattr" &&
        (l.includes("com.apple.quarantine") || l.some((a) => /^-[a-z]*[cd][a-z]*$/.test(a)))
    ) {
        add(
            st,
            hit(
                "quarantine_removal",
                "untrusted_code",
                5,
                evidence(seg, 3),
                seg.argv[seg.argv.length - 1],
            ),
        );
    } else if (h === "spctl" && /--master-disable|--global-disable|--add/.test(joined)) {
        add(st, hit("gatekeeper_off", "untrusted_code", 5, evidence(seg, 2)));
    } else if (/^(?:set|add)-mppreference$/.test(h) && /-disable|-exclusion/.test(joined)) {
        add(st, hit("defender_off", "untrusted_code", 5, evidence(seg, 2)));
    } else if ((h === "7z" || h === "7za") && l[1] === "x" && l.some((a) => /^-p\S/.test(a))) {
        add(st, hit("password_archive", "untrusted_code", 4, "7z x -p"));
    } else if (
        (h === "unzip" && l.includes("-p")) ||
        (h === "unrar" && l.some((a) => /^-p\S/.test(a)))
    ) {
        add(st, hit("password_archive", "untrusted_code", 4, `${h} with a password`));
    }
}

// PowerShell that downloads a script and runs it with iex, in either order on one line
function downloadCradle(raw: string): string | null {
    for (const line of raw.split("\n")) {
        if (!/\b(?:iex|invoke-expression)\b|\[scriptblock\]::create/i.test(line)) continue;
        if (!/downloadstring|\b(?:iwr|irm)\b|invoke-webrequest|invoke-restmethod/i.test(line))
            continue;
        const url = /https?:\/\/[^\s'")]+/i.exec(line);
        if (url) return url[0];
    }
    return null;
}

/* Never offered */

const abuseHeads = new Set([
    "xmrig",
    "cpuminer",
    "minerd",
    "nbminer",
    "t-rex",
    "lolminer",
    "phoenixminer",
    "ethminer",
    "xmr-stak",
    "srbminer",
    "masscan",
    "zmap",
    "slowloris",
    "loic",
    "hoic",
    "thc-ssl-dos",
]);
const scanHeads = new Set([
    "nmap",
    "arp-scan",
    "netdiscover",
    "rustscan",
    "fping",
    "angryip",
    "nbtscan",
]);

// The text check runs only when something would be offered, so plain commands stay cheap
function policy(segs: Segment[], text: string | null): Hit | null {
    for (const seg of segs) {
        if (abuseHeads.has(seg.head)) return hit("abuse", null, -10, seg.head);
        if (
            seg.head === "hping3" &&
            seg.lower.some((a) => a === "--flood" || /^-i$|^u\d+$/.test(a))
        ) {
            return hit("abuse", null, -10, "hping3 --flood");
        }
        if (
            ["hydra", "medusa", "ncrack", "patator"].includes(seg.head) &&
            seg.lower.some((a) => /^-[pPlLC]$/.test(a))
        ) {
            return hit("abuse", null, -10, `${seg.head} password guessing`);
        }
        if (scanHeads.has(seg.head)) {
            const targets = seg.lower.slice(1).filter((a) => !a.startsWith("-"));
            if (targets.some((t) => /^0\.0\.0\.0\/0$|\/(?:[0-9]|1[0-5])$/.test(t))) {
                return hit("abuse", null, -10, `${seg.head} of a wide range`);
            }
            if (
                targets.length === 0 ||
                targets.some(
                    (t) =>
                        L.privateTarget.test(t) ||
                        /^(?:192\.168|10|172\.(?:1[6-9]|2\d|3[01]))\./.test(t),
                )
            ) {
                return hit("lan_scan", null, -10, `${seg.head} of a local network`);
            }
        }
    }
    const m = text === null ? null : find(L.abuse, text);
    return m ? hit("abuse", null, -10, m[0]) : null;
}

export function classifyCommand(command: string, ctx: SessionContext = {}): Classification {
    const raw = ascii(clip(command)).trim();
    if (raw === "") return none;
    const segs = parse(raw);
    const st: State = {
        ctx,
        hits: [],
        cloned: false,
        clonedRepo: null,
        clonedFamous: false,
        ranClonedCode: false,
        downloads: new Set(),
    };
    const cradle = downloadCradle(raw);
    if (cradle && !isMainstream(cradle)) {
        add(st, hit("pipe_to_shell", "untrusted_code", 6, "iex download", hostPath(cradle)));
    }
    if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(raw)) {
        add(st, hit("fork_bomb", "risky_experiment", 5, ":(){ :|:& };:"));
    }
    for (let i = 0; i < segs.length; i++) {
        const seg = segs[i] as Segment;
        destructive(seg, st);
        kernel(seg, st);
        disguisedFile(seg, st);
        if (readOnly.has(seg.head)) continue;
        remoteExec(segs, i, st);
        decodedExec(segs, i, st);
        inlineCode(seg, st);
        policyBypass(seg, st);
        downloadThenRun(seg, st);
        gitClone(seg, st);
        clonedCode(seg, st);
        packages(seg, st);
        remoteBuild(seg, st);
        models(seg, st);
        aiRuns(seg, st);
        containers(seg, st);
        drivers(seg, st);
        load(seg, st);
        longJobs(seg, segs, st);
        lures(seg, st);
        quarantine(seg, st);
    }
    const sudoInstall = segs.find(
        (s) =>
            s.sudo &&
            ((s.head === "make" && s.lower[1] === "install") ||
                (/^python[\d.]*$/.test(s.head) &&
                    s.lower[1] === "setup.py" &&
                    s.lower[2] === "install")),
    );
    if (sudoInstall) {
        add(st, hit("system_wide_install", "environment", 4, evidence(sudoInstall, 3)));
    } else if (
        segs.some((s) => s.sudo && /^\.\/(?:install|setup)[\w-]*\.sh$/.test(s.argv[0] ?? ""))
    ) {
        add(st, hit("sudo_install_script", "environment", 2, "sudo ./install.sh"));
    }
    const stop = policy(segs, st.hits.some((h) => h.weight > 0) ? norm(raw) : null);
    if (stop) return refuse(st.hits, stop);
    return finish(st.hits);
}
