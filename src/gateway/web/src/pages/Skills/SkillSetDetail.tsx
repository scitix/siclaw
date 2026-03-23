import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Plus, Trash2, LogOut, Pencil, Check, X, Crown, GitFork, Link2, Copy, RefreshCw, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '../../hooks/useWebSocket';
import { getCurrentUser } from '../../auth';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Tooltip } from '../../components/Tooltip';
import { AddSkillDialog } from './AddSkillDialog';
import type { Skill, SkillSet, SkillSetMember } from './skillsData';
import {
    rpcGetSkillSet, rpcUpdateSkillSet, rpcDeleteSkillSet,
    rpcAddSkillSetMember, rpcRemoveSkillSetMember,
    rpcForkSkill, rpcDeleteSkill, rpcToggleShareLink,
} from './skillsData';

// ─── Inline Editable Text ──────────────────────────────────

function InlineEdit({ value, onSave, className, placeholder }: {
    value: string;
    onSave: (val: string) => void;
    className?: string;
    placeholder?: string;
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
                <input
                    autoFocus
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
                    className={cn("bg-transparent border-b border-gray-300 focus:border-gray-600 outline-none px-0 py-0.5", className)}
                />
                <button onClick={commit} className="text-gray-400 hover:text-gray-600"><Check className="w-3.5 h-3.5" /></button>
                <button onClick={() => setEditing(false)} className="text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
            </div>
        );
    }

    return (
        <button
            onClick={() => { setDraft(value); setEditing(true); }}
            className={cn("group flex items-center gap-1 hover:bg-gray-50 rounded px-1 -ml-1 transition-colors", className)}
        >
            <span>{value || <span className="text-gray-400 italic">{placeholder || 'Click to edit'}</span>}</span>
            <Pencil className="w-3 h-3 text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
    );
}

// ─── Main Page ─────────────────────────────────────────────

