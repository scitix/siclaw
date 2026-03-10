import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Globe, KeyRound, Plus, Pencil, Trash2, Loader2, Search, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePermissions } from '@/hooks/usePermissions';
import { EnvironmentDialog } from './components/EnvironmentDialog';
import { KubeconfigUploadDialog } from './components/KubeconfigUploadDialog';
// import { CredentialsSection } from './components/CredentialsSection';

/* ---------- Types ---------- */

interface Environment {
    id: string;
    name: string;
    isTest: boolean;
    apiServer: string;
    allowedServers: string[];
    hasDefaultKubeconfig: boolean;
    hasUserKubeconfig: boolean;
    userConfigUpdatedAt: string | null;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
}

const TYPE_BADGE_COLORS = {
    production: 'bg-blue-50 text-blue-700',
    testing: 'bg-amber-50 text-amber-700',
} as const;

type TabKey = 'environments' | 'ssh' | 'api';

/* ---------- Page ---------- */

export function EnvironmentsPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { isAdmin, loaded: permLoaded } = usePermissions(sendRpc, isConnected);

    const [searchParams, setSearchParams] = useSearchParams();
    const rawTab = searchParams.get('tab');
    const activeTab: TabKey = rawTab === 'ssh' ? 'ssh' : rawTab === 'api' ? 'api' : rawTab === 'credentials' ? 'ssh' : 'environments';
    const setActiveTab = (tab: TabKey) => {
        if (tab === 'environments') {
            setSearchParams({});
        } else {
            setSearchParams({ tab });
        }
    };

    const [environments, setEnvironments] = useState<Environment[]>([]);
    const [isAdminFromServer, setIsAdminFromServer] = useState(false);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingEnv, setEditingEnv] = useState<Environment | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
    const [uploadEnvId, setUploadEnvId] = useState<string | undefined>();
    const hasLoadedRef = useRef(false);

    const loadEnvironments = useCallback(async () => {
        setLoading(true);
        try {
            const result = await sendRpc<{ environments: Environment[]; isAdmin: boolean }>('environment.list');
            setEnvironments(result.environments ?? []);
            setIsAdminFromServer(result.isAdmin ?? false);
        } catch (err) {
            console.error('[Environments] Failed to load:', err);
        } finally {
            setLoading(false);
        }
    }, [sendRpc]);

    useEffect(() => {
        if (isConnected && permLoaded && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadEnvironments();
        }
    }, [isConnected, permLoaded, loadEnvironments]);

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

    const openUploadDialog = (envId?: string) => {
        setUploadEnvId(envId);
        setUploadDialogOpen(true);
    };

    const handleUploadComplete = () => {
        setUploadDialogOpen(false);
        setUploadEnvId(undefined);
        loadEnvironments();
    };

    const handleRemoveKubeconfig = async (envId: string) => {
        if (!window.confirm('Remove your kubeconfig for this environment?')) return;
        try {
            await sendRpc('userEnvConfig.remove', { envId });
            await loadEnvironments();
        } catch (err) {
            console.error('Failed to remove env config:', err);
        }
    };

    const showAdmin = isAdmin || isAdminFromServer;

    /* Status badge for kubeconfig */
    const getStatusBadge = (env: Environment) => {
        if (env.hasUserKubeconfig) {
            return (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
                    Configured
                </span>
            );
        }
        if (env.hasDefaultKubeconfig && env.isTest) {
            return (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-teal-50 text-teal-700">
                    Default
                </span>
            );
        }
        return (
            <span className="text-xs text-gray-400">&mdash;</span>
        );
    };

    /* Permission guards */
    if (!permLoaded) {
        return (
            <div className="h-full flex items-center justify-center text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }

    return (
        <div className="h-full bg-white flex flex-col">
            <header className="h-16 flex items-center justify-between px-6 bg-white sticky top-0 z-10 border-b border-gray-100">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary-50 rounded-lg">
                        <KeyRound className="w-5 h-5 text-primary-600" />
                    </div>
                    <div>
                        <h1 className="text-lg font-bold text-gray-900">Credentials</h1>
                        <p className="text-xs text-gray-500">Manage Kubernetes environments, SSH and API credentials</p>
                    </div>
                </div>
            </header>

            {/* Tab bar */}
            <div className="border-b border-gray-200 bg-white px-6">
                <nav className="flex gap-6 -mb-px">
                    {([
                        { key: 'environments' as TabKey, label: 'Kubernetes' },
                        { key: 'ssh' as TabKey, label: 'SSH' },
                        { key: 'api' as TabKey, label: 'API' },
                    ]).map(tab => (
                        <button
                            key={tab.key}
                            onClick={() => setActiveTab(tab.key)}
                            className={cn(
                                'py-3 text-sm font-medium border-b-2 transition-colors',
                                activeTab === tab.key
                                    ? 'border-primary-600 text-primary-600'
                                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
                            )}
                        >
                            {tab.label}
                        </button>
                    ))}
                </nav>
            </div>

            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-5xl mx-auto">
                    {activeTab !== 'environments' ? (
                        <div className="text-center py-20">
                            <Globe className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                            <div className="text-lg font-medium text-gray-500 mb-1">
                                {activeTab === 'ssh' ? 'SSH Credentials' : 'API Credentials'}
                            </div>
                            <div className="text-sm text-gray-400">Coming soon</div>
                        </div>
                    ) : (
                        <>
                            {/* Search + New button */}
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
                                <div className="flex-1" />
                                {showAdmin && (
                                    <button
                                        onClick={openCreate}
                                        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
                                    >
                                        <Plus className="w-4 h-4" />
                                        New Kubernetes
                                    </button>
                                )}
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
                                            ? (showAdmin ? 'Create your first environment to get started.' : 'No environments have been configured yet.')
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
                                                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                                                <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filtered.map((env) => (
                                                <tr
                                                    key={env.id}
                                                    className={cn(
                                                        "border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors",
                                                        showAdmin && "cursor-pointer",
                                                    )}
                                                    onClick={() => showAdmin && openEdit(env)}
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
                                                        {getStatusBadge(env)}
                                                    </td>
                                                    <td className="px-6 py-4 text-center">
                                                        <div className="inline-flex items-center gap-1">
                                                            {/* Upload / Replace kubeconfig (all users) */}
                                                            {env.hasUserKubeconfig ? (
                                                                <>
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); openUploadDialog(env.id); }}
                                                                        className="px-2 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded transition-colors"
                                                                        title="Replace kubeconfig"
                                                                    >
                                                                        Replace
                                                                    </button>
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); handleRemoveKubeconfig(env.id); }}
                                                                        className="px-2 py-1 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded transition-colors"
                                                                        title="Remove kubeconfig"
                                                                    >
                                                                        Remove
                                                                    </button>
                                                                </>
                                                            ) : (
                                                                <button
                                                                    onClick={(e) => { e.stopPropagation(); openUploadDialog(env.id); }}
                                                                    className="px-2 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded transition-colors"
                                                                    title="Upload kubeconfig"
                                                                >
                                                                    <Upload className="w-3 h-3 inline mr-1" />
                                                                    Upload
                                                                </button>
                                                            )}

                                                            {/* Admin-only actions */}
                                                            {showAdmin && (
                                                                <>
                                                                    <span className="w-px h-4 bg-gray-200 mx-1" />
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); openEdit(env); }}
                                                                        className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                                                                        title="Edit environment"
                                                                    >
                                                                        <Pencil className="w-3.5 h-3.5" />
                                                                    </button>
                                                                    <button
                                                                        onClick={(e) => handleDelete(e, env)}
                                                                        disabled={deleting === env.id}
                                                                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                                                                        title="Delete environment"
                                                                    >
                                                                        {deleting === env.id ? (
                                                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                                        ) : (
                                                                            <Trash2 className="w-3.5 h-3.5" />
                                                                        )}
                                                                    </button>
                                                                </>
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* Admin: Create / Edit environment dialog */}
            {dialogOpen && showAdmin && (
                <EnvironmentDialog
                    environment={editingEnv}
                    onClose={() => { setDialogOpen(false); setEditingEnv(null); }}
                    onSaved={handleSaved}
                    sendRpc={sendRpc}
                />
            )}

            {/* All users: Kubeconfig upload dialog */}
            {uploadDialogOpen && (
                <KubeconfigUploadDialog
                    environments={environments.map(e => ({
                        id: e.id,
                        name: e.name,
                        apiServer: e.apiServer,
                        hasUserKubeconfig: e.hasUserKubeconfig,
                    }))}
                    initialEnvId={uploadEnvId}
                    onClose={() => { setUploadDialogOpen(false); setUploadEnvId(undefined); }}
                    onUploaded={handleUploadComplete}
                    sendRpc={sendRpc}
                />
            )}
        </div>
    );
}
