/**
 * SkillSetSection — inline card section for a skill set on the My Skills tab.
 * Handles: share popover, settings popover, skill actions, add skill dialog.
 * No separate detail page needed.
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Plus, Trash2, LogOut, Pencil, Check, X, Crown, GitFork, Link2, Copy, RefreshCw, UserPlus, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getCurrentUser } from '../../auth';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Tooltip } from '../../components/Tooltip';
import { AddSkillDialog } from './AddSkillDialog';
import type { Skill, SkillSet, SkillSetMember } from './skillsData';
import {
    rpcGetSkillSet, rpcUpdateSkillSet, rpcDeleteSkillSet,
    rpcAddSkillSetMember, rpcRemoveSkillSetMember,
    rpcForkSkill, rpcDeleteSkill, rpcToggleShareLink,
    type RpcSendFn,
} from './skillsData';

interface SkillSetSectionProps {
    skillSet: SkillSet;
    skills: Skill[];
    sendRpc: RpcSendFn;
    onReload: () => void;
}

export function SkillSetSection({ skillSet, skills, sendRpc, onReload }: SkillSetSectionProps) {
    const navigate = useNavigate();
    const currentUser = getCurrentUser();
    const isOwner = skillSet.ownerId === currentUser?.id;

    // Share popover
    const [showShare, setShowShare] = useState(false);
    const [shareData, setShareData] = useState<{ members: SkillSetMember[]; inviteToken: string | null } | null>(null);
    const [inviteUsername, setInviteUsername] = useState('');
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    // Settings popover
    const [showSettings, setShowSettings] = useState(false);
    const [editName, setEditName] = useState<string | null>(null);
    const [editDesc, setEditDesc] = useState<string | null>(null);

    // Add skill dialog
    const [addDialog, setAddDialog] = useState(false);

    // Confirm dialog
    const [confirmDialog, setConfirmDialog] = useState<{
        isOpen: boolean; title: string; description: string;
        variant: 'primary' | 'danger' | 'warning';
        confirmText: string; onConfirm: () => void;
    }>({ isOpen: false, title: '', description: '', variant: 'primary', confirmText: 'Confirm', onConfirm: () => {} });

    const loadShareData = useCallback(async () => {
        const data = await rpcGetSkillSet(sendRpc, skillSet.id);
        setShareData({
            members: data.members ?? [],
            inviteToken: (data as any).inviteToken ?? null,
        });
    }, [sendRpc, skillSet.id]);

    const openShare = async () => {
        setShowShare(true);
        setShowSettings(false);
        setInviteError(null);
        setInviteUsername('');
        await loadShareData();
    };

    const openSettings = async () => {
        setShowSettings(true);
        setShowShare(false);
        setEditName(null);
        setEditDesc(null);
        await loadShareData();
    };

    // ─── Share link ───
    const shareUrl = shareData?.inviteToken
        ? `${window.location.origin}/skills/sets/join/${shareData.inviteToken}`
        : null;

    const handleToggleShareLink = async (enabled: boolean) => {
        await rpcToggleShareLink(sendRpc, skillSet.id, enabled);
        await loadShareData();
    };

    const handleResetLink = () => {
        setConfirmDialog({
            isOpen: true, title: 'Reset Share Link',
            description: 'The current link will stop working. A new link will be generated.',
            variant: 'warning', confirmText: 'Reset',
            onConfirm: async () => {
                await rpcToggleShareLink(sendRpc, skillSet.id, false);
                await rpcToggleShareLink(sendRpc, skillSet.id, true);
                await loadShareData();
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

    const handleInvite = async () => {
        if (!inviteUsername.trim()) return;
        setInviteError(null);
        try {
            await rpcAddSkillSetMember(sendRpc, skillSet.id, inviteUsername.trim());
            setInviteUsername('');
            await loadShareData();
            onReload();
        } catch (err: any) {
            setInviteError(err.message || 'Failed to invite');
        }
    };

    // ─── Settings actions ───
    const handleSaveName = async () => {
        if (editName === null || !editName.trim() || editName.trim() === skillSet.name) {
            setEditName(null);
            return;
        }
        await rpcUpdateSkillSet(sendRpc, skillSet.id, { name: editName.trim() });
        setEditName(null);
        onReload();
    };

    const handleSaveDesc = async () => {
        if (editDesc === null) return;
        await rpcUpdateSkillSet(sendRpc, skillSet.id, { description: editDesc.trim() });
        setEditDesc(null);
        onReload();
    };

    const handleRemoveMember = (userId: string, username: string) => {
        setConfirmDialog({
            isOpen: true, title: 'Remove Member',
            description: `Remove "${username}" from this skill set?`,
            variant: 'danger', confirmText: 'Remove',
            onConfirm: async () => {
                await rpcRemoveSkillSetMember(sendRpc, skillSet.id, userId);
                await loadShareData();
                onReload();
            },
        });
    };

    const handleLeave = () => {
        setConfirmDialog({
            isOpen: true, title: 'Leave Skill Set',
            description: 'You will lose access to all skills in this set.',
            variant: 'warning', confirmText: 'Leave',
            onConfirm: async () => {
                if (!currentUser) return;
                await rpcRemoveSkillSetMember(sendRpc, skillSet.id, currentUser.id);
                onReload();
            },
        });
    };

    const handleDeleteSet = () => {
        setConfirmDialog({
            isOpen: true, title: 'Delete Skill Set',
            description: 'All skills must be removed first.',
            variant: 'danger', confirmText: 'Delete',
            onConfirm: async () => {
                await rpcDeleteSkillSet(sendRpc, skillSet.id);
                onReload();
            },
        });
    };

    const handleDeleteSkill = (skill: Skill) => {
        setConfirmDialog({
            isOpen: true, title: 'Remove Skill',
            description: `Delete "${skill.name}" from this skill set?`,
            variant: 'danger', confirmText: 'Delete',
            onConfirm: async () => {
                await rpcDeleteSkill(sendRpc, String(skill.id));
                onReload();
            },
        });
    };

    return (
        <>
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
                skillSetId={skillSet.id}
                skillSetName={skillSet.name}
                sendRpc={sendRpc}
                onClose={() => setAddDialog(false)}
                onSuccess={onReload}
            />

            <div className="border rounded-xl overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50/80 border-b">
                    <div className="flex items-center gap-2 text-sm font-medium text-gray-700 min-w-0">
                        <Users className="w-4 h-4 text-green-600 shrink-0" />
                        <span className="truncate">{skillSet.name}</span>
                        <span className="text-xs text-gray-400 font-normal shrink-0">({skills.length})</span>
                    </div>
                    <div className="flex items-center gap-1 relative">
                        <Tooltip content="Add Skill">
                            <button
                                onClick={() => setAddDialog(true)}
                                className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                            >
                                <Plus className="w-4 h-4" />
                            </button>
                        </Tooltip>
                        <Tooltip content="Share">
                            <button
                                onClick={openShare}
                                className={cn("p-1.5 rounded-lg transition-colors", showShare ? "text-green-600 bg-green-50" : "text-gray-400 hover:text-gray-700 hover:bg-gray-100")}
                            >
                                <Link2 className="w-4 h-4" />
                            </button>
                        </Tooltip>
                        <Tooltip content="Settings">
                            <button
                                onClick={openSettings}
                                className={cn("p-1.5 rounded-lg transition-colors", showSettings ? "text-gray-700 bg-gray-100" : "text-gray-400 hover:text-gray-700 hover:bg-gray-100")}
                            >
                                <Settings className="w-4 h-4" />
                            </button>
                        </Tooltip>

                        {/* Share popover */}
                        {showShare && (
                            <div className="absolute right-0 top-full mt-1 w-80 bg-white border rounded-xl shadow-xl p-4 z-20 space-y-4" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-semibold text-gray-700">Share</span>
                                    <button onClick={() => setShowShare(false)} className="text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
                                </div>

                                {/* Share link */}
                                {isOwner && (
                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="text-xs text-gray-600 flex items-center gap-1.5">
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
                                                <div className="bg-gray-50 border rounded-lg px-2 py-1.5">
                                                    <input readOnly value={shareUrl} className="w-full text-xs text-gray-600 bg-transparent border-none outline-none select-all" onClick={e => (e.target as HTMLInputElement).select()} />
                                                </div>
                                                <div className="flex gap-1.5">
                                                    <button onClick={handleCopyLink} className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded transition-colors">
                                                        <Copy className="w-3 h-3" />
                                                        {copied ? 'Copied!' : 'Copy'}
                                                    </button>
                                                    <button onClick={handleResetLink} className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors" title="Reset link">
                                                        <RefreshCw className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Direct invite */}
                                {isOwner && (
                                    <div className={isOwner && shareUrl !== undefined ? "border-t pt-3" : ""}>
                                        <span className="text-xs text-gray-600 flex items-center gap-1.5 mb-2">
                                            <UserPlus className="w-3 h-3" />
                                            Add by username
                                        </span>
                                        <div className="flex gap-1.5">
                                            <input
                                                value={inviteUsername}
                                                onChange={e => setInviteUsername(e.target.value)}
                                                onKeyDown={e => e.key === 'Enter' && handleInvite()}
                                                placeholder="Username"
                                                className="flex-1 px-2.5 py-1.5 text-xs border rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300"
                                            />
                                            <button onClick={handleInvite} disabled={!inviteUsername.trim()} className="px-3 py-1.5 text-xs font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg disabled:opacity-40">
                                                Add
                                            </button>
                                        </div>
                                        {inviteError && <p className="text-xs text-red-500 mt-1">{inviteError}</p>}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Settings popover */}
                        {showSettings && shareData && (
                            <div className="absolute right-0 top-full mt-1 w-80 bg-white border rounded-xl shadow-xl p-4 z-20 space-y-4" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-between">
                                    <span className="text-xs font-semibold text-gray-700">Settings</span>
                                    <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
                                </div>

                                {/* Rename */}
                                {isOwner && (
                                    <div>
                                        <label className="text-xs text-gray-500 mb-1 block">Name</label>
                                        {editName !== null ? (
                                            <div className="flex gap-1">
                                                <input autoFocus value={editName} onChange={e => setEditName(e.target.value)}
                                                    onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setEditName(null); }}
                                                    className="flex-1 px-2 py-1 text-sm border rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300" />
                                                <button onClick={handleSaveName} className="text-gray-400 hover:text-gray-600"><Check className="w-3.5 h-3.5" /></button>
                                                <button onClick={() => setEditName(null)} className="text-gray-400 hover:text-gray-600"><X className="w-3.5 h-3.5" /></button>
                                            </div>
                                        ) : (
                                            <button onClick={() => setEditName(skillSet.name)} className="w-full text-left text-sm text-gray-900 hover:bg-gray-50 rounded px-2 py-1 flex items-center gap-1 group">
                                                {skillSet.name} <Pencil className="w-3 h-3 text-gray-300 opacity-0 group-hover:opacity-100" />
                                            </button>
                                        )}
                                    </div>
                                )}

                                {/* Description */}
                                {isOwner && (
                                    <div>
                                        <label className="text-xs text-gray-500 mb-1 block">Description</label>
                                        {editDesc !== null ? (
                                            <div className="space-y-1">
                                                <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)}
                                                    className="w-full px-2 py-1 text-sm border rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300 h-16 resize-none" autoFocus />
                                                <div className="flex gap-1 justify-end">
                                                    <button onClick={() => setEditDesc(null)} className="px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100 rounded">Cancel</button>
                                                    <button onClick={handleSaveDesc} className="px-2 py-0.5 text-xs font-medium text-white bg-gray-900 rounded hover:bg-gray-800">Save</button>
                                                </div>
                                            </div>
                                        ) : (
                                            <button onClick={() => setEditDesc(skillSet.description || '')} className="w-full text-left text-sm text-gray-500 hover:bg-gray-50 rounded px-2 py-1 flex items-center gap-1 group">
                                                {skillSet.description || <span className="italic text-gray-400">Add description...</span>}
                                                <Pencil className="w-3 h-3 text-gray-300 opacity-0 group-hover:opacity-100" />
                                            </button>
                                        )}
                                    </div>
                                )}

                                {/* Members */}
                                <div>
                                    <label className="text-xs text-gray-500 mb-1.5 block">Members ({shareData.members.length})</label>
                                    <div className="space-y-1 max-h-32 overflow-y-auto">
                                        {shareData.members.map(m => (
                                            <div key={m.userId} className="flex items-center justify-between px-2 py-1 rounded text-sm">
                                                <span className="flex items-center gap-1.5">
                                                    {m.role === 'owner' && <Crown className="w-3 h-3 text-amber-500" />}
                                                    <span className="text-gray-700">{(m as any).username || m.userId.slice(0, 8)}</span>
                                                    <span className="text-xs text-gray-400">{m.role}</span>
                                                </span>
                                                {isOwner && m.role !== 'owner' && (
                                                    <button onClick={() => handleRemoveMember(m.userId, (m as any).username || m.userId)} className="text-gray-300 hover:text-red-500">
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Actions */}
                                <div className="border-t pt-3 space-y-1">
                                    {!isOwner && (
                                        <button onClick={handleLeave} className="w-full text-left px-2 py-1.5 text-xs text-gray-500 hover:text-red-600 hover:bg-red-50 rounded flex items-center gap-1.5">
                                            <LogOut className="w-3 h-3" /> Leave this set
                                        </button>
                                    )}
                                    {isOwner && (
                                        <button onClick={handleDeleteSet} className="w-full text-left px-2 py-1.5 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 rounded flex items-center gap-1.5">
                                            <Trash2 className="w-3 h-3" /> Delete Skill Set
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Skills grid */}
                <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {skills.map(skill => (
                        <div
                            key={skill.id}
                            onClick={() => navigate(`/skills/${skill.id}`)}
                            className="group rounded-lg border p-4 hover:shadow-sm transition-all cursor-pointer flex items-center justify-between"
                        >
                            <div className="min-w-0 flex-1">
                                <div className="font-medium text-sm text-gray-900 truncate">{skill.name}</div>
                                <div className="text-xs text-gray-500 mt-1 line-clamp-1">{skill.description}</div>
                            </div>
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2" onClick={e => e.stopPropagation()}>
                                <Tooltip content="Fork to Personal">
                                    <button onClick={() => rpcForkSkill(sendRpc, String(skill.id)).then(onReload)} className="p-1 text-gray-300 hover:text-gray-600 rounded">
                                        <GitFork className="w-3.5 h-3.5" />
                                    </button>
                                </Tooltip>
                                <Tooltip content="Delete">
                                    <button onClick={() => handleDeleteSkill(skill)} className="p-1 text-gray-300 hover:text-red-500 rounded">
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </Tooltip>
                            </div>
                        </div>
                    ))}
                    {skills.length === 0 && (
                        <div className="col-span-full text-sm text-gray-400 text-center py-6">
                            No skills yet.{' '}
                            <button onClick={() => setAddDialog(true)} className="underline hover:text-gray-600">Add one</button>
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
