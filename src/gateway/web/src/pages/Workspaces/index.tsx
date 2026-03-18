import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, Boxes, Trash2, Pencil, Star } from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { WorkspaceDialog } from './WorkspaceDialog';
import type { Workspace } from '@/contexts/WorkspaceContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';

const COLORS: Record<string, string> = {
    indigo: 'bg-indigo-500',
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
    purple: 'bg-purple-500',
    teal: 'bg-teal-500',
    gray: 'bg-gray-400',
};

function getColorClass(color?: string): string {
    return COLORS[color ?? ''] ?? 'bg-indigo-500';
}

export function WorkspacesPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { reload: reloadSidebarWorkspaces } = useWorkspace();
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [editingWs, setEditingWs] = useState<Workspace | null>(null);
    const [isCreating, setIsCreating] = useState(false);
    const [skillCounts, setSkillCounts] = useState<Record<string, number>>({});
    const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
    const [clusterCounts, setClusterCounts] = useState<Record<string, number>>({});
    const hasLoadedRef = useRef(false);

    const loadWorkspaces = useCallback(async () => {
        if (!isConnected) return;
        try {
            const result = await sendRpc<{ workspaces: Workspace[] }>('workspace.list');
            const list = result.workspaces ?? [];
            setWorkspaces(list);

            // Load config counts for each non-default workspace
            for (const ws of list) {
                if (ws.isDefault) continue;
                sendRpc<{ skills: string[]; tools: string[]; clusters: string[] }>(
                    'workspace.getConfig', { id: ws.id }
                ).then(cfg => {
                    setSkillCounts(prev => ({ ...prev, [ws.id]: cfg.skills?.length ?? 0 }));
                    setToolCounts(prev => ({ ...prev, [ws.id]: cfg.tools?.length ?? 0 }));
                    setClusterCounts(prev => ({ ...prev, [ws.id]: cfg.clusters?.length ?? 0 }));
                }).catch(() => {});
            }
        } catch (err) {
            console.error('Failed to load workspaces:', err);
        }
    }, [isConnected, sendRpc]);

    useEffect(() => {
        if (isConnected && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadWorkspaces();
        }
    }, [isConnected, loadWorkspaces]);

    const handleDelete = async (ws: Workspace) => {
        if (ws.isDefault) return;
        if (!window.confirm(`Delete workspace "${ws.name}"? Sessions in this workspace will no longer be scoped.`)) return;
        try {
            await sendRpc('workspace.delete', { id: ws.id });
            await loadWorkspaces();
            reloadSidebarWorkspaces();
        } catch (err) {
            console.error('Failed to delete workspace:', err);
        }
    };

    const handleSaved = () => {
        setEditingWs(null);
        setIsCreating(false);
        loadWorkspaces();
        reloadSidebarWorkspaces();
    };

    return (
        <div className="h-full bg-white flex flex-col">
            <div className="flex-1 overflow-y-auto px-6 py-8 max-w-5xl mx-auto w-full">
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h1 className="text-lg font-semibold text-gray-900">Workspaces</h1>
                        <p className="text-sm text-gray-500 mt-1">
                            Isolated contexts with scoped skills, tools, and clusters.
                        </p>
                    </div>
                    <button
                        onClick={() => setIsCreating(true)}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
                    >
                        <Plus className="w-4 h-4" />
                        New Workspace
                    </button>
                </div>

                {workspaces.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-12">No workspaces configured</p>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {workspaces.map(ws => (
                            <div key={ws.id} className="rounded-2xl border border-gray-200 bg-white p-5 hover:shadow-md transition-shadow">
                                <div className="flex items-start justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <span className={`w-3 h-3 rounded-full ${getColorClass(ws.configJson?.color)}`} />
                                        <h3 className="text-base font-semibold text-gray-900">{ws.name}</h3>
                                        {ws.envType === 'test' && (
                                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 font-medium">TEST</span>
                                        )}
                                        {ws.envType === 'prod' && !ws.isDefault && (
                                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">PROD</span>
                                        )}
                                    </div>
                                    {ws.isDefault && (
                                        <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-600">
                                            <Star className="w-3 h-3" />
                                            Default
                                        </span>
                                    )}
                                </div>

                                <div className="space-y-1.5 mb-4 text-sm text-gray-500">
                                    {ws.isDefault ? (
                                        <div className="flex items-center gap-2">
                                            <Boxes className="w-3.5 h-3.5 text-gray-400" />
                                            <span>All skills, tools & clusters</span>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="flex items-center gap-2">
                                                <span className="w-3.5 text-center text-xs font-mono text-gray-400">S</span>
                                                <span>{skillCounts[ws.id] ?? 0} skills</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="w-3.5 text-center text-xs font-mono text-gray-400">T</span>
                                                <span>{toolCounts[ws.id] ?? 0} tools</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="w-3.5 text-center text-xs font-mono text-gray-400">E</span>
                                                <span>{clusterCounts[ws.id] ?? 0} clusters</span>
                                            </div>
                                        </>
                                    )}
                                </div>

                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setEditingWs(ws)}
                                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
                                    >
                                        <Pencil className="w-3.5 h-3.5" />
                                        {ws.isDefault ? 'View' : 'Edit'}
                                    </button>
                                    {!ws.isDefault && (
                                        <button
                                            onClick={() => handleDelete(ws)}
                                            className="flex items-center px-2 py-1.5 text-sm text-red-500 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                                            title="Delete workspace"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}

                        {/* Create card */}
                        <button
                            onClick={() => setIsCreating(true)}
                            className="rounded-2xl border-2 border-dashed border-gray-200 p-5 flex flex-col items-center justify-center gap-2 text-gray-400 hover:border-indigo-300 hover:text-indigo-500 transition-colors min-h-[160px]"
                        >
                            <Plus className="w-6 h-6" />
                            <span className="text-sm font-medium">Create Workspace</span>
                        </button>
                    </div>
                )}
            </div>

            {/* Edit / Create dialog */}
            {(editingWs || isCreating) && (
                <WorkspaceDialog
                    workspace={editingWs}
                    onClose={() => { setEditingWs(null); setIsCreating(false); }}
                    onSaved={handleSaved}
                    sendRpc={sendRpc}
                />
            )}
        </div>
    );
}
