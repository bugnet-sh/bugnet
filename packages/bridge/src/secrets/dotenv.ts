// The line grammar of the dotenv package, so a file that works with dotenv reads the same here
const line =
    /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gm;

export function parseDotenv(text: string): Map<string, string> {
    const out = new Map<string, string>();
    const src = text.replace(/\r\n?/g, "\n");
    for (const m of src.matchAll(line)) {
        const key = m[1] as string;
        let value = (m[2] ?? "").trim();
        const quote = value[0];
        value = value.replace(/^(['"`])([\s\S]*)\1$/, "$2");
        if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
        out.set(key, value);
    }
    return out;
}
