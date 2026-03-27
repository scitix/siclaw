/**
 * Shared AddSkillDialog — used by both SkillsPage (index.tsx) and SkillSpaceDetail.tsx.
 * Includes: three tabs (Fork from Global / From My Skills / Create New),
 * search, label filter chips, inline error, existing skill filtering, Move/Fork dual actions.
 */

import { useState, useEffect } from 'react';
import { Search, X, GitFork, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Skill } from './skillsData';
import {
    rpcGetSkills, rpcGetSkillSpace, rpcForkSkill, rpcMoveSkillToSpace,
    type RpcSendFn,
} from './skillsData';

// ─── Label colors (shared with index.tsx) ──────────
const LABEL_COLORS: Record<string, string> = {
    kubernetes: 'bg-blue-50 text-blue-700 border-blue-200',
    'bare-metal': 'bg-blue-50 text-blue-700 border-blue-200',
    switch: 'bg-blue-50 text-blue-700 border-blue-200',
    network: 'bg-purple-50 text-purple-700 border-purple-200',
    rdma: 'bg-purple-50 text-purple-700 border-purple-200',
    scheduling: 'bg-purple-50 text-purple-700 border-purple-200',
    storage: 'bg-purple-50 text-purple-700 border-purple-200',
    compute: 'bg-purple-50 text-purple-700 border-purple-200',
    general: 'bg-purple-50 text-purple-700 border-purple-200',
    diagnostic: 'bg-green-50 text-green-700 border-green-200',
    monitoring: 'bg-green-50 text-green-700 border-green-200',
    performance: 'bg-green-50 text-green-700 border-green-200',
    configuration: 'bg-green-50 text-green-700 border-green-200',
    sre: 'bg-orange-50 text-orange-700 border-orange-200',
    developer: 'bg-orange-50 text-orange-700 border-orange-200',
};

export interface AddSkillDialogProps {
    isOpen: boolean;
    skillSpaceId: string;
    skillSpaceName: string;
    workspaceId: string;
    sendRpc: RpcSendFn;
    onClose: () => void;
    onSuccess: () => void;
}

