import { useState, useEffect, useMemo } from 'react';
import { X, BookOpen, Tag, ChevronRight, Terminal, FileCode, Save, Loader2, Check, AlertCircle, AlertTriangle, Copy, Info, GitFork } from 'lucide-react';
import { cn } from '@/lib/utils';
import { diffLines, type Change } from 'diff';
import type { PilotMessage } from '@/hooks/usePilot';
import type { Skill } from '@/pages/Skills/skillsData';

type RpcSendFn = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

interface SkillData {
    name: string;
    description: string;
    type: string;
    specs: string;
    scripts: Array<{ name: string; content: string }>;
}

interface SkillFiles {
    specs?: string;
    scripts?: Array<{ name: string; content: string }>;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type SaveMode = 'create' | 'update' | 'update-existing' | 'create-new-name';

export interface SkillPanelProps {
    message: PilotMessage;
    sendRpc: RpcSendFn;
    skills: Skill[];
    onSave: (message: PilotMessage) => void;
    onDismiss: (message: PilotMessage) => void;
    onClose: () => void;
    updateMessageMeta: (messageId: string, meta: Record<string, unknown>) => Promise<void>;
}

export function SkillPanel({ message, sendRpc, skills, onSave, onDismiss, onClose, updateMessageMeta }: SkillPanelProps) {
    // Determine initial save state from metadata (avoid flash of idle → saved)
    const meta = message.metadata as Record<string, unknown> | undefined;
    const metaState = meta?.skillCard as string | undefined;
    const metaReviewStatus = meta?.reviewStatus as string | undefined;
    const initialState: SaveState = metaState === 'saved' ? 'saved' : metaState === 'dismissed' ? 'saved' : 'idle';

    const [saveState, setSaveState] = useState<SaveState>(initialState);
    const [errorMsg, setErrorMsg] = useState('');
    const [savedName, setSavedName] = useState(initialState === 'saved' ? 'Saved' : '');
    const [reviewStatus, setReviewStatus] = useState<string | undefined>(metaReviewStatus);
    const [oldFiles, setOldFiles] = useState<SkillFiles | null>(null);
    const [loadingOld, setLoadingOld] = useState(false);
    const [expandedScripts, setExpandedScripts] = useState<Set<string>>(new Set());
    const [specsExpanded, setSpecsExpanded] = useState(true);

    // Parse skill data from tool result
    let parsed: { skill: SkillData; skillId?: string; sourceSkillName?: string; fork?: boolean; summary: string } | null = null;
    try {
        parsed = JSON.parse(message.content);
    } catch {
        // ignore
    }

    const skill = parsed?.skill;
    const isUpdate = message.toolName === 'update_skill';
    const isFork = message.toolName === 'fork_skill' || !!parsed?.fork;

    // Find existing skill by name from skills list (primary lookup strategy)
    // Prefer personal scope: when both team and personal "dice-roll" exist,
    // update should target the personal copy, not the read-only team one.
    // For renames (e.g. roll-dice → rock-paper-scissors), also try matching skillId as a name.
    const matchedSkill = skill
        ? skills.find(s => s.name === skill.name && s.scope === 'personal') ??
          skills.find(s => s.name === skill.name) ??
          (parsed?.skillId
              ? skills.find(s => s.name === parsed.skillId && s.scope === 'personal') ??
                skills.find(s => s.name === parsed.skillId)
              : undefined)
        : undefined;

    // For fork_skill: find the source skill (builtin/team) to fork from
    const forkSourceSkill = isFork
        ? skills.find(s => s.name === (parsed?.sourceSkillName ?? skill?.name) && s.scope !== 'personal') ??
          skills.find(s => s.name === (parsed?.sourceSkillName ?? skill?.name))
        : undefined;

    // Resolve update target: prefer name-matched skill, fall back to toolSkillId
    const updateTargetId = matchedSkill ? String(matchedSkill.id) : parsed?.skillId || undefined;

    // Duplicate detection (create mode only, not for fork)
    const existingSkill = !isUpdate && !isFork ? matchedSkill : undefined;
    const hasDuplicate = !!existingSkill;

    // Sync save state when metadata changes (e.g. from another source)
    useEffect(() => {
        if (metaState === 'saved' || metaState === 'dismissed') {
            setSaveState('saved');
            setSavedName(metaState === 'saved' ? 'Saved' : 'Dismissed');
        }
    }, [metaState]);

    // Fetch old skill content for diff (update mode or fork mode)
    useEffect(() => {
        const fetchId = isUpdate ? updateTargetId
            : isFork ? (forkSourceSkill ? String(forkSourceSkill.id) : undefined)
            : undefined;
        if (!fetchId || !sendRpc) return;
        setLoadingOld(true);
        sendRpc<{ files?: SkillFiles }>('skill.get', { id: fetchId })
            .then(result => {
                setOldFiles(result.files ?? null);
            })
            .catch(() => setOldFiles(null))
            .finally(() => setLoadingOld(false));
    }, [isUpdate, isFork, updateTargetId, forkSourceSkill, sendRpc]);

    // Compute diffs (update mode shows changes; fork mode shows changes vs source)
    const showDiff = isUpdate || (isFork && !!oldFiles);
    const specsDiff = useMemo(() => {
        if (!showDiff || !skill?.specs || !oldFiles?.specs) return null;
        const changes = diffLines(oldFiles.specs ?? '', skill.specs ?? '');
        // Check if all changes are equal (no actual diff)
        if (changes.every(c => !c.added && !c.removed)) return null;
        return changes;
    }, [showDiff, skill?.specs, oldFiles?.specs]);

    const scriptDiffs = useMemo(() => {
        if (!showDiff || !skill?.scripts) return null;
        const oldScriptsMap = new Map(
            (oldFiles?.scripts ?? []).map(s => [s.name, s.content])
        );
        const results: Array<{ name: string; status: 'new' | 'changed' | 'unchanged'; changes?: Change[] }> = [];
        for (const s of skill.scripts) {
            const old = oldScriptsMap.get(s.name);
            if (!old) {
                results.push({ name: s.name, status: 'new' });
            } else {
                const changes = diffLines(old ?? '', s.content ?? '');
                const hasChanges = changes.some(c => c.added || c.removed);
                results.push({
                    name: s.name,
                    status: hasChanges ? 'changed' : 'unchanged',
                    changes: hasChanges ? changes : undefined,
                });
            }
        }
        return results;
    }, [isUpdate, skill?.scripts, oldFiles?.scripts]);

    const isAlreadyUpToDate = isUpdate && specsDiff === null &&
        scriptDiffs?.every(d => d.status === 'unchanged');

    const getUniqueName = () => {
        if (!skill) return '';
        let counter = 2;
        let candidate = `${skill.name}-${counter}`;
        while (skills.some(s => s.name === candidate)) {
            counter++;
            candidate = `${skill.name}-${counter}`;
        }
        return candidate;
    };

    const handleSave = async (mode: SaveMode) => {
        if (!skill) return;
        setSaveState('saving');
        setErrorMsg('');
        setSavedName('');
        try {
            const scripts = skill.scripts?.map(s => ({ name: s.name, content: s.content }));

            let rs: string | undefined;

            if (isFork && mode !== 'create-new-name') {
                // Fork mode: call skill.fork with source skill ID
                const sourceId = forkSourceSkill ? String(forkSourceSkill.id) : undefined;
                if (!sourceId) {
                    throw new Error(`Source skill "${parsed?.sourceSkillName ?? skill.name}" not found`);
                }
                const res = await sendRpc<{ reviewStatus?: string }>('skill.fork', {
                    sourceId,
                    name: skill.name,
                    description: skill.description,
                    type: skill.type,
                    specs: skill.specs,
                    scripts,
                });
                rs = res.reviewStatus;
                setSavedName('Forked to Personal');
            } else if (mode === 'update') {
                // Non-personal skills are read-only — fork to personal
                if (matchedSkill && matchedSkill.scope !== 'personal') {
                    const res = await sendRpc<{ reviewStatus?: string }>('skill.fork', {
                        sourceId: String(matchedSkill.id),
                        name: skill.name,
                        description: skill.description,
                        type: skill.type,
                        specs: skill.specs,
                        scripts,
                    });
                    rs = res.reviewStatus;
                    setSavedName('Saved to Personal');
                } else {
                    const res = await sendRpc<{ reviewStatus?: string }>('skill.update', {
                        id: updateTargetId,
                        name: skill.name,
                        description: skill.description,
                        type: skill.type,
                        specs: skill.specs,
                        scripts,
                    });
                    rs = res.reviewStatus;
                    setSavedName('Updated');
                }
            } else if (mode === 'update-existing' && existingSkill) {
                if (existingSkill.scope === 'personal') {
                    const res = await sendRpc<{ reviewStatus?: string }>('skill.update', {
                        id: String(existingSkill.id),
                        name: skill.name,
                        description: skill.description,
                        type: skill.type,
                        specs: skill.specs,
                        scripts,
                    });
                    rs = res.reviewStatus;
                    setSavedName('Updated');
                } else {
                    const res = await sendRpc<{ reviewStatus?: string }>('skill.fork', {
                        sourceId: String(existingSkill.id),
                        name: skill.name,
                        description: skill.description,
                        type: skill.type,
                        specs: skill.specs,
                        scripts,
                    });
                    rs = res.reviewStatus;
                    setSavedName('Saved to Personal');
                }
            } else if (mode === 'create-new-name') {
                const newName = getUniqueName();
                const res = await sendRpc<{ reviewStatus?: string }>('skill.create', {
                    name: newName,
                    description: skill.description,
                    type: skill.type,
                    specs: skill.specs,
                    scripts,
                });
                rs = res.reviewStatus;
                setSavedName(`Saved as "${newName}"`);
            } else {
                const res = await sendRpc<{ reviewStatus?: string }>('skill.create', {
                    name: skill.name,
                    description: skill.description,
                    type: skill.type,
                    specs: skill.specs,
                    scripts,
                });
                rs = res.reviewStatus;
                setSavedName('Saved');
            }
            setReviewStatus(rs);
            setSaveState('saved');
            await updateMessageMeta(message.id, { skillCard: 'saved', reviewStatus: rs });
            onSave(message);
        } catch (err: any) {
            setSaveState('error');
            setErrorMsg(err?.message || 'Failed to save skill');
        }
    };

    const handleDismiss = async () => {
        await updateMessageMeta(message.id, { skillCard: 'dismissed' });
        onDismiss(message);
    };

    if (!skill) {
        return (
            <div className="w-[480px] border-l border-gray-200 bg-white flex flex-col shrink-0">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                    <span className="text-sm text-gray-500">Invalid skill data</span>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="w-[480px] border-l border-gray-200 bg-white flex flex-col shrink-0 h-full">
            {/* Header */}
            <div className="px-4 py-3 border-b border-gray-200 bg-gradient-to-r from-indigo-50 to-purple-50 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                    <BookOpen className="w-4 h-4 text-indigo-600 shrink-0" />
                    <span className="font-semibold text-sm text-gray-900 truncate">{skill.name}</span>
                    {skill.type && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 text-indigo-700 shrink-0">
                            <Tag className="w-2.5 h-2.5" />
                            {skill.type}
                        </span>
                    )}
                </div>
                <button onClick={onClose} className="p-1 rounded hover:bg-white/60 transition-colors shrink-0">
                    <X className="w-4 h-4 text-gray-500" />
                </button>
            </div>

            {skill.description && (
                <div className="px-4 py-2 border-b border-gray-100 text-xs text-gray-600">
                    {skill.description}
                </div>
            )}

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto min-h-0">
                {loadingOld ? (
                    <div className="flex items-center justify-center py-12 text-gray-400">
                        <Loader2 className="w-5 h-5 animate-spin mr-2" />
                        <span className="text-sm">Loading current version...</span>
                    </div>
                ) : isAlreadyUpToDate ? (
                    <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                        <Check className="w-8 h-8 mb-2 text-green-400" />
                        <span className="text-sm font-medium text-green-600">Already up to date</span>
                        <span className="text-xs text-gray-400 mt-1">No changes detected</span>
                    </div>
                ) : (
                    <>
                        {/* SKILL.md section */}
                        <div className="border-b border-gray-100">
                            <button
                                type="button"
                                className="flex items-center gap-2 w-full px-4 py-2.5 hover:bg-gray-50 transition-colors text-left"
                                onClick={() => setSpecsExpanded(!specsExpanded)}
                            >
                                <ChevronRight className={cn(
                                    "w-3.5 h-3.5 text-gray-400 transition-transform",
                                    specsExpanded && "rotate-90"
                                )} />
                                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">SKILL.md</span>
                                {isUpdate && specsDiff && (
                                    <span className="ml-auto text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">changed</span>
                                )}
                            </button>
                            {specsExpanded && (
                                <div className="px-4 pb-3 max-h-96 overflow-y-auto">
                                    {isUpdate && specsDiff ? (
                                        <DiffView changes={specsDiff} />
                                    ) : (
                                        <pre className="text-xs font-mono leading-relaxed text-gray-600 whitespace-pre-wrap">{skill.specs}</pre>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Scripts section */}
                        {skill.scripts && skill.scripts.length > 0 && (
                            <div className="border-b border-gray-100">
                                <div className="px-4 py-2.5">
                                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Scripts</span>
                                </div>
                                {skill.scripts.map((s, i) => {
                                    const diffInfo = scriptDiffs?.[i];
                                    const isExpanded = expandedScripts.has(s.name);
                                    return (
                                        <div key={s.name} className="border-t border-gray-50">
                                            <button
                                                type="button"
                                                className="flex items-center gap-2 w-full px-4 py-2 hover:bg-gray-50 transition-colors text-left"
                                                onClick={() => setExpandedScripts(prev => {
                                                    const next = new Set(prev);
                                                    if (next.has(s.name)) next.delete(s.name);
                                                    else next.add(s.name);
                                                    return next;
                                                })}
                                            >
                                                <ChevronRight className={cn(
                                                    "w-3 h-3 text-gray-400 transition-transform",
                                                    isExpanded && "rotate-90"
                                                )} />
                                                {s.name.endsWith('.py') ? (
                                                    <FileCode className="w-3.5 h-3.5 text-blue-500" />
                                                ) : (
                                                    <Terminal className="w-3.5 h-3.5 text-green-500" />
                                                )}
                                                <span className="text-xs font-mono text-gray-700">{s.name}</span>
                                                {diffInfo && (
                                                    <span className={cn(
                                                        "ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded",
                                                        diffInfo.status === 'new' ? "text-green-600 bg-green-50" :
                                                        diffInfo.status === 'changed' ? "text-amber-600 bg-amber-50" :
                                                        "text-gray-400 bg-gray-50"
                                                    )}>
                                                        {diffInfo.status}
                                                    </span>
                                                )}
                                            </button>
                                            {isExpanded && (
                                                <div className="px-4 pb-3 max-h-64 overflow-y-auto">
                                                    {diffInfo?.changes ? (
                                                        <DiffView changes={diffInfo.changes} />
                                                    ) : (
                                                        <pre className="text-xs font-mono leading-relaxed text-gray-600 whitespace-pre-wrap">{s.content}</pre>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Duplicate warning */}
            {saveState === 'idle' && hasDuplicate && (
                <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 flex items-start gap-2 shrink-0">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                    <span className="text-xs text-amber-800">
                        A {existingSkill!.scope} skill named <strong>"{skill.name}"</strong> already exists.
                    </span>
                </div>
            )}

            {/* Review status guidance banner */}
            {saveState === 'saved' && reviewStatus === 'draft' && (
                <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 flex items-start gap-2 shrink-0">
                    <Info className="w-3.5 h-3.5 text-gray-400 shrink-0 mt-0.5" />
                    <span className="text-xs text-gray-600">
                        Saved as draft. Available in test workspaces. Request publish to use in production.
                    </span>
                </div>
            )}
            {saveState === 'saved' && (reviewStatus === 'pending' || reviewStatus === 'staged') && (
                <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 flex items-start gap-2 shrink-0">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                    <span className="text-xs text-amber-800">
                        Awaiting admin approval. You can switch to a test workspace to debug this skill immediately.
                    </span>
                </div>
            )}

            {/* Footer */}
            <div className="px-4 py-3 border-t border-gray-200 bg-gray-50/80 flex items-center justify-between shrink-0">
                <button
                    onClick={handleDismiss}
                    disabled={saveState === 'saving'}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-200 transition-colors"
                >
                    Dismiss
                </button>

                <div className="flex items-center gap-2">
                    {saveState === 'idle' && !isAlreadyUpToDate && (() => {
                        if (isFork && forkSourceSkill) {
                            const alreadyHasPersonal = skills.some(s => s.name === skill.name && s.scope === 'personal');
                            return (
                                <button
                                    onClick={() => handleSave(alreadyHasPersonal ? 'create-new-name' : 'create')}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-600 text-white hover:bg-purple-700 transition-colors shadow-sm"
                                >
                                    <GitFork className="w-3.5 h-3.5" />
                                    Fork to Personal
                                </button>
                            );
                        }
                        if (isUpdate && updateTargetId) {
                            const isNonPersonal = matchedSkill && matchedSkill.scope !== 'personal';
                            return (
                                <button
                                    onClick={() => handleSave('update')}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors shadow-sm"
                                >
                                    {isNonPersonal ? (
                                        <><Copy className="w-3.5 h-3.5" /> Save to Personal</>
                                    ) : (
                                        <><Save className="w-3.5 h-3.5" /> Update Skill</>
                                    )}
                                </button>
                            );
                        }
                        if (hasDuplicate) {
                            return (
                                <>
                                    <button
                                        onClick={() => handleSave('update-existing')}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors shadow-sm"
                                    >
                                        {existingSkill!.scope === 'personal' ? (
                                            <><Save className="w-3.5 h-3.5" /> Update Existing</>
                                        ) : (
                                            <><Copy className="w-3.5 h-3.5" /> Save to Personal</>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => handleSave('create-new-name')}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-100 border border-gray-300 transition-colors"
                                    >
                                        Save as New
                                    </button>
                                </>
                            );
                        }
                        return (
                            <button
                                onClick={() => handleSave('create')}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors shadow-sm"
                            >
                                <Save className="w-3.5 h-3.5" />
                                Save Skill
                            </button>
                        );
                    })()}
                    {saveState === 'idle' && isAlreadyUpToDate && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-600">
                            <Check className="w-3.5 h-3.5" />
                            Up to date
                        </span>
                    )}
                    {saveState === 'saving' && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Saving...
                        </span>
                    )}
                    {saveState === 'saved' && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-green-600">
                            <Check className="w-3.5 h-3.5" />
                            {savedName || 'Saved'}
                        </span>
                    )}
                    {saveState === 'error' && (
                        <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-xs text-red-600">
                                <AlertCircle className="w-3.5 h-3.5" />
                                {errorMsg}
                            </span>
                            <button
                                onClick={() => { setSaveState('idle'); setErrorMsg(''); }}
                                className="px-2.5 py-1 rounded-lg text-xs font-medium text-red-600 hover:bg-red-50 border border-red-200 transition-colors"
                            >
                                Retry
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Inline diff view with green/red highlighting */
function DiffView({ changes }: { changes: Change[] }) {
    return (
        <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap">
            {changes.map((part, i) => (
                <span
                    key={i}
                    className={cn(
                        part.added && "bg-green-100 text-green-800",
                        part.removed && "bg-red-100 text-red-800 line-through",
                        !part.added && !part.removed && "text-gray-500"
                    )}
                >
                    {part.value}
                </span>
            ))}
        </pre>
    );
}
