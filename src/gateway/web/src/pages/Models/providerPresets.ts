export interface PresetModel {
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    category: 'llm' | 'embedding';
    dimensions?: number;
}

export interface ProviderPreset {
    name: string;
    displayName: string;
    baseUrl: string;
    api: 'openai-completions' | 'anthropic';
    authHeader?: boolean;
    models: PresetModel[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
    {
        name: 'openai',
        displayName: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        api: 'openai-completions',
        models: [
            { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: false, contextWindow: 200000, maxTokens: 32768, category: 'llm' },
            { id: 'gpt-4o', name: 'GPT-4o', reasoning: false, contextWindow: 128000, maxTokens: 16384, category: 'llm' },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini', reasoning: false, contextWindow: 128000, maxTokens: 16384, category: 'llm' },
            { id: 'o3', name: 'o3', reasoning: true, contextWindow: 200000, maxTokens: 100000, category: 'llm' },
            { id: 'o3-mini', name: 'o3-mini', reasoning: true, contextWindow: 200000, maxTokens: 100000, category: 'llm' },
            { id: 'o4-mini', name: 'o4-mini', reasoning: true, contextWindow: 200000, maxTokens: 100000, category: 'llm' },
            { id: 'text-embedding-3-small', name: 'Text Embedding 3 Small', reasoning: false, contextWindow: 8191, maxTokens: 0, category: 'embedding', dimensions: 1536 },
            { id: 'text-embedding-3-large', name: 'Text Embedding 3 Large', reasoning: false, contextWindow: 8191, maxTokens: 0, category: 'embedding', dimensions: 3072 },
        ],
    },
    {
        name: 'anthropic',
        displayName: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        api: 'anthropic',
        authHeader: true,
        models: [
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, contextWindow: 200000, maxTokens: 32000, category: 'llm' },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: false, contextWindow: 200000, maxTokens: 16384, category: 'llm' },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', reasoning: false, contextWindow: 200000, maxTokens: 8192, category: 'llm' },
        ],
    },
    {
        name: 'google',
        displayName: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        api: 'openai-completions',
        models: [
            { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', reasoning: true, contextWindow: 1048576, maxTokens: 65536, category: 'llm' },
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true, contextWindow: 1048576, maxTokens: 65536, category: 'llm' },
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoning: true, contextWindow: 1048576, maxTokens: 65536, category: 'llm' },
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', reasoning: false, contextWindow: 1048576, maxTokens: 8192, category: 'llm' },
        ],
    },
    {
        name: 'zhipu',
        displayName: 'Zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        api: 'openai-completions',
        models: [
            { id: 'glm-5', name: 'GLM-5', reasoning: true, contextWindow: 203000, maxTokens: 8192, category: 'llm' },
            { id: 'glm-4-plus', name: 'GLM-4 Plus', reasoning: false, contextWindow: 128000, maxTokens: 4096, category: 'llm' },
            { id: 'glm-4-long', name: 'GLM-4 Long', reasoning: false, contextWindow: 1000000, maxTokens: 4096, category: 'llm' },
            { id: 'glm-4-air', name: 'GLM-4 Air', reasoning: false, contextWindow: 128000, maxTokens: 4096, category: 'llm' },
            { id: 'glm-4-airx', name: 'GLM-4 AirX', reasoning: false, contextWindow: 128000, maxTokens: 4096, category: 'llm' },
            { id: 'glm-4-flash', name: 'GLM-4 Flash', reasoning: false, contextWindow: 128000, maxTokens: 4096, category: 'llm' },
            { id: 'glm-4-flashx', name: 'GLM-4 FlashX', reasoning: false, contextWindow: 128000, maxTokens: 4096, category: 'llm' },
            { id: 'embedding-3', name: 'Embedding 3', reasoning: false, contextWindow: 8192, maxTokens: 0, category: 'embedding', dimensions: 2048 },
        ],
    },
    {
        name: 'moonshot',
        displayName: 'Moonshot',
        baseUrl: 'https://api.moonshot.cn/v1',
        api: 'openai-completions',
        models: [
            { id: 'kimi-k2.5', name: 'Kimi K2.5', reasoning: false, contextWindow: 256000, maxTokens: 8192, category: 'llm' },
            { id: 'kimi-k2', name: 'Kimi K2', reasoning: false, contextWindow: 128000, maxTokens: 8192, category: 'llm' },
            { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K', reasoning: false, contextWindow: 128000, maxTokens: 4096, category: 'llm' },
            { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K', reasoning: false, contextWindow: 32000, maxTokens: 4096, category: 'llm' },
        ],
    },
];

export function findPreset(name: string): ProviderPreset | undefined {
    return PROVIDER_PRESETS.find(p => p.name === name.toLowerCase());
}
