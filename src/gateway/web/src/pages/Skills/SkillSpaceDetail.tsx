import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Plus, Trash2, LogOut, Pencil, Check, X, Crown, GitFork, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '../../hooks/useWebSocket';
import { getCurrentUser } from '../../auth';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Tooltip } from '../../components/Tooltip';
import { AddSkillDialog } from './AddSkillDialog';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import type { Skill, SkillSpace, SkillSpaceMember } from './skillsData';
import {
    rpcGetSkillSpace, rpcUpdateSkillSpace, rpcDeleteSkillSpace,
    rpcAddSkillSpaceMember, rpcRemoveSkillSpaceMember,
    rpcForkSkill, rpcDeleteSkill, rpcRequestPublish, rpcWithdrawSkill, rpcGetSkillDiff, rpcGetSkillSystemCapabilities,
} from './skillsData';

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
    const [skillSpaceDevMode, setSkillSpaceDevMode] = useState(false);
    const [addDialog, setAddDialog] = useState(false);
    const [showInvite, setShowInvite] = useState(false);
    const [inviteUsername, setInviteUsername] = useState('');
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{
        isOpen: boolean; title: string; description: string;
        variant: 'primary' | 'danger' | 'warning'; confirmText: string; onConfirm: () => void;
    }>({ isOpen: false, title: '', description: '', variant: 'primary', confirmText: 'Confirm', onConfirm: () => {} });

    const isOwner = spaceData?.ownerId === currentUser?.id;
    const isMaintainer = spaceData?.members.some(m => m.userId === currentUser?.id && (m.role === 'owner' || m.role === 'maintainer')) ?? false;
    const isMember = spaceData?.members.some(m => m.userId === currentUser?.id) ?? false;

    const reload = useCallback(async () => {
        if (!spaceId || !isConnected || !currentWorkspace?.id) return;
        try {
            const [caps, data] = await Promise.all([
                rpcGetSkillSystemCapabilities(sendRpc, currentWorkspace.id),
                rpcGetSkillSpace(sendRpc, currentWorkspace.id, spaceId),
            ]);
            setSkillSpaceEnabled(caps.skillSpaceEnabled);
            setSkillSpaceDevMode(!!caps.skillSpaceDevMode);
            setSpaceData({
                ...data,
                skills: data.skills.map((s: any) => ({ ...s, icon: null, version: `v${s.version || 1}`, enabled: s.enabled ?? true })),
            });
            setError(null);
        } catch (err: any) {
            setError(err.message || 'Failed to load skill space');
        } finally {
            setLoading(false);
        }
    }, [spaceId, isConnected, sendRpc, currentWorkspace?.id]);

    useEffect(() => { reload(); }, [reload]);

    const handleInvite = async () => {
        if (!spaceId || !inviteUsername.trim() || !currentWorkspace?.id) return;
        setInviteError(null);
        try {
            await rpcAddSkillSpaceMember(sendRpc, currentWorkspace.id, spaceId, inviteUsername.trim());
            setInviteUsername('');
            setShowInvite(false);
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
            onConfirm: async () => { await rpcRemoveSkillSpaceMember(sendRpc, currentWorkspace!.id, spaceId!, userId); reload(); },
        });
    };

    const handleLeave = () => {
        setConfirmDialog({
            isOpen: true, title: 'Leave Skill Space',
            description: 'You will lose access to all skills in this space.',
            variant: 'warning', confirmText: 'Leave',
            onConfirm: async () => {
                await rpcRemoveSkillSpaceMember(sendRpc, currentWorkspace!.id, spaceId!, currentUser!.id);
                navigate('/skills?tab=myskills');
            },
        });
    };

    const handleDeleteSpace = () => {
        setConfirmDialog({
            isOpen: true, title: 'Delete Skill Space',
            description: 'All skills must be removed first.',
            variant: 'danger', confirmText: 'Delete',
            onConfirm: async () => {
                try { await rpcDeleteSkillSpace(sendRpc, currentWorkspace!.id, spaceId!); navigate('/skills?tab=myskills'); }
                catch (err: any) { setError(err.message || 'Failed to delete'); }
            },
        });
    };

    const handleDeleteSkill = (skill: Skill) => {
        setConfirmDialog({
            isOpen: true, title: 'Remove Skill',
            description: `Delete "${skill.name}" from this skill space?`,
            variant: 'danger', confirmText: 'Delete',
            onConfirm: async () => { await rpcDeleteSkill(sendRpc, String(skill.id), currentWorkspace?.id); reload(); },
        });
    };

    const handleSubmitPromotion = async (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        try {
            await rpcRequestPublish(sendRpc, String(skill.id), undefined, currentWorkspace.id);
            await reload();
        } catch (err: any) {
            setError(err.message || 'Failed to submit promotion');
        }
    };

    const handleWithdrawPromotion = async (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        try {
            await rpcWithdrawSkill(sendRpc, String(skill.id), currentWorkspace.id);
            await reload();
        } catch (err: any) {
            setError(err.message || 'Failed to withdraw promotion');
        }
    };

    const handleViewDiff = async (skill: Skill) => {
        if (!currentWorkspace?.id) return;
        try {
            const result = await rpcGetSkillDiff(sendRpc, String(skill.id), false, currentWorkspace.id);
            setConfirmDialog({
                isOpen: true,
                title: `${skill.name} vs Global`,
                description: result.diff || 'No changes detected.',
                variant: 'primary',
                confirmText: 'Close',
                onConfirm: () => {},
            });
        } catch (err: any) {
            setError(err.message || 'Failed to load diff');
        }
    };

    if (loading) {
        return <div className="flex items-center justify-center h-full"><div className="w-5 h-5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" /></div>;
    }
    if (currentWorkspace?.envType !== 'test' || !skillSpaceEnabled) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="text-sm text-gray-500">Skill Space is available only in K8s test workspaces.</p>
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
            <AddSkillDialog isOpen={addDialog} skillSpaceId={spaceId!} skillSpaceName={spaceData.name} workspaceId={currentWorkspace!.id}
                sendRpc={sendRpc} onClose={() => setAddDialog(false)} onSuccess={reload} />

            {skillSpaceDevMode && (
                <div className="px-6 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-200">
                    Skill Space Dev Mode is enabled locally. You can debug the collaboration UI and review flow here, but local runtime loading is still disabled.
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
                        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Skills ({spaceData.skills.length})</h2>
                        {isMaintainer && (
                            <button onClick={() => setAddDialog(true)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                                <Plus className="w-3.5 h-3.5" /> Add Skill
                            </button>
                        )}
                    </div>
                    {spaceData.skills.length === 0 ? (
                        <div className="text-center py-12 text-gray-400">
                            <p className="text-sm">No skills in this space yet.</p>
                            {isMaintainer && <button onClick={() => setAddDialog(true)} className="mt-2 text-sm text-gray-600 hover:text-gray-900 underline">Add your first skill</button>}
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {spaceData.skills.map(skill => (
                                <div key={skill.id} onClick={() => navigate(`/skills/${skill.id}`)}
                                    className="group rounded-xl border border-gray-200 p-5 hover:shadow-md hover:border-gray-300 transition-all cursor-pointer flex flex-col">
                                    <div className="flex items-start justify-between mb-2">
                                        <h3 className="text-sm font-semibold text-gray-900 group-hover:text-gray-700 truncate flex-1">{skill.name}</h3>
                                        {isMaintainer && (
                                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2" onClick={e => e.stopPropagation()}>
                                                <Tooltip content="Fork to Personal">
                                                    <button onClick={() => rpcForkSkill(sendRpc, String(skill.id), { workspaceId: currentWorkspace!.id }).then(reload)} className="p-1 text-gray-300 hover:text-gray-600 rounded">
                                                        <GitFork className="w-3.5 h-3.5" />
                                                    </button>
                                                </Tooltip>
                                                <Tooltip content="Delete">
                                                    <button onClick={() => handleDeleteSkill(skill)} className="p-1 text-gray-300 hover:text-red-500 rounded">
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </Tooltip>
                                            </div>
                                        )}
                                    </div>
                                    <p className="text-xs text-gray-500 line-clamp-2 flex-1">{skill.description || 'No description'}</p>
                                    <div className="flex items-center gap-2 mt-3 flex-wrap">
                                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-50 text-green-600 border border-green-200">{spaceData.name}</span>
                                        <span className={cn(
                                            "text-[10px] font-medium px-1.5 py-0.5 rounded border",
                                            skill.reviewStatus === 'pending'
                                                ? "bg-amber-50 text-amber-700 border-amber-200"
                                                : skill.globalSkillId
                                                    ? "bg-blue-50 text-blue-700 border-blue-200"
                                                    : "bg-gray-50 text-gray-600 border-gray-200"
                                        )}>
                                            {skill.reviewStatus === 'pending' ? 'Pending Promotion' : skill.globalSkillId ? 'Shadows Global' : 'Draft'}
                                        </span>
                                        <span className="text-[10px] text-gray-400">v{(skill as any).version || 1}</span>
                                    </div>
                                    <div className="mt-3 flex items-center gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
                                        <button onClick={() => handleViewDiff(skill)} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-md hover:bg-gray-100">
                                            Diff vs Global
                                        </button>
                                        {isOwner && skill.reviewStatus !== 'pending' && (
                                            <button onClick={() => handleSubmitPromotion(skill)} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-white bg-gray-900 rounded-md hover:bg-gray-800">
                                                Submit Promotion
                                            </button>
                                        )}
                                        {isOwner && skill.reviewStatus === 'pending' && (
                                            <button onClick={() => handleWithdrawPromotion(skill)} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100">
                                                Withdraw
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))}
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
