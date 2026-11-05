/**
 * Package names the command rules know about.
 *
 * Heavy ML packages pull PyTorch, CUDA wheels or model weights. Popular names are the ones
 * typosquats imitate, so a near miss of one of them is suspicious while an exact match is not.
 */

export interface HeavyPackage {
    weight: number;
    // Packages of one stack, such as torch and torchvision, count once
    group: string;
    nvidiaOnly?: boolean;
}

const heavy = (weight: number, group: string, nvidiaOnly = false): HeavyPackage => ({
    weight,
    group,
    nvidiaOnly,
});

const heavyTable: Record<string, HeavyPackage> = {
    torch: heavy(3, "torch"),
    torchvision: heavy(3, "torch"),
    torchaudio: heavy(3, "torch"),
    pytorch: heavy(3, "torch"),
    tensorflow: heavy(3, "tensorflow"),
    "tensorflow-gpu": heavy(4, "tensorflow", true),
    jax: heavy(3, "jax"),
    jaxlib: heavy(3, "jax"),
    transformers: heavy(3, "hf"),
    accelerate: heavy(3, "hf"),
    peft: heavy(3, "hf"),
    trl: heavy(3, "hf"),
    "sentence-transformers": heavy(3, "hf"),
    timm: heavy(3, "hf"),
    diffusers: heavy(5, "diffusion"),
    xformers: heavy(5, "cuda", true),
    "flash-attn": heavy(5, "cuda", true),
    "flash-attention": heavy(5, "cuda", true),
    bitsandbytes: heavy(5, "cuda", true),
    deepspeed: heavy(5, "cuda", true),
    triton: heavy(5, "cuda", true),
    tensorrt: heavy(5, "cuda", true),
    "auto-gptq": heavy(5, "cuda", true),
    autoawq: heavy(5, "cuda", true),
    exllamav2: heavy(5, "cuda", true),
    "mamba-ssm": heavy(5, "cuda", true),
    "causal-conv1d": heavy(5, "cuda", true),
    cupy: heavy(5, "cuda", true),
    pycuda: heavy(5, "cuda", true),
    "onnxruntime-gpu": heavy(4, "cuda", true),
    vllm: heavy(5, "llm", true),
    sglang: heavy(5, "llm", true),
    "llama-cpp-python": heavy(5, "llm"),
    ctransformers: heavy(5, "llm"),
    "mlx-lm": heavy(4, "llm"),
    unsloth: heavy(5, "train"),
    axolotl: heavy(5, "train"),
    tts: heavy(5, "tts"),
    "coqui-tts": heavy(5, "tts"),
    kokoro: heavy(5, "tts"),
    "kokoro-onnx": heavy(5, "tts"),
    "f5-tts": heavy(5, "tts"),
    "chatterbox-tts": heavy(5, "tts"),
    "parler-tts": heavy(5, "tts"),
    "piper-tts": heavy(4, "tts"),
    melotts: heavy(5, "tts"),
    styletts2: heavy(5, "tts"),
    "rvc-python": heavy(5, "tts"),
    "orpheus-speech": heavy(5, "tts"),
    "suno-bark": heavy(5, "tts"),
    bark: heavy(5, "tts"),
    audiocraft: heavy(5, "audio"),
    "openai-whisper": heavy(5, "asr"),
    whisperx: heavy(5, "asr"),
    "faster-whisper": heavy(4, "asr"),
    "insanely-fast-whisper": heavy(5, "asr"),
    "whisper-ctranslate2": heavy(4, "asr"),
    "nemo-toolkit": heavy(5, "asr"),
    "pyannote.audio": heavy(5, "asr"),
    comfyui: heavy(5, "image"),
    "comfy-cli": heavy(5, "image"),
    invokeai: heavy(5, "image"),
    fooocus: heavy(5, "image"),
    insightface: heavy(4, "image"),
    ultralytics: heavy(4, "vision"),
    detectron2: heavy(5, "vision"),
};

export function heavyPackage(name: string): HeavyPackage | null {
    const n = name.toLowerCase().replace(/_/g, "-");
    if (heavyTable[n]) return heavyTable[n];
    if (/^nvidia-[a-z0-9-]+-cu\d+$/.test(n) || /^cupy-cuda\d+\w*$/.test(n)) {
        return heavy(5, "cuda", true);
    }
    return null;
}

