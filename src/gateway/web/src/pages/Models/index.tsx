import { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Layers, Globe, Key, Save, Trash2, Plus, ShieldX } from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePermissions } from '@/hooks/usePermissions';
import { ModelsDialog } from './ModelsDialog';
import { ProviderDrawer } from './ProviderDrawer';
import { QuickSetupCard } from './QuickSetupCard';

interface ProviderInfo {
    name: string;
    baseUrl: string;
    apiKey: string;
    apiKeySet: boolean;
    api: string;
    authHeader?: boolean;
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
    const { isAdmin, loaded } = usePermissions(sendRpc, isConnected);

    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [allModels, setAllModels] = useState<ModelEntry[]>([]);
    const [defaultValue, setDefaultValue] = useState('');
    const [savedDefault, setSavedDefault] = useState('');
    const [saving, setSaving] = useState(false);

    // Embedding state
    const [embeddingValue, setEmbeddingValue] = useState('');
    const [embeddingDimensions, setEmbeddingDimensions] = useState(1024);
    const [savedEmbedding, setSavedEmbedding] = useState<EmbeddingConfig | null>(null);
    const [savingEmbedding, setSavingEmbedding] = useState(false);

    // Drawer/dialog state
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [drawerProvider, setDrawerProvider] = useState<ProviderInfo | null>(null);
    const [modelsProvider, setModelsProvider] = useState<string | null>(null);

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
                const val = `${result.default.provider}::${result.default.modelId}`;
                setDefaultValue(val);
                setSavedDefault(val);
            }
        } catch (err) {
            console.error('Failed to load models:', err);
        }
    }, [sendRpc]);

    const loadEmbeddingConfig = useCallback(async () => {
        try {
            const result = await sendRpc<{ config: EmbeddingConfig | null }>('embedding.getConfig');
            if (result.config) {
                setEmbeddingValue(`${result.config.provider}::${result.config.model}`);
                setEmbeddingDimensions(result.config.dimensions);
                setSavedEmbedding(result.config);
            }
        } catch (err) {
            console.error('Failed to load embedding config:', err);
        }
    }, [sendRpc]);

    useEffect(() => {
        if (!isConnected) { hasLoadedRef.current = false; return; }
        if (hasLoadedRef.current) return;
        hasLoadedRef.current = true;
        loadProviders();
        loadModels();
        loadEmbeddingConfig();
    }, [isConnected, loadProviders, loadModels, loadEmbeddingConfig]);

    // Parse "provider::modelId" value
    const parseValue = (val: string) => {
        const idx = val.indexOf('::');
        if (idx < 0) return { provider: '', modelId: '' };
        return { provider: val.slice(0, idx), modelId: val.slice(idx + 2) };
    };

    const handleSaveDefault = async () => {
        const { provider, modelId } = parseValue(defaultValue);
        if (!provider || !modelId) return;
        setSaving(true);
        try {
            await sendRpc('config.setDefaultModel', { provider, modelId });
            setSavedDefault(defaultValue);
            try { new BroadcastChannel('siclaw-model-config').postMessage('default-changed'); } catch { /* ignore */ }
        } catch (err) {
            console.error('Failed to save default model:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleSaveEmbedding = async () => {
        const { provider, modelId } = parseValue(embeddingValue);
        if (!provider || !modelId || !embeddingDimensions) return;
        setSavingEmbedding(true);
        try {
            await sendRpc('embedding.setConfig', { provider, model: modelId, dimensions: embeddingDimensions });
            setSavedEmbedding({ provider, model: modelId, dimensions: embeddingDimensions });
        } catch (err) {
            console.error('Failed to save embedding config:', err);
        } finally {
            setSavingEmbedding(false);
        }
    };

    const handleSaveProvider = async (data: { name: string; baseUrl: string; apiKey: string; api: string; authHeader: boolean }) => {
        const params: Record<string, unknown> = { provider: data.name, baseUrl: data.baseUrl, api: data.api, authHeader: data.authHeader };
        if (data.apiKey) params.apiKey = data.apiKey;
        await sendRpc('provider.save', params);
        await loadProviders();
    };

    const handleAddModel = async (providerName: string, model: { id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; category: string }) => {
        await sendRpc('provider.addModel', { provider: providerName, model });
        await Promise.all([loadProviders(), loadModels()]);
    };

    const handleUpdateModel = async (providerName: string, modelId: string, updates: { name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }) => {
        await sendRpc('provider.updateModel', { provider: providerName, modelId, updates });
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

    const handleQuickSetupComplete = () => {
        loadProviders();
        loadModels();
    };

    const openAddDrawer = () => {
        setDrawerProvider(null);
        setDrawerOpen(true);
    };

    const openEditDrawer = (p: ProviderInfo) => {
        setDrawerProvider(p);
        setDrawerOpen(true);
    };

    // Build grouped model lists for selects
    const llmModels = allModels.filter(m => m.category !== 'embedding');
    const embeddingModels = allModels.filter(m => m.category === 'embedding');

    // Group by provider
    const groupByProvider = (models: ModelEntry[]) => {
        const groups: Record<string, ModelEntry[]> = {};
        for (const m of models) {
            (groups[m.provider] ??= []).push(m);
        }
        return groups;
    };

    const llmGroups = groupByProvider(llmModels);
    const embeddingGroups = groupByProvider(embeddingModels);

    if (loaded && !isAdmin) {
        return (
            <div className="h-full flex items-center justify-center">
                <div className="text-center">
                    <ShieldX className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Admin access required</h2>
                    <p className="text-sm text-gray-500">Only administrators can manage models.</p>
                </div>
            </div>
        );
    }

    const defaultChanged = defaultValue !== savedDefault;
    const embeddingChanged = savedEmbedding
        ? embeddingValue !== `${savedEmbedding.provider}::${savedEmbedding.model}` || embeddingDimensions !== savedEmbedding.dimensions
        : !!embeddingValue;

    return (
        <div className="h-full bg-white flex flex-col">
            <div className="flex-1 overflow-y-auto px-6 py-8 max-w-5xl mx-auto w-full">
                {/* Providers Section (primary, top) */}
                <section className="mb-10">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold text-gray-900">Providers</h2>
                        {isAdmin && providers.length > 0 && (
                            <button
                                onClick={openAddDrawer}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors"
                            >
                                <Plus className="w-4 h-4" />
                                Add Provider
                            </button>
                        )}
                    </div>

                    {providers.length === 0 ? (
                        isAdmin ? (
                            <QuickSetupCard onComplete={handleQuickSetupComplete} />
                        ) : (
                            <p className="text-sm text-gray-400 text-center py-12">No providers configured</p>
                        )
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
                                                    onClick={() => openEditDrawer(p)}
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

                {/* Defaults Section (bottom, compact) */}
                {providers.length > 0 && (
                    <>
                        <section className="mb-10">
                            <h2 className="text-lg font-semibold text-gray-900 mb-4">Default Chat Model</h2>
                            <div className="rounded-2xl border border-gray-200 bg-gray-50/50 p-6">
                                <p className="text-sm text-gray-500 mb-4">
                                    The default model for new chat sessions.
                                </p>
                                <div className="flex flex-wrap items-end gap-4">
                                    <div className="flex-1 min-w-[300px]">
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                                        <select
                                            value={defaultValue}
                                            onChange={(e) => setDefaultValue(e.target.value)}
                                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                                        >
                                            <option value="">Select model</option>
                                            {Object.entries(llmGroups).map(([provider, models]) => (
                                                <optgroup key={provider} label={provider}>
                                                    {models.map(m => (
                                                        <option key={`${provider}::${m.id}`} value={`${provider}::${m.id}`}>
                                                            {m.name}
                                                        </option>
                                                    ))}
                                                </optgroup>
                                            ))}
                                        </select>
                                    </div>
                                    {isAdmin && (
                                        <button
                                            onClick={handleSaveDefault}
                                            disabled={saving || !defaultChanged || !defaultValue}
                                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <Save className="w-4 h-4" />
                                            {saving ? 'Saving...' : 'Save'}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </section>

                        <section className="mb-10">
                            <h2 className="text-lg font-semibold text-gray-900 mb-4">Default Embedding Model</h2>
                            <div className="rounded-2xl border border-gray-200 bg-gray-50/50 p-6">
                                <p className="text-sm text-gray-500 mb-4">
                                    Configure the embedding model used for memory search and semantic retrieval.
                                </p>
                                <div className="space-y-4">
                                    <div className="flex flex-wrap items-end gap-4">
                                        <div className="flex-1 min-w-[300px]">
                                            <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                                            <select
                                                value={embeddingValue}
                                                onChange={(e) => setEmbeddingValue(e.target.value)}
                                                disabled={!isAdmin}
                                                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 disabled:opacity-50"
                                            >
                                                <option value="">Select model</option>
                                                {Object.entries(embeddingGroups).map(([provider, models]) => (
                                                    <optgroup key={provider} label={provider}>
                                                        {models.map(m => (
                                                            <option key={`${provider}::${m.id}`} value={`${provider}::${m.id}`}>
                                                                {m.name}
                                                            </option>
                                                        ))}
                                                    </optgroup>
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
                                                disabled={savingEmbedding || !embeddingChanged || !embeddingValue || !embeddingDimensions}
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
                    </>
                )}
            </div>

            {/* Provider Drawer */}
            <ProviderDrawer
                isOpen={drawerOpen}
                provider={drawerProvider}
                onClose={() => setDrawerOpen(false)}
                onSave={handleSaveProvider}
            />

            {/* Models Dialog */}
            {modelsProvider && (
                <ModelsDialog
                    provider={modelsProvider}
                    models={allModels.filter(m => m.provider === modelsProvider)}
                    isAdmin={isAdmin}
                    onClose={() => setModelsProvider(null)}
                    onAdd={(model) => handleAddModel(modelsProvider, model)}
                    onUpdate={(modelId, updates) => handleUpdateModel(modelsProvider, modelId, updates)}
                    onRemove={(modelId) => handleRemoveModel(modelsProvider, modelId)}
                />
            )}
        </div>
    );
}
