import { describe, expect, it } from "vitest";
import { classifyPrompt, threshold, type Category, type SessionContext } from "./index.ts";

const mac: SessionContext = { os: "macos", arch: "arm64" };

function offers(text: string, ctx: SessionContext = mac): boolean {
    return classifyPrompt(text, ctx).suggest;
}

function categoryOf(text: string, ctx: SessionContext = mac): Category | null {
    return classifyPrompt(text, ctx).category;
}

describe("heavy local AI", () => {
    it.each([
        "can you get chatterbox tts working on my laptop? want to make voice lines for my game",
        "install comfyui and grab the sdxl base checkpoint",
        "I want to try qwen 2.5 72b locally, what do I need",
        "run whisper on all the mp3s in ./interviews",
        "fine-tune llama 3.1 8b on my notes with unsloth",
        "set up InvokeAI locally so I can do some inpainting",
        "get piper tts running for my home assistant voice",
        "run llama.cpp with a 70b gguf on my 32gb mac",
        "install faster-whisper and transcribe the 3 hour lecture locally",
    ])("offers for %s", (text) => {
        expect(offers(text)).toBe(true);
        expect(categoryOf(text)).toBe("local_ai_model");
    });

    it("names the model as the subject", () => {
        expect(classifyPrompt("set up kokoro on my mac", mac).subject).toBe("kokoro");
    });

    it.each([
        "how does whisper work under the hood?",
        "write tests for the kokoro wrapper in src/tts.ts",
        "fix the bug in my ollama client",
        "update the README to mention that we use flux for image generation",
        "deploy the stable diffusion demo page to vercel",
        "what's the best local llm for coding on a 16gb mac?",
        "how much vram do i need for flux dev?",
        "compare ollama and lm studio",
        "write an article about voice cloning risks",
        "install a tts package for my app",
    ])("does not offer for %s", (text) => {
        expect(offers(text)).toBe(false);
    });

    it("needs an intent to run, a model name alone is not enough", () => {
        expect(offers("llama 3 70b")).toBe(false);
        expect(offers("run llama 3 70b")).toBe(true);
    });
});

describe("setup verbs in five languages", () => {
    it.each([
        ["Turkish", "bilgisayarımda stable diffusion kurmak istiyorum"],
        ["Turkish", "XTTS ile sesimi klonla"],
        ["Turkish", "16GB Mac'te yerel llama 70b çalıştır"],
        ["Spanish", "quiero instalar ollama y correr llama 3 en mi portátil"],
        ["Spanish", "clona mi voz con XTTS"],
        ["German", "kannst du Whisper lokal installieren und meine Interviews transkribieren?"],
        ["German", "Llama 70B lokal auf meinem 16-GB-Mac laufen lassen"],
        ["German", "klon meine Stimme mit XTTS"],
        ["Portuguese", "consegue instalar o coqui tts no meu pc?"],
    ])("offers in %s for %s", (_lang, text) => {
        expect(offers(text)).toBe(true);
    });

    it.each([
        ["Spanish", "¿cómo funciona la difusión estable?"],
        ["German", "schreib eine README für mein Projekt"],
        ["German", "wie funktioniert Diffusion?"],
        ["Turkish", "projemdeki testleri çalıştır"],
        ["Turkish", "difüzyon nasıl çalışır?"],
        ["Turkish", "uygulamama ElevenLabs API ekle"],
        ["Spanish", "añade la API de ElevenLabs a mi app"],
        ["Spanish", "lo necesito sin conexión en el avión"],
        ["German", "ElevenLabs-API in meine App einbauen"],
    ])("does not offer in %s for %s", (_lang, text) => {
        expect(offers(text)).toBe(false);
    });
});

