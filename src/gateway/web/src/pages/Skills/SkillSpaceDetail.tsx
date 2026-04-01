import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Trash2, LogOut, Pencil, Check, X, Crown, UserPlus, GitFork, Upload, Download, RotateCcw, SendHorizontal, BookCheck, GitCommitHorizontal, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '../../hooks/useWebSocket';
import { getCurrentUser } from '../../auth';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { AddSkillDialog } from './AddSkillDialog';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { DiffPreviewDialog } from './components/DiffPreviewDialog';
import { VersionHistoryDrawer } from './components/VersionHistoryDrawer';
import type { Skill, SkillSpace, SkillSpaceMember } from './skillsData';
import {
    rpcGetSkillSpace, rpcUpdateSkillSpace, rpcDeleteSkillSpace,
    rpcAddSkillSpaceMember, rpcRemoveSkillSpaceMember,
    rpcDeleteSkill, rpcBatchSubmit, rpcBatchContribute, rpcWithdrawSubmit, rpcWithdrawContribute, rpcGetSkillSystemCapabilities, rpcPublishInSpace, rpcPreviewDiff, downloadSkillExport, getIconForType,
} from './skillsData';
import { DEFAULT_SKILL_LABEL_COLORS, SkillCard, type SkillCardAction, type SkillCardBadge } from './components/SkillCard';
import { SkillLifecycleStatus } from './components/SkillLifecycleStatus';

