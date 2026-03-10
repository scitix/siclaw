import { useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Environment {
    id: string;
    name: string;
    isTest: boolean;
    apiServer: string;
    allowedServers: string[];
    hasDefaultKubeconfig: boolean;
}

interface EnvironmentFormData {
    name: string;
    isTest: boolean;
    apiServer: string;
    allowedServers: string;
    defaultKubeconfig: string;
}

const EMPTY_FORM: EnvironmentFormData = {
    name: '',
    isTest: false,
    apiServer: '',
    allowedServers: '',
    defaultKubeconfig: '',
};

interface EnvironmentDialogProps {
    environment: Environment | null;
    onClose: () => void;
    onSaved: () => void;
    sendRpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

export function EnvironmentDialog({ environment, onClose, onSaved, sendRpc }: EnvironmentDialogProps) {
    const isNew = !environment;

    const [form, setForm] = useState<EnvironmentFormData>(() => {
        if (environment) {
            return {
                name: environment.name,
                isTest: environment.isTest,
                apiServer: environment.apiServer,
                allowedServers: environment.allowedServers.join(', '),
                defaultKubeconfig: '',
            };
        }
        return { ...EMPTY_FORM };
    });
    const [saving, setSaving] = useState(false);

    const updateField = <K extends keyof EnvironmentFormData>(key: K, value: EnvironmentFormData[K]) => {
        setForm(prev => ({ ...prev, [key]: value }));
    };

    const handleSave = async () => {
        if (!form.name.trim() || !form.apiServer.trim()) return;
        setSaving(true);
        try {
            const allowedServers = form.allowedServers.trim()
                ? form.allowedServers.split(',').map(s => s.trim()).filter(Boolean)
                : undefined;
            const defaultKubeconfig = form.isTest && form.defaultKubeconfig.trim()
                ? form.defaultKubeconfig.trim()
                : undefined;

            if (isNew) {
                await sendRpc('environment.create', {
                    name: form.name.trim(),
                    isTest: form.isTest,
                    apiServer: form.apiServer.trim(),
                    allowedServers,
                    defaultKubeconfig,
                });
            } else {
                await sendRpc('environment.update', {
                    id: environment.id,
                    name: form.name.trim(),
                    isTest: form.isTest,
                    apiServer: form.apiServer.trim(),
                    allowedServers,
                    defaultKubeconfig,
                });
            }
            onSaved();
        } catch (err) {
            console.error('[Environments] Save failed:', err);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
            <div
                className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                    <h2 className="text-lg font-semibold text-gray-900">
                        {isNew ? 'Create Environment' : `Edit: ${environment.name}`}
                    </h2>
                    <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
                    {/* Name */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            Name <span className="text-red-400">*</span>
                        </label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={e => updateField('name', e.target.value)}
                            placeholder="production-us-east"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                        />
                    </div>

                    {/* Type toggle */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Type</label>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => updateField('isTest', false)}
                                className={cn(
                                    'flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors',
                                    !form.isTest
                                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                                        : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50',
                                )}
                            >
                                Production
                            </button>
                            <button
                                type="button"
                                onClick={() => updateField('isTest', true)}
                                className={cn(
                                    'flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors',
                                    form.isTest
                                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                                        : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50',
                                )}
                            >
                                Testing
                            </button>
                        </div>
                    </div>

                    {/* API Server */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                            API Server <span className="text-red-400">*</span>
                        </label>
                        <input
                            type="text"
                            value={form.apiServer}
                            onChange={e => updateField('apiServer', e.target.value)}
                            placeholder="https://10.0.1.100:6443"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                        />
                    </div>

                    {/* Allowed Servers */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Allowed Servers</label>
                        <input
                            type="text"
                            value={form.allowedServers}
                            onChange={e => updateField('allowedServers', e.target.value)}
                            placeholder="server1, server2, server3"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                        />
                        <p className="text-xs text-gray-400 mt-1">Comma-separated list of allowed server addresses</p>
                    </div>

                    {/* Default Kubeconfig (only when isTest) */}
                    {form.isTest && (
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Default Kubeconfig</label>
                            <textarea
                                value={form.defaultKubeconfig}
                                onChange={e => updateField('defaultKubeconfig', e.target.value)}
                                placeholder="Paste kubeconfig YAML here..."
                                rows={6}
                                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none"
                            />
                            {!isNew && environment.hasDefaultKubeconfig && !form.defaultKubeconfig.trim() && (
                                <p className="text-xs text-gray-400 mt-1">
                                    A kubeconfig is already configured. Leave empty to keep the existing one.
                                </p>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving || !form.name.trim() || !form.apiServer.trim()}
                        className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50"
                    >
                        {saving ? 'Saving...' : isNew ? 'Create' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}
