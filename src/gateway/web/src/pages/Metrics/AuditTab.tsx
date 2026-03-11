import { useState, useCallback, useEffect } from 'react';
import { Search, ChevronDown, ChevronRight, CheckCircle, XCircle, Ban, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePermissions } from '@/hooks/usePermissions';

interface AuditLog {
    id: string;
    userId: string | null;
    userName: string | null;
    toolName: string | null;
    toolInput: string | null;
    outcome: string | null;
    durationMs: number | null;
    timestamp: string;
}

interface AuditDetail {
    id: string;
    content: string;
    toolName: string | null;
    toolInput: string | null;
    outcome: string | null;
    durationMs: number | null;
    timestamp: string;
}

const DATE_RANGES = [
    { label: 'Last 1h', value: '1h', ms: 3600_000 },
    { label: 'Last 6h', value: '6h', ms: 21600_000 },
    { label: 'Last 24h', value: '24h', ms: 86400_000 },
    { label: 'Last 7d', value: '7d', ms: 604800_000 },
    { label: 'Last 30d', value: '30d', ms: 2592000_000 },
] as const;

const TOOL_OPTIONS = ['All', 'bash', 'restricted_bash', 'run_skill', 'node_exec', 'pod_exec', 'kubectl'] as const;
const STATUS_OPTIONS = ['All', 'success', 'error', 'blocked'] as const;

function parseToolInput(toolName: string | null, toolInput: string | null): string {
    if (!toolInput) return '—';
    try {
        const parsed = JSON.parse(toolInput);
        switch (toolName) {
            case 'bash':
            case 'restricted_bash':
                return parsed.command ?? toolInput;
            case 'run_skill':
                return [parsed.skill, parsed.script].filter(Boolean).join('/');
            case 'node_exec':
            case 'pod_exec':
                return parsed.command ?? toolInput;
            default:
                return toolInput.length > 100 ? toolInput.slice(0, 100) + '...' : toolInput;
        }
    } catch {
        return toolInput.length > 100 ? toolInput.slice(0, 100) + '...' : toolInput;
    }
}

