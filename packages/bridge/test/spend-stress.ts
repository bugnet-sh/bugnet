// Stress for the spend ledger with real processes, run by hand: node --import tsx
// test/spend-stress.ts [a|b|c]... from packages/bridge. a: 8 processes x 40 claims of 1 against a
// cap of 200, 5 trials, exactly 200 reserved. b: the same while children are stopped and
// continued at random, never over 200. c: 6 processes claim 3 USD against 5 USD, 30 trials, at
// most one reserved. Exits 1 when a trial breaks its rule
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("..", import.meta.url));
const childPath = fileURLToPath(new URL("../src/testing/spend-child.ts", import.meta.url));
const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Child {
    proc: ChildProcess;
    lines: Interface;
}

async function children(n: number): Promise<Child[]> {
    const kids = Array.from({ length: n }, () => {
        const proc = spawn(process.execPath, ["--import", "tsx", childPath], {
            cwd: bridge,
            stdio: ["pipe", "pipe", "inherit"],
        });
        return { proc, lines: createInterface({ input: proc.stdout! }) };
    });
    await Promise.all(kids.map(next));
    return kids;
}

const next = (c: Child) => new Promise<string>((r) => c.lines.once("line", r));

// What the day folder holds: reservations that stayed, and their sum
async function onDisk(root: string): Promise<{ files: number; micros: number }> {
    const folder = join(root, today());
    let files = 0;
    let micros = 0;
    for (const name of await readdir(folder)) {
        if (!/^[0-9a-f]{64}$/.test(name)) continue;
        files += 1;
        micros += (JSON.parse(await readFile(join(folder, name), "utf8")) as { micros: number })
            .micros;
    }
    return { files, micros };
}

interface Run {
    reserved: number;
    over_cap: number;
    already_reserved: number;
    errors: number;
}

// Stops one child at a time at random for 50-500 ms until done() is true
async function chaos(kids: Child[], done: () => boolean): Promise<number> {
    let stops = 0;
    const loops = kids.map(async (k) => {
        while (!done()) {
            await sleep(Math.random() * 100);
            if (done()) break;
            k.proc.kill("SIGSTOP");
            stops += 1;
            await sleep(50 + Math.random() * 450);
            k.proc.kill("SIGCONT");
        }
    });
    await Promise.all(loops);
    return stops;
}

async function manyClaims(withChaos: boolean, trials: number): Promise<boolean> {
    const kids = await children(8);
    let ok = true;
    try {
        for (let t = 0; t < trials; t++) {
            const root = await mkdtemp(join(tmpdir(), "bugnet-stress-"));
            const answers = kids.map(next);
            kids.forEach((k, i) => k.proc.stdin!.write(`run ${root} p${t}x${i} 40 1 200\n`));
            let finished = false;
            const stopping = withChaos ? chaos(kids, () => finished) : Promise.resolve(0);
            const runs = (await Promise.all(answers)).map((l) => JSON.parse(l) as Run);
            finished = true;
            const stops = await stopping;
            const sum = (k: keyof Run) => runs.reduce((n, r) => n + r[k], 0);
            const disk = await onDisk(root);
            const reserved = sum("reserved");
            const good = withChaos
                ? reserved <= 200 && disk.micros <= 200
                : reserved === 200 && disk.micros === 200;
            ok &&= good && disk.files === reserved && sum("errors") === 0;
            console.log(
                `${withChaos ? "b" : "a"} trial ${t}: reserved ${reserved}, over_cap ` +
                    `${sum("over_cap")}, errors ${sum("errors")}, on disk ${disk.micros}` +
                    (withChaos ? `, stops ${stops}` : "") +
                    (good ? "" : "  FAIL"),
            );
            await rm(root, { recursive: true, force: true });
        }
    } finally {
        for (const k of kids) {
            k.proc.kill("SIGCONT");
            k.proc.kill();
        }
    }
    return ok;
}

async function bigClaims(trials: number): Promise<boolean> {
    const kids = await children(6);
    let ok = true;
    const tally = [0, 0];
    try {
        for (let t = 0; t < trials; t++) {
            const root = await mkdtemp(join(tmpdir(), "bugnet-stress-"));
            const answers = kids.map(next);
            kids.forEach((k, i) =>
                k.proc.stdin!.write(`go ${root} ord_${t}_${i} 3000000 5000000\n`),
            );
            const results = (await Promise.all(answers)).map(
                (l) => JSON.parse(l) as { granted?: boolean; error?: string },
            );
            const granted = results.filter((r) => r.granted === true).length;
            const disk = await onDisk(root);
            const good =
                granted <= 1 &&
                disk.files === granted &&
                results.every((r) => r.error === undefined);
            tally[granted] = (tally[granted] ?? 0) + 1;
            if (!good) console.log(`c trial ${t}: FAIL ${JSON.stringify(results)}`);
            ok &&= good;
            await rm(root, { recursive: true, force: true });
        }
    } finally {
        for (const k of kids) k.proc.kill();
    }
    console.log(
        `c: ${trials} trials, one reserved in ${tally[1]}, none in ${tally[0]}, ` +
            `more than one in ${trials - tally[0]! - tally[1]!}`,
    );
    return ok;
}

const wanted = process.argv.slice(2);
const pick = (s: string) => wanted.length === 0 || wanted.includes(s);
let ok = true;
if (pick("a")) ok = (await manyClaims(false, 5)) && ok;
if (pick("b")) ok = (await manyClaims(true, 5)) && ok;
if (pick("c")) ok = (await bigClaims(30)) && ok;
console.log(ok ? "all held" : "FAILED");
process.exit(ok ? 0 : 1);
