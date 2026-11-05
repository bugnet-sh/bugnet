/**
 * A light POSIX-ish shell parser, enough to read the commands coding agents run.
 *
 * It splits on the list and pipe operators and on newlines outside quotes, keeps $( ) and <( ) as
 * words and parses their contents too, unwraps sh -c strings and heredocs or echoed text fed to a
 * shell, records > targets and stdin text, and strips leading sudo, env assignments and wrappers
 * such as time or nohup. It never evaluates anything.
 */

export interface Segment {
    // Words after the stripped prefixes, quotes removed
    argv: string[];
    // The same words lowercased
    lower: string[];
    // Basename of the program, lowercased, without .exe
    head: string;
    sudo: boolean;
    redirects: string[];
    pipedFrom: boolean;
    pipesTo: boolean;
    // Head of the command this segment was nested in, and whether it came from $( ) or sh -c
    parent: string | null;
    via: "subst" | "string" | null;
    // Heredoc or here-string text given to the command on stdin
    stdin: string | null;
}

interface Raw {
    words: string[];
    redirects: string[];
    pipedFrom: boolean;
    pipesTo: boolean;
    stdin: string | null;
}

const maxDepth = 3;
const shellNames = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const plainPrefixes = new Set([
    "time",
    "nohup",
    "exec",
    "command",
    "builtin",
    "noglob",
    "then",
    "do",
    "else",
    "{",
    "}",
    "!",
    "caffeinate",
    "unbuffer",
    "stdbuf",
    "nice",
    "ionice",
    "chronic",
]);
const sudoValueFlags = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);

// Where a heredoc's closing line starts and the newline after it, scanning each line once
function heredocEnd(cmd: string, from: number, delim: string): { close: number; end: number } {
    let at = from;
    while (at < cmd.length) {
        const nl = cmd.indexOf("\n", at);
        const end = nl === -1 ? cmd.length : nl;
        if (cmd.slice(at, end).trim() === delim) return { close: at, end };
        at = end + 1;
    }
    return { close: cmd.length, end: cmd.length };
}

function split(cmd: string): Raw[] {
    const out: Raw[] = [];
    let words: string[] = [];
    let redirects: string[] = [];
    let word = "";
    let inWord = false;
    let quote: string | null = null;
    let depth = 0;
    let subQuote: string | null = null;
    let target: "out" | "in" | "here" | null = null;
    let pipedFrom = false;
    let heredoc: string | null = null;
    let heredocOwner = -1;
    let stdin: string | null = null;

    const endWord = () => {
        if (inWord) {
            if (target === "out") redirects.push(word);
            else if (target === "here") stdin = word;
            else if (target === null) words.push(word);
            target = null;
        }
        word = "";
        inWord = false;
    };
    const endSeg = (pipe: boolean) => {
        endWord();
        if (words.length > 0 || redirects.length > 0) {
            out.push({ words, redirects, pipedFrom, pipesTo: pipe, stdin });
            pipedFrom = pipe;
        } else if (!pipe) {
            pipedFrom = false;
        }
        words = [];
        redirects = [];
        stdin = null;
    };

    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i] as string;
        const next = cmd[i + 1] ?? "";
        if (quote === "'") {
            if (c === "'") quote = null;
            else word += c;
            continue;
        }
        if (quote === '"') {
            if (c === '"') quote = null;
            else if (c === "\\" && '"\\$`'.includes(next)) {
                word += next;
                i++;
            } else word += c;
            continue;
        }
        if (depth > 0) {
            word += c;
            if (subQuote) {
                if (c === subQuote) subQuote = null;
            } else if (c === "'" || c === '"') subQuote = c;
            else if (c === "(") depth++;
            else if (c === ")") depth--;
            continue;
        }
        if (c === "\\") {
            if (next === "\n") i++;
            else if (/[\w.-]/.test(next)) {
                // Windows paths such as .\install.ps1 keep their backslash
                word += c;
                inWord = true;
            } else {
                word += next;
                inWord = true;
                i++;
            }
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            inWord = true;
            continue;
        }
        if ((c === "$" || c === "<" || c === ">") && next === "(") {
            word += `${c}(`;
            inWord = true;
            depth = 1;
            i++;
            continue;
        }
        if (c === "`") {
            const close = cmd.indexOf("`", i + 1);
            const end = close === -1 ? cmd.length : close;
            word += `$(${cmd.slice(i + 1, end)})`;
            inWord = true;
            i = end;
            continue;
        }
        if (c === " " || c === "\t" || c === "\r") {
            endWord();
            continue;
        }
        if (c === "\n") {
            endSeg(false);
            if (heredoc !== null) {
                const { close, end } = heredocEnd(cmd, i + 1, heredoc);
                const owner = out[heredocOwner];
                if (owner) owner.stdin = cmd.slice(i + 1, close);
                i = end - 1;
                heredoc = null;
            }
            continue;
        }
        if (c === "#" && !inWord) {
            const nl = cmd.indexOf("\n", i);
            i = (nl === -1 ? cmd.length : nl) - 1;
            continue;
        }
        if (c === "(" && inWord) {
            word += c;
            continue;
        }
        if (c === ";" || c === "(" || c === ")") {
            endSeg(false);
            continue;
        }
        if (c === "&") {
            if (next === ">") {
                endWord();
                target = "out";
                i += cmd[i + 2] === ">" ? 2 : 1;
                continue;
            }
            if (next === "&") i++;
            endSeg(false);
            continue;
        }
        if (c === "|") {
            if (next === "|") {
                i++;
                endSeg(false);
            } else {
                if (next === "&") i++;
                endSeg(true);
            }
            continue;
        }
        if (c === ">" || c === "<") {
            if (/^\d+$/.test(word)) {
                word = "";
                inWord = false;
            }
            endWord();
            if (c === "<" && next === "<" && cmd[i + 2] === "<") {
                target = "here";
                i += 2;
                continue;
            }
            if (c === "<" && next === "<") {
                let j = i + 2;
                if (cmd[j] === "-") j++;
                const m = /^[ \t]*(['"]?)([\w.-]{1,64})\1/.exec(cmd.slice(j, j + 80));
                if (m) {
                    heredoc = m[2] as string;
                    heredocOwner = out.length;
                    i = j + m[0].length - 1;
                } else i = j - 1;
                continue;
            }
            if (c === ">" && (next === ">" || next === "|")) i++;
            if (c === ">" && cmd[i + 1] === "&") {
                i++;
                if (/\d|-/.test(cmd[i + 1] ?? "")) {
                    i++;
                    continue;
                }
            }
            target = c === ">" ? "out" : "in";
            continue;
        }
        word += c;
        inWord = true;
    }
    endSeg(false);
    return out;
}

