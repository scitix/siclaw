import { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Layers, Globe, Key, Save, Trash2 } from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePermissions } from '@/hooks/usePermissions';
import { SettingsDialog } from './SettingsDialog';
import { ModelsDialog } from './ModelsDialog';

interface ProviderInfo {
    name: string;
    baseUrl: string;
    apiKey: string;
    apiKeySet: boolean;
    api: string;
    modelCount: number;
}

interface ModelEntry {
    id: string;
    name: string;
    provider: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    category: string;
}

interface EmbeddingConfig {
    provider: string;
    model: string;
    dimensions: number;
}

export function ModelsPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { isAdmin } = usePermissions(sendRpc, isConnected);

    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [allModels, setAllModels] = useState<ModelEntry[]>([]);
    const [defaultProvider, setDefaultProvider] = useState('');
    const [defaultModelId, setDefaultModelId] = useState('');
    const [savedDefault, setSavedDefault] = useState<{ provider: string; modelId: string } | null>(null);
    const [saving, setSaving] = useState(false);

    const [settingsProvider, setSettingsProvider] = useState<ProviderInfo | null>(null);
    const [modelsProvider, setModelsProvider] = useState<string | null>(null);

    // Embedding state
    const [embeddingProvider, setEmbeddingProvider] = useState('');
    const [embeddingModel, setEmbeddingModel] = useState('');
    const [embeddingDimensions, setEmbeddingDimensions] = useState(1024);
    const [savedEmbedding, setSavedEmbedding] = useState<EmbeddingConfig | null>(null);
    const [savingEmbedding, setSavingEmbedding] = useState(false);

    const hasLoadedRef = useRef(false);

    const loadProviders = useCallback(async () => {
        try {
            const result = await sendRpc<{ providers: ProviderInfo[] }>('provider.list');
            setProviders(result.providers ?? []);
        } catch (err) {
            console.error('Failed to load providers:', err);
        }
    }, [sendRpc]);

    const loadModels = useCallback(async () => {
        try {
            const result = await sendRpc<{ models: ModelEntry[]; default: { provider: string; modelId: string } | null }>('model.list');
            setAllModels(result.models ?? []);
            if (result.default) {
                setDefaultProvider(result.default.provider);
                setDefaultModelId(result.default.modelId);
                setSavedDefault(result.default);
            }
        } catch (err) {
            console.error('Failed to load models:', err);
        }
    }, [sendRpc]);

    const loadEmbeddingConfig = useCallback(async () => {
        try {
            const result = await sendRpc<{ config: EmbeddingConfig | null }>('embedding.getConfig');
            if (result.config) {
                setEmbeddingProvider(result.config.provider);
                setEmbeddingModel(result.config.model);
                setEmbeddingDimensions(result.config.dimensions);
                setSavedEmbedding(result.config);
            }
        } catch (err) {
            console.error('Failed to load embedding config:', err);
        }
    }, [sendRpc]);

    useEffect(() => {
        if (isConnected && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadProviders();
            loadModels();
            loadEmbeddingConfig();
        }
    }, [isConnected, loadProviders, loadModels, loadEmbeddingConfig]);

    const handleSaveDefault = async () => {
        if (!defaultProvider || !defaultModelId) return;
        setSaving(true);
        try {
            await sendRpc('config.setDefaultModel', { provider: defaultProvider, modelId: defaultModelId });
            setSavedDefault({ provider: defaultProvider, modelId: defaultModelId });
        } catch (err) {
            console.error('Failed to save default model:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleSaveSettings = async (providerName: string, baseUrl: string, apiKey: string) => {
        const params: Record<string, unknown> = { provider: providerName, baseUrl };
        if (apiKey) params.apiKey = apiKey;
        await sendRpc('provider.save', params);
        await loadProviders();
    };

    const handleAddModel = async (providerName: string, model: { id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; category: string }) => {
        await sendRpc('provider.addModel', { provider: providerName, model });
        await Promise.all([loadProviders(), loadModels()]);
    };

    const handleRemoveModel = async (providerName: string, modelId: string) => {
        await sendRpc('provider.removeModel', { provider: providerName, modelId });
        await Promise.all([loadProviders(), loadModels()]);
    };

    const handleDeleteProvider = async (providerName: string) => {
        if (!window.confirm(`Delete provider "${providerName}" and all its models?`)) return;
        try {
            await sendRpc('provider.delete', { provider: providerName });
            await Promise.all([loadProviders(), loadModels()]);
        } catch (err) {
            console.error('Failed to delete provider:', err);
        }
    };

    const handleSaveEmbedding = async () => {
        if (!embeddingProvider || !embeddingModel || !embeddingDimensions) return;
        setSavingEmbedding(true);
        try {
            await sendRpc('embedding.setConfig', {
                provider: embeddingProvider,
                model: embeddingModel,
                dimensions: embeddingDimensions,
            });
            setSavedEmbedding({ provider: embeddingProvider, model: embeddingModel, dimensions: embeddingDimensions });
        } catch (err) {
            console.error('Failed to save embedding config:', err);
        } finally {
            setSavingEmbedding(false);
        }
    };

    // Models for selected default provider
    const providerModels = allModels.filter(m => m.provider === defaultProvider && m.category !== 'embedding');
    const embeddingModels = allModels.filter(m => m.provider === embeddingProvider && m.category === 'embedding');

    // When provider changes, auto-select first model if current selection doesn't belong
    const handleProviderChange = (prov: string) => {
        setDefaultProvider(prov);
        const modelsForProv = allModels.filter(m => m.provider === prov && m.category !== 'embedding');
        if (modelsForProv.length > 0 && !modelsForProv.some(m => m.id === defaultModelId)) {
            setDefaultModelId(modelsForProv[0].id);
        }
    };

    const handleEmbeddingProviderChange = (prov: string) => {
        setEmbeddingProvider(prov);
        const modelsForProv = allModels.filter(m => m.provider === prov && m.category === 'embedding');
        if (modelsForProv.length > 0 && !modelsForProv.some(m => m.id === embeddingModel)) {
            setEmbeddingModel(modelsForProv[0].id);
        }
    };

    const defaultChanged = savedDefault
        ? defaultProvider !== savedDefault.provider || defaultModelId !== savedDefault.modelId
        : !!(defaultProvider && defaultModelId);

    const embeddingChanged = savedEmbedding
        ? embeddingProvider !== savedEmbedding.provider || embeddingModel !== savedEmbedding.model || embeddingDimensions !== savedEmbedding.dimensions
        : !!(embeddingProvider && embeddingModel);

    return (
        <div className="h-full bg-white flex flex-col">
            <div className="flex-1 overflow-y-auto px-6 py-8 max-w-5xl mx-auto w-full">
                {/* Default Chat Model */}
                <section className="mb-10">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">Default Chat Model</h2>
                    <div className="rounded-2xl border border-gray-200 bg-gray-50/50 p-6">
                        <p className="text-sm text-gray-500 mb-4">
                            The default model for new chat sessions.
                        </p>
                        <div className="flex flex-wrap items-end gap-4">
                            <div className="flex-1 min-w-[180px]">
                                <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                                <select
                                    value={defaultProvider}
                                    onChange={(e) => handleProviderChange(e.target.value)}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                                >
                                    <option value="">Select provider</option>
                                    {providers.map(p => (
                                        <option key={p.name} value={p.name}>{p.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex-1 min-w-[220px]">
                                <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                                <select
                                    value={defaultModelId}
                                    onChange={(e) => setDefaultModelId(e.target.value)}
                                    disabled={!defaultProvider}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 disabled:opacity-50"
                                >
                                    <option value="">Select model</option>
                                    {providerModels.map(m => (
                                        <option key={m.id} value={m.id}>{m.name}</option>
                                    ))}
                                </select>
                            </div>
                            {isAdmin && (
                                <button
                                    onClick={handleSaveDefault}
                                    disabled={saving || !defaultChanged || !defaultProvider || !defaultModelId}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Save className="w-4 h-4" />
                                    {saving ? 'Saving...' : 'Save'}
                                </button>
                            )}
                        </div>
                    </div>
                </section>

                {/* Default Embedding Model */}
                <section className="mb-10">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">Default Embedding Model</h2>
                    <div className="rounded-2xl border border-gray-200 bg-gray-50/50 p-6">
                        <p className="text-sm text-gray-500 mb-4">
                            Configure the embedding model used for memory search and semantic retrieval.
                        </p>
                        <div className="space-y-4">
                            <div className="flex flex-wrap items-end gap-4">
                                <div className="flex-1 min-w-[180px]">
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                                    <select
                                        value={embeddingProvider}
                                        onChange={(e) => handleEmbeddingProviderChange(e.target.value)}
                                        disabled={!isAdmin}
                                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 disabled:opacity-50"
                                    >
                                        <option value="">Select provider</option>
                                        {providers.map(p => (
                                            <option key={p.name} value={p.name}>{p.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="flex-1 min-w-[220px]">
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                                    <select
                                        value={embeddingModel}
                                        onChange={(e) => setEmbeddingModel(e.target.value)}
                                        disabled={!isAdmin || !embeddingProvider}
                                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 disabled:opacity-50"
                                    >
                                        <option value="">Select model</option>
                                        {embeddingModels.map(m => (
                                            <option key={m.id} value={m.id}>{m.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="w-[120px]">
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Dimensions</label>
                                    <input
                                        type="number"
                                        value={embeddingDimensions}
                                        onChange={(e) => setEmbeddingDimensions(Number(e.target.value) || 0)}
                                        disabled={!isAdmin}
                                        placeholder="1024"
                                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 disabled:opacity-50"
                                    />
                                </div>
                                {isAdmin && (
                                    <button
                                        onClick={handleSaveEmbedding}
                                        disabled={savingEmbedding || !embeddingChanged || !embeddingProvider || !embeddingModel || !embeddingDimensions}
                                        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        <Save className="w-4 h-4" />
                                        {savingEmbedding ? 'Saving...' : 'Save'}
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </section>

                {/* Provider Cards */}
                <section>
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">Providers</h2>
                    {providers.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-12">No providers configured</p>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {providers.map(p => (
                                <div key={p.name} className="rounded-2xl border border-gray-200 bg-white p-5 hover:shadow-md transition-shadow">
                                    <div className="flex items-start justify-between mb-3">
                                        <h3 className="text-base font-semibold text-gray-900">{p.name}</h3>
                                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{p.api}</span>
                                    </div>

                                    <div className="space-y-2 mb-4">
                                        <div className="flex items-center gap-2 text-sm text-gray-500">
                                            <Globe className="w-3.5 h-3.5 text-gray-400" />
                                            <span className="truncate">{p.baseUrl || 'Not set'}</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-sm text-gray-500">
                                            <Key className="w-3.5 h-3.5 text-gray-400" />
                                            <span>{p.apiKeySet ? p.apiKey : 'Not set'}</span>
                                        </div>
                                        <div className="flex items-center gap-2 text-sm text-gray-500">
                                            <Layers className="w-3.5 h-3.5 text-gray-400" />
                                            <span>{p.modelCount} model{p.modelCount !== 1 ? 's' : ''}</span>
                                        </div>
                                    </div>

                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setModelsProvider(p.name)}
                                            className="flex-1 px-3 py-1.5 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
                                        >
                                            Models
                                        </button>
                                        {isAdmin && (
                                            <>
                                                <button
                                                    onClick={() => setSettingsProvider(p)}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                                                >
                                                    <Settings className="w-3.5 h-3.5" />
                                                    Settings
                                                </button>
                                                <button
                                                    onClick={() => handleDeleteProvider(p.name)}
                                                    className="flex items-center px-2 py-1.5 text-sm text-red-500 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                                                    title="Delete provider"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>

            {/* Settings Dialog */}
            {settingsProvider && (
                <SettingsDialog
                    provider={settingsProvider.name}
                    baseUrl={settingsProvider.baseUrl}
                    apiKeySet={settingsProvider.apiKeySet}
                    onClose={() => setSettingsProvider(null)}
                    onSave={(baseUrl, apiKey) => handleSaveSettings(settingsProvider.name, baseUrl, apiKey)}
                />
            )}

            {/* Models Dialog */}
            {modelsProvider && (
                <ModelsDialog
                    provider={modelsProvider}
                    models={allModels.filter(m => m.provider === modelsProvider)}
                    isAdmin={isAdmin}
                    onClose={() => setModelsProvider(null)}
                    onAdd={(model) => handleAddModel(modelsProvider, model)}
                    onRemove={(modelId) => handleRemoveModel(modelsProvider, modelId)}
                />
            )}
        </div>
    );
}