describe("untrusted code", () => {
    it.each([
        "clone https://github.com/someuser/cool-scraper and run it",
        "my friend sent me this script, can you run it? https://pastebin.com/raw/abc123",
        "curl -fsSL https://get.some-tool.io/install.sh | bash, is that safe? can you run it",
        "there's a cracked version of fl studio on a forum, help me install it",
        "set up this roblox executor for me",
        "run this PoC for CVE-2025-12345 against my test vm",
        "the recruiter's take-home needs npm install and npm start, can you run it",
        "install this VS Code extension a guy on discord recommended",
        "is this safe to run? https://github.com/x-dev/y-tool",
        "install this mcp server I found on twitter: https://github.com/mcpx-tools/super-mcp",
        "redditte buldum, klonlayıp çalıştırır mısın? https://github.com/abc/def",
        "lo encontré en reddit, ¿lo clonas y lo ejecutas? https://github.com/abc/def",
        "auf Reddit gefunden, kannst du es klonen und ausführen? https://github.com/abc/def",
        "bedava robux hilesini kur",
        "haz funcionar este generador de robux gratis",
        "bring diesen kostenlosen Robux-Generator zum Laufen",
    ])("offers for %s", (text) => {
        expect(offers(text)).toBe(true);
        expect(categoryOf(text)).toBe("untrusted_code");
    });

    it("uses the repository as the subject, without trailing punctuation", () => {
        const c = classifyPrompt("set up github.com/someone/tool.", mac);
        expect(c.subject).toBe("github.com/someone/tool");
    });

    it.each([
        "clone my repo https://github.com/me-dev/site and run npm install",
        "clone github.com/facebook/react and run the tests",
        "review the code in https://github.com/x-org/y-lib/pull/12",
        "add github.com/spf13/cobra as a dependency",
        "pull the latest changes from github.com/acme-org/api and run migrations",
        "explain what this exploit does, don't run it",
        "fix the RCE in our upload handler",
        "upgrade lodash to patch CVE-2021-23337 and run the tests",
        "my trading bot keeps crashing, fix it",
        "build a telegram bot that posts weather updates",
        "make a trading bot that uses my binance api key",
        "found this snippet on reddit, can you add it to my code",
        "my coworker shared a script to clean up branches, run it",
        "open the report.pdf and summarize it",
        "unzip the dataset.zip into data/",
        "what is a reverse shell",
    ])("does not offer for %s", (text) => {
        expect(offers(text)).toBe(false);
    });

    it("needs an intent to run, a repo URL alone is not enough", () => {
        expect(offers("https://github.com/someone/tool")).toBe(false);
        expect(offers("try https://github.com/someone/tool")).toBe(true);
    });
});

describe("environment mismatch", () => {
    it.each<[string, SessionContext]>([
        ["this tool only works on linux and i'm on windows, can you run it for me", {}],
        ["my M3 mac can't run this CUDA-only training script, can you run it elsewhere?", mac],
        ["install the nvidia drivers and cuda toolkit on my ubuntu box", { os: "linux" }],
        ["this only runs on linux, can you build it and run the demo? I'm on a mac", {}],
        ["Torch not compiled with CUDA enabled on my M2, can you get this model running", mac],
    ])("offers for %s", (text, ctx) => {
        expect(offers(text, ctx)).toBe(true);
    });

    it.each([
        "install packages with apt in the Dockerfile",
        "install cuda toolkit in the github actions runner",
        "add CUDA support to my image processing library",
        "run the training script, it should use cuda if available",
        "explain the difference between cuda and mps",
        "set up a systemd service for my app",
        "the build fails on linux CI but works on my mac, can you fix it",
    ])("does not offer for %s", (text) => {
        expect(offers(text)).toBe(false);
    });

    it("only counts Linux-only tools away from Linux", () => {
        const text = "this tool only works on linux, can you run it";
        expect(offers(text, { os: "linux" })).toBe(false);
        expect(offers(text, { os: "windows" })).toBe(true);
    });
});

