import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Check, Search, AlertTriangle, Layers3, ChevronDown, ChevronRight } from 'lucide-react';
import type { Workspace } from '@/contexts/WorkspaceContext';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface Credential {
    id: string;
    name: string;
    type: string;
}

interface ClusterOption {
    id: string;
    name: string;
    isTest: boolean;
    apiServer: string;
}

type Tab = 'general' | 'skills' | 'tools' | 'access';

type SkillComposerSkillOption = {
    id: string;
    ref: string;
    name: string;
    dirName: string;
    description?: string | null;
    labels?: string[];
    scope: 'builtin' | 'team' | 'personal' | 'skillset';
    skillSpaceId?: string;
};

type SkillComposerSpaceOption = {
    id: string;
    name: string;
    description?: string | null;
    memberRole?: string;
    skills: SkillComposerSkillOption[];
};

type WorkspaceSkillComposer = {
    globalSkillRefs: string[];
    personalSkillIds: string[];
    skillSpaces: Array<{
        skillSpaceId: string;
        disabledSkillIds: string[];
    }>;
};

interface SkillComposerOptions {
    skillSpaceAvailable: boolean;
    globalSkills: SkillComposerSkillOption[];
    personalSkills: SkillComposerSkillOption[];
    skillSpaces: SkillComposerSpaceOption[];
}

const COLOR_OPTIONS = [
    { name: 'indigo', class: 'bg-indigo-500' },
    { name: 'blue', class: 'bg-blue-500' },
    { name: 'green', class: 'bg-green-500' },
    { name: 'amber', class: 'bg-amber-500' },
    { name: 'rose', class: 'bg-rose-500' },
    { name: 'purple', class: 'bg-purple-500' },
    { name: 'teal', class: 'bg-teal-500' },
    { name: 'gray', class: 'bg-gray-400' },
];

