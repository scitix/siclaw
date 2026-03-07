import { useState } from 'react';
import { Zap, ChevronDown } from 'lucide-react';
import { PROVIDER_PRESETS, type ProviderPreset, type PresetModel } from './providerPresets';
import { ConnectionTestButton } from './ConnectionTestButton';
import { useWebSocket } from '@/hooks/useWebSocket';

interface QuickSetupCardProps {
    onComplete: () => void;
}

export function QuickSetupCard({ onComplete }: QuickSetupCardProps) {
    const { sendRpc } = useWebSocket();
    const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
    const [isCustom, setIsCustom] = useState(false);

    // Form fields
    const [providerName, setProviderName] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [api, setApi] = useState<'openai-completions' | 'anthropic'>('openai-completions');
    const [selectedModel, setSelectedModel] = useState<PresetModel | null>(null);
    const [customModelId, setCustomModelId] = useState('');
    const [customModelName, setCustomModelName] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const selectPreset = (preset: ProviderPreset) => {
        setSelectedPreset(preset);
        setIsCustom(false);
        setProviderName(preset.name);
        setBaseUrl(preset.baseUrl);
        setApi(preset.api);
        setSelectedModel(null);
        setError('');
        // Auto-select first LLM model
        const firstLlm = preset.models.find(m => m.category === 'llm');
        if (firstLlm) setSelectedModel(firstLlm);
    };

    const selectCustom = () => {
        setSelectedPreset(null);
        setIsCustom(true);
        setProviderName('');
        setBaseUrl('');
        setApi('openai-completions');
        setSelectedModel(null);
        setCustomModelId('');
        setCustomModelName('');
        setError('');
    };

    const handleSave = async () => {
        const name = providerName.trim();
        if (!name) { setError('Provider name is required'); return; }
        if (!apiKey) { setError('API Key is required'); return; }

        const modelId = isCustom ? customModelId.trim() : selectedModel?.id;
        const modelName = isCustom ? (customModelName.trim() || customModelId.trim()) : selectedModel?.name;
        if (!modelId) { setError('Please select or enter a model'); return; }

        setSaving(true);
        setError('');
        try {
            await sendRpc('provider.quickSetup', {
                provider: name,
                baseUrl: baseUrl.trim(),
                apiKey,
                api,
                authHeader: selectedPreset?.authHeader ?? false,
                model: {
                    id: modelId,
                    name: modelName,
                    reasoning: selectedModel?.reasoning ?? false,
                    contextWindow: selectedModel?.contextWindow ?? 128000,
                    maxTokens: selectedModel?.maxTokens ?? 65536,
                    category: selectedModel?.category ?? 'llm',
                },
                setAsDefault: true,
            });
            onComplete();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const showForm = selectedPreset || isCustom;
    const llmModels = selectedPreset?.models.filter(m => m.category === 'llm') ?? [];

    return (
        <div className="rounded-2xl border-2 border-dashed border-indigo-200 bg-indigo-50/30 p-8">
            <div className="flex items-center gap-2 mb-2">
                <Zap className="w-5 h-5 text-indigo-500" />
                <h3 className="text-lg font-semibold text-gray-900">Quick Setup</h3>
            </div>
            <p className="text-sm text-gray-500 mb-6">
                Select a provider to get started. You can add more providers later.
            </p>

            {/* Preset buttons */}
            <div className="flex flex-wrap gap-2 mb-6">
                {PROVIDER_PRESETS.map(preset => (
                    <button
                        key={preset.name}
                        onClick={() => selectPreset(preset)}
                        className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
                            selectedPreset?.name === preset.name
                                ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                    >
                        {preset.displayName}
                    </button>
                ))}
                <button
                    onClick={selectCustom}
                    className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
                        isCustom
                            ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                            : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                >
                    Custom
                </button>
            </div>

            {/* Form */}
            {showForm && (
                <div className="space-y-4 max-w-xl">
                    {isCustom && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Provider Name</label>
                            <input
                                type="text"
                                value={providerName}
                                onChange={(e) => setProviderName(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                                placeholder="e.g. my-provider"
                            />
                        </div>
                    )}

                    {/* API Type — locked by preset, only visible as label */}
                    {selectedPreset && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">API Type</label>
                            <div className="px-3 py-2 border border-gray-100 rounded-lg text-sm bg-gray-50 text-gray-500">
                                {selectedPreset.api === 'anthropic' ? 'Anthropic' : 'OpenAI Compatible'}
                            </div>
                        </div>
                    )}

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Base URL</label>
                        <input
                            type="text"
                            value={baseUrl}
                            onChange={(e) => setBaseUrl(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                            placeholder="https://api.example.com/v1"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                        <input
                            type="password"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                            placeholder="sk-..."
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                        {isCustom ? (
                            <div className="space-y-2">
                                <input
                                    type="text"
                                    value={customModelId}
                                    onChange={(e) => setCustomModelId(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                                    placeholder="Model ID (e.g. gpt-4o)"
                                />
                                <input
                                    type="text"
                                    value={customModelName}
                                    onChange={(e) => setCustomModelName(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                                    placeholder="Display name (optional)"
                                />
                            </div>
                        ) : (
                            <div className="relative">
                                <select
                                    value={selectedModel?.id ?? ''}
                                    onChange={(e) => {
                                        const m = llmModels.find(m => m.id === e.target.value);
                                        if (m) setSelectedModel(m);
                                    }}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 appearance-none pr-8"
                                >
                                    <option value="">Select a model</option>
                                    {llmModels.map(m => (
                                        <option key={m.id} value={m.id}>
                                            {m.name} {m.reasoning ? '(reasoning)' : ''}
                                        </option>
                                    ))}
                                </select>
                                <ChevronDown className="w-4 h-4 text-gray-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                            </div>
                        )}
                    </div>

                    {error && <p className="text-sm text-red-500">{error}</p>}

                    <div className="flex items-center gap-3 pt-2">
                        <ConnectionTestButton
                            baseUrl={baseUrl}
                            apiKey={apiKey}
                            api={api}
                        />
                        <button
                            onClick={handleSave}
                            disabled={saving || !apiKey}
                            className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {saving ? 'Saving...' : 'Save & Activate'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
