import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Globe, Plus, Pencil, Trash2, Loader2, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePermissions } from '@/hooks/usePermissions';

/* ---------- Types ---------- */

interface Environment {
    id: string;
    name: string;
    isTest: boolean;
    apiServer: string;
    allowedServers: string[];
    hasDefaultKubeconfig: boolean;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
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

const TYPE_BADGE_COLORS = {
    production: 'bg-blue-50 text-blue-700',
    testing: 'bg-amber-50 text-amber-700',
} as const;

/* ---------- Dialog ---------- */

interface DialogProps {
    environment: Environment | null;
    onClose: () => void;
    onSaved: () => void;
    sendRpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

function EnvironmentDialog({ environment, onClose, onSaved, sendRpc }: DialogProps) {
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

/* ---------- Page ---------- */

export function EnvironmentsPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { isAdmin, loaded: permLoaded } = usePermissions(sendRpc, isConnected);

    const [environments, setEnvironments] = useState<Environment[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingEnv, setEditingEnv] = useState<Environment | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const hasLoadedRef = useRef(false);

    const loadEnvironments = useCallback(async () => {
        setLoading(true);
        try {
            const result = await sendRpc<{ environments: Environment[] }>('environment.list');
            setEnvironments(result.environments ?? []);
        } catch (err) {
            console.error('[Environments] Failed to load:', err);
        } finally {
            setLoading(false);
        }
    }, [sendRpc]);

    useEffect(() => {
        if (isConnected && isAdmin && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadEnvironments();
        }
    }, [isConnected, isAdmin, loadEnvironments]);

    const filtered = useMemo(() => {
        if (!search.trim()) return environments;
        const q = search.toLowerCase();
        return environments.filter(env =>
            env.name.toLowerCase().includes(q) ||
            env.apiServer.toLowerCase().includes(q) ||
            env.allowedServers.some(s => s.toLowerCase().includes(q))
        );
    }, [environments, search]);

    const openCreate = () => {
        setEditingEnv(null);
        setDialogOpen(true);
    };

    const openEdit = (env: Environment) => {
        setEditingEnv(env);
        setDialogOpen(true);
    };

    const handleDelete = async (e: React.MouseEvent, env: Environment) => {
        e.stopPropagation();
        if (deleting) return;
        if (!window.confirm(`Delete environment "${env.name}"? This action cannot be undone.`)) return;
        setDeleting(env.id);
        try {
            await sendRpc('environment.delete', { id: env.id });
            await loadEnvironments();
        } catch (err) {
            console.error('[Environments] Delete failed:', err);
        } finally {
            setDeleting(null);
        }
    };

    const handleSaved = () => {
        setDialogOpen(false);
        setEditingEnv(null);
        loadEnvironments();
    };

    /* Permission guards */
    if (!permLoaded) {
        return (
            <div className="h-full flex items-center justify-center text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }

    if (!isAdmin) {
        return (
            <div className="h-full flex items-center justify-center text-gray-400">
                <div className="text-center">
                    <Globe className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                    <div className="text-lg font-medium text-gray-500 mb-1">Environments</div>
                    <div className="text-sm">Access denied. Admin access required.</div>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full bg-white flex flex-col">
            <header className="h-16 flex items-center justify-between px-6 bg-white sticky top-0 z-10 border-b border-gray-100">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary-50 rounded-lg">
                        <Globe className="w-5 h-5 text-primary-600" />
                    </div>
                    <div>
                        <h1 className="text-lg font-bold text-gray-900">Environments</h1>
                        <p className="text-xs text-gray-500">Manage Kubernetes environments and API server endpoints</p>
                    </div>
                </div>
                <button
                    onClick={openCreate}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    New Environment
                </button>
            </header>

            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-5xl mx-auto">
                    {/* Search */}
                    <div className="flex items-center gap-3 mb-6">
                        <div className="relative flex-1 max-w-xs">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search environments..."
                                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                            />
                        </div>
                    </div>

                    {loading ? (
                        <div className="flex items-center justify-center py-20">
                            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="text-center py-20">
                            <Globe className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                            <h3 className="text-sm font-medium text-gray-900 mb-1">
                                {environments.length === 0 ? 'No environments yet' : 'No matching environments'}
                            </h3>
                            <p className="text-xs text-gray-500">
                                {environments.length === 0
                                    ? 'Create your first environment to get started.'
                                    : 'Try adjusting your search.'}
                            </p>
                        </div>
                    ) : (
                        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-gray-100 bg-gray-50/50">
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">API Server</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Allowed Servers</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Created At</th>
                                        <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map((env) => (
                                        <tr
                                            key={env.id}
                                            onClick={() => openEdit(env)}
                                            className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors cursor-pointer"
                                        >
                                            <td className="px-6 py-4">
                                                <span className="text-sm font-medium text-gray-900">{env.name}</span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className={cn(
                                                    "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                                                    env.isTest ? TYPE_BADGE_COLORS.testing : TYPE_BADGE_COLORS.production,
                                                )}>
                                                    {env.isTest ? 'Testing' : 'Production'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="text-sm text-gray-500 font-mono text-xs">{env.apiServer}</span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="text-sm text-gray-500 truncate block max-w-[200px]">
                                                    {env.allowedServers.length > 0 ? env.allowedServers.join(', ') : '-'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="text-xs text-gray-400">
                                                    {env.createdAt ? new Date(env.createdAt).toLocaleDateString() : '-'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                <div className="inline-flex items-center gap-1">
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); openEdit(env); }}
                                                        className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                                                        title="Edit"
                                                    >
                                                        <Pencil className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                        onClick={(e) => handleDelete(e, env)}
                                                        disabled={deleting === env.id}
                                                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                                                        title="Delete"
                                                    >
                                                        {deleting === env.id ? (
                                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                        ) : (
                                                            <Trash2 className="w-3.5 h-3.5" />
                                                        )}
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {/* Create / Edit dialog */}
            {dialogOpen && (
                <EnvironmentDialog
                    environment={editingEnv}
                    onClose={() => { setDialogOpen(false); setEditingEnv(null); }}
                    onSaved={handleSaved}
                    sendRpc={sendRpc}
                />
            )}
        </div>
    );
}
