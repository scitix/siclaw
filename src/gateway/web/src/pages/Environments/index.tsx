import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Globe, KeyRound, Plus, Pencil, Trash2, Loader2, Search, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePermissions } from '@/hooks/usePermissions';
import { ClusterDialog } from './components/ClusterDialog';
import { KubeconfigUploadDialog } from './components/KubeconfigUploadDialog';

/* ---------- Types ---------- */

interface Cluster {
    id: string;
    name: string;
    infraContext: string | null;
    isTest: boolean;
    apiServer: string;
    allowedServers: string[];
    debugImage: string | null;
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

type TabKey = 'clusters' | 'ssh' | 'api';

/* ---------- Page ---------- */

export function CredentialsPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { isAdmin, loaded: permLoaded } = usePermissions(sendRpc, isConnected);

    const [searchParams, setSearchParams] = useSearchParams();
    const rawTab = searchParams.get('tab');
    const activeTab: TabKey = rawTab === 'ssh' ? 'ssh' : rawTab === 'api' ? 'api' : rawTab === 'credentials' ? 'ssh' : 'clusters';
    const setActiveTab = (tab: TabKey) => {
        if (tab === 'clusters') {
            setSearchParams({});
        } else {
            setSearchParams({ tab });
        }
    };

    const [clusters, setClusters] = useState<Cluster[]>([]);
    const [isAdminFromServer, setIsAdminFromServer] = useState(false);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingCluster, setEditingCluster] = useState<Cluster | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
    const [uploadClusterId, setUploadClusterId] = useState<string | undefined>();
    const hasLoadedRef = useRef(false);

    const loadClusters = useCallback(async () => {
        setLoading(true);
        try {
            const result = await sendRpc<{ clusters: Cluster[]; isAdmin: boolean }>('cluster.list');
            setClusters(result.clusters ?? []);
            setIsAdminFromServer(result.isAdmin ?? false);
        } catch (err) {
            console.error('[Clusters] Failed to load:', err);
        } finally {
            setLoading(false);
        }
    }, [sendRpc]);

    useEffect(() => {
        if (isConnected && permLoaded && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadClusters();
        }
    }, [isConnected, permLoaded, loadClusters]);

    const filtered = useMemo(() => {
        if (!search.trim()) return clusters;
        const q = search.toLowerCase();
        return clusters.filter(c =>
            c.name.toLowerCase().includes(q) ||
            c.apiServer.toLowerCase().includes(q) ||
            c.allowedServers.some(s => s.toLowerCase().includes(q))
        );
    }, [clusters, search]);

    const openCreate = () => {
        setEditingCluster(null);
        setDialogOpen(true);
    };

    const openEdit = (cls: Cluster) => {
        setEditingCluster(cls);
        setDialogOpen(true);
    };

    const handleDelete = async (e: React.MouseEvent, cls: Cluster) => {
        e.stopPropagation();
        if (deleting) return;
        if (!window.confirm(`Delete cluster "${cls.name}"? This action cannot be undone.`)) return;
        setDeleting(cls.id);
        try {
            await sendRpc('cluster.delete', { id: cls.id });
            await loadClusters();
        } catch (err) {
            console.error('[Clusters] Delete failed:', err);
        } finally {
            setDeleting(null);
        }
    };

    const handleSaved = () => {
        setDialogOpen(false);
        setEditingCluster(null);
        loadClusters();
    };

    const openUploadDialog = (clusterId?: string) => {
        setUploadClusterId(clusterId);
        setUploadDialogOpen(true);
    };

    const handleUploadComplete = () => {
        setUploadDialogOpen(false);
        setUploadClusterId(undefined);
        loadClusters();
    };

    const handleRemoveKubeconfig = async (clusterId: string) => {
        if (!window.confirm('Remove your kubeconfig for this cluster?')) return;
        try {
            await sendRpc('userClusterConfig.remove', { clusterId });
            await loadClusters();
        } catch (err) {
            console.error('Failed to remove cluster config:', err);
        }
    };

    const uploadCluster = useMemo(() => clusters.find(c => c.id === uploadClusterId), [clusters, uploadClusterId]);

    const showAdmin = isAdmin || isAdminFromServer;

    /* Status badge for kubeconfig */
    const getStatusBadge = (cls: Cluster) => {
        if (cls.hasUserKubeconfig) {
            return (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
                    Configured
                </span>
            );
        }
        if (cls.hasDefaultKubeconfig && cls.isTest) {
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
                        <p className="text-xs text-gray-500">Manage Kubernetes clusters, SSH and API credentials</p>
                    </div>
                </div>
            </header>

            {/* Tab bar */}
            <div className="border-b border-gray-200 bg-white px-6">
                <nav className="flex gap-6 -mb-px">
                    {([
                        { key: 'clusters' as TabKey, label: 'Kubernetes' },
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
                    {activeTab !== 'clusters' ? (
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
                                        placeholder="Search clusters..."
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
                                        {clusters.length === 0 ? 'No clusters yet' : 'No matching clusters'}
                                    </h3>
                                    <p className="text-xs text-gray-500">
                                        {clusters.length === 0
                                            ? (showAdmin ? 'Create your first cluster to get started.' : 'No clusters have been configured yet.')
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
                                            {filtered.map((cls) => (
                                                <tr
                                                    key={cls.id}
                                                    className={cn(
                                                        "border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors",
                                                        showAdmin && "cursor-pointer",
                                                    )}
                                                    onClick={() => showAdmin && openEdit(cls)}
                                                >
                                                    <td className="px-6 py-4">
                                                        <span className="text-sm font-medium text-gray-900">{cls.name}</span>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <span className={cn(
                                                            "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                                                            cls.isTest ? TYPE_BADGE_COLORS.testing : TYPE_BADGE_COLORS.production,
                                                        )}>
                                                            {cls.isTest ? 'Testing' : 'Production'}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <span className="text-sm text-gray-500 font-mono text-xs">{cls.apiServer}</span>
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        {getStatusBadge(cls)}
                                                    </td>
                                                    <td className="px-6 py-4 text-center">
                                                        <div className="inline-flex items-center gap-1">
                                                            {/* Upload / Replace kubeconfig (all users) */}
                                                            {cls.hasUserKubeconfig ? (
                                                                <>
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); openUploadDialog(cls.id); }}
                                                                        className="px-2 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded transition-colors"
                                                                        title="Replace kubeconfig"
                                                                    >
                                                                        Replace
                                                                    </button>
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); handleRemoveKubeconfig(cls.id); }}
                                                                        className="px-2 py-1 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded transition-colors"
                                                                        title="Remove kubeconfig"
                                                                    >
                                                                        Remove
                                                                    </button>
                                                                </>
                                                            ) : (
                                                                <button
                                                                    onClick={(e) => { e.stopPropagation(); openUploadDialog(cls.id); }}
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
                                                                        onClick={(e) => { e.stopPropagation(); openEdit(cls); }}
                                                                        className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                                                                        title="Edit cluster"
                                                                    >
                                                                        <Pencil className="w-3.5 h-3.5" />
                                                                    </button>
                                                                    <button
                                                                        onClick={(e) => handleDelete(e, cls)}
                                                                        disabled={deleting === cls.id}
                                                                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                                                                        title="Delete cluster"
                                                                    >
                                                                        {deleting === cls.id ? (
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

            {/* Admin: Create / Edit cluster dialog */}
            {dialogOpen && showAdmin && (
                <ClusterDialog
                    cluster={editingCluster}
                    onClose={() => { setDialogOpen(false); setEditingCluster(null); }}
                    onSaved={handleSaved}
                    sendRpc={sendRpc}
                />
            )}

            {/* All users: Kubeconfig upload dialog */}
            {uploadDialogOpen && uploadCluster && (
                <KubeconfigUploadDialog
                    clusterId={uploadCluster.id}
                    clusterName={uploadCluster.name}
                    apiServer={uploadCluster.apiServer}
                    replacing={uploadCluster.hasUserKubeconfig}
                    onClose={() => { setUploadDialogOpen(false); setUploadClusterId(undefined); }}
                    onUploaded={handleUploadComplete}
                    sendRpc={sendRpc}
                />
            )}
        </div>
    );
}
