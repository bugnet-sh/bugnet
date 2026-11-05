// Owners whose repositories are well known, so a clone of theirs is not unvetted code
export const famousOwners = new Set(
    `facebook facebookresearch meta-llama microsoft google google-research google-deepmind
    google-gemini googleapis vercel openai anthropics huggingface pytorch tensorflow torvalds
    rust-lang golang nodejs python apple aws awslabs kubernetes docker moby hashicorp ggerganov
    ggml-org ollama comfyanonymous automatic1111 lllyasviel oobabooga coqui-ai hexgrad suno-ai
    mozilla apache nvidia intel gitlab-org jetbrains sveltejs vuejs angular nestjs denoland oven-sh
    astral-sh pallets django tiangolo psf numpy pandas-dev scikit-learn matplotlib jupyter electron
    flutter dotnet homebrew ohmyzsh nvm-sh neovim vim git curl ffmpeg openssl postgres redis
    elastic grafana prometheus home-assistant supabase prisma tailwindlabs shadcn-ui langchain-ai
    run-llama ultralytics stability-ai black-forest-labs wan-video tencent deepseek-ai qwenlm
    mistralai vllm-project sgl-project xai-org lmstudio-ai invoke-ai unslothai expressjs webpack
    vitejs babel eslint prettier withastro remix-run solidjs preactjs nuxt storybookjs jestjs
    cypress-io puppeteer axios lodash fastify koajs socketio npm yarnpkg pnpm
    biomejs swc-project evanw rollup parcel-bundler gatsbyjs strapi tanstack trpc pmndrs reduxjs
    date-fns sindresorhus typicode cloudflare netlify tauri-apps ionic-team expo
    react-native-community software-mansion mui ant-design chakra-ui apollographql graphql encode
    pydantic python-poetry pypa pytest-dev pre-commit ansible scrapy celery explosion nltk
    streamlit gradio-app plotly pyca boto conda conda-forge mamba-org burntsushi sharkdp tokio-rs
    serde-rs clap-rs rust-lang-nursery alacritty wez helix-editor zellij-org nushell starship
    eza-community ajeetdsouza dandavison casey bevyengine rustdesk zed-industries pola-rs golangci
    spf13 gin-gonic gofiber labstack go-gorm junegunn jesseduffield charmbracelet cli gohugoio
    caddyserver traefik containerd etcd-io coredns cilium istio helm argoproj fluxcd rancher
    k3s-io kubernetes-sigs minio cockroachdb pingcap influxdata gravitational syncthing restic
    rclone go-gitea mattermost air-verse cosmtrek android googlesamples square
    kotlin spring-projects eclipse netflix alibaba reactivex swiftlang dart-lang julialang ziglang
    elixir-lang phoenixframework rails ruby rubygems laravel symfony php composer wordpress
    godotengine raysan5 ocornut libsdl-org glfw opencv keras-team jax-ml karpathy lm-sys nomic-ai
    mlc-ai ml-explore abetlen lightning-ai wandb mlflow ray-project dmlc github actions
    microsoftdocs azure azure-samples aws-samples pulumi nixos nix-community tmux zsh-users tpope
    folke nvim-lua nvim-treesitter lazyvim kovidgoyal ghostty-org mitchellh jqlang stedolan
    containers portainer nginx sqlite duckdb tursodatabase meilisearch typesense qdrant
    milvus-io chroma-core weaviate opentofu terraform-linters aquasecurity sigstore
    open-telemetry jaegertracing getsentry posthog calcom n8n-io appwrite pocketbase hasura
    nocodb directus excalidraw tldraw mermaid-js jgraph obsproject videolan audacity blender
    signalapp telegramdesktop bitwarden keepassxreboot`
        .split(/\s+/)
        .filter(Boolean),
);

// github.com/owner/repo from any clone or browse URL
export function repoOf(url: string): { short: string; owner: string; host: string } {
    const u = url
        .replace(/^git@([^:]+):/, "$1/")
        .replace(/^[a-z+]+:\/\//i, "")
        .replace(/^www\./, "")
        .replace(/\.git$/, "")
        .replace(/\/+$/, "");
    const [host = "", owner = "", name = ""] = u.split("/");
    const short = name ? `${host}/${owner}/${name}` : u;
    return { short: short.toLowerCase(), owner: owner.toLowerCase(), host: host.toLowerCase() };
}

export function isFamousRepo(url: string): boolean {
    return famousOwners.has(repoOf(url).owner);
}
