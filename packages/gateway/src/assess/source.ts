export type Source =
    | {
          kind: "github";
          owner: string;
          repo: string;
          ref: string | null;
          path: string | null;
          asset: string | null;
          key: string;
      }
    | { kind: "huggingface"; id: string; revision: string | null; key: string }
    | { kind: "url"; url: string; key: string }
    | { kind: "none"; key: ""; reason: string };

const ghOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ghRepo = /^[A-Za-z0-9._-]{1,100}$/;
const hfPart = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

const githubPages = new Set([
    "about",
    "apps",
    "collections",
    "enterprise",
    "explore",
    "features",
    "login",
    "marketplace",
    "notifications",
    "orgs",
    "pricing",
    "search",
    "settings",
    "sponsors",
    "topics",
    "trending",
    "users",
]);

const huggingfacePages = new Set([
    "api",
    "blog",
    "chat",
    "collections",
    "docs",
    "join",
    "learn",
    "login",
    "models",
    "organizations",
    "papers",
    "posts",
    "pricing",
    "settings",
    "tasks",
]);

function none(reason: string): Source {
    return { kind: "none", key: "", reason };
}

function github(
    owner: string,
    repoRaw: string,
    ref: string | null = null,
    path: string | null = null,
    asset: string | null = null,
): Source {
    const repo = repoRaw.replace(/\.git$/i, "");
    if (!ghOwner.test(owner) || !ghRepo.test(repo) || repo === "." || repo === "..") {
        return none("not a GitHub owner and repo");
    }
    if (githubPages.has(owner.toLowerCase())) return none("a GitHub page, not a repo");
    const key =
        `github:${owner.toLowerCase()}/${repo.toLowerCase()}` +
        (ref ? `@${ref}` : "") +
        (path ? `:${path}` : "") +
        (asset ? `!${asset}` : "");
    return { kind: "github", owner, repo, ref, path, asset, key };
}

function huggingface(org: string | null, name: string, revision: string | null = null): Source {
    if ((org !== null && !hfPart.test(org)) || !hfPart.test(name)) {
        return none("not a Hugging Face model id");
    }
    const id = org ? `${org}/${name}` : name;
    return {
        kind: "huggingface",
        id,
        revision,
        key: `hf:${id.toLowerCase()}${revision ? `@${revision}` : ""}`,
    };
}

function decode(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

function fromGithubUrl(segs: string[]): Source {
    const [owner, repo, kind, ...rest] = segs;
    if (!owner || !repo) return none("a GitHub URL without a repo");
    if (kind === "tree" || kind === "commit" || kind === "commits") {
        return github(owner, repo, rest[0] ?? null);
    }
    if (kind === "blob" || kind === "raw") {
        const path = rest.slice(1).join("/");
        return github(owner, repo, rest[0] ?? null, path || null);
    }
    if (kind === "releases" && rest[0] === "download" && rest.length >= 3) {
        return github(owner, repo, rest[1] ?? null, null, rest.slice(2).join("/"));
    }
    return github(owner, repo);
}

function fromHuggingfaceUrl(segs: string[]): Source {
    let s = segs;
    if (s[0] === "api" && s[1] === "models") s = s.slice(2);
    const [first, second, kind, rev] = s;
    if (!first) return none("a Hugging Face URL without a model");
    if (first === "datasets" || first === "spaces") {
        return none(`Hugging Face ${first} are not checked, only models`);
    }
    if (huggingfacePages.has(first)) return none("a Hugging Face page, not a model");
    const revision = (k: string | undefined) =>
        k === "tree" || k === "blob" || k === "resolve" || k === "commit" ? (rev ?? null) : null;
    if (!second || second === "tree" || second === "blob" || second === "resolve") {
        return huggingface(null, first, second ? (kind ?? null) : null);
    }
    return huggingface(first, second, revision(kind));
}

const knownHosts =
    /^(?:www\.)?(?:github\.com|huggingface\.co|hf\.co|raw\.githubusercontent\.com|gist\.github\.com|gist\.githubusercontent\.com)\//i;

// Turns whatever the agent passed into a GitHub repo, Hugging Face model, script URL or none
export function parseSource(input: string | undefined): Source {
    let s = (input ?? "").trim().replace(/^[<"'`(]+|[>"'`)]+$/g, "");
    if (!s) return none("no source given");
    const scp = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s#?]+?)\/?$/i.exec(s);
    if (scp) return github(scp[1] as string, scp[2] as string);
    s = s.replace(/^git\+/i, "");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        if (knownHosts.test(s)) {
            s = `https://${s}`;
        } else {
            const bare = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/.exec(s);
            if (bare) return huggingface(bare[1] as string, bare[2] as string);
            return none("not a URL, GitHub repo or Hugging Face model id");
        }
    }
    let url: URL;
    try {
        url = new URL(s);
    } catch {
        return none("not a valid URL");
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const segs = url.pathname.split("/").filter(Boolean).map(decode);
    const web = url.protocol === "https:" || url.protocol === "http:";
    if (host === "github.com" && web) return fromGithubUrl(segs);
    if ((host === "huggingface.co" || host === "hf.co") && web) return fromHuggingfaceUrl(segs);
    if (url.protocol === "file:") return none("a local file, not a download link");
    if (host === "gist.github.com" && url.protocol === "https:" && segs.length >= 2) {
        url = new URL(`https://gist.githubusercontent.com/${segs[0]}/${segs[1]}/raw`);
    }
    url.hash = "";
    return { kind: "url", url: url.href, key: `url:${url.href}` };
}

// Short name for summaries, never the full URL with its query string
export function sourceName(s: Source): string {
    switch (s.kind) {
        case "github":
            return `${s.owner}/${s.repo}`;
        case "huggingface":
            return s.id;
        case "url": {
            const u = new URL(s.url);
            const file = u.pathname.split("/").filter(Boolean).pop();
            return file ? `${file} from ${u.hostname}` : u.hostname;
        }
        case "none":
            return "";
    }
}

export function sourceRef(s: Source): string {
    switch (s.kind) {
        case "github":
            return (
                `github.com/${s.owner}/${s.repo}` +
                (s.ref ? `@${s.ref}` : "") +
                (s.path ? `/${s.path}` : "") +
                (s.asset ? ` release file ${s.asset}` : "")
            );
        case "huggingface":
            return `huggingface.co/${s.id}${s.revision ? `@${s.revision}` : ""}`;
        case "url":
            return s.url;
        case "none":
            return "";
    }
}