function InlineEdit({ value, onSave, className, placeholder }: {
    value: string; onSave: (val: string) => void; className?: string; placeholder?: string;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    const commit = () => {
        const trimmed = draft.trim();
        if (trimmed && trimmed !== value) onSave(trimmed);
        setEditing(false);
    };
    if (editing) {
        return (
            <div className="flex items-center gap-1">
                <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                    className={cn("bg-transparent border-b border-gray-300 focus:border-gray-600 outline-none px-0 py-0.5", className)} />
                <button onClick={commit} className="text-gray-400 hover:text-gray-600"><Check className="w-3.5 h-3.5" /></button>
                <button onClick={() => setEditing(false)} className="text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
            </div>
        );
    }
    return (
        <button onClick={() => { setDraft(value); setEditing(true); }}
            className={cn("group flex items-center gap-1 hover:bg-gray-50 rounded px-1 -ml-1 transition-colors", className)}>
            <span>{value || <span className="text-gray-400 italic">{placeholder || 'Click to edit'}</span>}</span>
            <Pencil className="w-3 h-3 text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
    );
}

export function SkillSpaceDetailPage() {
    const { spaceId } = useParams();
    const navigate = useNavigate();
    const { sendRpc, isConnected } = useWebSocket();
    const { currentWorkspace } = useWorkspace();
    const currentUser = getCurrentUser();

    const [spaceData, setSpaceData] = useState<(SkillSpace & { members: SkillSpaceMember[]; skills: Skill[] }) | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [skillSpaceEnabled, setSkillSpaceEnabled] = useState(false);
    const [showInvite, setShowInvite] = useState(false);
    const [inviteUsername, setInviteUsername] = useState('');
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [flashMessage, setFlashMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{
        isOpen: boolean; title: string; description: string;
        variant: 'primary' | 'danger' | 'warning'; confirmText: string; onConfirm: () => void;
    }>({ isOpen: false, title: '', description: '', variant: 'primary', confirmText: 'Confirm', onConfirm: () => {} });
    const [addDialog, setAddDialog] = useState(false);
    const [batchDialog, setBatchDialog] = useState<{
        isOpen: boolean;
        mode: 'submit' | 'contribute' | 'download';
        eligible: Skill[];
        selected: Set<string>;
        diffs: Map<string, import('./skillsData').PreviewDiffResult>;
        loadingDiffs: Set<string>;
    }>({ isOpen: false, mode: 'submit', eligible: [], selected: new Set(), diffs: new Map(), loadingDiffs: new Set() });

    const [historyDrawer, setHistoryDrawer] = useState<{
        isOpen: boolean; skillId: string; skillName: string; tag?: 'published' | 'approved';
    }>({ isOpen: false, skillId: '', skillName: '' });

    const [previewAction, setPreviewAction] = useState<{
        isOpen: boolean; title: string; loading: boolean;
        diff: import('./skillsData').PreviewDiffResult | null;
        onConfirm: (message?: string) => Promise<void>;
    }>({ isOpen: false, title: '', loading: false, diff: null, onConfirm: async () => {} });

    const isOwner = spaceData?.ownerId === currentUser?.id;
    const isMaintainer = spaceData?.members.some(m => m.userId === currentUser?.id && (m.role === 'owner' || m.role === 'maintainer')) ?? false;
    const isMember = spaceData?.members.some(m => m.userId === currentUser?.id) ?? false;

    useEffect(() => {
        if (!flashMessage) return;
        const timer = window.setTimeout(() => setFlashMessage(null), 4200);
        return () => window.clearTimeout(timer);
    }, [flashMessage]);

    const reload = useCallback(async () => {
        if (!spaceId || !isConnected || !currentWorkspace?.id) return;
        try {
            const [caps, data] = await Promise.all([
                rpcGetSkillSystemCapabilities(sendRpc, currentWorkspace.id),
                rpcGetSkillSpace(sendRpc, currentWorkspace.id, spaceId),
            ]);
            setSkillSpaceEnabled(caps.skillSpaceEnabled);
            setSpaceData({
                ...data,
                skills: data.skills.map((s: any) => ({
                    ...s,
                    icon: getIconForType(s.type || 'Custom'),
                    version: `v${s.version || 1}`,
                    enabled: s.enabled ?? true,
                })),
            });
            setError(null);
        } catch (err: any) {
            setError(err.message || 'Failed to load skill space');
        } finally {
            setLoading(false);
        }
    }, [spaceId, isConnected, sendRpc, currentWorkspace?.id]);

    useEffect(() => { reload(); }, [reload]);

    const showFlash = useCallback((tone: 'success' | 'error', text: string) => {
        setFlashMessage({ tone, text });
    }, []);

    const handleInvite = async () => {
        if (!spaceId || !inviteUsername.trim()) return;
        if (!currentWorkspace?.id) {
            setInviteError('Workspace not loaded yet. Please wait and try again.');
            return;
        }
        setInviteError(null);
        try {
            await rpcAddSkillSpaceMember(sendRpc, currentWorkspace.id, spaceId, inviteUsername.trim());
            setInviteUsername('');
            setShowInvite(false);
            showFlash('success', `Invited ${inviteUsername.trim()} to this Skill Space.`);
            reload();
        } catch (err: any) {
            setInviteError(err.message || 'Failed to invite');
        }
    };

    const handleRemoveMember = (userId: string, username: string) => {
        setConfirmDialog({
            isOpen: true, title: 'Remove Member',
            description: `Remove "${username}" from this skill space?`,
            variant: 'danger', confirmText: 'Remove',
            onConfirm: async () => {
                try {
                    await rpcRemoveSkillSpaceMember(sendRpc, currentWorkspace!.id, spaceId!, userId);
                    showFlash('success', `Removed ${username} from this Skill Space.`);
                    reload();
                } catch (err: any) {
                    showFlash('error', err.message || 'Failed to remove member');
                }
            },
        });
    };

    const handleLeave = () => {
        setConfirmDialog({
            isOpen: true, title: 'Leave Skill Space',
            description: 'You will lose access to all skills in this space.',
            variant: 'warning', confirmText: 'Leave',
            onConfirm: async () => {
                try {
                    await rpcRemoveSkillSpaceMember(sendRpc, currentWorkspace!.id, spaceId!, currentUser!.id);
                    navigate('/skills?tab=myskills&view=shared');
                } catch (err: any) {
                    showFlash('error', err.message || 'Failed to leave skill space');
                }
            },
        });
    };

    const handleDeleteSpace = () => {
        setConfirmDialog({
            isOpen: true, title: 'Delete Skill Space',
            description: 'All skills must be removed first.',
            variant: 'danger', confirmText: 'Delete',
            onConfirm: async () => {
                try {
                    await rpcDeleteSkillSpace(sendRpc, currentWorkspace!.id, spaceId!);
                    navigate('/skills?tab=myskills&view=shared');
                } catch (err: any) {
                    showFlash('error', err.message || 'Failed to delete');
                }
            },
        });
    };

    const handleDeleteSkill = (skill: Skill) => {
        setConfirmDialog({
            isOpen: true, title: 'Remove Skill',
            description: `Delete "${skill.name}" from this skill space?`,
            variant: 'danger', confirmText: 'Delete',
            onConfirm: async () => {
                try {
                    await rpcDeleteSkill(sendRpc, String(skill.id), currentWorkspace?.id);
                    showFlash('success', `Removed ${skill.name} from this Skill Space.`);
                    reload();
                } catch (err: any) {
                    showFlash('error', err.message || 'Failed to remove skill');
                }
            },
        });
    };

    const handleToggleEnabled = async (e: React.MouseEvent, skill: Skill) => {
        e.stopPropagation();
        try {
            await sendRpc('skill.setEnabled', { id: String(skill.id), enabled: !skill.enabled });
            setSpaceData(prev => prev ? {
                ...prev,
                skills: prev.skills.map(s => s.id === skill.id ? { ...s, enabled: !s.enabled } : s),
            } : prev);
        } catch (err: any) {
            showFlash('error', err.message || 'Failed to update skill status');
        }
    };


    const handleWithdrawSubmit = (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        setConfirmDialog({
            isOpen: true,
            title: 'Withdraw Review',
            description: `Withdraw the review request for "${skill.name}"?`,
            variant: 'warning',
            confirmText: 'Withdraw',
            onConfirm: async () => {
                try {
                    await rpcWithdrawSubmit(sendRpc, String(skill.id), currentWorkspace.id);
                    await reload();
                    showFlash('success', `Withdrew ${skill.name} review request.`);
                } catch (err: any) {
                    showFlash('error', err.message || 'Failed to withdraw');
                }
            },
        });
    };

    const handleWithdrawContribute = (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        setConfirmDialog({
            isOpen: true,
            title: 'Withdraw Contribution',
            description: `Withdraw the contribution request for "${skill.name}"?`,
            variant: 'warning',
            confirmText: 'Withdraw',
            onConfirm: async () => {
                try {
                    await rpcWithdrawContribute(sendRpc, String(skill.id), currentWorkspace.id);
                    await reload();
                    showFlash('success', `Withdrew ${skill.name} contribution.`);
                } catch (err: any) {
                    showFlash('error', err.message || 'Failed to withdraw');
                }
            },
        });
    };

    const showActionPreview = async (skill: Skill, action: 'publish' | 'submit' | 'contribute', title: string, onConfirm: (message?: string) => Promise<void>) => {
        setPreviewAction({ isOpen: true, title, loading: true, diff: null, onConfirm });
        try {
            const diff = await rpcPreviewDiff(sendRpc, String(skill.id), action);
            setPreviewAction(prev => ({ ...prev, diff, loading: false }));
        } catch (err: any) {
            setPreviewAction(prev => ({ ...prev, loading: false }));
            showFlash('error', err.message || 'Failed to load diff');
        }
    };

    const handlePublishInSpace = (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        showActionPreview(skill, 'publish', `Publish "${skill.name}"`, async (message) => {
            await rpcPublishInSpace(sendRpc, String(skill.id), message, currentWorkspace!.id);
            await reload();
            showFlash('success', `Published ${skill.name}.`);
        });
    };

    // Eligible skills for batch actions
    const submittableSkills = (spaceData?.skills ?? []).filter(s => s.canSubmit);
    const contributableSkills = (spaceData?.skills ?? []).filter(s => s.canContribute);

    const handleBatchSubmit = () => {
        if (submittableSkills.length === 0) return;
        setBatchDialog({
            isOpen: true, mode: 'submit', eligible: submittableSkills,
            selected: new Set(submittableSkills.map(s => String(s.id))),
            diffs: new Map(), loadingDiffs: new Set(),
        });
    };

    const handleBatchContribute = () => {
        if (contributableSkills.length === 0) return;
        setBatchDialog({
            isOpen: true, mode: 'contribute', eligible: contributableSkills,
            selected: new Set(contributableSkills.map(s => String(s.id))),
            diffs: new Map(), loadingDiffs: new Set(),
        });
    };

    const loadBatchDiff = async (skillId: string) => {
        if (batchDialog.diffs.has(skillId) || batchDialog.loadingDiffs.has(skillId)) return;
        setBatchDialog(prev => ({ ...prev, loadingDiffs: new Set(prev.loadingDiffs).add(skillId) }));
        try {
            const action = batchDialog.mode === 'contribute' ? 'contribute' as const : 'submit' as const;
            const diff = await rpcPreviewDiff(sendRpc, skillId, action);
            setBatchDialog(prev => {
                const diffs = new Map(prev.diffs);
                diffs.set(skillId, diff);
                const loading = new Set(prev.loadingDiffs);
                loading.delete(skillId);
                return { ...prev, diffs, loadingDiffs: loading };
            });
        } catch (err: any) {
            setBatchDialog(prev => {
                const loading = new Set(prev.loadingDiffs);
                loading.delete(skillId);
                return { ...prev, loadingDiffs: loading };
            });
            showFlash('error', err?.message || 'Failed to load diff');
        }
    };

    const executeBatch = async () => {
        if (batchDialog.selected.size === 0) return;
        const ids = [...batchDialog.selected];
        setBatchDialog(prev => ({ ...prev, isOpen: false }));

        if (batchDialog.mode === 'download') {
            try {
                await downloadSkillExport(sendRpc, ids);
                showFlash('success', `Downloaded ${ids.length} skill${ids.length > 1 ? 's' : ''}.`);
            } catch (err: any) {
                showFlash('error', err.message || 'Download failed');
            }
            return;
        }

        if (!currentWorkspace?.id) return;
        const isContribute = batchDialog.mode === 'contribute';
        try {
            const result = isContribute
                ? await rpcBatchContribute(sendRpc, ids, currentWorkspace.id)
                : await rpcBatchSubmit(sendRpc, ids, currentWorkspace.id);
            await reload();
            // Check for partial failures
            const errors = result.results?.filter(r => r.status === 'error') ?? [];
            const succeeded = ids.length - errors.length;
            if (errors.length > 0 && succeeded > 0) {
                showFlash('error', `${succeeded} succeeded, ${errors.length} failed: ${errors[0].error}`);
            } else if (errors.length > 0) {
                showFlash('error', errors[0].error || 'Operation failed');
            } else {
                showFlash('success', `${isContribute ? 'Contributed' : 'Submitted'} ${ids.length} skill${ids.length > 1 ? 's' : ''}.`);
            }
        } catch (err: any) {
            showFlash('error', err.message || 'Operation failed');
        }
    };

    const renderSkillSpaceCard = (skill: Skill) => {
        const badges: SkillCardBadge[] = [
            ...(skill.globalSkillId ? [{ label: 'Shadows Global', className: 'bg-blue-50 text-blue-700 border-blue-200' }] : []),
        ];
        const actions: SkillCardAction[] = [
            {
                key: 'withdraw-submit',
                tooltip: 'Withdraw Review',
                icon: RotateCcw,
                tone: 'orange',
                hidden: !isMaintainer || skill.reviewStatus !== 'pending',
                onClick: (e) => { e.stopPropagation(); handleWithdrawSubmit(skill); },
            },
            {
                key: 'withdraw-contribute',
                tooltip: 'Withdraw Contribution',
                icon: RotateCcw,
                tone: 'orange',
                hidden: !isMaintainer || skill.contributionStatus !== 'pending',
                onClick: (e) => { e.stopPropagation(); handleWithdrawContribute(skill); },
            },
            {
                key: 'publish',
                tooltip: 'Publish',
                icon: BookCheck,
                tone: 'green',
                hidden: !isMaintainer || !skill.hasUnpublishedChanges,
                onClick: (e) => { e.stopPropagation(); handlePublishInSpace(skill); },
            },
            {
                key: 'history-dev',
                tooltip: 'Dev History',
                icon: GitCommitHorizontal,
                tone: 'indigo',
                hidden: !skill.publishedVersion,
                onClick: () => setHistoryDrawer({ isOpen: true, skillId: String(skill.id), skillName: skill.name, tag: 'published' }),
            },
            {
                key: 'history-prod',
                tooltip: 'Prod History',
                icon: GitCommitHorizontal,
                tone: 'blue',
                hidden: !skill.approvedVersion,
                onClick: () => setHistoryDrawer({ isOpen: true, skillId: String(skill.id), skillName: skill.name, tag: 'approved' }),
            },
            {
                key: 'edit',
                tooltip: 'Edit',
                icon: Pencil,
                tone: 'primary',
                hidden: !isMaintainer,
                onClick: () => navigate(`/skills/${skill.id}`, { state: { fromSkillSpaceId: spaceId } }),
            },
            {
                key: 'download',
                tooltip: 'Download',
                icon: Download,
                tone: 'default',
                onClick: (e) => { e.stopPropagation(); downloadSkillExport(sendRpc, [String(skill.id)]).catch(() => showFlash('error', 'Download failed')); },
            },
            {
                key: 'delete',
                tooltip: 'Delete Skill',
                icon: Trash2,
                tone: 'red',
                hidden: !isMaintainer,
                onClick: (e) => { e.stopPropagation(); handleDeleteSkill(skill); },
            },
        ];

        return (
            <SkillCard
                key={skill.id}
                skill={skill}
                badges={badges}
                footerScope={{
                    label: spaceData?.name || 'Skill Space',
                    className: 'bg-green-50 text-green-600 border border-green-200',
                }}
                actions={actions}
                selectionMode={undefined}
                showToggle
                onToggleEnabled={(e) => handleToggleEnabled(e, skill)}
                labelColors={DEFAULT_SKILL_LABEL_COLORS}
                descriptionFallback="No description"
                bottomContent={<SkillLifecycleStatus skill={skill} />}
            />
        );
    };

    if (loading) {
        return <div className="flex items-center justify-center h-full"><div className="w-5 h-5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" /></div>;
    }
    if (!skillSpaceEnabled) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="text-sm text-gray-500">Skill Space is not enabled for the current workspace.</p>
                <button onClick={() => navigate('/skills?tab=myskills&view=shared')} className="text-sm text-gray-600 hover:text-gray-900 underline">Back to Skills</button>
            </div>
        );
    }
    if (error || !spaceData) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="text-sm text-gray-500">{error || 'Skill space not found'}</p>
                <button onClick={() => navigate('/skills?tab=myskills&view=shared')} className="text-sm text-gray-600 hover:text-gray-900 underline">Back to Skills</button>
            </div>
        );
    }

    return (
        <div className="h-full bg-white flex flex-col">
            <ConfirmDialog isOpen={confirmDialog.isOpen} onClose={() => setConfirmDialog(p => ({ ...p, isOpen: false }))}
                onConfirm={confirmDialog.onConfirm} title={confirmDialog.title} description={confirmDialog.description}
                variant={confirmDialog.variant} confirmText={confirmDialog.confirmText} />
            <VersionHistoryDrawer
                isOpen={historyDrawer.isOpen}
                skillId={historyDrawer.skillId}
                skillName={historyDrawer.skillName}
                tag={historyDrawer.tag}
                sendRpc={sendRpc}
                onClose={() => setHistoryDrawer(prev => ({ ...prev, isOpen: false }))}
                onRollback={reload}
            />
            <AddSkillDialog isOpen={addDialog} skillSpaceId={spaceId!} skillSpaceName={spaceData.name} workspaceId={currentWorkspace!.id}
                sendRpc={sendRpc} onClose={() => setAddDialog(false)} onSuccess={reload} />
            <DiffPreviewDialog
                isOpen={previewAction.isOpen}
                title={previewAction.title}
                loading={previewAction.loading}
                diff={previewAction.diff}
                onClose={() => setPreviewAction(prev => ({ ...prev, isOpen: false }))}
                onConfirm={async (message) => {
                    setPreviewAction(prev => ({ ...prev, isOpen: false }));
                    try { await previewAction.onConfirm(message); }
                    catch (err: any) { showFlash('error', err.message || 'Operation failed'); }
                }}
            />
            {/* Batch submit/contribute dialog with per-skill diff */}
            {batchDialog.isOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
                        onClick={() => setBatchDialog(prev => ({ ...prev, isOpen: false }))} />
                    <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[85vh]">
                        <div className="p-6 border-b">
                            <h3 className="text-base font-semibold text-gray-900 mb-1">
                                {batchDialog.mode === 'download' ? 'Download Skills'
                                    : batchDialog.mode === 'submit' ? 'Submit for Production' : 'Contribute to Global'}
                            </h3>
                            <p className="text-sm text-gray-500">
                                {batchDialog.mode === 'download'
                                    ? 'Select skills to download as a tar.gz archive.'
                                    : batchDialog.mode === 'submit'
                                        ? 'Review changes and select skills to submit.'
                                        : 'Review changes and select skills to contribute.'}
                            </p>
                        </div>
                        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-2">
                            {batchDialog.eligible.map(skill => {
                                const sid = String(skill.id);
                                const checked = batchDialog.selected.has(sid);
                                const diff = batchDialog.diffs.get(sid);
                                const isLoadingDiff = batchDialog.loadingDiffs.has(sid);
                                const hasDiff = diff !== undefined || isLoadingDiff;
                                return (
                                    <div key={sid} className={cn("border rounded-lg overflow-hidden", checked ? "border-blue-200" : "border-gray-100")}>
                                        <div className="flex items-center gap-3 px-3 py-2.5">
                                            <button
                                                onClick={() => setBatchDialog(prev => {
                                                    const next = new Set(prev.selected);
                                                    if (next.has(sid)) next.delete(sid); else next.add(sid);
                                                    return { ...prev, selected: next };
                                                })}
                                                className={cn(
                                                    "w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors",
                                                    checked ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300"
                                                )}
                                            >
                                                {checked && <Check className="w-3 h-3" />}
                                            </button>
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm font-medium text-gray-900 truncate">{skill.name}</div>
                                            </div>
                                            {batchDialog.mode !== 'download' && (
                                                <button
                                                    onClick={() => loadBatchDiff(sid)}
                                                    className="text-xs text-blue-600 hover:text-blue-800 shrink-0"
                                                    disabled={hasDiff}
                                                >
                                                    {diff ? 'Diff loaded' : isLoadingDiff ? 'Loading...' : 'View Diff'}
                                                </button>
                                            )}
                                        </div>
                                        {isLoadingDiff && (
                                            <div className="px-3 pb-3 flex justify-center">
                                                <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                            </div>
                                        )}
                                        {diff && (
                                            <div className="px-3 pb-3 space-y-2">
                                                {diff.metadataChanges.length > 0 && (
                                                    <div className="text-xs space-y-0.5">
                                                        {diff.metadataChanges.map(c => (
                                                            <div key={c.field}>
                                                                <span className="font-medium text-gray-600">{c.field}: </span>
                                                                {c.from && <span className="text-red-500 line-through">{c.from}</span>}
                                                                {c.from && c.to && <span className="text-gray-400 mx-1">→</span>}
                                                                {c.to && <span className="text-green-600">{c.to}</span>}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                                {diff.specsDiff && (
                                                    <pre className="text-[10px] font-mono whitespace-pre-wrap bg-gray-50 rounded p-2 max-h-40 overflow-y-auto">
                                                        {diff.specsDiff.split('\n').map((line, i) => (
                                                            <div key={i} className={
                                                                line.startsWith('+') ? 'text-green-700 bg-green-50' :
                                                                line.startsWith('-') ? 'text-red-700 bg-red-50' : 'text-gray-500'
                                                            }>{line || '\u00A0'}</div>
                                                        ))}
                                                    </pre>
                                                )}
                                                {diff.scriptDiffs.filter(s => s.status !== 'unchanged').map(s => (
                                                    <div key={s.name} className="text-[10px]">
                                                        <span className={cn("font-medium",
                                                            s.status === 'added' ? 'text-green-600' :
                                                            s.status === 'removed' ? 'text-red-600' : 'text-blue-600'
                                                        )}>scripts/{s.name} ({s.status})</span>
                                                        {s.diff && (
                                                            <pre className="font-mono whitespace-pre-wrap bg-gray-50 rounded p-2 mt-1 max-h-32 overflow-y-auto">
                                                                {s.diff.split('\n').map((line, i) => (
                                                                    <div key={i} className={
                                                                        line.startsWith('+') ? 'text-green-700' :
                                                                        line.startsWith('-') ? 'text-red-700' : 'text-gray-500'
                                                                    }>{line || '\u00A0'}</div>
                                                                ))}
                                                            </pre>
                                                        )}
                                                    </div>
                                                ))}
                                                {diff.isNew && <p className="text-xs text-gray-400">First time — no baseline.</p>}
                                                {!diff.hasChanges && !diff.isNew && <p className="text-xs text-gray-400">No changes.</p>}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        <div className="border-t px-6 py-3 flex items-center justify-between">
                            <button
                                onClick={() => {
                                    const allSelected = batchDialog.selected.size === batchDialog.eligible.length;
                                    setBatchDialog(prev => ({
                                        ...prev,
                                        selected: allSelected ? new Set() : new Set(prev.eligible.map(s => String(s.id))),
                                    }));
                                }}
                                className="text-xs text-blue-600 hover:text-blue-800"
                            >
                                {batchDialog.selected.size === batchDialog.eligible.length ? 'Deselect All' : 'Select All'}
                            </button>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setBatchDialog(prev => ({ ...prev, isOpen: false }))}
                                    className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={executeBatch}
                                    disabled={batchDialog.selected.size === 0}
                                    className={cn(
                                        "px-4 py-1.5 text-sm font-medium rounded-lg text-white transition-colors",
                                        batchDialog.mode === 'download'
                                            ? "bg-gray-700 hover:bg-gray-800 disabled:bg-gray-300"
                                            : batchDialog.mode === 'submit'
                                                ? "bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300"
                                                : "bg-green-600 hover:bg-green-700 disabled:bg-green-300"
                                    )}
                                >
                                    {batchDialog.mode === 'download' ? 'Download' : batchDialog.mode === 'submit' ? 'Submit' : 'Contribute'} ({batchDialog.selected.size})
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {flashMessage && (
                <div
                    className={cn(
                        'px-6 py-2.5 border-b flex items-center gap-2 text-sm',
                        flashMessage.tone === 'success'
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                            : 'bg-red-50 border-red-200 text-red-800'
                    )}
                >
                    <span className="flex-1">{flashMessage.text}</span>
                    <button
                        onClick={() => setFlashMessage(null)}
                        className={cn(
                            'rounded-md p-1 transition-colors',
                            flashMessage.tone === 'success'
                                ? 'text-emerald-500 hover:bg-emerald-100'
                                : 'text-red-500 hover:bg-red-100'
                        )}
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* Header */}
            <div className="px-6 py-4 border-b flex items-center gap-3">
                <button onClick={() => navigate('/skills?tab=myskills&view=shared')}
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="flex-1 min-w-0">
                    {isOwner ? (
                        <InlineEdit value={spaceData.name} onSave={async name => { await rpcUpdateSkillSpace(sendRpc, currentWorkspace!.id, spaceId!, { name }); reload(); }}
                            className="text-lg font-semibold text-gray-900" />
                    ) : (
                        <h1 className="text-lg font-semibold text-gray-900">{spaceData.name}</h1>
                    )}
                    {isOwner ? (
                        <InlineEdit value={spaceData.description || ''} onSave={async description => { await rpcUpdateSkillSpace(sendRpc, currentWorkspace!.id, spaceId!, { description }); reload(); }}
                            className="text-sm text-gray-500 mt-0.5" placeholder="Add a description..." />
                    ) : spaceData.description ? (
                        <p className="text-sm text-gray-500 mt-0.5">{spaceData.description}</p>
                    ) : null}
                </div>
                {isMaintainer && (
                    <div className="relative">
                        <button onClick={() => { setShowInvite(!showInvite); setInviteError(null); }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                            <UserPlus className="w-3.5 h-3.5" /> Invite
                        </button>
                        {showInvite && (
                            <div className="absolute right-0 top-full mt-1 w-64 bg-white border rounded-xl shadow-lg p-3 z-10">
                                <div className="flex gap-1.5">
                                    <input autoFocus value={inviteUsername} onChange={e => setInviteUsername(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && handleInvite()} placeholder="Username"
                                        className="flex-1 px-2.5 py-1.5 text-xs border rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300" />
                                    <button onClick={handleInvite} disabled={!inviteUsername.trim()}
                                        className="px-3 py-1.5 text-xs font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg disabled:opacity-40">Add</button>
                                </div>
                                {inviteError && <p className="text-xs text-red-500 mt-1">{inviteError}</p>}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
                {/* Members */}
                <section>
                    <div className="flex items-center gap-2 mb-3">
                        <Users className="w-4 h-4 text-gray-400" />
                        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Members ({spaceData.members.length})</h2>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {spaceData.members.map(m => (
                            <div key={m.id} className={cn("inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border",
                                m.role === 'owner' ? "bg-amber-50 border-amber-200" : "bg-gray-50 border-gray-200")}>
                                {m.role === 'owner' && <Crown className="w-3 h-3 text-amber-500" />}
                                <span className="font-medium text-gray-700">{m.username || m.userId.slice(0, 8)}</span>
                                <span className="text-xs text-gray-400">{m.role}</span>
                                {isOwner && m.role !== 'owner' && (
                                    <button onClick={() => handleRemoveMember(m.userId, m.username || m.userId)}
                                        className="text-gray-300 hover:text-red-500 transition-colors ml-0.5">
                                        <X className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                    {!isOwner && isMember && (
                        <button onClick={handleLeave} className="mt-3 inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-red-500 transition-colors">
                            <LogOut className="w-3 h-3" /> Leave this space
                        </button>
                    )}
                </section>

                {/* Skills */}
                <section>
                    <div className="flex items-center justify-between mb-3">
                        <div>
                            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Skills ({spaceData.skills.length})</h2>
                            <p className="text-xs text-gray-400 mt-1">
                                Browse and edit shared skills here. Merge changes into the accepted Skill Space snapshot first, then contribute clean merged versions to Global.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            {isMaintainer && submittableSkills.length > 0 && (
                                <button onClick={handleBatchSubmit}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors">
                                    <SendHorizontal className="w-3.5 h-3.5" /> Submit ({submittableSkills.length})
                                </button>
                            )}
                            {isMaintainer && contributableSkills.length > 0 && (
                                <button onClick={handleBatchContribute}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors">
                                    <Upload className="w-3.5 h-3.5" /> Contribute ({contributableSkills.length})
                                </button>
                            )}
                            {spaceData.skills.length > 0 && (
                                <button onClick={() => setBatchDialog({
                                    isOpen: true, mode: 'download', eligible: spaceData.skills,
                                    selected: new Set(spaceData.skills.map(s => String(s.id))),
                                    diffs: new Map(), loadingDiffs: new Set(),
                                })}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                                    <Download className="w-3.5 h-3.5" /> Download
                                </button>
                            )}
                            {isMaintainer && (
                                <button onClick={() => setAddDialog(true)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                                    <GitFork className="w-3.5 h-3.5" /> Add Skill
                                </button>
                            )}
                        </div>
                    </div>
                    {/* Batch merge mode removed — skillset skills are read-only */}
                    {spaceData.skills.length === 0 ? (
                        <div className="text-center py-12 text-gray-400">
                            <p className="text-sm">No skills in this space yet.</p>
                            <p className="mt-2 text-xs text-gray-400">Sync skills from My Skills to share them here.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {spaceData.skills.map(skill => renderSkillSpaceCard(skill))}
                        </div>
                    )}
                </section>

                {/* Danger zone */}
                {isOwner && (
                    <section className="pt-6 border-t">
                        <button onClick={handleDeleteSpace}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" /> Delete Skill Space
                        </button>
                    </section>
                )}
            </div>
        </div>
    );
}
