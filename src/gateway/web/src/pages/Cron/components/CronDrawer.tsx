import { X, Save, Clock, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { CronJob } from '../cronData';
import { useState, useEffect } from 'react';

interface CronDrawerProps {
    job: CronJob | null;
    isOpen: boolean;
    onClose: () => void;
    onSave: (job: Partial<CronJob>) => Promise<void>;
}

export function CronDrawer({ job, isOpen, onClose, onSave }: CronDrawerProps) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [schedule, setSchedule] = useState('');
    const [saving, setSaving] = useState(false);

    // Reset or load data when drawer opens
    useEffect(() => {
        if (isOpen) {
            if (job) {
                setName(job.name);
                setDescription(job.description);
                setSchedule(job.schedule);
            } else {
                // New job defaults
                setName('');
                setDescription('');
                setSchedule('0 9 * * 1-5'); // Default: Weekdays 9 AM
            }
            setSaving(false);
        }
    }, [isOpen, job]);

    const handleSave = async () => {
        if (!name.trim() || !schedule.trim() || saving) return;

        setSaving(true);
        try {
            await onSave({
                id: job?.id,
                name,
                description,
                schedule,
                status: job?.status || 'active',
            });
        } catch (err) {
            console.error('[CronDrawer] Save failed:', err);
        } finally {
            setSaving(false);
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
                        className="fixed right-0 top-0 bottom-0 w-[480px] bg-white shadow-2xl z-50 flex flex-col border-l border-gray-100"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-white">
                            <div>
                                <h2 className="text-lg font-bold text-gray-900">{job ? 'Edit Schedule' : 'New Schedule'}</h2>
                                <p className="text-xs text-gray-400">Automate skills with cron jobs</p>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6">

                            {/* Cron Expression */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                                    <Clock className="w-4 h-4 text-primary-500" />
                                    Cron Schedule <span className="text-red-500">*</span>
                                </label>
                                <div className="relative">
                                    <input
                                        type="text"
                                        value={schedule}
                                        onChange={(e) => setSchedule(e.target.value)}
                                        placeholder="* * * * *"
                                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-sm font-mono text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all"
                                    />
                                    <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                                        UTC
                                    </div>
                                </div>
                                <p className="text-xs text-gray-500">
                                    Format: <code>min hour day month weekday</code>. <a href="https://crontab.guru" target="_blank" className="text-primary-600 hover:underline">Help?</a>
                                </p>
                            </div>

                            <div className="h-px bg-gray-100 w-full" />

                            {/* Job Info */}
                            <div className="space-y-4">
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-700">Job Name <span className="text-red-500">*</span></label>
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        placeholder="e.g. Weekly Report"
                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-700">Description</label>
                                    <textarea
                                        value={description}
                                        onChange={(e) => setDescription(e.target.value)}
                                        placeholder="Describe what this scheduled job does (Natural Language)."
                                        rows={4}
                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none"
                                    />
                                </div>

                            </div>
                        </div>

                        {/* Footer */}
                        <div className="p-6 border-t border-gray-100 bg-white flex items-center justify-end gap-3">
                            <button
                                onClick={onClose}
                                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={!name.trim() || !schedule.trim() || saving}
                                className="px-4 py-2 text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 rounded-lg shadow-sm flex items-center gap-2 disabled:opacity-50"
                            >
                                {saving ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                    <Save className="w-4 h-4" />
                                )}
                                {saving ? 'Saving...' : job ? 'Save Job' : 'Create Schedule'}
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
