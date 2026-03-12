import { useState, useEffect } from 'react';
import { X, CheckCircle2, AlertTriangle, Loader2, Clock, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/Markdown';
import type { CronJob } from '../cronData';

type RpcSendFn = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

interface CronRun {
    id: string;
    status: string;
    resultText?: string | null;
    error?: string | null;
    durationMs?: number | null;
    createdAt?: string | null;
}

interface CronRunHistoryProps {
    job: CronJob;
    isOpen: boolean;
    onClose: () => void;
    sendRpc: RpcSendFn;
}

function formatTime(iso?: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    return d.toLocaleString();
}

function formatDuration(ms?: number | null): string {
    if (!ms) return '';
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function CronRunHistory({ job, isOpen, onClose, sendRpc }: CronRunHistoryProps) {
    const [runs, setRuns] = useState<CronRun[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedRun, setSelectedRun] = useState<CronRun | null>(null);

    useEffect(() => {
        if (isOpen) {
            setSelectedRun(null);
            loadRuns();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, job.id]);

    const loadRuns = async () => {
        setLoading(true);
        try {
            const result = await sendRpc<{ runs: CronRun[] }>('cron.runs', { jobId: job.id });
            setRuns(result.runs ?? []);
        } catch (err) {
            console.error('[CronRunHistory] Failed to load:', err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
                    />
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed right-0 top-0 bottom-0 w-[560px] bg-white shadow-2xl z-50 flex flex-col border-l border-gray-100"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                            <div className="min-w-0">
                                <h2 className="text-lg font-bold text-gray-900 truncate">{job.name}</h2>
                                <p className="text-xs text-gray-400">Execution History</p>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors flex-shrink-0"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto">
                            {loading ? (
                                <div className="flex items-center justify-center h-40 text-gray-400 text-sm gap-2">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Loading...
                                </div>
                            ) : runs.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-40 text-gray-400 text-sm">
                                    <Clock className="w-8 h-8 mb-2 text-gray-200" />
                                    No executions yet
                                </div>
                            ) : selectedRun ? (
                                /* Detail view for a selected run */
                                <div className="flex flex-col h-full">
                                    <button
                                        onClick={() => setSelectedRun(null)}
                                        className="px-6 py-2 text-xs text-primary-600 hover:text-primary-700 font-medium text-left border-b border-gray-100 hover:bg-gray-50"
                                    >
                                        &larr; Back to list
                                    </button>
                                    <div className="flex items-center gap-2 px-6 py-3 border-b border-gray-50">
                                        {selectedRun.status === 'success' ? (
                                            <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                                        ) : (
                                            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                                        )}
                                        <span className={cn(
                                            'text-sm font-medium',
                                            selectedRun.status === 'success' ? 'text-green-700' : 'text-red-700',
                                        )}>
                                            {selectedRun.status === 'success' ? 'Success' : 'Failed'}
                                        </span>
                                        <span className="text-xs text-gray-400">{formatTime(selectedRun.createdAt)}</span>
                                        {selectedRun.durationMs != null && (
                                            <span className="text-xs text-gray-400 ml-auto">{formatDuration(selectedRun.durationMs)}</span>
                                        )}
                                    </div>
                                    <div className="flex-1 overflow-y-auto px-6 py-4">
                                        {selectedRun.error ? (
                                            <div className="text-sm text-red-600 bg-red-50 rounded-lg p-3 mb-3">
                                                {selectedRun.error}
                                            </div>
                                        ) : null}
                                        {selectedRun.resultText ? (
                                            <div className="prose prose-sm prose-gray max-w-none">
                                                <Markdown>{selectedRun.resultText}</Markdown>
                                            </div>
                                        ) : (
                                            <p className="text-sm text-gray-400 italic">No output captured</p>
                                        )}
                                    </div>
                                </div>
                            ) : (
                                /* Run list */
                                <div>
                                    {runs.map((run) => (
                                        <button
                                            key={run.id}
                                            onClick={() => setSelectedRun(run)}
                                            className="w-full text-left px-6 py-3 border-b border-gray-50 hover:bg-gray-50/80 transition-colors flex items-center gap-3 group"
                                        >
                                            {run.status === 'success' ? (
                                                <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                                            ) : (
                                                <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                                            )}
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className={cn(
                                                        'text-sm font-medium',
                                                        run.status === 'success' ? 'text-green-700' : 'text-red-700',
                                                    )}>
                                                        {run.status === 'success' ? 'Success' : 'Failed'}
                                                    </span>
                                                    <span className="text-xs text-gray-400">{formatTime(run.createdAt)}</span>
                                                    {run.durationMs != null && (
                                                        <span className="text-xs text-gray-300">{formatDuration(run.durationMs)}</span>
                                                    )}
                                                </div>
                                                {run.error && (
                                                    <p className="text-xs text-red-500 truncate mt-0.5">{run.error}</p>
                                                )}
                                                {!run.error && run.resultText && (
                                                    <p className="text-xs text-gray-400 truncate mt-0.5">{run.resultText.replace(/[#*_`~\n]/g, ' ').slice(0, 80)}</p>
                                                )}
                                            </div>
                                            <FileText className="w-3.5 h-3.5 text-gray-300 group-hover:text-primary-500 flex-shrink-0 transition-colors" />
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