interface Props {
    workspace: Workspace | null;
    onClose: () => void;
    onSaved: () => void;
    sendRpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

function normalizeComposer(raw?: Partial<WorkspaceSkillComposer> | null): WorkspaceSkillComposer {
    return {
        globalSkillRefs: [...new Set((raw?.globalSkillRefs ?? []).filter(Boolean))],
        personalSkillIds: [...new Set((raw?.personalSkillIds ?? []).filter(Boolean))],
        skillSpaces: (raw?.skillSpaces ?? [])
            .filter(entry => !!entry?.skillSpaceId)
            .map(entry => ({
                skillSpaceId: entry.skillSpaceId,
                disabledSkillIds: [...new Set((entry.disabledSkillIds ?? []).filter(Boolean))],
            })),
    };
}

function SelectAllBar({ total, selected, onSelectAll, onDeselectAll, disableSelectAll = false, disableDeselectAll = false }: {
    total: number;
    selected: number;
    onSelectAll: () => void;
    onDeselectAll: () => void;
    disableSelectAll?: boolean;
    disableDeselectAll?: boolean;
}) {
    if (total === 0) return null;
    return (
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-100">
            <span className="text-xs text-gray-400">{selected} / {total} selected</span>
            <div className="flex gap-2">
                <button
                    onClick={onSelectAll}
                    disabled={selected === total || disableSelectAll}
                    className="text-xs text-indigo-600 hover:text-indigo-800 disabled:text-gray-300"
                >
                    Select All
                </button>
                <button
                    onClick={onDeselectAll}
                    disabled={selected === 0 || disableDeselectAll}
                    className="text-xs text-gray-500 hover:text-gray-700 disabled:text-gray-300"
                >
                    Deselect All
                </button>
            </div>
        </div>
    );
}

function sourceLabel(scope: SkillComposerSkillOption['scope']): string {
    switch (scope) {
        case 'team':
            return 'team';
        case 'builtin':
            return 'builtin';
        case 'personal':
            return 'personal';
        default:
            return 'space';
    }
}

export function WorkspaceDialog({ workspace, onClose, onSaved, sendRpc }: Props) {
    const isNew = !workspace;
    const isDefault = workspace?.isDefault ?? false;

    const [tab, setTab] = useState<Tab>('general');
    const [name, setName] = useState(workspace?.name ?? '');
    const [color, setColor] = useState(workspace?.configJson?.color ?? 'indigo');
    const [systemPrompt, setSystemPrompt] = useState(workspace?.configJson?.systemPrompt ?? '');
    const [saving, setSaving] = useState(false);
    const [envType, setEnvType] = useState<string>(workspace?.envType ?? 'prod');
    const [selectedClusters, setSelectedClusters] = useState<Set<string>>(new Set());
    const [allClusters, setAllClusters] = useState<ClusterOption[]>([]);
    const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
    const [selectedCreds, setSelectedCreds] = useState<Set<string>>(new Set());
    const [allTools, setAllTools] = useState<string[]>([]);
    const [allCreds, setAllCreds] = useState<Credential[]>([]);
    const [composerOptions, setComposerOptions] = useState<SkillComposerOptions>({
        skillSpaceAvailable: false,
        globalSkills: [],
        personalSkills: [],
        skillSpaces: [],
    });
    const [composer, setComposer] = useState<WorkspaceSkillComposer>(normalizeComposer());
    const [globalSearch, setGlobalSearch] = useState('');
    const [personalSearch, setPersonalSearch] = useState('');
    const [skillSpaceSearch, setSkillSpaceSearch] = useState('');
    const [globalLabelFilter, setGlobalLabelFilter] = useState<string | null>(null);
    const [personalLabelFilter, setPersonalLabelFilter] = useState<string | null>(null);
    const [expandedSpaceIds, setExpandedSpaceIds] = useState<Set<string>>(new Set());
    const [saveError, setSaveError] = useState<string | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{
        isOpen: boolean;
        title: string;
        description: string;
        confirmText: string;
        variant: 'primary' | 'warning' | 'danger';
        onConfirm: () => void;
    }>({
        isOpen: false,
        title: '',
        description: '',
        confirmText: 'Confirm',
        variant: 'primary',
        onConfirm: () => {},
    });

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const [options, toolsResult, credsResult, clustersResult, configResult] = await Promise.all([
                    sendRpc<SkillComposerOptions>('workspace.skillComposerOptions'),
                    sendRpc<{ tools: string[] }>('workspace.availableTools'),
                    sendRpc<{ credentials: Credential[] }>('credential.list'),
                    sendRpc<{ clusters: ClusterOption[] }>('cluster.list'),
                    workspace && !workspace.isDefault
                        ? sendRpc<{
                            skillComposer?: WorkspaceSkillComposer;
                            tools: string[];
                            credentials: string[];
                            clusters: string[];
                        }>('workspace.getConfig', { id: workspace.id })
                        : Promise.resolve(null),
                ]);

                if (cancelled) return;
                setComposerOptions(options);
                setAllTools(toolsResult.tools ?? []);
                setAllCreds(credsResult.credentials ?? []);
                setAllClusters(clustersResult.clusters ?? []);
                if (configResult) {
                    setComposer(normalizeComposer(configResult.skillComposer));
                    setSelectedTools(new Set(configResult.tools ?? []));
                    setSelectedCreds(new Set(configResult.credentials ?? []));
                    setSelectedClusters(new Set(configResult.clusters ?? []));
                    setExpandedSpaceIds(new Set((configResult.skillComposer?.skillSpaces ?? []).map(entry => entry.skillSpaceId)));
                } else {
                    setComposer(normalizeComposer());
                    setSelectedTools(new Set());
                    setSelectedCreds(new Set());
                    setSelectedClusters(new Set());
                }
            } catch (err) {
                console.error('Failed to load workspace dialog data:', err);
                if (!cancelled) {
                    setSaveError('Failed to load workspace configuration.');
                }
            }
        }

        load();
        return () => { cancelled = true; };
    }, [sendRpc, workspace]);

    const filteredClusters = useMemo(() => (
        envType === 'test' ? allClusters.filter(cluster => cluster.isTest) : allClusters
    ), [allClusters, envType]);

    const globalLabels = useMemo(() => {
        const set = new Set<string>();
        composerOptions.globalSkills.forEach(skill => skill.labels?.forEach(label => set.add(label)));
        return [...set].sort();
    }, [composerOptions.globalSkills]);

    const personalLabels = useMemo(() => {
        const set = new Set<string>();
        composerOptions.personalSkills.forEach(skill => skill.labels?.forEach(label => set.add(label)));
        return [...set].sort();
    }, [composerOptions.personalSkills]);

    const filteredGlobalSkills = useMemo(() => {
        const query = globalSearch.trim().toLowerCase();
        return composerOptions.globalSkills.filter(skill => {
            const matchesLabel = !globalLabelFilter || skill.labels?.includes(globalLabelFilter);
            const matchesSearch = !query
                || skill.name.toLowerCase().includes(query)
                || skill.description?.toLowerCase().includes(query)
                || skill.dirName.toLowerCase().includes(query);
            return matchesLabel && matchesSearch;
        });
    }, [composerOptions.globalSkills, globalLabelFilter, globalSearch]);

    const filteredPersonalSkills = useMemo(() => {
        const query = personalSearch.trim().toLowerCase();
        return composerOptions.personalSkills.filter(skill => {
            const matchesLabel = !personalLabelFilter || skill.labels?.includes(personalLabelFilter);
            const matchesSearch = !query
                || skill.name.toLowerCase().includes(query)
                || skill.description?.toLowerCase().includes(query)
                || skill.dirName.toLowerCase().includes(query);
            return matchesLabel && matchesSearch;
        });
    }, [composerOptions.personalSkills, personalLabelFilter, personalSearch]);

    const filteredSkillSpaces = useMemo(() => {
        const query = skillSpaceSearch.trim().toLowerCase();
        return composerOptions.skillSpaces.filter(space => {
            if (!query) return true;
            if (space.name.toLowerCase().includes(query)) return true;
            if (space.description?.toLowerCase().includes(query)) return true;
            return space.skills.some(skill =>
                skill.name.toLowerCase().includes(query)
                || skill.dirName.toLowerCase().includes(query)
                || skill.description?.toLowerCase().includes(query),
            );
        });
    }, [composerOptions.skillSpaces, skillSpaceSearch]);

    const selectedGlobalRefSet = useMemo(() => new Set(composer.globalSkillRefs), [composer.globalSkillRefs]);
    const selectedPersonalIdSet = useMemo(() => new Set(composer.personalSkillIds), [composer.personalSkillIds]);

    const prodHasInvalidSelections = envType === 'prod' && (
        composer.personalSkillIds.length > 0 || composer.skillSpaces.length > 0
    );

    const skillSpaceConflictDetails = useMemo(() => {
        const dirNameMap = new Map<string, Array<{ spaceName: string; skillName: string }>>();
        for (const selection of composer.skillSpaces) {
            const space = composerOptions.skillSpaces.find(item => item.id === selection.skillSpaceId);
            if (!space) continue;
            const disabledIds = new Set(selection.disabledSkillIds);
            for (const skill of space.skills) {
                if (disabledIds.has(skill.id)) continue;
                const list = dirNameMap.get(skill.dirName) ?? [];
                list.push({ spaceName: space.name, skillName: skill.name });
                dirNameMap.set(skill.dirName, list);
            }
        }
        return [...dirNameMap.entries()]
            .filter(([, entries]) => new Set(entries.map(entry => entry.spaceName)).size > 1)
            .map(([dirName, entries]) => ({ dirName, entries }));
    }, [composer.skillSpaces, composerOptions.skillSpaces]);
    const blockingSkillSpaceConflicts = envType === 'test' ? skillSpaceConflictDetails : [];

    const shadowWarnings = useMemo(() => {
        const sourceEntries = new Map<string, Array<{ source: string; priority: number }>>();
        for (const skill of composerOptions.globalSkills) {
            if (!selectedGlobalRefSet.has(skill.ref)) continue;
            const current = sourceEntries.get(skill.dirName) ?? [];
            current.push({ source: skill.scope === 'team' ? `Global (${skill.name}, team)` : `Global (${skill.name})`, priority: skill.scope === 'team' ? 1 : 0 });
            sourceEntries.set(skill.dirName, current);
        }
        for (const selection of composer.skillSpaces) {
            const space = composerOptions.skillSpaces.find(item => item.id === selection.skillSpaceId);
            if (!space) continue;
            const disabledIds = new Set(selection.disabledSkillIds);
            for (const skill of space.skills) {
                if (disabledIds.has(skill.id)) continue;
                const current = sourceEntries.get(skill.dirName) ?? [];
                current.push({ source: `Skill Space (${space.name})`, priority: 2 });
                sourceEntries.set(skill.dirName, current);
            }
        }
        for (const skill of composerOptions.personalSkills) {
            if (!selectedPersonalIdSet.has(skill.id)) continue;
            const current = sourceEntries.get(skill.dirName) ?? [];
            current.push({ source: `Personal (${skill.name})`, priority: 3 });
            sourceEntries.set(skill.dirName, current);
        }
        return [...sourceEntries.entries()]
            .filter(([, entries]) => entries.length > 1)
            .filter(([, entries]) => {
                const priorities = new Set(entries.map(entry => entry.priority));
                return !(priorities.size === 1 && priorities.has(2));
            })
            .map(([dirName, entries]) => {
                const winner = [...entries].sort((a, b) => b.priority - a.priority)[0];
                return `${dirName} resolves to ${winner.source}`;
            });
    }, [composer.skillSpaces, composerOptions.globalSkills, composerOptions.personalSkills, composerOptions.skillSpaces, selectedGlobalRefSet, selectedPersonalIdSet]);

    const effectiveSkillCount = useMemo(() => {
        const winners = new Map<string, number>();
        for (const skill of composerOptions.globalSkills) {
            if (!selectedGlobalRefSet.has(skill.ref)) continue;
            winners.set(skill.dirName, Math.max(winners.get(skill.dirName) ?? -1, skill.scope === 'team' ? 1 : 0));
        }
        for (const selection of composer.skillSpaces) {
            const space = composerOptions.skillSpaces.find(item => item.id === selection.skillSpaceId);
            if (!space) continue;
            const disabledIds = new Set(selection.disabledSkillIds);
            for (const skill of space.skills) {
                if (disabledIds.has(skill.id)) continue;
                winners.set(skill.dirName, Math.max(winners.get(skill.dirName) ?? -1, 2));
            }
        }
        for (const skill of composerOptions.personalSkills) {
            if (!selectedPersonalIdSet.has(skill.id)) continue;
            winners.set(skill.dirName, 3);
        }
        return winners.size;
    }, [composer.skillSpaces, composerOptions.globalSkills, composerOptions.personalSkills, composerOptions.skillSpaces, selectedGlobalRefSet, selectedPersonalIdSet]);

    const accessCount = selectedCreds.size + selectedClusters.size;

    const tabs: { key: Tab; label: string }[] = [
        { key: 'general', label: 'General' },
        ...(!isDefault ? [
            { key: 'skills' as Tab, label: `Skills (${effectiveSkillCount})` },
            { key: 'tools' as Tab, label: `Tools (${selectedTools.size})` },
            { key: 'access' as Tab, label: `Access (${accessCount})` },
        ] : []),
    ];

    const toggleGlobalSkill = useCallback((ref: string) => {
        setComposer(prev => {
            const next = new Set(prev.globalSkillRefs);
            if (next.has(ref)) next.delete(ref);
            else next.add(ref);
            return { ...prev, globalSkillRefs: [...next] };
        });
    }, []);

    const togglePersonalSkill = useCallback((skillId: string) => {
        setComposer(prev => {
            const next = new Set(prev.personalSkillIds);
            if (next.has(skillId)) next.delete(skillId);
            else next.add(skillId);
            return { ...prev, personalSkillIds: [...next] };
        });
    }, []);

    const toggleSkillSpace = useCallback((skillSpaceId: string) => {
        setComposer(prev => {
            const exists = prev.skillSpaces.find(entry => entry.skillSpaceId === skillSpaceId);
            if (exists) {
                return {
                    ...prev,
                    skillSpaces: prev.skillSpaces.filter(entry => entry.skillSpaceId !== skillSpaceId),
                };
            }
            return {
                ...prev,
                skillSpaces: [...prev.skillSpaces, { skillSpaceId, disabledSkillIds: [] }],
            };
        });
        setExpandedSpaceIds(prev => {
            const next = new Set(prev);
            next.add(skillSpaceId);
            return next;
        });
    }, []);

    const toggleDisabledSkillInSpace = useCallback((skillSpaceId: string, skillId: string) => {
        setComposer(prev => ({
            ...prev,
            skillSpaces: prev.skillSpaces.map(entry => {
                if (entry.skillSpaceId !== skillSpaceId) return entry;
                const disabled = new Set(entry.disabledSkillIds);
                if (disabled.has(skillId)) disabled.delete(skillId);
                else disabled.add(skillId);
                return { ...entry, disabledSkillIds: [...disabled] };
            }),
        }));
    }, []);

    const toggleTool = useCallback((toolName: string) => {
        setSelectedTools(prev => {
            const next = new Set(prev);
            next.has(toolName) ? next.delete(toolName) : next.add(toolName);
            return next;
        });
    }, []);

    const toggleCred = useCallback((credId: string) => {
        setSelectedCreds(prev => {
            const next = new Set(prev);
            next.has(credId) ? next.delete(credId) : next.add(credId);
            return next;
        });
    }, []);

    const toggleCluster = useCallback((clusterId: string) => {
        setSelectedClusters(prev => {
            const next = new Set(prev);
            next.has(clusterId) ? next.delete(clusterId) : next.add(clusterId);
            return next;
        });
    }, []);

    const toggleExpandedSpace = useCallback((spaceId: string) => {
        setExpandedSpaceIds(prev => {
            const next = new Set(prev);
            if (next.has(spaceId)) next.delete(spaceId);
            else next.add(spaceId);
            return next;
        });
    }, []);

    const buildProdCleanComposer = useCallback((): WorkspaceSkillComposer => ({
        globalSkillRefs: [...composer.globalSkillRefs],
        personalSkillIds: [],
        skillSpaces: [],
    }), [composer.globalSkillRefs]);

    const persistWorkspace = useCallback(async (skillComposerToSave: WorkspaceSkillComposer) => {
        if (!name.trim()) return;
        if (blockingSkillSpaceConflicts.length > 0) {
            setSaveError('Resolve conflicting Skill Space skills before saving this workspace.');
            return;
        }

        setSaving(true);
        setSaveError(null);
        try {
            if (isNew) {
                const result = await sendRpc<{ workspace: Workspace }>('workspace.create', {
                    name: name.trim(),
                    envType,
                    config: { color, systemPrompt: systemPrompt || undefined },
                });
                const wsId = result.workspace.id;
                await Promise.all([
                    sendRpc('workspace.setSkillComposer', { workspaceId: wsId, envType, skillComposer: skillComposerToSave }),
                    sendRpc('workspace.setTools', { workspaceId: wsId, tools: [...selectedTools] }),
                    sendRpc('workspace.setCredentials', { workspaceId: wsId, credentialIds: [...selectedCreds] }),
                    sendRpc('workspace.setClusters', { workspaceId: wsId, clusterIds: [...selectedClusters] }),
                ]);
            } else if (!isDefault) {
                await sendRpc('workspace.update', {
                    id: workspace!.id,
                    name: name.trim(),
                    envType,
                    config: { ...workspace!.configJson, color, systemPrompt: systemPrompt || undefined },
                });
                await Promise.all([
                    sendRpc('workspace.setSkillComposer', { workspaceId: workspace!.id, envType, skillComposer: skillComposerToSave }),
                    sendRpc('workspace.setTools', { workspaceId: workspace!.id, tools: [...selectedTools] }),
                    sendRpc('workspace.setCredentials', { workspaceId: workspace!.id, credentialIds: [...selectedCreds] }),
                    sendRpc('workspace.setClusters', { workspaceId: workspace!.id, clusterIds: [...selectedClusters] }),
                ]);
            }
            onSaved();
        } catch (err: any) {
            console.error('Failed to save workspace:', err);
            setSaveError(err.message || 'Failed to save workspace.');
        } finally {
            setSaving(false);
        }
    }, [blockingSkillSpaceConflicts.length, color, envType, isDefault, isNew, name, onSaved, selectedClusters, selectedCreds, selectedTools, sendRpc, systemPrompt, workspace]);

    const handleSave = async () => {
        if (!name.trim()) return;
        if (prodHasInvalidSelections) {
            const cleanedComposer = buildProdCleanComposer();
            setConfirmDialog({
                isOpen: true,
                title: 'Review Production Cleanup',
                description: `Production workspaces cannot include Personal skills or Skill Spaces. This save will remove ${composer.personalSkillIds.length} personal skill${composer.personalSkillIds.length === 1 ? '' : 's'} and ${composer.skillSpaces.length} skill space selection${composer.skillSpaces.length === 1 ? '' : 's'} before saving.`,
                confirmText: 'Remove and Save',
                variant: 'warning',
                onConfirm: () => {
                    setComposer(cleanedComposer);
                    void persistWorkspace(cleanedComposer);
                },
            });
            return;
        }
        await persistWorkspace(composer);
    };

    return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
            <ConfirmDialog
                isOpen={confirmDialog.isOpen}
                onClose={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
                onConfirm={confirmDialog.onConfirm}
                title={confirmDialog.title}
                description={confirmDialog.description}
                confirmText={confirmDialog.confirmText}
                variant={confirmDialog.variant}
            />
            <div
                className="bg-white rounded-2xl shadow-xl w-full max-w-6xl max-h-[88vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                    <h2 className="text-lg font-semibold text-gray-900">
                        {isNew ? 'Create Workspace' : isDefault ? 'Default Workspace' : `Edit: ${workspace!.name}`}
                    </h2>
                    <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {!isDefault && (
                    <div className="px-6 pt-3">
                        <input
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="Workspace name"
                            className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 ${
                                !name.trim() ? 'border-red-300 bg-red-50/30' : 'border-gray-200'
                            }`}
                        />
                    </div>
                )}

                <div className="flex gap-1 px-6 pt-3 border-b border-gray-100">
                    {tabs.map(item => (
                        <button
                            key={item.key}
                            onClick={() => setTab(item.key)}
                            className={`px-3 py-2 text-sm font-medium rounded-t-md transition-colors ${
                                tab === item.key
                                    ? 'text-indigo-600 border-b-2 border-indigo-600'
                                    : 'text-gray-500 hover:text-gray-700'
                            }`}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
                    {saveError && (
                        <div className="mb-4 px-4 py-3 rounded-xl border border-red-200 bg-red-50 text-sm text-red-700">
                            {saveError}
                        </div>
                    )}

                    {tab === 'general' && (
                        <div className="space-y-4">
                            {!isDefault && (
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">Environment Type</label>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setEnvType('prod')}
                                            className={`px-4 py-2 rounded-lg text-sm font-medium border ${
                                                envType === 'prod'
                                                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                                                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                                            }`}
                                        >
                                            Production
                                        </button>
                                        <button
                                            onClick={() => { setEnvType('test'); setSelectedClusters(new Set()); }}
                                            className={`px-4 py-2 rounded-lg text-sm font-medium border ${
                                                envType === 'test'
                                                    ? 'border-amber-500 bg-amber-50 text-amber-700'
                                                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                                            }`}
                                        >
                                            Testing
                                        </button>
                                    </div>
                                </div>
                            )}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Color</label>
                                <div className="flex gap-2">
                                    {COLOR_OPTIONS.map(option => (
                                        <button
                                            key={option.name}
                                            onClick={() => !isDefault && setColor(option.name)}
                                            disabled={isDefault}
                                            className={`w-7 h-7 rounded-full ${option.class} flex items-center justify-center transition-transform ${
                                                color === option.name ? 'ring-2 ring-offset-2 ring-indigo-400 scale-110' : 'hover:scale-105'
                                            } disabled:opacity-50`}
                                        >
                                            {color === option.name && <Check className="w-3.5 h-3.5 text-white" />}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {!isDefault && (
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">System Prompt</label>
                                    <textarea
                                        value={systemPrompt}
                                        onChange={e => setSystemPrompt(e.target.value)}
                                        placeholder="Optional: custom instructions for this workspace..."
                                        rows={4}
                                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
                                    />
                                </div>
                            )}
                            {isDefault && (
                                <p className="text-sm text-gray-400 italic">
                                    The default workspace includes all skills, tools, and credentials. It cannot be modified.
                                </p>
                            )}
                        </div>
                    )}

                    {tab === 'skills' && (
                        <div className="space-y-5">
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                                            <Layers3 className="w-4 h-4 text-slate-500" />
                                            Skill Composer
                                        </div>
                                        <p className="text-sm text-slate-600 mt-1">
                                            Compose the exact skill set available in this workspace.
                                        </p>
                                    </div>
                                    <div className="text-right text-xs text-slate-500">
                                        <div>{composer.globalSkillRefs.length} Global</div>
                                        <div>{composer.skillSpaces.length} Skill Spaces</div>
                                        <div>{composer.personalSkillIds.length} Personal</div>
                                        <div>{effectiveSkillCount} effective skills</div>
                                    </div>
                                </div>
                                <div className="mt-3 text-xs text-slate-500">
                                    Resolution order: Personal &gt; Skill Space &gt; Global
                                </div>
                                {prodHasInvalidSelections && (
                                    <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                                        <span>
                                            Production workspaces cannot keep Personal skills or Skill Spaces. You can remove them manually now, or let save review and remove them automatically.
                                        </span>
                                    </div>
                                )}
                                {blockingSkillSpaceConflicts.length > 0 && (
                                    <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                        <div className="font-medium mb-1">Resolve Skill Space conflicts before saving.</div>
                                        <div className="space-y-1">
                                            {blockingSkillSpaceConflicts.slice(0, 4).map(conflict => (
                                                <div key={conflict.dirName}>
                                                    {conflict.dirName}: {conflict.entries.map(entry => entry.spaceName).join(', ')}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {shadowWarnings.length > 0 && (
                                    <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-700">
                                        <div className="font-medium mb-1">Shadowing warnings</div>
                                        <div className="space-y-1">
                                            {shadowWarnings.slice(0, 4).map(warning => (
                                                <div key={warning}>{warning}</div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>

                            <section className="rounded-2xl border border-gray-200 bg-white p-4">
                                <div className="flex items-center justify-between gap-4 mb-3">
                                    <div>
                                        <h3 className="text-sm font-semibold text-gray-900">Global Skills</h3>
                                        <p className="text-xs text-gray-500 mt-1">Pick the builtin and team skills this workspace should load.</p>
                                    </div>
                                </div>
                                <div className="relative mb-2">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                    <input
                                        type="text"
                                        value={globalSearch}
                                        onChange={e => setGlobalSearch(e.target.value)}
                                        placeholder="Search global skills..."
                                        className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                    />
                                </div>
                                {globalLabels.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mb-2">
                                        <button
                                            onClick={() => setGlobalLabelFilter(null)}
                                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                                !globalLabelFilter ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                            }`}
                                        >
                                            All
                                        </button>
                                        {globalLabels.map(label => (
                                            <button
                                                key={label}
                                                onClick={() => setGlobalLabelFilter(globalLabelFilter === label ? null : label)}
                                                className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                                    globalLabelFilter === label ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                                }`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <SelectAllBar
                                    total={filteredGlobalSkills.length}
                                    selected={filteredGlobalSkills.filter(skill => selectedGlobalRefSet.has(skill.ref)).length}
                                    onSelectAll={() => setComposer(prev => ({
                                        ...prev,
                                        globalSkillRefs: [...new Set([...prev.globalSkillRefs, ...filteredGlobalSkills.map(skill => skill.ref)])],
                                    }))}
                                    onDeselectAll={() => setComposer(prev => ({
                                        ...prev,
                                        globalSkillRefs: prev.globalSkillRefs.filter(ref => !filteredGlobalSkills.some(skill => skill.ref === ref)),
                                    }))}
                                />
                                <div className="max-h-56 overflow-y-auto space-y-0.5">
                                    {filteredGlobalSkills.map(skill => (
                                        <label key={skill.ref} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={selectedGlobalRefSet.has(skill.ref)}
                                                onChange={() => toggleGlobalSkill(skill.ref)}
                                                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                            />
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm text-gray-900 truncate">{skill.name}</div>
                                                <div className="text-xs text-gray-400 truncate">{skill.description || skill.dirName}</div>
                                            </div>
                                            {skill.labels && skill.labels.length > 0 && (
                                                <span className="text-xs text-gray-400 truncate max-w-[180px]">{skill.labels.join(', ')}</span>
                                            )}
                                            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">{sourceLabel(skill.scope)}</span>
                                        </label>
                                    ))}
                                    {filteredGlobalSkills.length === 0 && (
                                        <p className="text-sm text-gray-400 py-4 text-center">No global skills match.</p>
                                    )}
                                </div>
                            </section>

                            <section className="rounded-2xl border border-gray-200 bg-white p-4">
                                <div className="flex items-center justify-between gap-4 mb-3">
                                    <div>
                                        <h3 className="text-sm font-semibold text-gray-900">Skill Spaces</h3>
                                        <p className="text-xs text-gray-500 mt-1">
                                            Select whole spaces, then expand them to disable specific skills inside each selected space.
                                        </p>
                                    </div>
                                    {!composerOptions.skillSpaceAvailable && (
                                        <span className="text-xs text-gray-400">Unavailable in this deployment</span>
                                    )}
                                </div>
                                <div className="relative mb-2">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                    <input
                                        type="text"
                                        value={skillSpaceSearch}
                                        onChange={e => setSkillSpaceSearch(e.target.value)}
                                        placeholder="Search skill spaces..."
                                        className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                    />
                                </div>
                                <div className="space-y-3 max-h-[26rem] overflow-y-auto">
                                    {filteredSkillSpaces.map(space => {
                                        const selection = composer.skillSpaces.find(entry => entry.skillSpaceId === space.id);
                                        const disabledIds = new Set(selection?.disabledSkillIds ?? []);
                                        const isSelected = !!selection;
                                        const canToggle = composerOptions.skillSpaceAvailable && (envType === 'test' || isSelected);
                                        return (
                                            <div key={space.id} className={`rounded-xl border ${isSelected ? 'border-indigo-200 bg-indigo-50/40' : 'border-gray-200 bg-white'}`}>
                                                <div className="flex items-start gap-3 px-4 py-3">
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        disabled={!canToggle}
                                                        onChange={() => toggleSkillSpace(space.id)}
                                                        className="mt-1 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40"
                                                    />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleExpandedSpace(space.id)}
                                                                className="text-gray-400 hover:text-gray-600"
                                                            >
                                                                {expandedSpaceIds.has(space.id) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                                            </button>
                                                            <div className="font-medium text-gray-900">{space.name}</div>
                                                            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{space.memberRole || 'maintainer'}</span>
                                                            <span className="text-xs text-gray-400">{space.skills.length} skills</span>
                                                        </div>
                                                        <p className="text-xs text-gray-500 mt-1">{space.description || 'No description'}</p>
                                                    </div>
                                                </div>
                                                {expandedSpaceIds.has(space.id) && (
                                                    <div className="border-t border-gray-100 px-4 py-3 space-y-1 bg-white/70">
                                                        {space.skills.map(skill => {
                                                            const included = !disabledIds.has(skill.id);
                                                            return (
                                                                <label key={skill.id} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-gray-50">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={included}
                                                                        disabled={!isSelected || envType === 'prod'}
                                                                        onChange={() => toggleDisabledSkillInSpace(space.id, skill.id)}
                                                                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40"
                                                                    />
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className="text-sm text-gray-900 truncate">{skill.name}</div>
                                                                        <div className="text-xs text-gray-400 truncate">{skill.description || skill.dirName}</div>
                                                                    </div>
                                                                    {skill.labels && skill.labels.length > 0 && (
                                                                        <span className="text-xs text-gray-400 truncate max-w-[180px]">{skill.labels.join(', ')}</span>
                                                                    )}
                                                                </label>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                    {filteredSkillSpaces.length === 0 && (
                                        <p className="text-sm text-gray-400 py-4 text-center">No Skill Spaces match.</p>
                                    )}
                                </div>
                            </section>

                            <section className="rounded-2xl border border-gray-200 bg-white p-4">
                                <div className="flex items-center justify-between gap-4 mb-3">
                                    <div>
                                        <h3 className="text-sm font-semibold text-gray-900">Personal Skills</h3>
                                        <p className="text-xs text-gray-500 mt-1">Select the exact personal overrides this workspace should use.</p>
                                    </div>
                                </div>
                                <div className="relative mb-2">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                    <input
                                        type="text"
                                        value={personalSearch}
                                        onChange={e => setPersonalSearch(e.target.value)}
                                        placeholder="Search personal skills..."
                                        className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                    />
                                </div>
                                {personalLabels.length > 0 && (
                                    <div className="flex flex-wrap gap-1 mb-2">
                                        <button
                                            onClick={() => setPersonalLabelFilter(null)}
                                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                                !personalLabelFilter ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                            }`}
                                        >
                                            All
                                        </button>
                                        {personalLabels.map(label => (
                                            <button
                                                key={label}
                                                onClick={() => setPersonalLabelFilter(personalLabelFilter === label ? null : label)}
                                                className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                                    personalLabelFilter === label ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                                }`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <SelectAllBar
                                    total={filteredPersonalSkills.length}
                                    selected={filteredPersonalSkills.filter(skill => selectedPersonalIdSet.has(skill.id)).length}
                                    disableSelectAll={envType !== 'test'}
                                    onSelectAll={() => setComposer(prev => ({
                                        ...prev,
                                        personalSkillIds: [...new Set([...prev.personalSkillIds, ...filteredPersonalSkills.map(skill => skill.id)])],
                                    }))}
                                    onDeselectAll={() => setComposer(prev => ({
                                        ...prev,
                                        personalSkillIds: prev.personalSkillIds.filter(id => !filteredPersonalSkills.some(skill => skill.id === id)),
                                    }))}
                                />
                                <div className="max-h-56 overflow-y-auto space-y-0.5">
                                    {filteredPersonalSkills.map(skill => {
                                        const isSelected = selectedPersonalIdSet.has(skill.id);
                                        const canToggle = envType === 'test' || isSelected;
                                        return (
                                            <label key={skill.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    disabled={!canToggle}
                                                    onChange={() => togglePersonalSkill(skill.id)}
                                                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40"
                                                />
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-sm text-gray-900 truncate">{skill.name}</div>
                                                    <div className="text-xs text-gray-400 truncate">{skill.description || skill.dirName}</div>
                                                </div>
                                                {skill.labels && skill.labels.length > 0 && (
                                                    <span className="text-xs text-gray-400 truncate max-w-[180px]">{skill.labels.join(', ')}</span>
                                                )}
                                                <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">personal</span>
                                            </label>
                                        );
                                    })}
                                    {filteredPersonalSkills.length === 0 && (
                                        <p className="text-sm text-gray-400 py-4 text-center">No personal skills match.</p>
                                    )}
                                </div>
                            </section>
                        </div>
                    )}

                    {tab === 'tools' && (
                        <div className="space-y-2">
                            <SelectAllBar
                                total={allTools.length}
                                selected={selectedTools.size}
                                onSelectAll={() => setSelectedTools(new Set(allTools))}
                                onDeselectAll={() => setSelectedTools(new Set())}
                            />
                            {allTools.length === 0 ? (
                                <p className="text-sm text-gray-400 py-4 text-center">No tools available</p>
                            ) : (
                                <div className="space-y-0.5">
                                    {allTools.map(tool => (
                                        <label key={tool} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={selectedTools.has(tool)}
                                                onChange={() => toggleTool(tool)}
                                                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                            />
                                            <span className="text-sm text-gray-900 font-mono">{tool}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {tab === 'access' && (
                        <div className="space-y-5">
                            <div>
                                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">K8s Clusters</h3>
                                {filteredClusters.length === 0 ? (
                                    <p className="text-sm text-gray-400 py-2 text-center">No clusters available</p>
                                ) : (
                                    <div className="space-y-0.5">
                                        {filteredClusters.map(cluster => (
                                            <label key={cluster.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedClusters.has(cluster.id)}
                                                    onChange={() => toggleCluster(cluster.id)}
                                                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                                />
                                                <span className="text-sm text-gray-900 flex-1">{cluster.name}</span>
                                                <span className={`text-xs px-1.5 py-0.5 rounded ${cluster.isTest ? 'bg-amber-50 text-amber-600' : 'bg-blue-50 text-blue-600'}`}>
                                                    {cluster.isTest ? 'test' : 'prod'}
                                                </span>
                                                <span className="text-xs text-gray-400 font-mono">{cluster.apiServer}</span>
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div>
                                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Credentials (SSH / API)</h3>
                                {allCreds.length === 0 ? (
                                    <p className="text-sm text-gray-400 py-2 text-center">No credentials available</p>
                                ) : (
                                    <div className="space-y-0.5">
                                        {allCreds.map(cred => (
                                            <label key={cred.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedCreds.has(cred.id)}
                                                    onChange={() => toggleCred(cred.id)}
                                                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                                />
                                                <span className="text-sm text-gray-900 flex-1">{cred.name}</span>
                                                <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{cred.type}</span>
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {!isDefault && (
                    <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={saving || !name.trim() || blockingSkillSpaceConflicts.length > 0}
                            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
                        >
                            {saving ? 'Saving...' : isNew ? 'Create' : 'Save'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
