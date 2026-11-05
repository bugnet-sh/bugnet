// Data-plane 10.3, the only hosts a secret may go to without the user confirming them
export interface Preset {
    service: string;
    names: readonly string[];
    hosts: readonly string[];
    headerNames: readonly string[];
}

export const presets: readonly Preset[] = [
    { service: "Hugging Face", names: ["HF_TOKEN"], hosts: ["huggingface.co"], headerNames: [] },
    {
        service: "GitHub",
        names: ["GH_TOKEN", "GITHUB_TOKEN"],
        hosts: ["api.github.com", "github.com", "uploads.github.com"],
        headerNames: [],
    },
    { service: "OpenAI", names: ["OPENAI_API_KEY"], hosts: ["api.openai.com"], headerNames: [] },
    {
        service: "Anthropic",
        names: ["ANTHROPIC_API_KEY"],
        hosts: ["api.anthropic.com"],
        headerNames: ["x-api-key"],
    },
    { service: "npm", names: ["NPM_TOKEN"], hosts: ["registry.npmjs.org"], headerNames: [] },
];

export function presetFor(name: string): Preset | undefined {
    return presets.find((p) => p.names.includes(name));
}

// Canonical hosts and header names that stay inside the named secret's preset
export function withinPreset(name: string, hosts: string[], headerNames: string[]): boolean {
    const p = presetFor(name);
    if (!p) return false;
    return (
        hosts.every((h) => p.hosts.includes(h)) &&
        headerNames.every((h) => p.headerNames.includes(h))
    );
}