function basename(p: string): string {
    const b = p.split(/[\\/]/).pop() ?? p;
    return b.toLowerCase().replace(/\.exe$/, "");
}

function strip(words: string[]): { rest: string[]; sudo: boolean } {
    let i = 0;
    let sudo = false;
    while (i < words.length) {
        const w = words[i] as string;
        const lw = w.toLowerCase();
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
            i++;
        } else if (lw === "sudo" || lw === "doas" || lw === "run0" || lw === "pkexec") {
            sudo = true;
            i++;
            while (i < words.length && (words[i] as string).startsWith("-")) {
                i += sudoValueFlags.has(words[i] as string) ? 2 : 1;
            }
        } else if (lw === "env") {
            i++;
            while (i < words.length && /^(?:-|[A-Za-z_][A-Za-z0-9_]*=)/.test(words[i] as string)) {
                i += ["-u", "-C", "-S"].includes(words[i] as string) ? 2 : 1;
            }
        } else if (lw === "timeout" || lw === "xargs" || lw === "watch") {
            i++;
            while (i < words.length && (words[i] as string).startsWith("-")) {
                i += /^-(?:[nIPsdkL]|-signal|-kill-after|-interval)$/.test(words[i] as string)
                    ? 2
                    : 1;
            }
            if (lw === "timeout" && i < words.length) i++;
        } else if (plainPrefixes.has(lw)) {
            i++;
            while (i < words.length && /^-/.test(words[i] as string)) {
                i += /^-[nc]$/.test(words[i] as string) ? 2 : 1;
            }
        } else break;
    }
    return { rest: words.slice(i), sudo };
}

interface Nested {
    text: string;
    via: "subst" | "string";
}

// Commands inside $( ), <( ) or backticks, and the string given to sh -c
function nested(argv: string[], head: string): Nested[] {
    const inner: Nested[] = [];
    for (const w of argv) {
        let at = w.search(/[$<>]\(/);
        while (at !== -1) {
            let d = 0;
            let end = at + 1;
            for (; end < w.length; end++) {
                if (w[end] === "(") d++;
                else if (w[end] === ")" && --d === 0) break;
            }
            inner.push({ text: w.slice(at + 2, end), via: "subst" });
            const rest = w.slice(end + 1).search(/[$<>]\(/);
            at = rest === -1 ? -1 : end + 1 + rest;
        }
    }
    const lowered = argv.map((a) => a.toLowerCase());
    const runsString =
        shellNames.has(head) ||
        head === "powershell" ||
        head === "pwsh" ||
        head === "cmd" ||
        head === "eval";
    if (runsString) {
        const flag = lowered.findIndex((a, i) =>
            head === "eval" ? i === 1 : /^(?:-c|-command|\/c|-[a-z]*c)$/.test(a) && i > 0,
        );
        const target = head === "eval" ? 1 : flag + 1;
        const text = argv[target];
        if (flag !== -1 && text !== undefined) inner.push({ text, via: "string" });
    }
    return inner;
}

export function parse(
    cmd: string,
    depth = 0,
    parent: string | null = null,
    via: Segment["via"] = null,
): Segment[] {
    const segs: Segment[] = [];
    const raws = split(cmd).map((raw) => {
        const { rest, sudo } = strip(raw.words);
        const argv = rest.length > 0 ? rest : raw.words;
        return { raw, argv, sudo, head: basename(argv[0] ?? "") };
    });
    raws.forEach(({ raw, argv, sudo, head }, i) => {
        segs.push({
            argv,
            lower: argv.map((a) => a.toLowerCase()),
            head,
            sudo,
            redirects: raw.redirects,
            pipedFrom: raw.pipedFrom,
            pipesTo: raw.pipesTo,
            parent,
            via,
            stdin: raw.stdin,
        });
        if (depth >= maxDepth) return;
        const inner = nested(argv, head);
        if (raw.stdin !== null && shellNames.has(head))
            inner.push({ text: raw.stdin, via: "string" });
        // Text echoed or catted into a shell is a script that shell runs
        const sink = raw.pipesTo ? raws[i + 1]?.head : undefined;
        if (sink && shellNames.has(sink) && /^(?:echo|printf|cat)$/.test(head)) {
            const text = head === "cat" ? raw.stdin : argv.slice(1).join(" ");
            if (text) segs.push(...parse(text, depth + 1, sink, "string"));
        }
        for (const n of inner) segs.push(...parse(n.text, depth + 1, head, n.via));
    });
    return segs;
}
