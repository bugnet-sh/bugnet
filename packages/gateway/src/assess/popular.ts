export interface Popular {
    repo: string;
    // The real owner first, then accounts the project moved from
    owners: string[];
    // A plain word many unrelated projects share, so only a young copy counts as a lookalike
    generic?: boolean;
}

// Well-known AI and developer repos that lookalike copies imitate
export const popular: Popular[] = [
    { repo: "stable-diffusion-webui", owners: ["AUTOMATIC1111"] },
    { repo: "stable-diffusion-webui-forge", owners: ["lllyasviel"] },
    { repo: "ComfyUI", owners: ["comfyanonymous", "Comfy-Org"] },
    { repo: "Fooocus", owners: ["lllyasviel"] },
    { repo: "InvokeAI", owners: ["invoke-ai"] },
    { repo: "whisper", owners: ["openai"], generic: true },
    { repo: "whisper.cpp", owners: ["ggml-org", "ggerganov"] },
    { repo: "llama.cpp", owners: ["ggml-org", "ggerganov"] },
    { repo: "ollama", owners: ["ollama", "jmorganca"], generic: true },
    { repo: "kokoro", owners: ["hexgrad"], generic: true },
    { repo: "TTS", owners: ["coqui-ai", "idiap"], generic: true },
    { repo: "bark", owners: ["suno-ai"], generic: true },
    { repo: "ChatTTS", owners: ["2noise"] },
    { repo: "fish-speech", owners: ["fishaudio"] },
    { repo: "OpenVoice", owners: ["myshell-ai"] },
    { repo: "piper", owners: ["rhasspy", "OHF-Voice"], generic: true },
    { repo: "faster-whisper", owners: ["SYSTRAN", "guillaumekln"] },
    { repo: "whisperX", owners: ["m-bain"] },
    { repo: "Retrieval-based-Voice-Conversion-WebUI", owners: ["RVC-Project"] },
    { repo: "text-generation-webui", owners: ["oobabooga"] },
    { repo: "open-webui", owners: ["open-webui"], generic: true },
    { repo: "LocalAI", owners: ["mudler"], generic: true },
    { repo: "gpt4all", owners: ["nomic-ai"] },
    { repo: "anything-llm", owners: ["Mintplex-Labs"] },
    { repo: "vllm", owners: ["vllm-project"], generic: true },
    { repo: "FastChat", owners: ["lm-sys"], generic: true },
    { repo: "transformers", owners: ["huggingface"], generic: true },
    { repo: "diffusers", owners: ["huggingface"], generic: true },
    { repo: "generative-models", owners: ["Stability-AI"], generic: true },
    { repo: "stable-diffusion", owners: ["CompVis"], generic: true },
    { repo: "segment-anything", owners: ["facebookresearch"], generic: true },
    { repo: "ultralytics", owners: ["ultralytics"], generic: true },
    { repo: "yolov5", owners: ["ultralytics"], generic: true },
    { repo: "Deep-Live-Cam", owners: ["hacksider"] },
    { repo: "roop", owners: ["s0md3v"], generic: true },
    { repo: "DeepFaceLab", owners: ["iperov"] },
    { repo: "facefusion", owners: ["facefusion"], generic: true },
    { repo: "AutoGPT", owners: ["Significant-Gravitas"] },
    { repo: "langchain", owners: ["langchain-ai", "hwchase17"], generic: true },
    { repo: "lobe-chat", owners: ["lobehub"] },
    { repo: "DeepSeek-V3", owners: ["deepseek-ai"] },
    { repo: "claude-code", owners: ["anthropics"] },
    { repo: "gemini-cli", owners: ["google-gemini"] },
    { repo: "openai-python", owners: ["openai"] },
    { repo: "pytorch", owners: ["pytorch"], generic: true },
    { repo: "tensorflow", owners: ["tensorflow"], generic: true },
];