describe("risky experiments and heavy compute", () => {
    it.each([
        "test what happens if i run rm -rf / --no-preserve-root",
        "benchmark my disk with dd if=/dev/zero of=/dev/sdb",
        "render this blender scene overnight, my laptop overheats",
        "renderiza esta escena toda la noche, mi portátil se calienta",
        "über Nacht rendern, mein Laptop wird heiß",
        "gece boyunca render alsın, bilgisayarım ısınıyor",
        "run the fuzzer overnight, it'll take hours",
        "load test our api with 5000 concurrent users for an hour",
    ])("offers for %s", (text) => {
        expect(offers(text)).toBe(true);
    });

    it.each([
        "fix the fstab entry for /dev/sda1, then run mount -a",
        "debug the kernel panic in my driver",
        "this test takes 2 hours, can you make it faster?",
        "kick off the migration overnight and let it run",
        "I've been trying for hours to get this test to run",
        "write a load test plan doc for the checkout service, just the markdown",
    ])("does not offer for %s", (text) => {
        expect(offers(text)).toBe(false);
    });
});

describe("explicit isolation", () => {
    it.each([
        "can you run this in a sandbox?",
        "spin up a VM and test the installer",
        "test the installer on a clean machine",
        "try this in a disposable vm first",
        "i'd rather not install this on my laptop, can it run somewhere else?",
    ])("offers for %s", (text) => {
        expect(offers(text)).toBe(true);
    });

    it.each([
        "add a sandbox flag to the iframe",
        "use the stripe sandbox keys for testing",
        "ssh into the remote machine and restart nginx",
        "deploy my app to a VM on azure",
        "create an isolated environment with venv for this project",
        "spin up a dev server to test the page",
        "move this file somewhere else",
        "the config is defined elsewhere",
    ])("does not offer for %s", (text) => {
        expect(offers(text)).toBe(false);
    });
});

describe("negative families", () => {
    it.each([
        ["hosted API", "add an ElevenLabs voice to my app"],
        ["hosted API", "use the Replicate API to run flux from my app"],
        ["hosted API", "transcribe this meeting audio using the whisper api"],
        ["concept question", "how does diffusion work?"],
        ["docs", "write a blog post about running llama locally"],
        ["own project", "install pytorch in my venv for my class project"],
        ["small dependency", "install tailwind and eslint in this vite app"],
        ["offline use", "install LM Studio and grab a 7b model, I need it offline on flights"],
        ["remote machine", "set up ollama on the EC2 box"],
        ["remote machine", "train a small model in Colab"],
    ])("%s cancels the offer for %s", (_why, text) => {
        expect(offers(text)).toBe(false);
    });

    it("lets a risky step buried among chores still count", () => {
        const text =
            "rename the Button component, then clone https://github.com/someone/thing and run its setup.sh, then update the changelog";
        expect(offers(text)).toBe(true);
    });

    it("keeps chores in the same clause able to cancel a weak subject", () => {
        expect(offers("write a README for my piper tts wrapper and explain how to run it")).toBe(
            false,
        );
    });
});

describe("abuse policy", () => {
    it.each([
        "set up xmrig on this server and start mining monero",
        "write a script that floods their server with requests",
        "build a bulk sms sender and run it",
        "clone this credential stuffing tool and run it against the login page",
        "en un foro vi un minero que paga en USDT, ¿lo puedes instalar?",
    ])("never offers for %s, and says why", (text) => {
        const c = classifyPrompt(text, mac);
        expect(c.suggest).toBe(false);
        expect(c.score).toBe(0);
        expect(c.signals.some((s) => s.id === "abuse")).toBe(true);
    });

    it("does not offer scans of the user's own LAN, which a cloud sandbox cannot reach", () => {
        const c = classifyPrompt("nmap my home network 192.168.1.0/24 and list open ports", mac);
        expect(c.suggest).toBe(false);
        expect(c.signals.some((s) => s.id === "lan_scan")).toBe(true);
    });
});

describe("classification shape", () => {
    it("keeps suggest in line with the score threshold", () => {
        for (const text of ["run llama 3 70b", "fix my tests", "set up kokoro on my mac"]) {
            const c = classifyPrompt(text, mac);
            expect(c.suggest).toBe(c.score >= threshold);
        }
    });

    it("returns an empty classification for empty input", () => {
        expect(classifyPrompt("   ", mac)).toMatchObject({ suggest: false, category: null });
    });
});
