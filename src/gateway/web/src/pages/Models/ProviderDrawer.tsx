import { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { PROVIDER_PRESETS, type ProviderPreset } from './providerPresets';
import { ConnectionTestButton } from './ConnectionTestButton';

interface ProviderDrawerProps {
    isOpen: boolean;
    provider: { name: string; baseUrl: string; apiKeySet: boolean; api: string; authHeader?: boolean } | null;
    onClose: () => void;
    onSave: (data: { name: string; baseUrl: string; apiKey: string; api: string; authHeader: boolean }) => Promise<void>;
}

export function ProviderDrawer({ isOpen, provider, onClose, onSave }: ProviderDrawerProps) {
    const isEditing = !!provider;

    const [selectedPreset, setSelectedPreset] = useState<ProviderPreset | null>(null);
    const [name, setName] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [api, setApi] = useState<'openai-completions' | 'anthropic'>('openai-completions');
    const [authHeader, setAuthHeader] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (isOpen) {
            setError('');
            setSaving(false);
            setApiKey('');
            if (provider) {
                setName(provider.name);
                setBaseUrl(provider.baseUrl);
                setApi(provider.api as 'openai-completions' | 'anthropic');
                setAuthHeader(provider.authHeader ?? false);
                // Try to match a preset
                const preset = PROVIDER_PRESETS.find(p => p.name === provider.name);
                setSelectedPreset(preset ?? null);
            } else {
                setSelectedPreset(null);
                setName('');
                setBaseUrl('');
                setApi('openai-completions');
                setAuthHeader(false);
            }
        }
    }, [isOpen, provider]);

    const selectPreset = (preset: ProviderPreset) => {
        if (isEditing) return;
        setSelectedPreset(preset);
        setName(preset.name);
        setBaseUrl(preset.baseUrl);
        setApi(preset.api);
        setAuthHeader(preset.authHeader ?? false);
    };

    const selectCustom = () => {
        if (isEditing) return;
        setSelectedPreset(null);
        setName('');
        setBaseUrl('');
        setApi('openai-completions');
        setAuthHeader(false);
    };

    const handleSave = async () => {
        if (!name.trim()) { setError('Provider name is required'); return; }
        setSaving(true);
        setError('');
        try {
            await onSave({
                name: name.trim(),
                baseUrl: baseUrl.trim(),
                apiKey,
                api,
                authHeader,
            });
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
                    />
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed right-0 top-0 bottom-0 w-[480px] bg-white shadow-2xl z-50 flex flex-col border-l border-gray-100"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                            <div>
                                <h2 className="text-lg font-bold text-gray-900">
                                    {isEditing ? 'Edit Provider' : 'Add Provider'}
                                </h2>
                                <p className="text-xs text-gray-400">
                                    {isEditing ? provider.name : 'Configure a new model provider'}
                                </p>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6">
                            {/* Preset selector (add mode only) */}
                            {!isEditing && (
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-700">Provider Template</label>
                                    <div className="flex flex-wrap gap-2">
                                        {PROVIDER_PRESETS.map(preset => (
                                            <button
                                                key={preset.name}
                                                onClick={() => selectPreset(preset)}
                                                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                                                    selectedPreset?.name === preset.name
                                                        ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                                                }`}
                                            >
                                                {preset.displayName}
                                            </button>
                                        ))}
                                        <button
                                            onClick={selectCustom}
                                            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                                                !selectedPreset
                                                    ? 'border-indigo-500 bg-indigo-100 text-indigo-700'
                                                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                                            }`}
                                        >
                                            Custom
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Name */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">
                                    Provider Name <span className="text-red-500">*</span>
                                </label>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    disabled={isEditing}
                                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300 disabled:opacity-60 disabled:bg-gray-50"
                                    placeholder="e.g. openai, deepseek"
                                />
                            </div>

                            {/* API Type — locked when preset selected */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">API Type</label>
                                {selectedPreset ? (
                                    <div className="px-3 py-2 border border-gray-100 rounded-lg text-sm bg-gray-50 text-gray-500">
                                        {api === 'anthropic' ? 'Anthropic' : 'OpenAI Compatible'}
                                    </div>
                                ) : (
                                    <select
                                        value={api}
                                        onChange={(e) => {
                                            const val = e.target.value as 'openai-completions' | 'anthropic';
                                            setApi(val);
                                            setAuthHeader(val === 'anthropic');
                                        }}
                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                                    >
                                        <option value="openai-completions">OpenAI Compatible</option>
                                        <option value="anthropic">Anthropic</option>
                                    </select>
                                )}
                            </div>

                            {/* Base URL */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">Base URL</label>
                                <input
                                    type="text"
                                    value={baseUrl}
                                    onChange={(e) => setBaseUrl(e.target.value)}
                                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                                    placeholder="https://api.example.com/v1"
                                />
                            </div>

                            {/* API Key */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">
                                    API Key {isEditing && provider.apiKeySet && (
                                        <span className="text-gray-400 font-normal">(currently set)</span>
                                    )}
                                </label>
                                <input
                                    type="password"
                                    value={apiKey}
                                    onChange={(e) => setApiKey(e.target.value)}
                                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                                    placeholder={isEditing && provider.apiKeySet ? 'Leave blank to keep current key' : 'sk-...'}
                                />
                            </div>

                            {/* Test Connection */}
                            <ConnectionTestButton
                                baseUrl={baseUrl}
                                apiKey={isEditing && !apiKey && provider.apiKeySet ? '***' : apiKey}
                                api={api}
                                provider={isEditing ? provider.name : undefined}
                                disabled={!baseUrl || (!apiKey && !(isEditing && provider.apiKeySet))}
                            />

                            {error && <p className="text-xs text-red-500">{error}</p>}
                        </div>

                        {/* Footer */}
                        <div className="p-6 border-t border-gray-100 bg-white flex items-center justify-end gap-3">
                            <button
                                onClick={onClose}
                                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-50 rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={saving || !name.trim()}
                                className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 rounded-lg shadow-sm flex items-center gap-2 disabled:opacity-50"
                            >
                                <Save className="w-4 h-4" />
                                {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Provider'}
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
