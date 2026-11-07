export const keyNamePattern = /^[A-Z][A-Z0-9_]{1,63}$/;

export const dependencyKeys: Readonly<Record<string, string>> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    "@anthropic-ai/sdk": "ANTHROPIC_API_KEY",
    elevenlabs: "ELEVENLABS_API_KEY",
    "@elevenlabs/elevenlabs-js": "ELEVENLABS_API_KEY",
    replicate: "REPLICATE_API_TOKEN",
    "fal-client": "FAL_KEY",
    "@fal-ai/client": "FAL_KEY",
    "google-genai": "GEMINI_API_KEY",
    "google-generativeai": "GEMINI_API_KEY",
    "@google/genai": "GEMINI_API_KEY",
    cohere: "COHERE_API_KEY",
    groq: "GROQ_API_KEY",
    "groq-sdk": "GROQ_API_KEY",
    "exa-py": "EXA_API_KEY",
    "exa-js": "EXA_API_KEY",
    mistralai: "MISTRAL_API_KEY",
    "@mistralai/mistralai": "MISTRAL_API_KEY",
};

const known = new Set(Object.values(dependencyKeys));

export function isApiKeyName(name: string, indexKeys: ReadonlySet<string>): boolean {
    return (
        known.has(name) ||
        indexKeys.has(name) ||
        name.endsWith("_API_KEY") ||
        name.endsWith("_API_TOKEN")
    );
}
