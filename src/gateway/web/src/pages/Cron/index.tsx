import { Plus, Timer, Play, Pause, Trash2, Search, Boxes } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useEffect, useRef } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useCronJobs } from '@/hooks/useCronJobs';
import type { CronJob } from './cronData';
import { CronDrawer } from './components/CronDrawer';
import { Tooltip } from '../../components/Tooltip';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useWorkspace } from '@/contexts/WorkspaceContext';

export function CronPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { jobs, loading, error, loadJobs, saveJob, deleteJob } = useCronJobs(sendRpc);
    const { currentWorkspace } = useWorkspace();
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [selectedJob, setSelectedJob] = useState<CronJob | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (isConnected && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadJobs();
        }
    }, [isConnected, loadJobs]);

    const handleCreate = () => {
        setSelectedJob(null);
        setIsDrawerOpen(true);
    };

    const handleEdit = (job: CronJob) => {
        setSelectedJob(job);
        setIsDrawerOpen(true);
    };

    const handleSave = async (updated: Partial<CronJob>) => {
        try {
            await saveJob({ ...updated, workspaceId: updated.workspaceId ?? currentWorkspace?.id ?? null });
            setIsDrawerOpen(false);
        } catch (err) {
            console.error('[CronPage] Save failed:', err);
            alert(err instanceof Error ? err.message : 'Failed to save schedule');
        }
    };

    const handleToggleStatus = async (e: React.MouseEvent, job: CronJob) => {
        e.stopPropagation();
        const newStatus = job.status === 'active' ? 'paused' : 'active';
        try {
            await saveJob({ ...job, status: newStatus });
        } catch (err) {
            console.error('[CronPage] Toggle failed:', err);
        }
    };

    const handleDeleteClick = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        setDeleteTarget(id);
    };

    const handleDeleteConfirm = async () => {
        if (!deleteTarget) return;
        try {
            await deleteJob(deleteTarget);
        } catch (err) {
            console.error('[CronPage] Delete failed:', err);
        } finally {
            setDeleteTarget(null);
        }
    };

    return (
        <div className="h-full bg-white flex flex-col">
            {/* Header */}
            <header className="h-16 flex items-center justify-end px-6 bg-white sticky top-0 z-10">
                <div className="flex items-center gap-2">
                    <div className="relative group">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-primary-500 transition-colors" />
                        <input
                            type="text"
                            placeholder="Search schedules..."
                            className="pl-9 pr-3 py-1.5 bg-gray-50 border-none rounded-md text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-200 w-48 transition-all"
                        />
                    </div>
                    <Tooltip content="Add Schedule">
                        <button
                            onClick={handleCreate}
                            className="p-2 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-all"
                        >
                            <Plus className="w-5 h-5" />
                        </button>
                    </Tooltip>
                </div>
            </header>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8 bg-white">
                {loading ? (
                    <div className="flex items-center justify-center h-40 text-gray-400 text-sm">Loading...</div>
                ) : error ? (
                    <div className="flex flex-col items-center justify-center h-40 text-red-400 text-sm gap-2">
                        <p>Failed to load schedules: {error}</p>
                        <button onClick={loadJobs} className="px-3 py-1 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 text-xs">Retry</button>
                    </div>
                ) : (
                <div className="max-w-6xl mx-auto space-y-4">
                    {jobs.map((job) => (
                        <div
                            key={job.id}
                            onClick={() => handleEdit(job)}
                            className="group bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md hover:border-primary-200 transition-all cursor-pointer relative overflow-hidden flex items-center gap-6"
                        >
                            {/* Status Indicator */}
                            <div className={cn(
                                "w-1 h-12 rounded-full shrink-0",
                                job.status === 'active' ? "bg-green-500" : "bg-gray-300"
                            )} />

                            <div className="flex-1 min-w-0">
                                <h3 className="font-bold text-gray-900 mb-1 group-hover:text-primary-600 transition-colors truncate">
                                    {job.name}
                                </h3>
                                <p className="text-sm text-gray-500 truncate mb-2">
                                    {job.description}
                                </p>
                                <div className="flex items-center gap-4 text-xs">
                                    <div className="flex items-center gap-1.5 text-gray-600 font-mono bg-gray-50 px-2 py-0.5 rounded">
                                        <Timer className="w-3 h-3 text-gray-400" />
                                        {job.schedule}
                                    </div>
                                    {job.workspaceName && (
                                        <div className="flex items-center gap-1.5 text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded font-medium">
                                            <Boxes className="w-3 h-3" />
                                            {job.workspaceName}
                                        </div>
                                    )}
                                </div>
                            </div>


                            <div className="flex items-center gap-2 shrink-0">
                                <button
                                    onClick={(e) => handleToggleStatus(e, job)}
                                    className={cn(
                                        "p-2 rounded-lg transition-colors border",
                                        job.status === 'active'
                                            ? "bg-white border-gray-200 text-gray-400 hover:text-orange-500 hover:border-orange-200"
                                            : "bg-green-50 border-green-200 text-green-600"
                                    )}
                                    title={job.status === 'active' ? "Pause Job" : "Resume Job"}
                                >
                                    {job.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                                </button>
                                <button
                                    onClick={(e) => handleDeleteClick(e, job.id)}
                                    className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 hover:border-red-200 border border-transparent transition-all"
                                    title="Delete Job"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    ))}

                    {/* Empty State */}
                    {jobs.length === 0 && (
                        <div className="text-center py-20 text-gray-400">
                            <Timer className="w-12 h-12 mx-auto mb-4 text-gray-200" />
                            <h3 className="text-lg font-medium text-gray-900">No Scheduled Jobs</h3>
                            <p className="mb-6 max-w-sm mx-auto">Create a cron job to automate your skills periodically.</p>
                            <button
                                onClick={handleCreate}
                                className="px-4 py-2 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors"
                            >
                                + Create First Schedule
                            </button>
                        </div>
                    )}
                </div>
                )}
            </div>

            <CronDrawer
                isOpen={isDrawerOpen}
                onClose={() => setIsDrawerOpen(false)}
                job={selectedJob}
                onSave={handleSave}
            />

            <ConfirmDialog
                isOpen={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                onConfirm={handleDeleteConfirm}
                title="Delete Schedule"
                description="Are you sure you want to delete this scheduled job? This action cannot be undone."
                confirmText="Delete"
                variant="danger"
            />
        </div>
    );
}
