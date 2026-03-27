import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Plus, Trash2, LogOut, Pencil, Check, X, Crown, UserPlus, Layers3, SendHorizontal, RotateCcw, Eye, Settings, GitFork, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '../../hooks/useWebSocket';
import { getCurrentUser } from '../../auth';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DiffViewerModal } from '../../components/DiffViewerModal';
import { AddSkillDialog } from './AddSkillDialog';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import type { Skill, SkillSpace, SkillSpaceMember, SkillDiffMetadataChange } from './skillsData';
import {
    rpcGetSkillSpace, rpcUpdateSkillSpace, rpcDeleteSkillSpace,
    rpcAddSkillSpaceMember, rpcRemoveSkillSpaceMember,
    rpcForkSkill, rpcDeleteSkill, rpcRequestPublish, rpcWithdrawSkill, rpcGetSkillDiff, rpcGetSkillSystemCapabilities, getIconForType,
} from './skillsData';
import { DEFAULT_SKILL_LABEL_COLORS, SkillCard, type SkillCardAction, type SkillCardBadge } from './components/SkillCard';

function getSkillSpaceStatus(skill: Skill): { label: string; tone: string; mergeActionable: boolean; canContribute: boolean } {
    if (skill.contributionStatus === 'pending') {
        return { label: 'Pending Contribution', tone: 'bg-orange-50 text-orange-700 border-orange-200', mergeActionable: false, canContribute: false };
    }
    if (skill.reviewStatus === 'pending') {
        return { label: 'Pending Merge', tone: 'bg-amber-50 text-amber-700 border-amber-200', mergeActionable: false, canContribute: false };
    }
    if (skill.reviewStatus === 'approved' && !skill.hasUnpublishedChanges) {
        if (skill.contributionStatus === 'approved') {
            return { label: 'Contributed', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200', mergeActionable: false, canContribute: false };
        }
        return { label: 'Ready to Contribute', tone: 'bg-blue-50 text-blue-700 border-blue-200', mergeActionable: false, canContribute: true };
    }
    if (skill.reviewStatus === 'approved') {
        return { label: 'Ready to Merge Update', tone: 'bg-blue-50 text-blue-700 border-blue-200', mergeActionable: true, canContribute: false };
    }
    return { label: 'Ready to Merge', tone: 'bg-slate-50 text-slate-700 border-slate-200', mergeActionable: true, canContribute: false };
}

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
    const [addDialog, setAddDialog] = useState(false);
    const [showInvite, setShowInvite] = useState(false);
    const [inviteUsername, setInviteUsername] = useState('');
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [flashMessage, setFlashMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
    const [isMergeMode, setIsMergeMode] = useState(false);
    const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set());
    const [batchBusy, setBatchBusy] = useState(false);
    const [forkingSkillIds, setForkingSkillIds] = useState<Set<string>>(new Set());
    const [diffModal, setDiffModal] = useState<{
        isOpen: boolean;
        title: string;
        subtitle?: string;
        diffText: string | null;
        metadataChanges: SkillDiffMetadataChange[];
        isLoading: boolean;
    }>({ isOpen: false, title: '', diffText: null, metadataChanges: [], isLoading: false });
    const [confirmDialog, setConfirmDialog] = useState<{
        isOpen: boolean; title: string; description: string;
        variant: 'primary' | 'danger' | 'warning'; confirmText: string; onConfirm: () => void;
    }>({ isOpen: false, title: '', description: '', variant: 'primary', confirmText: 'Confirm', onConfirm: () => {} });

    const isOwner = spaceData?.ownerId === currentUser?.id;
    const isMaintainer = spaceData?.members.some(m => m.userId === currentUser?.id && (m.role === 'owner' || m.role === 'maintainer')) ?? false;
    const isMember = spaceData?.members.some(m => m.userId === currentUser?.id) ?? false;
    const visibleSkills = spaceData?.skills ?? [];
    const selectedSkills = useMemo(
        () => visibleSkills.filter(skill => selectedSkillIds.has(String(skill.id))),
        [visibleSkills, selectedSkillIds],
    );
    const selectedPendingCount = selectedSkills.filter(skill => skill.reviewStatus === 'pending').length;
    const selectedReadyCount = selectedSkills.filter(skill => getSkillSpaceStatus(skill).mergeActionable).length;

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
            setSelectedSkillIds(prev => {
                const next = new Set<string>();
                for (const skill of data.skills ?? []) {
                    if (prev.has(String(skill.id))) next.add(String(skill.id));
                }
                return next;
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
                    navigate('/skills?tab=myskills');
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
                    navigate('/skills?tab=myskills');
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

    const handleViewDiff = async (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        const useGlobalContributionBaseline =
            skill.contributionStatus === 'pending' ||
            (skill.reviewStatus === 'approved' && !skill.hasUnpublishedChanges);
        try {
            setDiffModal({
                isOpen: true,
                title: `${skill.name} Diff`,
                subtitle: 'Loading comparison...',
                diffText: null,
                metadataChanges: [],
                isLoading: true,
            });
            const result = await rpcGetSkillDiff(
                sendRpc,
                String(skill.id),
                useGlobalContributionBaseline,
                currentWorkspace.id,
                useGlobalContributionBaseline ? 'global' : undefined,
            );
            setDiffModal({
                isOpen: true,
                title: `${skill.name} Diff`,
                subtitle: result.baselineLabel && result.compareLabel
                    ? `${result.baselineLabel} -> ${result.compareLabel}`
                    : useGlobalContributionBaseline
                        ? 'Latest global -> Contribution candidate'
                        : 'Skill Space diff',
                diffText: result.diff || 'No changes detected.',
                metadataChanges: result.metadataChanges ?? [],
                isLoading: false,
            });
        } catch (err: any) {
            setDiffModal({
                isOpen: true,
                title: `${skill.name} Diff`,
                subtitle: useGlobalContributionBaseline
                    ? 'Latest global -> Contribution candidate'
                    : 'Skill Space diff',
                diffText: 'Failed to load diff.',
                metadataChanges: [],
                isLoading: false,
            });
            showFlash('error', err.message || 'Failed to load diff');
        }
    };

    const handleToggleEnabled = async (e: React.MouseEvent, skill: Skill) => {
        e.stopPropagation();
        try {
            await sendRpc('skill.setEnabled', { name: skill.name, enabled: !skill.enabled });
            setSpaceData(prev => prev ? {
                ...prev,
                skills: prev.skills.map(s => s.name === skill.name ? { ...s, enabled: !s.enabled } : s),
            } : prev);
        } catch (err: any) {
            showFlash('error', err.message || 'Failed to update skill status');
        }
    };

    const handleSubmitSkill = (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        setConfirmDialog({
            isOpen: true,
            title: 'Submit Merge',
            description: `Submit "${skill.name}" from Skill Space for merge review? Once approved, it will become the latest merged version in this Skill Space.`,
            variant: 'primary',
            confirmText: 'Submit Merge',
            onConfirm: async () => {
                try {
                    await rpcRequestPublish(sendRpc, String(skill.id), undefined, currentWorkspace.id);
                    await reload();
                    showFlash('success', `Submitted ${skill.name} for merge review.`);
                } catch (err: any) {
                    showFlash('error', err.message || 'Failed to submit skill');
                }
            },
        });
    };

    const handleContributeSkill = (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        setConfirmDialog({
            isOpen: true,
            title: 'Contribute to Global',
            description: `Contribute the latest merged version of "${skill.name}" to Global? Local unmerged edits are excluded from this request.`,
            variant: 'primary',
            confirmText: 'Contribute',
            onConfirm: async () => {
                try {
                    await rpcRequestPublish(sendRpc, String(skill.id), true, currentWorkspace.id);
                    await reload();
                    showFlash('success', `Submitted ${skill.name} for global contribution review.`);
                } catch (err: any) {
                    showFlash('error', err.message || 'Failed to contribute skill');
                }
            },
        });
    };

    const handleWithdrawSkill = (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        const isContributionRequest = skill.contributionStatus === 'pending' && skill.reviewStatus !== 'pending';
        setConfirmDialog({
            isOpen: true,
            title: isContributionRequest ? 'Withdraw Contribution Request' : 'Withdraw Merge Request',
            description: isContributionRequest
                ? `Withdraw the contribution request for "${skill.name}"? The merged version will stay unchanged in Skill Space.`
                : `Withdraw the merge request for "${skill.name}"? The working copy will stay in Skill Space.`,
            variant: 'warning',
            confirmText: 'Withdraw',
            onConfirm: async () => {
                try {
                    await rpcWithdrawSkill(sendRpc, String(skill.id), currentWorkspace.id);
                    await reload();
                    showFlash('success', `Withdrew ${skill.name} review request.`);
                } catch (err: any) {
                    showFlash('error', err.message || 'Failed to withdraw skill');
                }
            },
        });
    };

    const toggleSkillSelection = (skillId: string) => {
        setSelectedSkillIds(prev => {
            const next = new Set(prev);
            if (next.has(skillId)) next.delete(skillId);
            else next.add(skillId);
            return next;
        });
    };

    const clearSelection = () => setSelectedSkillIds(new Set());
    const exitMergeMode = () => {
        clearSelection();
        setIsMergeMode(false);
    };
    const selectAllVisible = () => {
        setSelectedSkillIds(new Set(visibleSkills.map(skill => String(skill.id))));
    };

    const handleBatchSubmit = async () => {
        if (!currentWorkspace?.id || selectedReadyCount === 0) return;
        setBatchBusy(true);
        try {
            let submittedCount = 0;
            for (const skill of selectedSkills) {
                if (!getSkillSpaceStatus(skill).mergeActionable) continue;
                await rpcRequestPublish(sendRpc, String(skill.id), undefined, currentWorkspace.id);
                submittedCount += 1;
            }
            await reload();
            exitMergeMode();
            showFlash('success', `Submitted ${submittedCount} skill${submittedCount === 1 ? '' : 's'} for merge review.`);
        } catch (err: any) {
            showFlash('error', err.message || 'Failed to submit selected skills');
        } finally {
            setBatchBusy(false);
        }
    };

    const handleBatchWithdraw = async () => {
        if (!currentWorkspace?.id || selectedPendingCount === 0) return;
        setBatchBusy(true);
        try {
            let withdrawnCount = 0;
            for (const skill of selectedSkills) {
                if (skill.reviewStatus !== 'pending') continue;
                await rpcWithdrawSkill(sendRpc, String(skill.id), currentWorkspace.id);
                withdrawnCount += 1;
            }
            await reload();
            exitMergeMode();
            showFlash('success', `Withdrew ${withdrawnCount} review request${withdrawnCount === 1 ? '' : 's'}.`);
        } catch (err: any) {
            showFlash('error', err.message || 'Failed to withdraw selected requests');
        } finally {
            setBatchBusy(false);
        }
    };

    const handleForkToPersonal = async (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        const skillId = String(skill.id);
        setForkingSkillIds(prev => new Set(prev).add(skillId));
        try {
            await rpcForkSkill(sendRpc, skillId, { workspaceId: currentWorkspace.id });
            await reload();
            showFlash('success', `Forked ${skill.name} to Personal.`);
        } catch (err: any) {
            showFlash('error', err.message || 'Failed to fork skill');
        } finally {
            setForkingSkillIds(prev => {
                const next = new Set(prev);
                next.delete(skillId);
                return next;
            });
        }
    };

    const renderSkillSpaceCard = (skill: Skill) => {
        const status = getSkillSpaceStatus(skill);
        const badges: SkillCardBadge[] = [
            { label: status.label, className: status.tone },
            ...(skill.globalSkillId ? [{ label: 'Shadows Global', className: 'bg-blue-50 text-blue-700 border-blue-200' }] : []),
        ];
        const actions: SkillCardAction[] = [
            {
                key: 'withdraw',
                tooltip: 'Withdraw',
                icon: RotateCcw,
                tone: 'orange',
                hidden: skill.reviewStatus !== 'pending' && skill.contributionStatus !== 'pending',
                onClick: (e) => { e.stopPropagation(); handleWithdrawSkill(skill); },
            },
            {
                key: 'submit',
                tooltip: 'Submit Merge',
                icon: Upload,
                tone: 'blue',
                hidden: !status.mergeActionable,
                onClick: (e) => { e.stopPropagation(); handleSubmitSkill(skill); },
            },
            {
                key: 'contribute',
                tooltip: 'Contribute to Global',
                icon: Upload,
                tone: 'blue',
                hidden: !status.canContribute,
                onClick: (e) => { e.stopPropagation(); handleContributeSkill(skill); },
            },
            {
                key: 'fork',
                tooltip: 'Fork to Personal',
                icon: GitFork,
                tone: 'purple',
                disabled: forkingSkillIds.has(String(skill.id)),
                onClick: (e) => { e.stopPropagation(); handleForkToPersonal(skill); },
            },
            {
                key: 'diff',
                tooltip: 'Open Diff',
                icon: Eye,
                tone: 'cyan',
                hidden: !(skill.forkedFromId || (skill.publishedVersion && skill.publishedVersion > 0)),
                onClick: (e) => { e.stopPropagation(); handleViewDiff(skill); },
            },
            {
                key: 'open',
                tooltip: 'Configure Skill',
                icon: Settings,
                tone: 'primary',
                onClick: () => navigate(`/skills/${skill.id}`, { state: { fromSkillSpaceId: spaceId } }),
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
                selectionMode={isOwner && isMergeMode ? {
                    selected: selectedSkillIds.has(String(skill.id)),
                    onToggle: () => toggleSkillSelection(String(skill.id)),
                } : undefined}
                showToggle
                onToggleEnabled={(e) => handleToggleEnabled(e, skill)}
                labelColors={DEFAULT_SKILL_LABEL_COLORS}
                descriptionFallback="No description"
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
                <button onClick={() => navigate('/skills?tab=myskills')} className="text-sm text-gray-600 hover:text-gray-900 underline">Back to Skills</button>
            </div>
        );
    }
    if (error || !spaceData) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="text-sm text-gray-500">{error || 'Skill space not found'}</p>
                <button onClick={() => navigate('/skills?tab=myskills')} className="text-sm text-gray-600 hover:text-gray-900 underline">Back to Skills</button>
            </div>
        );
    }

    return (
        <div className="h-full bg-white flex flex-col">
            <ConfirmDialog isOpen={confirmDialog.isOpen} onClose={() => setConfirmDialog(p => ({ ...p, isOpen: false }))}
                onConfirm={confirmDialog.onConfirm} title={confirmDialog.title} description={confirmDialog.description}
                variant={confirmDialog.variant} confirmText={confirmDialog.confirmText} />
            <DiffViewerModal
                isOpen={diffModal.isOpen}
                onClose={() => setDiffModal(prev => ({ ...prev, isOpen: false }))}
                title={diffModal.title}
                subtitle={diffModal.subtitle}
                diffText={diffModal.diffText}
                metadataChanges={diffModal.metadataChanges}
                isLoading={diffModal.isLoading}
            />
            <AddSkillDialog isOpen={addDialog} skillSpaceId={spaceId!} skillSpaceName={spaceData.name} workspaceId={currentWorkspace!.id}
                sendRpc={sendRpc} onClose={() => setAddDialog(false)} onSuccess={reload} />
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
                <button onClick={() => navigate('/skills?tab=myskills')}
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
                            {isOwner && spaceData.skills.length > 0 && !isMergeMode && (
                                <button
                                    onClick={() => {
                                        clearSelection();
                                        setIsMergeMode(true);
                                    }}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
                                >
                                    <Layers3 className="w-3.5 h-3.5" /> Start Merge Mode
                                </button>
                            )}
                            {isMaintainer && (
                                <button onClick={() => setAddDialog(true)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                                    <Plus className="w-3.5 h-3.5" /> Add Skill
                                </button>
                            )}
                        </div>
                    </div>
                    {spaceData.skills.length > 0 && isOwner && isMergeMode && (
                        <div className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                            <div className="flex items-center gap-3 flex-wrap text-sm text-slate-600">
                                <span className="inline-flex items-center gap-2 font-medium text-slate-900">
                                    <Layers3 className="w-4 h-4 text-slate-400" />
                                    {selectedSkillIds.size} selected
                                </span>
                                <button
                                    onClick={selectAllVisible}
                                    disabled={selectedSkillIds.size === visibleSkills.length}
                                    className="text-xs font-medium text-slate-500 hover:text-slate-900 disabled:opacity-40"
                                >
                                    Select all
                                </button>
                                <button onClick={clearSelection} className="text-xs font-medium text-slate-400 hover:text-slate-700">Clear</button>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                                <button
                                    onClick={handleBatchSubmit}
                                    disabled={batchBusy || selectedReadyCount === 0}
                                    className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-white bg-slate-900 rounded-xl hover:bg-slate-800 disabled:opacity-40"
                                >
                                    <SendHorizontal className="w-3.5 h-3.5" />
                                    Submit selected merges
                                </button>
                                <button
                                    onClick={handleBatchWithdraw}
                                    disabled={batchBusy || selectedPendingCount === 0}
                                    className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-xl hover:bg-amber-100 disabled:opacity-40"
                                >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    Withdraw selected
                                </button>
                                <button
                                    onClick={exitMergeMode}
                                    className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-100"
                                >
                                    Cancel merge mode
                                </button>
                            </div>
                        </div>
                    )}
                    {spaceData.skills.length === 0 ? (
                        <div className="text-center py-12 text-gray-400">
                            <p className="text-sm">No skills in this space yet.</p>
                            {isMaintainer && <button onClick={() => setAddDialog(true)} className="mt-2 text-sm text-gray-600 hover:text-gray-900 underline">Add your first skill</button>}
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
