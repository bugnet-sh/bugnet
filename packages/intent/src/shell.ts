/**
 * A light POSIX-ish shell parser, enough to read the commands coding agents run.
 *
 * It splits on the list and pipe operators and on newlines outside quotes, keeps $( ) and <( ) as
 * words and parses their contents too, unwraps sh -c strings, records > targets and strips
 * leading sudo, env assignments and wrappers such as time or nohup. It never evaluates anything.
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
}

interface Raw {
    words: string[];
    redirects: string[];
    pipedFrom: boolean;
    pipesTo: boolean;
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

// Index of the newline that ends a heredoc's closing line, scanning each line once
function heredocEnd(cmd: string, from: number, delim: string): number {
    let at = from;
    while (at < cmd.length) {
        const nl = cmd.indexOf("\n", at);
        const end = nl === -1 ? cmd.length : nl;
        if (cmd.slice(at, end).trim() === delim) return end;
        at = end + 1;
    }
    return cmd.length;
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
    let target: "out" | "in" | null = null;
    let pipedFrom = false;
    let heredoc: string | null = null;

    const endWord = () => {
        if (inWord) {
            if (target === "out") redirects.push(word);
            else if (target === null) words.push(word);
            target = null;
        }
        word = "";
        inWord = false;
    };
    const endSeg = (pipe: boolean) => {
        endWord();
        if (words.length > 0 || redirects.length > 0) {
            out.push({ words, redirects, pipedFrom, pipesTo: pipe });
            pipedFrom = pipe;
        } else if (!pipe) {
            pipedFrom = false;
        }
        words = [];
        redirects = [];
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
            else {
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
                i = heredocEnd(cmd, i + 1, heredoc) - 1;
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
            if (c === "<" && next === "<") {
                let j = i + 2;
                if (cmd[j] === "<") j++;
                if (cmd[j] === "-") j++;
                const m = /^\s*(['"]?)([\w.-]+)\1/.exec(cmd.slice(j));
                if (m) {
                    heredoc = m[2] as string;
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
    for (const raw of split(cmd)) {
        const { rest, sudo } = strip(raw.words);
        const argv = rest.length > 0 ? rest : raw.words;
        const head = basename(argv[0] ?? "");
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
        });
        if (depth < maxDepth) {
            for (const n of nested(argv, head)) segs.push(...parse(n.text, depth + 1, head, n.via));
        }
    }
    return segs;
}
