/**
 * VersionHistoryDrawer — slide-in drawer showing version history for a skill.
 * Supports tag filtering (published/approved) and rollback.
 */

import { useState, useEffect } from 'react';
import { X, Loader2, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rpcGetSkillHistory, rpcRollbackSkill, type RpcSendFn } from '../skillsData';
import { ConfirmDialog } from '../../../components/ConfirmDialog';

export interface VersionHistoryDrawerProps {
    isOpen: boolean;
    skillId: string;
    skillName: string;
    tag?: 'published' | 'approved';
    title?: string;
    sendRpc: RpcSendFn;
    onClose: () => void;
    onRollback?: () => void; // called after successful rollback to refresh parent
}

export function VersionHistoryDrawer({
    isOpen, skillId, skillName, tag, title: titleProp, sendRpc, onClose, onRollback,
}: VersionHistoryDrawerProps) {
    const [versions, setVersions] = useState<Array<{ hash: string; version: number; tag?: string; message: string; author: string; date: string }>>([]);
    const [loading, setLoading] = useState(false);
    const [rollbackConfirm, setRollbackConfirm] = useState<number | null>(null);
    const [rollbackInProgress, setRollbackInProgress] = useState(false);

    useEffect(() => {
        if (!isOpen || !skillId) return;
        setLoading(true);
        rpcGetSkillHistory(sendRpc, skillId, tag)
            .then(result => setVersions(result.versions))
            .catch(() => setVersions([]))
            .finally(() => setLoading(false));
    }, [isOpen, skillId, tag, sendRpc]);

    const handleRollback = async (version: number) => {
        setRollbackConfirm(null);
        setRollbackInProgress(true);
        try {
            const target = tag === 'published' ? 'dev' : 'prod';
            await rpcRollbackSkill(sendRpc, skillId, version, target as 'dev' | 'prod');
            // Reload history
            const result = await rpcGetSkillHistory(sendRpc, skillId, tag);
            setVersions(result.versions);
            onRollback?.();
        } catch (err: any) {
            console.error('[VersionHistory] Rollback failed:', err);
        } finally {
            setRollbackInProgress(false);
        }
    };

    if (!isOpen) return null;

    const title = titleProp || (tag === 'published' ? 'Dev History' : tag === 'approved' ? 'Prod History' : 'Version History');

    return (
        <>
            <div className="fixed inset-0 z-50 flex justify-end">
                <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
                <div className="relative w-full sm:w-[400px] bg-white shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
                    {/* Header */}
                    <div className="flex items-center justify-between px-5 py-4 border-b">
                        <div>
                            <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
                            <p className="text-xs text-gray-500 mt-0.5">{skillName}</p>
                        </div>
                        <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Version list */}
                    <div className="flex-1 overflow-y-auto">
                        {loading ? (
                            <div className="flex items-center justify-center py-16">
                                <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                            </div>
                        ) : versions.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                                <p className="text-sm">No versions yet.</p>
                            </div>
                        ) : (
                            <div className="relative">
                                {/* Timeline line */}
                                <div className="absolute left-7 top-0 bottom-0 w-px bg-gray-100" />

                                {versions.map((v, i) => (
                                    <div key={v.hash} className="relative flex items-start gap-3 px-5 py-3 hover:bg-gray-50 transition-colors group">
                                        {/* Timeline dot */}
                                        <div className={cn(
                                            "w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 z-10 ring-2 ring-white",
                                            i === 0 ? "bg-blue-500" : "bg-gray-300"
                                        )} />

                                        {/* Version info */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-bold text-gray-900">
                                                    {v.date ? new Date(v.date).toLocaleString() : `#${v.version}`}
                                                </span>
                                                {v.tag && (
                                                    <span className={cn(
                                                        "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                                                        v.tag === 'published' ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'
                                                    )}>
                                                        {v.tag === 'published' ? 'dev' : 'prod'}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-gray-600 mt-0.5 truncate">{v.message || 'No message'}</p>
                                            <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-400">
                                                <span>{v.author}</span>
                                            </div>
                                        </div>

                                        {/* Rollback button */}
                                        {i > 0 && (
                                            <button
                                                onClick={() => setRollbackConfirm(v.version)}
                                                disabled={rollbackInProgress}
                                                className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all disabled:opacity-50"
                                                title={`Rollback to v${v.version}`}
                                            >
                                                <RotateCcw className="w-3.5 h-3.5" />
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <ConfirmDialog
                isOpen={rollbackConfirm !== null}
                onClose={() => setRollbackConfirm(null)}
                onConfirm={() => rollbackConfirm !== null && handleRollback(rollbackConfirm)}
                title="Rollback Version"
                description={`Rollback ${tag === 'published' ? 'dev' : 'production'} to v${rollbackConfirm}? This creates a new version with historical content. Working drafts are not affected.`}
                confirmText="Rollback"
                variant="warning"
            />
        </>
    );
}
