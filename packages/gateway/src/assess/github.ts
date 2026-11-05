import type { Finding } from "./assessor.ts";
import { bodyJson, bodyText, type Fetched, type Fetcher } from "./fetch.ts";
import { safePath } from "./scan.ts";

export interface RepoInfo {
    owner: string;
    repo: string;
    description: string;
    stars: number;
    forks: number;
    createdAt: string;
    pushedAt: string;
    sizeKiB: number;
    archived: boolean;
    fork: boolean;
    license: string | null;
    language: string | null;
    defaultBranch: string;
    topics: string[];
}

export interface TreeEntry {
    path: string;
    type: "blob" | "tree" | "commit";
    size: number | null;
}

export interface RepoFile {
    path: string;
    text: string;
    truncated: boolean;
}

export interface RepoSnapshot {
    info: RepoInfo | null;
    ownerCreatedAt: string | null;
    ownerType: string | null;
    tree: TreeEntry[];
    treeTruncated: boolean;
    // How many files were chosen for reading, so an empty files list can be told apart from failures
    picked: number;
    files: RepoFile[];
    notes: Finding[];
    complete: boolean;
}

export interface GithubEnv {
    fetch: Fetcher;
    api: string;
    raw: string;
    token: string;
    maxFileBytes: number;
}

// Listings run larger than single files, a big repo's recursive tree is several MiB
const listingBytes = 8 * 1024 * 1024;
export const maxFilesRead = 6;

function rateLimited(r: Fetched): boolean {
    return r.status === 429 || (r.status === 403 && r.headers["x-ratelimit-remaining"] === "0");
}

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function repoInfoFrom(json: unknown): RepoInfo | null {
    if (!json || typeof json !== "object") return null;
    const d = json as Record<string, unknown>;
    const full = str(d.full_name);
    const [owner, repo] = full.split("/");
    if (!owner || !repo) return null;
    const license = d.license as { spdx_id?: unknown; name?: unknown } | null | undefined;
    const spdx = str(license?.spdx_id);
    return {
        owner,
        repo,
        description: str(d.description),
        stars: num(d.stargazers_count),
        forks: num(d.forks_count),
        createdAt: str(d.created_at),
        pushedAt: str(d.pushed_at),
        sizeKiB: num(d.size),
        archived: d.archived === true,
        fork: d.fork === true,
        license: license ? spdx || str(license.name) || "other" : null,
        language: str(d.language) || null,
        defaultBranch: str(d.default_branch) || "main",
        topics: Array.isArray(d.topics) ? d.topics.filter((t) => typeof t === "string") : [],
    };
}

// The gateway's token may see private repos, whose names and files must never reach a caller
export function isPrivateRepo(json: unknown): boolean {
    const d = (json ?? {}) as { private?: unknown; visibility?: unknown };
    return d.private === true || (typeof d.visibility === "string" && d.visibility !== "public");
}

export function treeFrom(json: unknown): { tree: TreeEntry[]; truncated: boolean } {
    const d = (json ?? {}) as { tree?: unknown; truncated?: unknown };
    const raw = Array.isArray(d.tree) ? d.tree : [];
    const tree: TreeEntry[] = [];
    for (const e of raw as Record<string, unknown>[]) {
        const path = str(e?.path);
        const type = e?.type;
        if (!path || (type !== "blob" && type !== "tree" && type !== "commit")) continue;
        tree.push({ path, type, size: typeof e.size === "number" ? e.size : null });
    }
    return { tree, truncated: d.truncated === true };
}

const readme = /^readme(?:\.(?:md|markdown|rst|txt))?$/i;
const rootShell = /^[^/]+\.(?:sh|bash|command)$/i;
const rootWindows = /^[^/]+\.(?:bat|cmd|ps1)$/i;
const workflow = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const installName = /^(?:install|setup|run|start|build|bootstrap|get)/i;

// Files most likely to show what an install or first run does, in reading order
export function pickFiles(
    tree: TreeEntry[],
    preferred: string | null,
    max = maxFilesRead,
): string[] {
    const blobs = tree.filter((e) => e.type === "blob");
    const byLower = new Map(blobs.map((e) => [e.path.toLowerCase(), e.path]));
    const picked: string[] = [];
    const add = (path: string | undefined) => {
        if (path && !picked.includes(path) && picked.length < max) picked.push(path);
    };
    if (preferred) add(byLower.get(preferred.toLowerCase()));
    add(byLower.get("package.json"));
    add(byLower.get("setup.py"));
    add(byLower.get("pyproject.toml"));
    const shells = blobs
        .filter((e) => rootShell.test(e.path))
        .sort((a, b) => Number(installName.test(b.path)) - Number(installName.test(a.path)));
    for (const e of shells.slice(0, 2)) add(e.path);
    const readmes = blobs
        .filter((e) => readme.test(e.path))
        .sort((a, b) => Number(/\.md$/i.test(b.path)) - Number(/\.md$/i.test(a.path)));
    add(readmes[0]?.path);
    add(byLower.get("requirements.txt"));
    add(byLower.get("dockerfile"));
    add(byLower.get(".devcontainer/devcontainer.json"));
    for (const e of blobs.filter((e) => workflow.test(e.path)).slice(0, 2)) add(e.path);
    const windows = blobs.filter((e) => rootWindows.test(e.path));
    add(windows[0]?.path);
    return picked;
}