export function SkillSetDetailPage() {
    const { setId } = useParams();
    const navigate = useNavigate();
    const { sendRpc, isConnected } = useWebSocket();
    const currentUser = getCurrentUser();

    const [setData, setSetData] = useState<(SkillSet & { members: SkillSetMember[]; skills: Skill[]; inviteToken?: string | null }) | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Share panel
    const [showShare, setShowShare] = useState(false);
    const [inviteUsername, setInviteUsername] = useState('');
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    // Add skill dialog
    const [addDialog, setAddDialog] = useState(false);

    // Confirm dialog
    const [confirmDialog, setConfirmDialog] = useState<{
        isOpen: boolean; title: string; description: string;
        variant: 'primary' | 'danger' | 'warning';
        confirmText: string; onConfirm: () => void;
    }>({ isOpen: false, title: '', description: '', variant: 'primary', confirmText: 'Confirm', onConfirm: () => {} });

    const isOwner = setData?.ownerId === currentUser?.id;
    const isMember = setData?.members.some(m => m.userId === currentUser?.id) ?? false;

    const reload = useCallback(async () => {
        if (!setId || !isConnected) return;
        try {
            const data = await rpcGetSkillSet(sendRpc, setId);
            const enriched = {
                ...data,
                skills: data.skills.map((s: any) => ({ ...s, icon: null, version: `v${s.version || 1}`, enabled: s.enabled ?? true })),
            };
            setSetData(enriched);
            setError(null);
        } catch (err: any) {
            setError(err.message || 'Failed to load skill set');
        } finally {
            setLoading(false);
        }
    }, [setId, isConnected, sendRpc]);

    useEffect(() => { reload(); }, [reload]);

    const handleUpdateName = async (name: string) => {
        if (!setId) return;
        await rpcUpdateSkillSet(sendRpc, setId, { name });
        reload();
    };

    const handleUpdateDescription = async (description: string) => {
        if (!setId) return;
        await rpcUpdateSkillSet(sendRpc, setId, { description });
        reload();
    };

    // ─── Share link ───
    const shareUrl = setData?.inviteToken
        ? `${window.location.origin}/skills/sets/join/${setData.inviteToken}`
        : null;

    const handleToggleShareLink = async (enabled: boolean) => {
        if (!setId) return;
        await rpcToggleShareLink(sendRpc, setId, enabled);
        reload();
    };

    const handleResetLink = () => {
        setConfirmDialog({
            isOpen: true,
            title: 'Reset Share Link',
            description: 'The current link will stop working. A new link will be generated.',
            variant: 'warning',
            confirmText: 'Reset',
            onConfirm: async () => {
                if (!setId) return;
                // Disable then re-enable to get new token
                await rpcToggleShareLink(sendRpc, setId, false);
                await rpcToggleShareLink(sendRpc, setId, true);
                reload();
            },
        });
    };

    const handleCopyLink = () => {
        if (shareUrl) {
            navigator.clipboard.writeText(shareUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    // ─── Username invite ───
    const handleInvite = async () => {
        if (!setId || !inviteUsername.trim()) return;
        setInviteError(null);
        try {
            await rpcAddSkillSetMember(sendRpc, setId, inviteUsername.trim());
            setInviteUsername('');
            reload();
        } catch (err: any) {
            setInviteError(err.message || 'Failed to invite');
        }
    };

    const handleRemoveMember = (userId: string, username: string) => {
        setConfirmDialog({
            isOpen: true,
            title: 'Remove Member',
            description: `Remove "${username}" from this skill set?`,
            variant: 'danger',
            confirmText: 'Remove',
            onConfirm: async () => {
                if (!setId) return;
                await rpcRemoveSkillSetMember(sendRpc, setId, userId);
                reload();
            },
        });
    };

    const handleLeave = () => {
        setConfirmDialog({
            isOpen: true,
            title: 'Leave Skill Set',
            description: 'You will lose access to all skills in this set. Are you sure?',
            variant: 'warning',
            confirmText: 'Leave',
            onConfirm: async () => {
                if (!setId || !currentUser) return;
                await rpcRemoveSkillSetMember(sendRpc, setId, currentUser.id);
                navigate('/skills?tab=myskills');
            },
        });
    };

    const handleDeleteSet = () => {
        setConfirmDialog({
            isOpen: true,
            title: 'Delete Skill Set',
            description: 'This will permanently delete the skill set. All skills must be removed first.',
            variant: 'danger',
            confirmText: 'Delete',
            onConfirm: async () => {
                if (!setId) return;
                try {
                    await rpcDeleteSkillSet(sendRpc, setId);
                    navigate('/skills?tab=myskills');
                } catch (err: any) {
                    setError(err.message || 'Failed to delete');
                }
            },
        });
    };

    const handleDeleteSkill = (skill: Skill) => {
        setConfirmDialog({
            isOpen: true,
            title: 'Remove Skill',
            description: `Delete "${skill.name}" from this skill set?`,
            variant: 'danger',
            confirmText: 'Delete',
            onConfirm: async () => {
                await rpcDeleteSkill(sendRpc, String(skill.id));
                reload();
            },
        });
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
            </div>
        );
    }

    if (error || !setData) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="text-sm text-gray-500">{error || 'Skill set not found'}</p>
                <button onClick={() => navigate('/skills?tab=myskills')} className="text-sm text-gray-600 hover:text-gray-900 underline">
                    Back to Skills
                </button>
            </div>
        );
    }

    return (
        <div className="h-full bg-white flex flex-col">
            <ConfirmDialog
                isOpen={confirmDialog.isOpen}
                onClose={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
                onConfirm={confirmDialog.onConfirm}
                title={confirmDialog.title}
                description={confirmDialog.description}
                variant={confirmDialog.variant}
                confirmText={confirmDialog.confirmText}
            />

            <AddSkillDialog
                isOpen={addDialog}
                skillSetId={setId!}
                skillSetName={setData.name}
                sendRpc={sendRpc}
                onClose={() => setAddDialog(false)}
                onSuccess={reload}
            />

            {/* Top bar */}
            <div className="px-6 py-4 border-b flex items-center gap-3">
                <button
                    onClick={() => navigate('/skills?tab=myskills')}
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="flex-1 min-w-0">
                    {isOwner ? (
                        <InlineEdit
                            value={setData.name}
                            onSave={handleUpdateName}
                            className="text-lg font-semibold text-gray-900"
                        />
                    ) : (
                        <h1 className="text-lg font-semibold text-gray-900">{setData.name}</h1>
                    )}
                    {isOwner ? (
                        <InlineEdit
                            value={setData.description || ''}
                            onSave={handleUpdateDescription}
                            className="text-sm text-gray-500 mt-0.5"
                            placeholder="Add a description..."
                        />
                    ) : setData.description ? (
                        <p className="text-sm text-gray-500 mt-0.5">{setData.description}</p>
                    ) : null}
                </div>
                {isOwner && (
                    <div className="relative">
                        <button
                            onClick={() => { setShowShare(!showShare); setInviteError(null); }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                        >
                            <Link2 className="w-3.5 h-3.5" />
                            Share
                        </button>

                        {/* Share panel popover */}
                        {showShare && (
                            <div className="absolute right-0 top-full mt-1 w-80 bg-white border rounded-xl shadow-xl p-4 z-20 space-y-4">
                                {/* Share link section */}
                                <div>
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-medium text-gray-700 flex items-center gap-1.5">
                                            <Link2 className="w-3 h-3" />
                                            Anyone with the link can join
                                        </span>
                                        <button
                                            onClick={() => handleToggleShareLink(!shareUrl)}
                                            className={cn(
                                                "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                                                shareUrl ? "bg-green-500" : "bg-gray-200"
                                            )}
                                        >
                                            <span className={cn(
                                                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                                                shareUrl ? "translate-x-[18px]" : "translate-x-[3px]"
                                            )} />
                                        </button>
                                    </div>
                                    {shareUrl && (
                                        <div className="space-y-2">
                                            <div className="flex items-center gap-1 bg-gray-50 border rounded-lg px-2 py-1.5">
                                                <input
                                                    readOnly
                                                    value={shareUrl}
                                                    className="flex-1 text-xs text-gray-600 bg-transparent border-none outline-none select-all min-w-0"
                                                    onClick={e => (e.target as HTMLInputElement).select()}
                                                />
                                            </div>
                                            <div className="flex gap-1.5">
                                                <button
                                                    onClick={handleCopyLink}
                                                    className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded transition-colors"
                                                >
                                                    <Copy className="w-3 h-3" />
                                                    {copied ? 'Copied!' : 'Copy Link'}
                                                </button>
                                                <button
                                                    onClick={handleResetLink}
                                                    className="inline-flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                                                    title="Generate new link (old link stops working)"
                                                >
                                                    <RefreshCw className="w-3 h-3" />
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Direct invite section */}
                                <div className="border-t pt-3">
                                    <span className="text-xs font-medium text-gray-700 flex items-center gap-1.5 mb-2">
                                        <UserPlus className="w-3 h-3" />
                                        Add people directly
                                    </span>
                                    <div className="flex gap-1.5">
                                        <input
                                            value={inviteUsername}
                                            onChange={e => setInviteUsername(e.target.value)}
                                            onKeyDown={e => e.key === 'Enter' && handleInvite()}
                                            placeholder="Username"
                                            className="flex-1 px-2.5 py-1.5 text-xs border rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300"
                                        />
                                        <button
                                            onClick={handleInvite}
                                            disabled={!inviteUsername.trim()}
                                            className="px-3 py-1.5 text-xs font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg disabled:opacity-40"
                                        >
                                            Add
                                        </button>
                                    </div>
                                    {inviteError && <p className="text-xs text-red-500 mt-1">{inviteError}</p>}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">

                {/* Members section */}
                <section>
                    <div className="flex items-center gap-2 mb-3">
                        <Users className="w-4 h-4 text-gray-400" />
                        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
                            Members ({setData.members.length})
                        </h2>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {setData.members.map(m => (
                            <div
                                key={m.id}
                                className={cn(
                                    "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm border",
                                    m.role === 'owner' ? "bg-amber-50 border-amber-200" : "bg-gray-50 border-gray-200"
                                )}
                            >
                                {m.role === 'owner' && <Crown className="w-3 h-3 text-amber-500" />}
                                <span className="font-medium text-gray-700">{m.username || m.userId.slice(0, 8)}</span>
                                <span className="text-xs text-gray-400">{m.role}</span>
                                {isOwner && m.role !== 'owner' && (
                                    <button
                                        onClick={() => handleRemoveMember(m.userId, m.username || m.userId)}
                                        className="text-gray-300 hover:text-red-500 transition-colors ml-0.5"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                    {!isOwner && isMember && (
                        <button
                            onClick={handleLeave}
                            className="mt-3 inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-red-500 transition-colors"
                        >
                            <LogOut className="w-3 h-3" />
                            Leave this set
                        </button>
                    )}
                </section>

                {/* Skills section */}
                <section>
                    <div className="flex items-center justify-between mb-3">
                        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
                            Skills ({setData.skills.length})
                        </h2>
                        {isMember && (
                            <button
                                onClick={() => setAddDialog(true)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                            >
                                <Plus className="w-3.5 h-3.5" />
                                Add Skill
                            </button>
                        )}
                    </div>

                    {setData.skills.length === 0 ? (
                        <div className="text-center py-12 text-gray-400">
                            <p className="text-sm">No skills in this set yet.</p>
                            {isMember && (
                                <button
                                    onClick={() => setAddDialog(true)}
                                    className="mt-2 text-sm text-gray-600 hover:text-gray-900 underline"
                                >
                                    Add your first skill
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {setData.skills.map(skill => (
                                <div
                                    key={skill.id}
                                    onClick={() => navigate(`/skills/${skill.id}`)}
                                    className="group rounded-xl border border-gray-200 p-5 hover:shadow-md hover:border-gray-300 transition-all cursor-pointer flex flex-col"
                                >
                                    <div className="flex items-start justify-between mb-2">
                                        <h3 className="text-sm font-semibold text-gray-900 group-hover:text-gray-700 truncate flex-1">
                                            {skill.name}
                                        </h3>
                                        {isMember && (
                                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2" onClick={e => e.stopPropagation()}>
                                                <Tooltip content="Fork to Personal">
                                                    <button
                                                        onClick={() => rpcForkSkill(sendRpc, String(skill.id)).then(reload)}
                                                        className="p-1 text-gray-300 hover:text-gray-600 rounded"
                                                    >
                                                        <GitFork className="w-3.5 h-3.5" />
                                                    </button>
                                                </Tooltip>
                                                <Tooltip content="Delete">
                                                    <button
                                                        onClick={() => handleDeleteSkill(skill)}
                                                        className="p-1 text-gray-300 hover:text-red-500 rounded"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </Tooltip>
                                            </div>
                                        )}
                                    </div>
                                    <p className="text-xs text-gray-500 line-clamp-2 flex-1">{skill.description || 'No description'}</p>
                                    <div className="flex items-center gap-2 mt-3">
                                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-50 text-green-600 border border-green-200">
                                            {setData.name}
                                        </span>
                                        <span className="text-[10px] text-gray-400">v{(skill as any).version || 1}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                {/* Danger zone */}
                {isOwner && (
                    <section className="pt-6 border-t">
                        <button
                            onClick={handleDeleteSet}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            Delete Skill Set
                        </button>
                    </section>
                )}
            </div>
        </div>
    );
}
