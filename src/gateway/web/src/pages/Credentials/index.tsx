import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { KeyRound, Loader2, Plus, Pencil, Trash2, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useCredentials } from '../../hooks/useCredentials';
import { CredentialDrawer } from './components/CredentialDrawer';
import type { Credential, CredentialType } from './credentialData';
import { CREDENTIAL_TYPE_LABELS, CREDENTIAL_TYPE_OPTIONS } from './credentialData';

const TYPE_BADGE_COLORS: Record<CredentialType, string> = {
    ssh_password: 'bg-emerald-50 text-emerald-700',
    ssh_key: 'bg-teal-50 text-teal-700',
    api_token: 'bg-purple-50 text-purple-700',
    api_basic_auth: 'bg-amber-50 text-amber-700',
};

export function CredentialsPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { credentials, loading, loadCredentials, createCredential, updateCredential, deleteCredential } = useCredentials(sendRpc);

    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState<CredentialType | ''>('');
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [editingCredential, setEditingCredential] = useState<Credential | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);

    const [envConfigs, setEnvConfigs] = useState<Array<{
        envId: string;
        envName: string;
        isTest: boolean;
        apiServer: string;
        hasKubeconfig: boolean;
        updatedAt: string | null;
    }>>([]);
    const [uploadEnvId, setUploadEnvId] = useState<string | null>(null);
    const [kubeContent, setKubeContent] = useState('');
    const [envSaving, setEnvSaving] = useState(false);

    const loadEnvConfigs = useCallback(async () => {
        try {
            const result = await sendRpc<{ configs: typeof envConfigs }>('userEnvConfig.list');
            setEnvConfigs(result.configs ?? []);
        } catch (err) {
            console.error('Failed to load env configs:', err);
        }
    }, [sendRpc]);

    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (isConnected && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadCredentials();
            loadEnvConfigs();
        }
    }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

    const filtered = useMemo(() => {
        let list = credentials;
        if (typeFilter) {
            list = list.filter(c => c.type === typeFilter);
        }
        if (search.trim()) {
            const q = search.toLowerCase();
            list = list.filter(c =>
                c.name.toLowerCase().includes(q) ||
                (c.description ?? '').toLowerCase().includes(q) ||
                c.configSummary.toLowerCase().includes(q)
            );
        }
        return list;
    }, [credentials, search, typeFilter]);

    const openCreate = () => {
        setEditingCredential(null);
        setDrawerOpen(true);
    };

    const openEdit = (cred: Credential) => {
        setEditingCredential(cred);
        setDrawerOpen(true);
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (deleting) return;
        setDeleting(id);
        try {
            await deleteCredential(id);
        } catch (err) {
            console.error('[Credentials] Delete failed:', err);
        } finally {
            setDeleting(null);
        }
    };

    const handleEnvUpload = async () => {
        if (!uploadEnvId || !kubeContent.trim()) return;
        setEnvSaving(true);
        try {
            await sendRpc('userEnvConfig.set', { envId: uploadEnvId, kubeconfig: kubeContent });
            setUploadEnvId(null);
            setKubeContent('');
            await loadEnvConfigs();
        } catch (err: any) {
            alert(err?.message || 'Failed to upload kubeconfig');
        } finally {
            setEnvSaving(false);
        }
    };

    const handleEnvRemove = async (envId: string) => {
        if (!window.confirm('Remove kubeconfig for this environment?')) return;
        try {
            await sendRpc('userEnvConfig.remove', { envId });
            await loadEnvConfigs();
        } catch (err) {
            console.error('Failed to remove env config:', err);
        }
    };

    return (
        <div className="h-full bg-white flex flex-col">
            <header className="h-16 flex items-center justify-between px-6 bg-white sticky top-0 z-10 border-b border-gray-100">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary-50 rounded-lg">
                        <KeyRound className="w-5 h-5 text-primary-600" />
                    </div>
                    <div>
                        <h1 className="text-lg font-bold text-gray-900">Credentials</h1>
                        <p className="text-xs text-gray-500">Manage your SSH and API credentials</p>
                    </div>
                </div>
                <button
                    onClick={openCreate}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    New Credential
                </button>
            </header>

            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-5xl mx-auto">
                    {/* K8s Environments — kubeconfig management */}
                    {envConfigs.length > 0 && (
                        <div className="mb-8">
                            <h2 className="text-sm font-semibold text-gray-900 mb-3">K8s Environments</h2>
                            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                                <table className="w-full">
                                    <thead>
                                        <tr className="border-b border-gray-100 bg-gray-50/50">
                                            <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Environment</th>
                                            <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                                            <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">API Server</th>
                                            <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                                            <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {envConfigs.map(env => (
                                            <tr key={env.envId} className="border-b border-gray-50 last:border-0">
                                                <td className="px-6 py-4">
                                                    <span className="text-sm font-medium text-gray-900">{env.envName}</span>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <span className={cn(
                                                        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                                                        env.isTest ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'
                                                    )}>
                                                        {env.isTest ? 'Test' : 'Prod'}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <span className="text-sm text-gray-500 font-mono text-xs">{env.apiServer}</span>
                                                </td>
                                                <td className="px-6 py-4">
                                                    {env.hasKubeconfig ? (
                                                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">Configured</span>
                                                    ) : (
                                                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">Not configured</span>
                                                    )}
                                                </td>
                                                <td className="px-6 py-4 text-center">
                                                    <div className="inline-flex items-center gap-1">
                                                        <button
                                                            onClick={() => { setUploadEnvId(env.envId); setKubeContent(''); }}
                                                            className="px-2 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded transition-colors"
                                                        >
                                                            {env.hasKubeconfig ? 'Replace' : 'Upload'}
                                                        </button>
                                                        {env.hasKubeconfig && (
                                                            <button
                                                                onClick={() => handleEnvRemove(env.envId)}
                                                                className="px-2 py-1 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded transition-colors"
                                                            >
                                                                Remove
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Kubeconfig upload dialog */}
                    {uploadEnvId && (
                        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setUploadEnvId(null)}>
                            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
                                <h3 className="text-lg font-semibold text-gray-900 mb-1">Upload Kubeconfig</h3>
                                <p className="text-sm text-gray-500 mb-4">
                                    Environment: {envConfigs.find(e => e.envId === uploadEnvId)?.envName}{' '}
                                    ({envConfigs.find(e => e.envId === uploadEnvId)?.apiServer})
                                </p>
                                <textarea
                                    value={kubeContent}
                                    onChange={e => setKubeContent(e.target.value)}
                                    placeholder="Paste kubeconfig YAML content..."
                                    rows={12}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none mb-4"
                                />
                                <div className="flex justify-end gap-3">
                                    <button onClick={() => setUploadEnvId(null)} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">Cancel</button>
                                    <button
                                        onClick={handleEnvUpload}
                                        disabled={!kubeContent.trim() || envSaving}
                                        className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
                                    >
                                        {envSaving ? 'Uploading...' : 'Upload'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Filters */}
                    <div className="flex items-center gap-3 mb-6">
                        <div className="relative flex-1 max-w-xs">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search credentials..."
                                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                            />
                        </div>
                        <select
                            value={typeFilter}
                            onChange={(e) => setTypeFilter(e.target.value as CredentialType | '')}
                            className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 bg-white"
                        >
                            <option value="">All Types</option>
                            {CREDENTIAL_TYPE_OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    </div>

                    {loading ? (
                        <div className="flex items-center justify-center py-20">
                            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="text-center py-20">
                            <KeyRound className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                            <h3 className="text-sm font-medium text-gray-900 mb-1">
                                {credentials.length === 0 ? 'No credentials yet' : 'No matching credentials'}
                            </h3>
                            <p className="text-xs text-gray-500">
                                {credentials.length === 0
                                    ? 'Create your first credential to get started.'
                                    : 'Try adjusting your search or filter.'}
                            </p>
                        </div>
                    ) : (
                        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-gray-100 bg-gray-50/50">
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Details</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Description</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Updated</th>
                                        <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map((cred) => (
                                        <tr
                                            key={cred.id}
                                            onClick={() => openEdit(cred)}
                                            className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors cursor-pointer"
                                        >
                                            <td className="px-6 py-4">
                                                <span className="text-sm font-medium text-gray-900">{cred.name}</span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className={cn(
                                                    "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                                                    TYPE_BADGE_COLORS[cred.type]
                                                )}>
                                                    {CREDENTIAL_TYPE_LABELS[cred.type]}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="text-sm text-gray-500 font-mono text-xs">{cred.configSummary}</span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="text-sm text-gray-500 truncate block max-w-[200px]">{cred.description || '-'}</span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="text-xs text-gray-400">
                                                    {cred.updatedAt ? new Date(cred.updatedAt).toLocaleDateString() : '-'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                <div className="inline-flex items-center gap-1">
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); openEdit(cred); }}
                                                        className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                                                        title="Edit"
                                                    >
                                                        <Pencil className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                        onClick={(e) => handleDelete(e, cred.id)}
                                                        disabled={deleting === cred.id}
                                                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                                                        title="Delete"
                                                    >
                                                        {deleting === cred.id ? (
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

            <CredentialDrawer
                credential={editingCredential}
                isOpen={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                onSave={async (data) => { await createCredential(data); }}
                onUpdate={async (id, data) => { await updateCredential(id, data); }}
            />
        </div>
    );
}