function formatDuration(ms: number | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function OutcomeIcon({ outcome }: { outcome: string | null }) {
    switch (outcome) {
        case 'success':
            return <CheckCircle className="w-4 h-4 text-green-500" />;
        case 'error':
            return <XCircle className="w-4 h-4 text-red-500" />;
        case 'blocked':
            return <Ban className="w-4 h-4 text-amber-500" />;
        default:
            return <span className="text-gray-400 text-xs">—</span>;
    }
}

export function AuditTab() {
    const { sendRpc, isConnected } = useWebSocket();
    const { isAdmin } = usePermissions(sendRpc, isConnected);

    // Filters
    const [filterUser, setFilterUser] = useState('');
    const [filterTool, setFilterTool] = useState('All');
    const [filterStatus, setFilterStatus] = useState('All');
    const [filterRange, setFilterRange] = useState('24h');

    // Data
    const [logs, setLogs] = useState<AuditLog[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);

    // Expand detail
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [detailCache, setDetailCache] = useState<Record<string, AuditDetail>>({});
    const [detailLoading, setDetailLoading] = useState(false);

    const doSearch = useCallback(async (cursor?: { ts: number; id: string }) => {
        setLoading(true);
        try {
            const rangeMs = DATE_RANGES.find(r => r.value === filterRange)?.ms ?? 86400_000;
            const now = new Date();
            const startDate = new Date(now.getTime() - rangeMs).toISOString();
            const endDate = now.toISOString();

            const params: Record<string, unknown> = {
                startDate,
                endDate,
                limit: 50,
            };
            if (isAdmin && filterUser) params.userId = filterUser;
            if (filterTool !== 'All') params.toolName = filterTool;
            if (filterStatus !== 'All') params.outcome = filterStatus;
            if (cursor) {
                params.cursorTs = cursor.ts;
                params.cursorId = cursor.id;
            }

            const result = await sendRpc<{ logs: AuditLog[]; hasMore: boolean }>('audit.list', params);
            if (cursor) {
                setLogs(prev => [...prev, ...result.logs]);
            } else {
                setLogs(result.logs);
            }
            setHasMore(result.hasMore);
            setSearched(true);
        } catch (err) {
            console.error('[AuditTab] search failed:', err);
        } finally {
            setLoading(false);
        }
    }, [sendRpc, isAdmin, filterUser, filterTool, filterStatus, filterRange]);

    // Auto-load on mount when connected
    useEffect(() => {
        if (isConnected && !searched) doSearch();
    }, [isConnected, searched, doSearch]);

    const loadMore = useCallback(() => {
        if (logs.length === 0) return;
        const last = logs[logs.length - 1];
        const ts = Math.floor(new Date(last.timestamp).getTime() / 1000);
        doSearch({ ts, id: last.id });
    }, [logs, doSearch]);

    const toggleExpand = useCallback(async (id: string) => {
        if (expandedId === id) {
            setExpandedId(null);
            return;
        }
        setExpandedId(id);
        if (detailCache[id]) return;

        setDetailLoading(true);
        try {
            const detail = await sendRpc<AuditDetail>('audit.detail', { messageId: id });
            setDetailCache(prev => ({ ...prev, [id]: detail }));
        } catch (err) {
            console.error('[AuditTab] detail load failed:', err);
        } finally {
            setDetailLoading(false);
        }
    }, [expandedId, detailCache, sendRpc]);

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* Filter bar */}
            <div className="px-6 py-4 border-b border-gray-200 flex flex-wrap items-center gap-3">
                {isAdmin && (
                    <input
                        type="text"
                        placeholder="User ID"
                        value={filterUser}
                        onChange={e => setFilterUser(e.target.value)}
                        className="h-8 px-3 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 w-36"
                    />
                )}
                <select
                    value={filterTool}
                    onChange={e => setFilterTool(e.target.value)}
                    className="h-8 px-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
                >
                    {TOOL_OPTIONS.map(t => (
                        <option key={t} value={t}>{t === 'All' ? 'All Tools' : t}</option>
                    ))}
                </select>
                <select
                    value={filterStatus}
                    onChange={e => setFilterStatus(e.target.value)}
                    className="h-8 px-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
                >
                    {STATUS_OPTIONS.map(s => (
                        <option key={s} value={s}>{s === 'All' ? 'All Status' : s}</option>
                    ))}
                </select>
                <select
                    value={filterRange}
                    onChange={e => setFilterRange(e.target.value)}
                    className="h-8 px-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
                >
                    {DATE_RANGES.map(r => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                </select>
                <button
                    onClick={() => doSearch()}
                    disabled={loading}
                    className="h-8 px-4 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center gap-1.5"
                >
                    <Search className="w-3.5 h-3.5" />
                    Search
                </button>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto">
                {!searched ? (
                    <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                        Click Search to load audit logs
                    </div>
                ) : logs.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                        No audit logs found
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                            <tr>
                                <th className="text-left px-6 py-2.5 font-medium text-gray-500 w-10"></th>
                                <th className="text-left px-3 py-2.5 font-medium text-gray-500">Time</th>
                                <th className="text-left px-3 py-2.5 font-medium text-gray-500">User</th>
                                <th className="text-left px-3 py-2.5 font-medium text-gray-500">Tool</th>
                                <th className="text-left px-3 py-2.5 font-medium text-gray-500">Command</th>
                                <th className="text-center px-3 py-2.5 font-medium text-gray-500 w-16">Status</th>
                                <th className="text-right px-6 py-2.5 font-medium text-gray-500 w-20">Duration</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map(log => (
                                <LogRow
                                    key={log.id}
                                    log={log}
                                    expanded={expandedId === log.id}
                                    detail={detailCache[log.id]}
                                    detailLoading={detailLoading && expandedId === log.id}
                                    onToggle={() => toggleExpand(log.id)}
                                />
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Load more */}
            {hasMore && (
                <div className="px-6 py-3 border-t border-gray-200 flex justify-center">
                    <button
                        onClick={loadMore}
                        disabled={loading}
                        className="px-4 py-1.5 text-sm text-primary-600 hover:bg-primary-50 rounded-lg disabled:opacity-50 flex items-center gap-1.5"
                    >
                        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Load More
                    </button>
                </div>
            )}
        </div>
    );
}

function LogRow({
    log,
    expanded,
    detail,
    detailLoading,
    onToggle,
}: {
    log: AuditLog;
    expanded: boolean;
    detail?: AuditDetail;
    detailLoading: boolean;
    onToggle: () => void;
}) {
    const command = parseToolInput(log.toolName, log.toolInput);

    return (
        <>
            <tr
                onClick={onToggle}
                className={cn(
                    'cursor-pointer hover:bg-gray-50 border-b border-gray-100',
                    expanded && 'bg-gray-50',
                )}
            >
                <td className="px-6 py-2.5 text-gray-400">
                    {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </td>
                <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">
                    <span className="text-gray-400 text-xs mr-1">{formatDate(log.timestamp)}</span>
                    {formatTime(log.timestamp)}
                </td>
                <td className="px-3 py-2.5 text-gray-700 font-medium">{log.userName ?? log.userId ?? '—'}</td>
                <td className="px-3 py-2.5">
                    <span className="inline-block px-1.5 py-0.5 text-xs font-mono bg-gray-100 text-gray-600 rounded">
                        {log.toolName ?? '—'}
                    </span>
                </td>
                <td className="px-3 py-2.5 text-gray-600 max-w-xs truncate font-mono text-xs" title={command}>
                    {command}
                </td>
                <td className="px-3 py-2.5 text-center">
                    <OutcomeIcon outcome={log.outcome} />
                </td>
                <td className="px-6 py-2.5 text-right text-gray-500 tabular-nums">
                    {formatDuration(log.durationMs)}
                </td>
            </tr>
            {expanded && (
                <tr className="bg-gray-50">
                    <td colSpan={7} className="px-6 py-4">
                        {detailLoading ? (
                            <div className="flex items-center gap-2 text-gray-400 text-sm">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Loading...
                            </div>
                        ) : detail ? (
                            <DetailPanel detail={detail} />
                        ) : (
                            <div className="text-gray-400 text-sm">Failed to load details</div>
                        )}
                    </td>
                </tr>
            )}
        </>
    );
}

function DetailPanel({ detail }: { detail: AuditDetail }) {
    const [showFull, setShowFull] = useState(false);
    const content = detail.content || '';
    const isLong = content.length > 500;

    let parsedInput: Record<string, unknown> | null = null;
    try {
        if (detail.toolInput) parsedInput = JSON.parse(detail.toolInput);
    } catch { /* ignore */ }

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <span className="text-gray-400">Tool</span>
                <span className="font-mono text-gray-700">{detail.toolName}</span>

                {parsedInput && detail.toolName === 'run_skill' && (
                    <>
                        <span className="text-gray-400">Skill</span>
                        <span className="font-mono text-gray-700">{(parsedInput as any).skill}</span>
                        <span className="text-gray-400">Script</span>
                        <span className="font-mono text-gray-700">{(parsedInput as any).script}</span>
                        {(parsedInput as any).args && (
                            <>
                                <span className="text-gray-400">Args</span>
                                <span className="font-mono text-gray-700">{(parsedInput as any).args}</span>
                            </>
                        )}
                    </>
                )}

                {parsedInput && (detail.toolName === 'bash' || detail.toolName === 'restricted_bash') && (
                    <>
                        <span className="text-gray-400">Command</span>
                        <span className="font-mono text-gray-700 break-all">{(parsedInput as any).command}</span>
                    </>
                )}

                <span className="text-gray-400">Outcome</span>
                <span className={cn(
                    'font-medium',
                    detail.outcome === 'success' && 'text-green-600',
                    detail.outcome === 'error' && 'text-red-600',
                    detail.outcome === 'blocked' && 'text-amber-600',
                )}>
                    {detail.outcome ?? '—'}
                </span>

                <span className="text-gray-400">Duration</span>
                <span className="text-gray-700">{formatDuration(detail.durationMs)}</span>
            </div>

            {detail.toolInput && (
                <div>
                    <div className="text-xs text-gray-400 mb-1">Command</div>
                    <pre className="p-3 bg-gray-900 text-gray-100 rounded-lg text-xs font-mono overflow-auto max-h-64">
                        {detail.toolInput}
                    </pre>
                </div>
            )}

            {content && (
                <div>
                    <div className="text-xs text-gray-400 mb-1">Output</div>
                    <pre className={cn(
                        'p-3 bg-gray-900 text-gray-100 rounded-lg text-xs font-mono overflow-auto',
                        !showFull && isLong && 'max-h-48',
                    )}>
                        {showFull || !isLong ? content : content.slice(0, 500) + '...'}
                    </pre>
                    {isLong && (
                        <button
                            onClick={() => setShowFull(f => !f)}
                            className="mt-1 text-xs text-primary-600 hover:text-primary-700"
                        >
                            {showFull ? 'Show less' : 'Show full output'}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
