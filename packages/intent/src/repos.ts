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
    vitejs babel eslint prettier`
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