export function AddSkillDialog({
    isOpen, skillSpaceId, skillSpaceName, workspaceId, sendRpc, onClose, onSuccess,
}: AddSkillDialogProps) {
    const [tab, setTab] = useState<'global' | 'personal' | 'new'>('global');
    const [search, setSearch] = useState('');
    const [newName, setNewName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());

    // Data loaded on open
    const [loading, setLoading] = useState(false);
    const [globalSkills, setGlobalSkills] = useState<Skill[]>([]);
    const [personalSkills, setPersonalSkills] = useState<Skill[]>([]);
    const [existingNames, setExistingNames] = useState<Set<string>>(new Set());

    // Load data when dialog opens
    useEffect(() => {
        if (!isOpen) return;
        setLoading(true);
        setError(null);
        setSearch('');
        setNewName('');
        setTab('global');
        setSelectedLabels(new Set());

        Promise.all([
            rpcGetSkills(sendRpc, { limit: 200, workspaceId }),
            rpcGetSkillSpace(sendRpc, workspaceId, skillSpaceId),
        ]).then(([result, spaceDetail]) => {
            setGlobalSkills(result.skills.filter(s => s.scope === 'builtin' || s.scope === 'global'));
            setPersonalSkills(result.skills.filter(s => s.scope === 'personal'));
            setExistingNames(new Set((spaceDetail.skills ?? []).map((s: Skill) => s.name)));
            setLoading(false);
        }).catch(() => {
            setLoading(false);
        });
    }, [isOpen, skillSpaceId, workspaceId, sendRpc]);

    if (!isOpen) return null;

    const handleFork = async (sourceId: string) => {
        setError(null);
        try {
            await rpcForkSkill(sendRpc, sourceId, { targetSkillSpaceId: skillSpaceId, workspaceId });
            onSuccess();
            onClose();
        } catch (err: any) {
            setError(err.message || 'Failed to fork skill');
        }
    };

    const handleMove = async (skillId: string) => {
        setError(null);
        try {
            await rpcMoveSkillToSpace(sendRpc, String(skillId), skillSpaceId, workspaceId);
            onSuccess();
            onClose();
        } catch (err: any) {
            setError(err.message || 'Failed to move skill');
        }
    };

    const handleCreate = async () => {
        const name = newName.trim();
        if (!name) return;
        setError(null);
        try {
            await sendRpc('skill.create', { name, skillSpaceId, workspaceId });
            onSuccess();
            onClose();
        } catch (err: any) {
            setError(err.message || 'Failed to create skill');
        }
    };

    const toggleLabel = (l: string) => {
        setSelectedLabels(prev => {
            const next = new Set(prev);
            if (next.has(l)) next.delete(l); else next.add(l);
            return next;
        });
    };

    // Filter global skills
    const q = search.toLowerCase();
    const filteredGlobal = globalSkills.filter(s => {
        if (existingNames.has(s.name)) return false;
        if (q && !s.name.toLowerCase().includes(q) && !s.description?.toLowerCase().includes(q)) return false;
        if (selectedLabels.size > 0 && ![...selectedLabels].every(l => (s.labels ?? []).includes(l))) return false;
        return true;
    });

    // Label chips data
    const labelCounts = new Map<string, number>();
    for (const s of globalSkills) {
        for (const l of s.labels ?? []) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
    }

    const filteredPersonal = personalSkills.filter(s => !existingNames.has(s.name));

    const tabs = [
        { id: 'global' as const, label: 'Fork from Global' },
        { id: 'personal' as const, label: 'From My Skills' },
        { id: 'new' as const, label: 'Create New' },
    ];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
                <div className="px-6 pt-5 pb-3 border-b">
                    <h3 className="text-base font-semibold text-gray-900">Add Skill to {skillSpaceName}</h3>
                    <div className="flex gap-1 mt-3">
                        {tabs.map(t => (
                            <button
                                key={t.id}
                                onClick={() => { setTab(t.id); setError(null); }}
                                className={cn(
                                    "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
                                    tab === t.id
                                        ? "bg-gray-900 text-white"
                                        : "text-gray-500 hover:bg-gray-100"
                                )}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="px-6 py-4 overflow-y-auto flex-1 min-h-0">
                    {/* Inline error banner */}
                    {error && (
                        <div className="mb-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                            <span className="text-sm text-red-700 flex-1">{error}</span>
                            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    )}

                    {/* ─── Global tab ─── */}
                    {tab === 'global' && (
                        <div>
                            {/* Search */}
                            <div className="relative mb-2">
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                                <input
                                    type="text"
                                    placeholder="Search skills..."
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    className="w-full pl-8 pr-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-green-300"
                                    autoFocus
                                />
                            </div>

                            {/* Label filter chips */}
                            {labelCounts.size > 0 && (
                                <div className="flex flex-wrap gap-1 mb-2">
                                    {[...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([l, c]) => (
                                        <button
                                            key={l}
                                            onClick={() => toggleLabel(l)}
                                            className={cn(
                                                "px-2 py-0.5 rounded-full text-xs border transition-colors",
                                                selectedLabels.has(l)
                                                    ? "bg-green-100 text-green-800 border-green-300"
                                                    : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
                                            )}
                                        >
                                            {l} <span className="text-gray-400 ml-0.5">{c}</span>
                                        </button>
                                    ))}
                                </div>
                            )}

                            {/* Skill list */}
                            <div className="space-y-1">
                                {loading ? (
                                    <div className="flex items-center justify-center py-8">
                                        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                                    </div>
                                ) : filteredGlobal.length === 0 ? (
                                    <div className="text-sm text-gray-400 text-center py-8">No matching skills.</div>
                                ) : filteredGlobal.map(s => (
                                    <button
                                        key={s.id}
                                        onClick={() => handleFork(String(s.id))}
                                        className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-green-50 transition-colors flex items-center justify-between group"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="text-sm font-medium text-gray-900">{s.name}</div>
                                            <div className="text-xs text-gray-500 line-clamp-1">{s.description}</div>
                                            {(s.labels ?? []).length > 0 && (
                                                <div className="flex gap-1 mt-1 flex-wrap">
                                                    {s.labels!.map(l => (
                                                        <span key={l} className={cn("px-1.5 py-0 rounded text-[10px] border", LABEL_COLORS[l] || "bg-gray-50 text-gray-600 border-gray-200")}>{l}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <GitFork className="w-4 h-4 text-gray-300 group-hover:text-green-600 shrink-0 ml-2" />
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ─── Personal tab ─── */}
                    {tab === 'personal' && (
                        <div className="space-y-1">
                            {loading ? (
                                <div className="flex items-center justify-center py-8">
                                    <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                                </div>
                            ) : filteredPersonal.length === 0 ? (
                                <div className="text-sm text-gray-400 text-center py-6">No personal skills available.</div>
                            ) : filteredPersonal.map(s => (
                                <div
                                    key={s.id}
                                    className="px-3 py-2.5 rounded-lg hover:bg-gray-50 transition-colors flex items-center justify-between"
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-medium text-gray-900">{s.name}</div>
                                        <div className="text-xs text-gray-500 line-clamp-1">{s.description}</div>
                                    </div>
                                    <div className="flex gap-1.5 shrink-0 ml-2">
                                        <button
                                            onClick={() => handleMove(String(s.id))}
                                            title="Move (removes from My Skills)"
                                            className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded transition-colors"
                                        >
                                            Move
                                        </button>
                                        <button
                                            onClick={() => handleFork(String(s.id))}
                                            title="Fork (keeps a copy in My Skills)"
                                            className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded transition-colors"
                                        >
                                            Fork
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* ─── New tab ─── */}
                    {tab === 'new' && (
                        <div className="space-y-3">
                            <input
                                type="text"
                                placeholder="New skill name"
                                value={newName}
                                onChange={e => setNewName(e.target.value)}
                                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-300"
                                autoFocus
                                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                            />
                            <button
                                onClick={handleCreate}
                                disabled={!newName.trim()}
                                className="w-full px-4 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg disabled:opacity-40"
                            >
                                Create in {skillSpaceName}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