function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

function note(id: string, title: string): Finding {
    return { id, severity: "info", title };
}

export async function readGithub(
    env: GithubEnv,
    src: { owner: string; repo: string; ref: string | null; path: string | null },
    signal: AbortSignal,
): Promise<RepoSnapshot> {
    const snap: RepoSnapshot = {
        info: null,
        ownerCreatedAt: null,
        ownerType: null,
        tree: [],
        treeTruncated: false,
        picked: 0,
        files: [],
        notes: [],
        complete: true,
    };
    const api = env.api.replace(/\/$/, "");
    const apiGet = (path: string) =>
        env.fetch(`${api}${path}`, {
            signal,
            maxBytes: listingBytes,
            headers: {
                accept: "application/vnd.github+json",
                "x-github-api-version": "2022-11-28",
            },
            ...(env.token ? { originHeaders: { authorization: `Bearer ${env.token}` } } : {}),
        });
    const limited = () => {
        snap.notes.push(
            note("github_rate_limited", "GitHub rate limit reached, repo details were not checked"),
        );
        snap.complete = false;
    };

    const repoRes = await apiGet(
        `/repos/${encodeURIComponent(src.owner)}/${encodeURIComponent(src.repo)}`,
    );
    if (rateLimited(repoRes)) {
        limited();
        return snap;
    }
    if (repoRes.status === 404) {
        snap.notes.push(note("github_not_found", "Repo not found on GitHub, or it is private"));
        return snap;
    }
    if (repoRes.status === 451) {
        snap.notes.push({
            id: "github_blocked",
            severity: "medium",
            title: "GitHub blocks access to this repo for legal reasons",
        });
        return snap;
    }
    if (repoRes.status !== 200) {
        snap.notes.push(note("github_error", `GitHub answered ${repoRes.status} for this repo`));
        snap.complete = false;
        return snap;
    }
    const repoJson = bodyJson(repoRes);
    if (isPrivateRepo(repoJson)) {
        snap.notes.push(note("github_not_found", "Repo not found on GitHub, or it is private"));
        return snap;
    }
    const info = repoInfoFrom(repoJson);
    if (!info) {
        snap.notes.push(note("github_error", "GitHub returned repo details in an unknown shape"));
        snap.complete = false;
        return snap;
    }
    snap.info = info;
    const ref = src.ref ?? info.defaultBranch;
    const repoPath = `/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}`;

    const [ownerRes, treeRes] = await Promise.allSettled([
        apiGet(`/users/${encodeURIComponent(info.owner)}`),
        apiGet(`${repoPath}/git/trees/${encodeURIComponent(ref)}?recursive=1`),
    ]);
    if (ownerRes.status === "fulfilled" && ownerRes.value.status === 200) {
        const o = bodyJson(ownerRes.value) as { created_at?: unknown; type?: unknown };
        snap.ownerCreatedAt = str(o.created_at) || null;
        snap.ownerType = str(o.type) || null;
    } else if (ownerRes.status === "fulfilled" && rateLimited(ownerRes.value)) {
        limited();
    } else {
        snap.complete = false;
    }
    if (
        treeRes.status === "fulfilled" &&
        treeRes.value.status === 200 &&
        !treeRes.value.truncated
    ) {
        const t = treeFrom(bodyJson(treeRes.value));
        snap.tree = t.tree;
        snap.treeTruncated = t.truncated;
    } else if (treeRes.status === "fulfilled" && rateLimited(treeRes.value)) {
        if (snap.complete) limited();
        return snap;
    } else if (treeRes.status === "fulfilled" && treeRes.value.status === 404) {
        snap.notes.push(
            note("github_ref_not_found", `Branch, tag or commit ${safePath(ref)} not found`),
        );
        return snap;
    } else {
        snap.notes.push(note("github_tree_unread", "The repo's file list could not be read"));
        snap.complete = false;
        return snap;
    }

    const raw = env.raw.replace(/\/$/, "");
    const paths = pickFiles(snap.tree, src.path);
    snap.picked = paths.length;
    const reads = await Promise.allSettled(
        paths.map((path) =>
            env.fetch(
                `${raw}/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/${encodePath(ref)}/${encodePath(path)}`,
                {
                    signal,
                    maxBytes: env.maxFileBytes,
                },
            ),
        ),
    );
    reads.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value.status === 200) {
            snap.files.push({
                path: paths[i] as string,
                text: bodyText(r.value),
                truncated: r.value.truncated,
            });
        } else {
            snap.complete = false;
        }
    });
    const unread = paths.length - snap.files.length;
    if (unread > 0) {
        snap.notes.push(
            note("files_unread", `${unread} of ${paths.length} repo files could not be read`),
        );
    }
    return snap;
}