const pypi = `
    requests request urllib3 certifi idna charset-normalizer chardet six packaging setuptools wheel pip
    virtualenv pipenv poetry uv numpy numba scipy scapy sympy pandas polars pyarrow matplotlib
    seaborn plotly bokeh scikit-learn sklearn scikit-image statsmodels networkx pillow opencv-python
    opencv-python-headless imageio moviepy pydub librosa soundfile torch torchvision torchaudio
    torchx tensorflow keras jax jaxlib xgboost lightgbm catboost transformers tokenizers datasets
    accelerate safetensors sentencepiece huggingface-hub diffusers peft trl timm einops gradio
    streamlit openai anthropic langchain langchain-openai langchain-community llama-index cohere
    groq replicate elevenlabs deepgram-sdk tiktoken flask django fastapi starlette uvicorn gunicorn
    unicorn werkzeug jinja2 jinja markupsafe itsdangerous click typer rich colorama termcolor colorlog
    loguru tqdm pyyaml yaml toml tomli tomlkit python-dotenv dotenv pydantic attrs attr marshmallow
    sqlalchemy alembic psycopg psycopg2 psycopg2-binary asyncpg pymysql mysqlclient redis celery
    kombu pymongo motor boto3 botocore s3fs awscli google-cloud-storage azure-storage-blob
    aiohttp httpx httpcore websockets websocket-client grpcio protobuf requests-oauthlib oauthlib
    pyjwt jwt cryptography pycryptodome paramiko fabric pexpect pytest pytest-cov pytest-asyncio
    tox nox coverage hypothesis black ruff flake8 pylint mypy isort autopep8 yapf pre-commit
    selenium playwright beautifulsoup4 beautifulsoup bs4 lxml html5lib scrapy mechanize discord discord.py
    python-telegram-bot telethon pyrogram tweepy praw web3 eth-account solana solders ccxt
    python-binance yfinance alpaca-trade-api ta pyautogui pynput keyboard mouse psutil watchdog
    schedule apscheduler arrow pendulum python-dateutil pytz tzdata babel regex chromadb faiss-cpu
    faiss-gpu pinecone-client qdrant-client weaviate-client sentence-transformers spacy nltk gensim jupyter
    notebook jupyterlab ipython ipykernel ipywidgets openpyxl xlrd xlsxwriter python-docx pypdf
    pypdf2 pdfplumber reportlab markdown mkdocs sphinx docutils pygments
`;

const npm = `
    react react-dom preact next vue nuxt svelte @sveltejs/kit angular @angular/core solid-js astro
    express koa fastify hapi @hapi/hapi nestjs @nestjs/core lodash lodash-es underscore ramda axios
    request node-fetch got ky superagent chalk colors kleur picocolors colorette commander yargs inquirer
    prompts ora debug dotenv dotenvx uuid nanoid moment dayjs date-fns luxon zod yup joi ajv
    typescript ts-node tsx esbuild vite vitest webpack rollup parcel @babel/core babel-loader
    eslint prettier jest mocha chai sinon supertest nodemon pm2 concurrently cross-env rimraf
    mkdirp glob fs-extra ws socket.io socket.io-client mongoose mongodb pg mysql mysql2 sqlite3
    better-sqlite3 prisma @prisma/client sequelize typeorm knex drizzle-orm redis ioredis
    jsonwebtoken bcrypt bcryptjs passport cors helmet morgan body-parser cookie-parser multer sharp
    jimp puppeteer playwright cheerio tailwindcss postcss autoprefixer sass less styled-components
    @emotion/react react-router react-router-dom redux @reduxjs/toolkit zustand jotai swr
    @tanstack/react-query react-hook-form @hookform/resolvers formik classnames clsx framer-motion
    three d3 chart.js discord.js telegraf openai @anthropic-ai/sdk ethers web3 viem wagmi
    @solana/web3.js electron nodemailer stripe aws-sdk firebase @supabase/supabase-js graphql
    @apollo/client apollo-server husky lint-staged nx turbo lerna serve http-server
    create-react-app create-next-app create-vite npm pnpm yarn bun deno
`;

const brands = `
    pytorch torch tensorflow cuda nvidia numpy pandas requests colorama discord telegram solana
    ethereum binance openai anthropic deepseek huggingface whisper stable diffusion selenium
`;

const words = (s: string) => s.trim().split(/\s+/);

// PyPI treats dots, underscores and dashes in names as the same character
const canonical = (s: string) => s.toLowerCase().replace(/[._]/g, "-");

export const popular = new Set([...words(pypi), ...words(npm)].map(canonical));
const popularList = [...popular];
const brandSet = new Set([...words(brands), ...popularList]);

const leet: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t" };

function distance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    let prevPrev = prev;
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let v = Math.min(
                (prev[j] as number) + 1,
                (cur[j - 1] as number) + 1,
                (prev[j - 1] as number) + cost,
            );
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                v = Math.min(v, (prevPrev[j - 2] as number) + 1);
            }
            cur.push(v);
            rowMin = Math.min(rowMin, v);
        }
        if (rowMin > max) return max + 1;
        prevPrev = prev;
        prev = cur;
    }
    return prev[b.length] as number;
}

// The popular name a package imitates, through a one letter slip or a digit for a letter
export function typosquatOf(name: string): string | null {
    const n = canonical(name);
    if (popular.has(n) || n.startsWith("@") || n.length < 5) return null;
    for (const part of n.split(/[-_.]/)) {
        if (/[a-z][013457][a-z]/.test(part)) {
            const unfolded = part.replace(/[013457]/g, (d) => leet[d] ?? d);
            if (brandSet.has(unfolded) && unfolded !== part) return unfolded;
        }
    }
    for (const p of popularList) {
        if (p.length < 5 || p.startsWith("@")) continue;
        if (distance(n, p, 1) <= 1) return p;
    }
    return null;
}

const lureWords =
    /(?:^|[-_.])(?:crack|cracked|keygen|activator|aimbot|wallhack|injector|spoofer|stealer|grabber|drainer|robux|vbucks|nitro-?gen|unlocker|airdrop-?claim)(?:$|[-_.])|(?:^|[-_.])free(?:[-_.][a-z0-9]+)*[-_.](?:pro|premium|plus|vip|nitro|license|activator)(?:$|[-_.])|(?:^|[-_.])(?:pro|premium|plus)[-_.]free(?:$|[-_.])/;

export function isLurePackage(name: string): boolean {
    return lureWords.test(name.toLowerCase());
}
