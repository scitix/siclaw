import { useState, useEffect, useRef, useMemo } from 'react';
import { Plug, Loader2, Plus, Pencil, Trash2, Search, Power } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '../../hooks/useWebSocket';
import { usePermissions } from '../../hooks/usePermissions';
import { useMcpServers } from '../../hooks/useMcpServers';
import { McpServerDrawer } from './components/McpServerDrawer';
import type { McpServer, McpTransport } from './mcpServerData';
import { MCP_TRANSPORT_LABELS, MCP_TRANSPORT_OPTIONS } from './mcpServerData';

const TRANSPORT_BADGE_COLORS: Record<McpTransport, string> = {
    'streamable-http': 'bg-blue-50 text-blue-700',
    sse: 'bg-purple-50 text-purple-700',
    stdio: 'bg-emerald-50 text-emerald-700',
};

const SOURCE_BADGE_COLORS: Record<string, string> = {
    seed: 'bg-gray-50 text-gray-500',
    db: 'bg-indigo-50 text-indigo-600',
    file: 'bg-amber-50 text-amber-600',
};

export function McpServersPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { isAdmin } = usePermissions(sendRpc, isConnected);
    const { servers, loading, loadServers, createServer, updateServer, toggleServer, deleteServer } = useMcpServers(sendRpc);

    const [search, setSearch] = useState('');
    const [transportFilter, setTransportFilter] = useState<McpTransport | ''>('');
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [editingServer, setEditingServer] = useState<McpServer | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [toggling, setToggling] = useState<string | null>(null);

    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (!isConnected) { hasLoadedRef.current = false; return; }
        if (hasLoadedRef.current) return;
        hasLoadedRef.current = true;
        loadServers();
    }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

    const filtered = useMemo(() => {
        let list = servers;
        if (transportFilter) {
            list = list.filter(s => s.transport === transportFilter);
        }
        if (search.trim()) {
            const q = search.toLowerCase();
            list = list.filter(s =>
                s.name.toLowerCase().includes(q) ||
                (s.description ?? '').toLowerCase().includes(q) ||
                (s.url ?? '').toLowerCase().includes(q) ||
                (s.command ?? '').toLowerCase().includes(q)
            );
        }
        return list;
    }, [servers, search, transportFilter]);

    const openCreate = () => {
        setEditingServer(null);
        setDrawerOpen(true);
    };

    const openEdit = (server: McpServer) => {
        setEditingServer(server);
        setDrawerOpen(true);
    };

    const handleToggle = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (toggling) return;
        setToggling(id);
        try {
            await toggleServer(id);
        } catch (err) {
            console.error('[McpServers] Toggle failed:', err);
        } finally {
            setToggling(null);
        }
    };

    const handleDelete = async (e: React.MouseEvent, id: string, name: string) => {
        e.stopPropagation();
        if (deleting) return;
        if (!window.confirm(`Delete MCP server "${name}"?`)) return;
        setDeleting(id);
        try {
            await deleteServer(id);
        } catch (err: any) {
            console.error('[McpServers] Delete failed:', err);
            alert(`Delete failed: ${err?.message || 'Unknown error'}`);
        } finally {
            setDeleting(null);
        }
    };

    return (
        <div className="h-full bg-white flex flex-col">
            <header className="h-16 flex items-center justify-between px-6 bg-white sticky top-0 z-10 border-b border-gray-100">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary-50 rounded-lg">
                        <Plug className="w-5 h-5 text-primary-600" />
                    </div>
                    <div>
                        <h1 className="text-lg font-bold text-gray-900">MCP Servers</h1>
                        <p className="text-xs text-gray-500">Manage Model Context Protocol server connections</p>
                    </div>
                </div>
                {isAdmin && (
                    <button
                        onClick={openCreate}
                        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
                    >
                        <Plus className="w-4 h-4" />
                        New Server
                    </button>
                )}
            </header>

            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-5xl mx-auto">
                    {/* Filters */}
                    <div className="flex items-center gap-3 mb-6">
                        <div className="relative flex-1 max-w-xs">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search servers..."
                                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                            />
                        </div>
                        <select
                            value={transportFilter}
                            onChange={(e) => setTransportFilter(e.target.value as McpTransport | '')}
                            className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 bg-white"
                        >
                            <option value="">All Transports</option>
                            {MCP_TRANSPORT_OPTIONS.map(opt => (
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
                            <Plug className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                            <h3 className="text-sm font-medium text-gray-900 mb-1">
                                {servers.length === 0 ? 'No MCP servers yet' : 'No matching servers'}
                            </h3>
                            <p className="text-xs text-gray-500">
                                {servers.length === 0
                                    ? 'Register your first MCP server to get started.'
                                    : 'Try adjusting your search or filter.'}
                            </p>
                        </div>
                    ) : (
                        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-gray-100 bg-gray-50/50">
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Transport</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Endpoint</th>
                                        <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Source</th>
                                        {isAdmin && <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map((server) => (
                                        <tr
                                            key={server.id}
                                            onClick={isAdmin ? () => openEdit(server) : undefined}
                                            className={cn(
                                                "border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors",
                                                isAdmin && "cursor-pointer"
                                            )}
                                        >
                                            <td className="px-6 py-4">
                                                <div>
                                                    <span className="text-sm font-medium text-gray-900">{server.name}</span>
                                                    {server.description && (
                                                        <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[200px]">{server.description}</p>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className={cn(
                                                    "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                                                    TRANSPORT_BADGE_COLORS[server.transport] ?? 'bg-gray-50 text-gray-600'
                                                )}>
                                                    {MCP_TRANSPORT_LABELS[server.transport] ?? server.transport}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="text-xs text-gray-500 font-mono truncate block max-w-[240px]">
                                                    {server.url || server.command || '-'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                <span className={cn(
                                                    "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
                                                    server.enabled
                                                        ? "bg-green-50 text-green-700"
                                                        : "bg-gray-100 text-gray-500"
                                                )}>
                                                    <span className={cn(
                                                        "w-1.5 h-1.5 rounded-full",
                                                        server.enabled ? "bg-green-500" : "bg-gray-400"
                                                    )} />
                                                    {server.enabled ? 'Enabled' : 'Disabled'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className={cn(
                                                    "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                                                    SOURCE_BADGE_COLORS[server.source ?? 'db'] ?? 'bg-gray-50 text-gray-500'
                                                )}>
                                                    {server.source ?? 'db'}
                                                </span>
                                            </td>
                                            {isAdmin && (
                                                <td className="px-6 py-4 text-center">
                                                    <div className="inline-flex items-center gap-1">
                                                        <button
                                                            onClick={(e) => handleToggle(e, server.id)}
                                                            disabled={toggling === server.id}
                                                            className={cn(
                                                                "p-1.5 rounded-lg transition-colors",
                                                                server.enabled
                                                                    ? "text-green-600 hover:text-orange-600 hover:bg-orange-50"
                                                                    : "text-gray-400 hover:text-green-600 hover:bg-green-50",
                                                                "disabled:opacity-50"
                                                            )}
                                                            title={server.enabled ? 'Disable' : 'Enable'}
                                                        >
                                                            {toggling === server.id ? (
                                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                            ) : (
                                                                <Power className="w-3.5 h-3.5" />
                                                            )}
                                                        </button>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); openEdit(server); }}
                                                            className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                                                            title="Edit"
                                                        >
                                                            <Pencil className="w-3.5 h-3.5" />
                                                        </button>
                                                        <button
                                                            onClick={(e) => handleDelete(e, server.id, server.name)}
                                                            disabled={deleting === server.id}
                                                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                                                            title="Delete"
                                                        >
                                                            {deleting === server.id ? (
                                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                            ) : (
                                                                <Trash2 className="w-3.5 h-3.5" />
                                                            )}
                                                        </button>
                                                    </div>
                                                </td>
                                            )}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {isAdmin && (
                <McpServerDrawer
                    server={editingServer}
                    isOpen={drawerOpen}
                    onClose={() => setDrawerOpen(false)}
                    onSave={async (data) => { await createServer(data); }}
                    onUpdate={async (id, data) => { await updateServer(id, data); }}
                />
            )}
        </div>
    );
}
