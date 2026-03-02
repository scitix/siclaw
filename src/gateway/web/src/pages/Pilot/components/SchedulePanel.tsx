import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Clock, Tag, ChevronRight, Save, Loader2, Check, AlertCircle, Trash2, Pause, Play, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { diffLines, type Change } from 'diff';
import type { PilotMessage } from '@/hooks/usePilot';

type RpcSendFn = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

interface ScheduleData {
    name: string;
    description: string;
    schedule: string;
    status: string;
}

interface ParsedResult {
    action: 'create' | 'update' | 'delete' | 'pause' | 'resume' | 'rename';
    id?: string;
    name?: string;
    newName?: string;
    schedule?: ScheduleData;
    summary?: string;
    error?: string;
}

interface CronJob {
    id: string;
    name: string;
    description?: string | null;
    schedule: string;
    status: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface SchedulePanelProps {
    message: PilotMessage;
    sendRpc: RpcSendFn;
    onSave: (message: PilotMessage) => void;
    onDismiss: (message: PilotMessage) => void;
    onClose: () => void;
    updateMessageMeta: (messageId: string, meta: Record<string, unknown>) => Promise<void>;
    selectedEnvId?: string | null;
}

/** Look up a schedule by ID or name via cron.list (fuzzy name matching) */
async function resolveSchedule(
    sendRpc: RpcSendFn,
    id: string | undefined,
    name: string | undefined,
    envId?: string | null,
): Promise<CronJob | null> {
    try {
        const result = await sendRpc<{ jobs: CronJob[] }>('cron.list');
        const pool = envId ? result.jobs.filter(j => (j as any).envId === envId) : result.jobs;
        if (id) {
            return pool.find(j => j.id === id) ?? null;
        }
        if (name) {
            const lower = name.toLowerCase();
            // Exact match first
            const exact = pool.find(j => j.name === name);
            if (exact) return exact;
            // Case-insensitive match
            const ci = pool.find(j => j.name.toLowerCase() === lower);
            if (ci) return ci;
            // Partial match (name contains search or search contains name)
            const partial = pool.find(j =>
                j.name.toLowerCase().includes(lower) || lower.includes(j.name.toLowerCase())
            );
            if (partial) return partial;
        }
        // If only one job exists, return it as fallback
        if (pool.length === 1) return pool[0];
        return null;
    } catch {
        return null;
    }
}

export function SchedulePanel({ message, sendRpc, onSave, onDismiss, onClose, updateMessageMeta, selectedEnvId }: SchedulePanelProps) {
    const metaState = (message.metadata as Record<string, unknown> | undefined)?.scheduleCard as string | undefined;
    const initialState: SaveState = (metaState === 'saved' || metaState === 'dismissed') ? 'saved' : 'idle';

    const [saveState, setSaveState] = useState<SaveState>(initialState);
    const [errorMsg, setErrorMsg] = useState('');
    const [oldJob, setOldJob] = useState<CronJob | null>(null);
    const [loadingOld, setLoadingOld] = useState(false);
    const [detailsExpanded, setDetailsExpanded] = useState(true);
    const [descExpanded, setDescExpanded] = useState(true);

    let parsed: ParsedResult | null = null;
    try {
        parsed = JSON.parse(message.content);
    } catch {
        // ignore
    }

    const action = parsed?.action;
    const scheduleInfo = parsed?.schedule;
    const isCreate = action === 'create';
    const isUpdate = action === 'update';
    const isDelete = action === 'delete';
    const isPause = action === 'pause';
    const isResume = action === 'resume';
    const isRename = action === 'rename';

    const displayName = isRename
        ? (parsed?.name || parsed?.id || '...')
        : (scheduleInfo?.name || parsed?.name || parsed?.id || '...');

    // Sync save state when metadata changes
    useEffect(() => {
        if (metaState === 'saved' || metaState === 'dismissed') {
            setSaveState('saved');
        }
    }, [metaState]);

    // Auto-execute pause/resume without user confirmation
    const autoExecuted = useRef(false);
    useEffect(() => {
        if (autoExecuted.current) return;
        if (saveState !== 'idle') return;
        const meta = message.metadata as Record<string, unknown> | undefined;
        if (meta?.scheduleCard) return; // Already processed
        if (isPause || isResume) {
            autoExecuted.current = true;
            handleSave();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPause, isResume, saveState]);

    // Fetch old schedule for diff (update mode)
    useEffect(() => {
        if (!isUpdate || !sendRpc) return;
        setLoadingOld(true);
        resolveSchedule(sendRpc, parsed?.id, parsed?.name ?? scheduleInfo?.name, selectedEnvId)
            .then(job => setOldJob(job))
            .catch(() => setOldJob(null))
            .finally(() => setLoadingOld(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isUpdate, parsed?.id, parsed?.name, scheduleInfo?.name, sendRpc, selectedEnvId]);

    // Compute diffs for update
    const cronChanged = isUpdate && oldJob && scheduleInfo && oldJob.schedule !== scheduleInfo.schedule;
    const statusChanged = isUpdate && oldJob && scheduleInfo && oldJob.status !== scheduleInfo.status;

    const descDiff = useMemo(() => {
        if (!isUpdate || !oldJob || !scheduleInfo) return null;
        const oldDesc = oldJob.description ?? '';
        const newDesc = scheduleInfo.description ?? '';
        if (oldDesc === newDesc) return null;
        const changes = diffLines(oldDesc, newDesc);
        if (changes.every(c => !c.added && !c.removed)) return null;
        return changes;
    }, [isUpdate, oldJob, scheduleInfo]);

    const isAlreadyUpToDate = isUpdate && oldJob && !cronChanged && !statusChanged && !descDiff;

    const handleSave = async () => {
        if (!parsed) return;
        if (!selectedEnvId) {
            setSaveState('error');
            setErrorMsg('Please select an environment first');
            return;
        }
        setSaveState('saving');
        setErrorMsg('');
        try {
            if (isCreate && scheduleInfo) {
                await sendRpc('cron.save', {
                    name: scheduleInfo.name,
                    description: scheduleInfo.description,
                    schedule: scheduleInfo.schedule,
                    status: scheduleInfo.status || 'active',
                    envId: selectedEnvId ?? null,
                });
            } else if (isUpdate && scheduleInfo) {
                const job = await resolveSchedule(sendRpc, parsed.id, parsed.name, selectedEnvId);
                if (!job) throw new Error('Schedule not found');
                await sendRpc('cron.save', {
                    id: job.id,
                    name: scheduleInfo.name,
                    description: scheduleInfo.description,
                    schedule: scheduleInfo.schedule,
                    status: scheduleInfo.status || 'active',
                    envId: selectedEnvId ?? null,
                });
            } else if (isDelete) {
                const job = await resolveSchedule(sendRpc, parsed.id, parsed.name, selectedEnvId);
                if (!job) throw new Error('Schedule not found');
                await sendRpc('cron.delete', { id: job.id });
            } else if (isPause || isResume) {
                const job = await resolveSchedule(sendRpc, parsed.id, parsed.name, selectedEnvId);
                if (!job) throw new Error('Schedule not found');
                await sendRpc('cron.setStatus', {
                    id: job.id,
                    status: isPause ? 'paused' : 'active',
                });
            } else if (isRename) {
                const job = await resolveSchedule(sendRpc, parsed.id, parsed.name, selectedEnvId);
                if (!job) throw new Error('Schedule not found');
                await sendRpc('cron.rename', {
                    id: job.id,
                    newName: parsed.newName,
                });
            }
            setSaveState('saved');
            await updateMessageMeta(message.id, { scheduleCard: 'saved' });
            onSave(message);
        } catch (err: any) {
            setSaveState('error');
            setErrorMsg(err?.message || 'Operation failed');
        }
    };

    const handleDismiss = async () => {
        await updateMessageMeta(message.id, { scheduleCard: 'dismissed' });
        onDismiss(message);
    };

    if (!parsed || parsed.error) {
        return (
            <div className="w-[480px] border-l border-gray-200 bg-white flex flex-col shrink-0">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                    <span className="text-sm text-gray-500">Invalid schedule data</span>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>
            </div>
        );
    }

    const actionConfig = getActionConfig(action!);
    const isAutoAction = isPause || isResume;

    // Auto-executed actions: compact inline status (no full panel)
    if (isAutoAction) {
        return (
            <div className="w-[320px] border-l border-gray-200 bg-white flex flex-col shrink-0">
                <div className={cn("px-4 py-3 border-b border-gray-200 bg-gradient-to-r flex items-center justify-between shrink-0", actionConfig.gradient)}>
                    <div className="flex items-center gap-2 min-w-0">
                        <Clock className={cn("w-4 h-4 shrink-0", actionConfig.iconColor)} />
                        <span className="font-semibold text-sm text-gray-900 truncate">{displayName}</span>
                    </div>
                    <button onClick={onClose} className="p-1 rounded hover:bg-white/60 transition-colors shrink-0">
                        <X className="w-4 h-4 text-gray-500" />
                    </button>
                </div>
                <div className="flex flex-col items-center justify-center py-8 px-4">
                    {saveState === 'saving' && (
                        <>
                            <Loader2 className={cn("w-8 h-8 mb-3 animate-spin", actionConfig.iconColor)} />
                            <span className="text-sm text-gray-600">
                                {isPause ? 'Pausing...' : 'Resuming...'}
                            </span>
                        </>
                    )}
                    {saveState === 'saved' && (
                        <>
                            <Check className="w-8 h-8 mb-3 text-green-500" />
                            <span className="text-sm font-medium text-green-600">
                                {isPause ? 'Schedule paused' : 'Schedule resumed'}
                            </span>
                        </>
                    )}
                    {saveState === 'error' && (
                        <>
                            <AlertCircle className="w-8 h-8 mb-3 text-red-500" />
                            <span className="text-sm font-medium text-red-600">{errorMsg}</span>
                            <button
                                onClick={() => { setSaveState('idle'); setErrorMsg(''); autoExecuted.current = false; }}
                                className="mt-3 px-3 py-1.5 rounded-lg text-xs font-medium text-red-600 hover:bg-red-50 border border-red-200"
                            >
                                Retry
                            </button>
                        </>
                    )}
                    {saveState === 'idle' && (
                        <>
                            <Loader2 className={cn("w-8 h-8 mb-3 animate-spin", actionConfig.iconColor)} />
                            <span className="text-sm text-gray-500">Preparing...</span>
                        </>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="w-[480px] border-l border-gray-200 bg-white flex flex-col shrink-0 h-full">
            {/* Header */}
            <div className={cn("px-4 py-3 border-b border-gray-200 bg-gradient-to-r flex items-center justify-between shrink-0", actionConfig.gradient)}>
                <div className="flex items-center gap-2 min-w-0">
                    <Clock className={cn("w-4 h-4 shrink-0", actionConfig.iconColor)} />
                    <span className="font-semibold text-sm text-gray-900 truncate">{displayName}</span>
                    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0", actionConfig.badgeColor)}>
                        <Tag className="w-2.5 h-2.5" />
                        {actionConfig.badge}
                    </span>
                </div>
                <button onClick={onClose} className="p-1 rounded hover:bg-white/60 transition-colors shrink-0">
                    <X className="w-4 h-4 text-gray-500" />
                </button>
            </div>

            {/* Summary */}
            {parsed.summary && (
                <div className="px-4 py-2 border-b border-gray-100 text-xs text-gray-600">
                    {parsed.summary}
                </div>
            )}

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto min-h-0">
                {loadingOld ? (
                    <div className="flex items-center justify-center py-12 text-gray-400">
                        <Loader2 className="w-5 h-5 animate-spin mr-2" />
                        <span className="text-sm">Loading current version...</span>
                    </div>
                ) : isAlreadyUpToDate ? (
                    <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                        <Check className="w-8 h-8 mb-2 text-green-400" />
                        <span className="text-sm font-medium text-green-600">Already up to date</span>
                        <span className="text-xs text-gray-400 mt-1">No changes detected</span>
                    </div>
                ) : (
                    <>
                        {/* Schedule Details section */}
                        {(scheduleInfo || isRename) && (
                            <div className="border-b border-gray-100">
                                <button
                                    type="button"
                                    className="flex items-center gap-2 w-full px-4 py-2.5 hover:bg-gray-50 transition-colors text-left"
                                    onClick={() => setDetailsExpanded(!detailsExpanded)}
                                >
                                    <ChevronRight className={cn(
                                        "w-3.5 h-3.5 text-gray-400 transition-transform",
                                        detailsExpanded && "rotate-90"
                                    )} />
                                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Schedule</span>
                                    {isUpdate && (cronChanged || statusChanged) && (
                                        <span className="ml-auto text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">changed</span>
                                    )}
                                </button>
                                {detailsExpanded && (
                                    <div className="px-4 pb-3 space-y-3">
                                        {/* Cron expression */}
                                        {scheduleInfo && (
                                            <div>
                                                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Cron Expression</span>
                                                {isUpdate && cronChanged && oldJob ? (
                                                    <div className="mt-1 space-y-1">
                                                        <div className="font-mono text-xs bg-red-50 text-red-700 px-2 py-1 rounded line-through">{oldJob.schedule}</div>
                                                        <div className="font-mono text-xs bg-green-50 text-green-700 px-2 py-1 rounded">{scheduleInfo.schedule}</div>
                                                    </div>
                                                ) : (
                                                    <div className="font-mono text-xs text-gray-700 bg-gray-50 px-2 py-1 rounded mt-1">{scheduleInfo.schedule}</div>
                                                )}
                                            </div>
                                        )}

                                        {/* Status */}
                                        {scheduleInfo && (
                                            <div>
                                                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Status</span>
                                                {isUpdate && statusChanged && oldJob ? (
                                                    <div className="mt-1 space-y-1">
                                                        <div className="text-xs bg-red-50 text-red-700 px-2 py-1 rounded line-through">{oldJob.status}</div>
                                                        <div className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded">{scheduleInfo.status}</div>
                                                    </div>
                                                ) : (
                                                    <div className="text-xs text-gray-700 bg-gray-50 px-2 py-1 rounded mt-1">
                                                        {scheduleInfo.status || 'active'}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Rename: old → new name */}
                                        {isRename && (
                                            <div>
                                                <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Name</span>
                                                <div className="mt-1 space-y-1">
                                                    <div className="text-xs bg-red-50 text-red-700 px-2 py-1 rounded line-through">{parsed?.name || parsed?.id}</div>
                                                    <div className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded">{parsed?.newName}</div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Description section */}
                        {(scheduleInfo?.description || (isUpdate && oldJob?.description)) && (
                            <div className="border-b border-gray-100">
                                <button
                                    type="button"
                                    className="flex items-center gap-2 w-full px-4 py-2.5 hover:bg-gray-50 transition-colors text-left"
                                    onClick={() => setDescExpanded(!descExpanded)}
                                >
                                    <ChevronRight className={cn(
                                        "w-3.5 h-3.5 text-gray-400 transition-transform",
                                        descExpanded && "rotate-90"
                                    )} />
                                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Description</span>
                                    {descDiff && (
                                        <span className="ml-auto text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">changed</span>
                                    )}
                                </button>
                                {descExpanded && (
                                    <div className="px-4 pb-3">
                                        {descDiff ? (
                                            <DiffView changes={descDiff} />
                                        ) : (
                                            <pre className="text-xs font-mono leading-relaxed text-gray-600 whitespace-pre-wrap">
                                                {scheduleInfo?.description || oldJob?.description || ''}
                                            </pre>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* For delete action, show confirmation info */}
                        {isDelete && !scheduleInfo && (
                            <div className="px-4 py-6 flex flex-col items-center text-center">
                                <actionConfig.Icon className={cn("w-8 h-8 mb-3", actionConfig.iconColor)} />
                                <span className="text-sm text-gray-600">
                                    This will permanently delete the schedule.
                                </span>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-gray-200 bg-gray-50/80 flex items-center justify-between shrink-0">
                <button
                    onClick={handleDismiss}
                    disabled={saveState === 'saving'}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-200 transition-colors"
                >
                    Dismiss
                </button>

                <div className="flex items-center gap-2">
                    {saveState === 'idle' && !isAlreadyUpToDate && (
                        <button
                            onClick={handleSave}
                            className={cn(
                                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-colors shadow-sm",
                                actionConfig.btnClass,
                            )}
                        >
                            <actionConfig.Icon className="w-3.5 h-3.5" />
                            {actionConfig.label}
                        </button>
                    )}
                    {saveState === 'idle' && isAlreadyUpToDate && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-600">
                            <Check className="w-3.5 h-3.5" />
                            Up to date
                        </span>
                    )}
                    {saveState === 'saving' && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-600">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Processing...
                        </span>
                    )}
                    {saveState === 'saved' && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-600">
                            <Check className="w-3.5 h-3.5" />
                            Done
                        </span>
                    )}
                    {saveState === 'error' && (
                        <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-xs text-red-600">
                                <AlertCircle className="w-3.5 h-3.5" />
                                {errorMsg}
                            </span>
                            <button
                                onClick={() => { setSaveState('idle'); setErrorMsg(''); }}
                                className="px-2.5 py-1 rounded-lg text-xs font-medium text-red-600 hover:bg-red-50 border border-red-200 transition-colors"
                            >
                                Retry
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Action-specific configuration */
function getActionConfig(action: string) {
    switch (action) {
        case 'delete':
            return {
                label: 'Delete Schedule', Icon: Trash2,
                btnClass: 'bg-red-600 hover:bg-red-700',
                gradient: 'from-red-50 to-orange-50',
                badge: 'Delete', badgeColor: 'bg-red-100 text-red-700',
                iconColor: 'text-red-500',
            };
        case 'pause':
            return {
                label: 'Pause Schedule', Icon: Pause,
                btnClass: 'bg-amber-600 hover:bg-amber-700',
                gradient: 'from-amber-50 to-orange-50',
                badge: 'Pause', badgeColor: 'bg-amber-100 text-amber-700',
                iconColor: 'text-amber-500',
            };
        case 'resume':
            return {
                label: 'Resume Schedule', Icon: Play,
                btnClass: 'bg-green-600 hover:bg-green-700',
                gradient: 'from-green-50 to-emerald-50',
                badge: 'Resume', badgeColor: 'bg-green-100 text-green-700',
                iconColor: 'text-green-500',
            };
        case 'rename':
            return {
                label: 'Rename Schedule', Icon: Pencil,
                btnClass: 'bg-blue-600 hover:bg-blue-700',
                gradient: 'from-blue-50 to-indigo-50',
                badge: 'Rename', badgeColor: 'bg-blue-100 text-blue-700',
                iconColor: 'text-blue-500',
            };
        case 'update':
            return {
                label: 'Update Schedule', Icon: Save,
                btnClass: 'bg-amber-600 hover:bg-amber-700',
                gradient: 'from-amber-50 to-orange-50',
                badge: 'Update', badgeColor: 'bg-amber-100 text-amber-700',
                iconColor: 'text-amber-500',
            };
        default:
            return {
                label: 'Save Schedule', Icon: Save,
                btnClass: 'bg-amber-600 hover:bg-amber-700',
                gradient: 'from-amber-50 to-yellow-50',
                badge: 'Create', badgeColor: 'bg-amber-100 text-amber-700',
                iconColor: 'text-amber-500',
            };
    }
}

/** Inline diff view with green/red highlighting */
function DiffView({ changes }: { changes: Change[] }) {
    return (
        <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap">
            {changes.map((part, i) => (
                <span
                    key={i}
                    className={cn(
                        part.added && "bg-green-100 text-green-800",
                        part.removed && "bg-red-100 text-red-800 line-through",
                        !part.added && !part.removed && "text-gray-500"
                    )}
                >
                    {part.value}
                </span>
            ))}
        </pre>
    );
}
