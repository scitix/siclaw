import { useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';

interface ModelEntry {
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    category: string;
    dimensions?: number;
}

interface ModelsDialogProps {
    provider: string;
    models: ModelEntry[];
    isAdmin: boolean;
    onClose: () => void;
    onAdd: (model: { id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; category: string }) => Promise<void>;
    onRemove: (modelId: string) => Promise<void>;
}

export function ModelsDialog({ provider, models, isAdmin, onClose, onAdd, onRemove }: ModelsDialogProps) {
    const [activeTab, setActiveTab] = useState<'llm' | 'embedding'>('llm');
    const [showAdd, setShowAdd] = useState(false);
    const [newId, setNewId] = useState('');
    const [newName, setNewName] = useState('');
    const [newContextWindow, setNewContextWindow] = useState(128000);
    const [newMaxTokens, setNewMaxTokens] = useState(65536);
    const [newReasoning, setNewReasoning] = useState(false);
    const [newDimensions, setNewDimensions] = useState(1024);
    const [saving, setSaving] = useState(false);
    const [removing, setRemoving] = useState<string | null>(null);

    const llmModels = models.filter(m => m.category !== 'embedding');
    const embeddingModels = models.filter(m => m.category === 'embedding');
    const currentModels = activeTab === 'llm' ? llmModels : embeddingModels;

    const resetForm = () => {
        setNewId('');
        setNewName('');
        setNewContextWindow(128000);
        setNewMaxTokens(65536);
        setNewReasoning(false);
        setNewDimensions(1024);
        setShowAdd(false);
    };

    const handleAdd = async () => {
        if (!newId.trim() || !newName.trim()) return;
        setSaving(true);
        try {
            await onAdd({
                id: newId.trim(),
                name: newName.trim(),
                contextWindow: activeTab === 'embedding' ? 0 : newContextWindow,
                maxTokens: activeTab === 'embedding' ? 0 : newMaxTokens,
                reasoning: activeTab === 'embedding' ? false : newReasoning,
                category: activeTab === 'embedding' ? 'embedding' : 'llm',
            });
            resetForm();
        } catch (err) {
            console.error('Failed to add model:', err);
        } finally {
            setSaving(false);
        }
    };

    const handleRemove = async (modelId: string) => {
        setRemoving(modelId);
        try {
            await onRemove(modelId);
        } catch (err) {
            console.error('Failed to remove model:', err);
        } finally {
            setRemoving(null);
        }
    };

    const handleTabChange = (tab: 'llm' | 'embedding') => {
        setActiveTab(tab);
        resetForm();
    };

    const tabs = [
        { id: 'llm' as const, label: 'Chat Models' },
        { id: 'embedding' as const, label: 'Embedding Models' },
    ];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
                <div className="px-6 py-4 border-b border-gray-100">
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="text-lg font-semibold text-gray-900">Models — {provider}</h2>
                        <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        {tabs.map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => handleTabChange(tab.id)}
                                className={[
                                    "px-3 py-1 rounded-full text-xs font-medium transition-all border",
                                    activeTab === tab.id
                                        ? "bg-gray-900 text-white border-gray-900"
                                        : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50 hover:text-gray-700"
                                ].join(' ')}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4">
                    {currentModels.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-8">
                            No {activeTab === 'embedding' ? 'embedding' : 'chat'} models configured
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {currentModels.map((m) => (
                                <div key={m.id} className="flex items-center justify-between px-4 py-3 rounded-xl border border-gray-100 bg-gray-50/50">
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-medium text-gray-900 truncate">{m.name}</div>
                                        <div className="text-xs text-gray-400 truncate">{m.id}</div>
                                        <div className="flex gap-3 mt-1 text-xs text-gray-400">
                                            {activeTab === 'embedding' ? (
                                                <span>Dimensions: {m.dimensions ?? '—'}</span>
                                            ) : (
                                                <>
                                                    <span>Context: {(m.contextWindow / 1000).toFixed(0)}k</span>
                                                    <span>Max: {(m.maxTokens / 1000).toFixed(0)}k</span>
                                                    {m.reasoning && <span className="text-indigo-500">Reasoning</span>}
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    {isAdmin && (
                                        <button
                                            onClick={() => handleRemove(m.id)}
                                            disabled={removing === m.id}
                                            className="ml-3 p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-50"
                                            title="Remove model"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {isAdmin && showAdd && (
                        <div className="mt-4 p-4 rounded-xl border border-indigo-100 bg-indigo-50/30 space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                                <div className="col-span-2">
                                    <label className="block text-xs font-medium text-gray-600 mb-1">Model ID</label>
                                    <input
                                        type="text"
                                        value={newId}
                                        onChange={(e) => setNewId(e.target.value)}
                                        className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                        placeholder={activeTab === 'embedding' ? 'e.g. BAAI/bge-m3' : 'e.g. openai/gpt-4o'}
                                    />
                                </div>
                                <div className="col-span-2">
                                    <label className="block text-xs font-medium text-gray-600 mb-1">Display Name</label>
                                    <input
                                        type="text"
                                        value={newName}
                                        onChange={(e) => setNewName(e.target.value)}
                                        className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                        placeholder={activeTab === 'embedding' ? 'e.g. BGE-M3' : 'e.g. GPT-4o'}
                                    />
                                </div>
                                {activeTab === 'embedding' ? (
                                    <div className="col-span-2">
                                        <label className="block text-xs font-medium text-gray-600 mb-1">Dimensions</label>
                                        <input
                                            type="number"
                                            value={newDimensions}
                                            onChange={(e) => setNewDimensions(Number(e.target.value))}
                                            className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                        />
                                    </div>
                                ) : (
                                    <>
                                        <div>
                                            <label className="block text-xs font-medium text-gray-600 mb-1">Context Window</label>
                                            <input
                                                type="number"
                                                value={newContextWindow}
                                                onChange={(e) => setNewContextWindow(Number(e.target.value))}
                                                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-medium text-gray-600 mb-1">Max Tokens</label>
                                            <input
                                                type="number"
                                                value={newMaxTokens}
                                                onChange={(e) => setNewMaxTokens(Number(e.target.value))}
                                                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                            />
                                        </div>
                                    </>
                                )}
                            </div>
                            {activeTab === 'llm' && (
                                <div className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        id="reasoning"
                                        checked={newReasoning}
                                        onChange={(e) => setNewReasoning(e.target.checked)}
                                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-300"
                                    />
                                    <label htmlFor="reasoning" className="text-sm text-gray-600">Reasoning model</label>
                                </div>
                            )}
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={() => setShowAdd(false)}
                                    className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleAdd}
                                    disabled={saving || !newId.trim() || !newName.trim()}
                                    className="px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                                >
                                    {saving ? 'Adding...' : 'Add'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100">
                    {isAdmin && !showAdd ? (
                        <button
                            onClick={() => setShowAdd(true)}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg"
                        >
                            <Plus className="w-4 h-4" />
                            Add {activeTab === 'embedding' ? 'Embedding' : 'Chat'} Model
                        </button>
                    ) : (
                        <div />
                    )}
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}
