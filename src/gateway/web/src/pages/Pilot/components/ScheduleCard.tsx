import { useState, useEffect, useRef } from 'react';
import { Clock, Check, X, Layers, Eye, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
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

export type ScheduleCardStatus = 'pending' | 'saved' | 'dismissed' | 'superseded';

async function resolveSchedule(
    sendRpc: RpcSendFn,
    id: string | undefined,
    name: string | undefined,
    envId?: string | null,
): Promise<CronJob | null> {
    try {
        const result = await sendRpc<{ jobs: CronJob[] }>('cron.list');
        const pool = envId ? result.jobs.filter(j => (j as any).envId === envId) : result.jobs;
        if (id) return pool.find(j => j.id === id) ?? null;
        if (name) {
            const lower = name.toLowerCase();
            const exact = pool.find(j => j.name === name);
            if (exact) return exact;
            const ci = pool.find(j => j.name.toLowerCase() === lower);
            if (ci) return ci;
            const partial = pool.find(j =>
                j.name.toLowerCase().includes(lower) || lower.includes(j.name.toLowerCase())
            );
            if (partial) return partial;
        }
        if (pool.length === 1) return pool[0];
        return null;
    } catch {
        return null;
    }
}

export function ScheduleCard({ message, status, onOpenPanel, sendRpc, updateMessageMeta, selectedEnvId, selectedWorkspaceId }: {
    message: PilotMessage;
    status: ScheduleCardStatus;
    onOpenPanel?: (msg: PilotMessage) => void;
    sendRpc?: RpcSendFn;
    updateMessageMeta?: (messageId: string, meta: Record<string, unknown>) => Promise<void>;
    selectedEnvId?: string | null;
    selectedWorkspaceId?: string | null;
}) {
    const [execState, setExecState] = useState<'idle' | 'executing' | 'done' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState('');
    const autoExecRef = useRef(false);

    let parsed: ParsedResult | null = null;
    try {
        parsed = JSON.parse(message.content);
    } catch {
        // ignore
    }

    // Auto-execute on mount — only for pause/resume (other actions require manual confirmation via View panel)
    const isPauseResume = parsed?.action === 'pause' || parsed?.action === 'resume';
    useEffect(() => {
        if (!parsed || parsed.error || !sendRpc || !updateMessageMeta) return;
        if (autoExecRef.current) return;
        if (status === 'saved' || status === 'dismissed' || status === 'superseded') return;
        if (!isPauseResume) return;

        autoExecRef.current = true;
        autoExecute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status, isPauseResume]);

    const autoExecute = async () => {
        if (!parsed || !sendRpc || !updateMessageMeta) return;
        if (!selectedWorkspaceId) {
            setExecState('error');
            setErrorMsg('Please select a workspace first');
            return;
        }
        setExecState('executing');
        try {
            const action = parsed.action;
            if (action === 'create' && parsed.schedule) {
                await sendRpc('cron.save', {
                    name: parsed.schedule.name,
                    description: parsed.schedule.description,
                    schedule: parsed.schedule.schedule,
                    status: parsed.schedule.status || 'active',
                    envId: selectedEnvId ?? null,
                    workspaceId: selectedWorkspaceId ?? null,
                });
            } else if (action === 'update' && parsed.schedule) {
                const job = await resolveSchedule(sendRpc, parsed.id, parsed.name ?? parsed.schedule?.name, selectedEnvId);
                if (!job) throw new Error('Schedule not found');
                await sendRpc('cron.save', {
                    id: job.id,
                    name: parsed.schedule.name,
                    description: parsed.schedule.description,
                    schedule: parsed.schedule.schedule,
                    status: parsed.schedule.status || 'active',
                    envId: selectedEnvId ?? null,
                    workspaceId: selectedWorkspaceId ?? null,
                });
            } else if (action === 'delete') {
                const job = await resolveSchedule(sendRpc, parsed.id, parsed.name ?? parsed.schedule?.name, selectedEnvId);
                if (!job) throw new Error('Schedule not found');
                await sendRpc('cron.delete', { id: job.id });
            } else if (action === 'pause' || action === 'resume') {
                const job = await resolveSchedule(sendRpc, parsed.id, parsed.name ?? parsed.schedule?.name, selectedEnvId);
                if (!job) throw new Error('Schedule not found');
                await sendRpc('cron.setStatus', {
                    id: job.id,
                    status: action === 'pause' ? 'paused' : 'active',
                });
            } else if (action === 'rename') {
                const job = await resolveSchedule(sendRpc, parsed.id, parsed.name ?? parsed.schedule?.name, selectedEnvId);
                if (!job) throw new Error('Schedule not found');
                await sendRpc('cron.rename', { id: job.id, newName: parsed.newName });
            }
            setExecState('done');
            await updateMessageMeta(message.id, { scheduleCard: 'saved' });
        } catch (err: any) {
            setExecState('error');
            setErrorMsg(err?.message || 'Operation failed');
        }
    };

    if (!parsed || parsed.error) {
        return null;
    }

    const action = parsed.action;
    const isRename = action === 'rename';
    const isDelete = action === 'delete';
    const displayName = isRename
        ? `${parsed.name || parsed.id} → ${parsed.newName}`
        : (parsed.schedule?.name || parsed.name || parsed.id || '...');

    const getActionLabel = () => {
        switch (action) {
            case 'delete': return 'Deleted';
            case 'pause': return 'Paused';
            case 'resume': return 'Resumed';
            case 'rename': return 'Renamed';
            case 'update': return 'Updated';
            default: return 'Saved';
        }
    };

    const effectiveStatus = execState === 'done' ? 'saved' : status;

    return (
        <div className="pl-12">
            <div className={cn(
                "inline-flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors",
                effectiveStatus === 'saved' && "border-green-200 bg-green-50/50",
                effectiveStatus === 'dismissed' && "border-gray-200 bg-gray-50/50 opacity-60",
                effectiveStatus === 'superseded' && "border-gray-200 bg-gray-50/50 opacity-40",
                effectiveStatus === 'pending' && (
                    isDelete ? "border-red-200 bg-red-50/50" :
                    "border-amber-200 bg-amber-50/50"
                ),
                execState === 'error' && "border-red-200 bg-red-50/50",
            )}>
                <Clock className={cn(
                    "w-4 h-4 shrink-0",
                    effectiveStatus === 'saved' ? "text-green-500" :
                    effectiveStatus === 'dismissed' ? "text-gray-400" :
                    effectiveStatus === 'superseded' ? "text-gray-300" :
                    execState === 'error' ? "text-red-500" :
                    isDelete ? "text-red-500" :
                    "text-amber-500"
                )} />

                <span className={cn(
                    "text-sm font-medium",
                    effectiveStatus === 'superseded' ? "text-gray-400" : "text-gray-800"
                )}>
                    {displayName}
                </span>

                {parsed.schedule && (
                    <span className="font-mono text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                        {parsed.schedule.schedule}
                    </span>
                )}

                {/* Status badges */}
                {execState === 'executing' && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-600">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        Processing
                    </span>
                )}
                {execState === 'error' && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-600">
                        <AlertCircle className="w-2.5 h-2.5" />
                        {errorMsg}
                    </span>
                )}
                {execState !== 'executing' && execState !== 'error' && effectiveStatus === 'saved' && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">
                        <Check className="w-2.5 h-2.5" />
                        {getActionLabel()}
                    </span>
                )}
                {effectiveStatus === 'dismissed' && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">
                        <X className="w-2.5 h-2.5" />
                        Dismissed
                    </span>
                )}
                {effectiveStatus === 'superseded' && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-400">
                        <Layers className="w-2.5 h-2.5" />
                        Superseded
                    </span>
                )}

                {/* View button — only for non-auto actions or to inspect details */}
                {effectiveStatus !== 'superseded' && onOpenPanel && execState !== 'executing' && (
                    <button
                        onClick={() => onOpenPanel(message)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-gray-500 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                    >
                        <Eye className="w-3 h-3" />
                        View
                    </button>
                )}
            </div>
        </div>
    );
}
