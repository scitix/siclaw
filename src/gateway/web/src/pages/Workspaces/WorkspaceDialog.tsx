import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Check, Search } from 'lucide-react';
import type { Workspace } from '@/contexts/WorkspaceContext';

interface Skill {
    name: string;
    scope: string;
    dirName: string;
    labels?: string[];
}

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
    workspace: Workspace | null; // null = creating new
    onClose: () => void;
    onSaved: () => void;
    sendRpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/* ── Select All / Deselect All helper bar ─────────────────────── */
function SelectAllBar({ total, selected, onSelectAll, onDeselectAll }: {
    total: number;
    selected: number;
    onSelectAll: () => void;
    onDeselectAll: () => void;
}) {
    if (total === 0) return null;
    return (
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-gray-100">
            <span className="text-xs text-gray-400">{selected} / {total} selected</span>
            <div className="flex gap-2">
                <button
                    onClick={onSelectAll}
                    disabled={selected === total}
                    className="text-xs text-indigo-600 hover:text-indigo-800 disabled:text-gray-300"
                >
                    Select All
                </button>
                <button
                    onClick={onDeselectAll}
                    disabled={selected === 0}
                    className="text-xs text-gray-500 hover:text-gray-700 disabled:text-gray-300"
                >
                    Deselect All
                </button>
            </div>
        </div>
    );
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

    // Skills filter state
    const [skillSearch, setSkillSearch] = useState('');
    const [skillLabelFilter, setSkillLabelFilter] = useState<string | null>(null);

    // Allow-lists
    const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
    const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
    const [selectedCreds, setSelectedCreds] = useState<Set<string>>(new Set());

    // Available lists
    const [allSkills, setAllSkills] = useState<Skill[]>([]);
    const [allTools, setAllTools] = useState<string[]>([]);
    const [allCreds, setAllCreds] = useState<Credential[]>([]);

    // Load available options
    useEffect(() => {
        sendRpc<{ skills: Skill[] }>('skill.list', { limit: 500 })
            .then(r => setAllSkills(r.skills ?? []))
            .catch(() => {});

        sendRpc<{ tools: string[] }>('workspace.availableTools')
            .then(r => setAllTools(r.tools ?? []))
            .catch(() => {});

        sendRpc<{ credentials: Credential[] }>('credential.list')
            .then(r => setAllCreds(r.credentials ?? []))
            .catch(() => {});

        sendRpc<{ clusters: ClusterOption[] }>('cluster.list')
            .then(r => setAllClusters(r.clusters ?? []))
            .catch(() => {});

        // Load existing config if editing
        if (workspace && !workspace.isDefault) {
            sendRpc<{ skills: string[]; tools: string[]; credentials: string[]; clusters: string[] }>(
                'workspace.getConfig', { id: workspace.id }
            ).then(cfg => {
                setSelectedSkills(new Set(cfg.skills ?? []));
                setSelectedTools(new Set(cfg.tools ?? []));
                setSelectedCreds(new Set(cfg.credentials ?? []));
                setSelectedClusters(new Set(cfg.clusters ?? []));
            }).catch(() => {});
        }
    }, [sendRpc, workspace]);

    // ── Derived: unique labels from all skills ──
    const allLabels = useMemo(() => {
        const set = new Set<string>();
        for (const s of allSkills) {
            if (s.labels) s.labels.forEach(l => set.add(l));
        }
        return [...set].sort();
    }, [allSkills]);

    // ── Derived: filtered skills ──
    const filteredSkills = useMemo(() => {
        let list = allSkills;
        if (skillLabelFilter) {
            list = list.filter(s => s.labels?.includes(skillLabelFilter));
        }
        if (skillSearch.trim()) {
            const q = skillSearch.toLowerCase();
            list = list.filter(s => s.name.toLowerCase().includes(q));
        }
        return list;
    }, [allSkills, skillSearch, skillLabelFilter]);

    // ── Derived: filtered clusters by envType ──
    const filteredClusters = useMemo(() => {
        return envType === 'test' ? allClusters.filter(e => e.isTest) : allClusters;
    }, [allClusters, envType]);

    const toggleSkill = useCallback((skillName: string) => {
        setSelectedSkills(prev => {
            const next = new Set(prev);
            next.has(skillName) ? next.delete(skillName) : next.add(skillName);
            return next;
        });
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

    const toggleCluster = useCallback((envId: string) => {
        setSelectedClusters(prev => {
            const next = new Set(prev);
            next.has(envId) ? next.delete(envId) : next.add(envId);
            return next;
        });
    }, []);

    const handleSave = async () => {
        if (!name.trim()) return;
        setSaving(true);
        try {
            if (isNew) {
                const result = await sendRpc<{ workspace: Workspace }>('workspace.create', {
                    name: name.trim(),
                    envType,
                    config: { color, systemPrompt: systemPrompt || undefined },
                });
                const wsId = result.workspace.id;
                await Promise.all([
                    sendRpc('workspace.setSkills', { workspaceId: wsId, skills: [...selectedSkills] }),
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
                    sendRpc('workspace.setSkills', { workspaceId: workspace!.id, skills: [...selectedSkills] }),
                    sendRpc('workspace.setTools', { workspaceId: workspace!.id, tools: [...selectedTools] }),
                    sendRpc('workspace.setCredentials', { workspaceId: workspace!.id, credentialIds: [...selectedCreds] }),
                    sendRpc('workspace.setClusters', { workspaceId: workspace!.id, clusterIds: [...selectedClusters] }),
                ]);
            }
            onSaved();
        } catch (err) {
            console.error('Failed to save workspace:', err);
        } finally {
            setSaving(false);
        }
    };

    // ── Access tab counts ──
    const accessCount = selectedCreds.size + selectedClusters.size;

    const tabs: { key: Tab; label: string }[] = [
        { key: 'general', label: 'General' },
        ...(!isDefault ? [
            { key: 'skills' as Tab, label: `Skills (${selectedSkills.size})` },
            { key: 'tools' as Tab, label: `Tools (${selectedTools.size})` },
            { key: 'access' as Tab, label: `Access (${accessCount})` },
        ] : []),
    ];

    return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
            <div
                className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                    <h2 className="text-lg font-semibold text-gray-900">
                        {isNew ? 'Create Workspace' : isDefault ? 'Default Workspace' : `Edit: ${workspace!.name}`}
                    </h2>
                    <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Name — always visible above tabs */}
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

                {/* Tab bar */}
                <div className="flex gap-1 px-6 pt-3 border-b border-gray-100">
                    {tabs.map(t => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`px-3 py-2 text-sm font-medium rounded-t-md transition-colors ${
                                tab === t.key
                                    ? 'text-indigo-600 border-b-2 border-indigo-600'
                                    : 'text-gray-500 hover:text-gray-700'
                            }`}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
                    {/* ── General Tab ── */}
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
                                    {COLOR_OPTIONS.map(c => (
                                        <button
                                            key={c.name}
                                            onClick={() => !isDefault && setColor(c.name)}
                                            disabled={isDefault}
                                            className={`w-7 h-7 rounded-full ${c.class} flex items-center justify-center transition-transform ${
                                                color === c.name ? 'ring-2 ring-offset-2 ring-indigo-400 scale-110' : 'hover:scale-105'
                                            } disabled:opacity-50`}
                                        >
                                            {color === c.name && <Check className="w-3.5 h-3.5 text-white" />}
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

                    {/* ── Skills Tab ── */}
                    {tab === 'skills' && (
                        <div className="space-y-2">
                            {/* Search */}
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                <input
                                    type="text"
                                    value={skillSearch}
                                    onChange={e => setSkillSearch(e.target.value)}
                                    placeholder="Search skills..."
                                    className="w-full pl-9 pr-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                                />
                            </div>

                            {/* Label filter chips */}
                            {allLabels.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                    <button
                                        onClick={() => setSkillLabelFilter(null)}
                                        className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                                            !skillLabelFilter
                                                ? 'bg-indigo-100 text-indigo-700'
                                                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                        }`}
                                    >
                                        All
                                    </button>
                                    {allLabels.map(label => (
                                        <button
                                            key={label}
                                            onClick={() => setSkillLabelFilter(skillLabelFilter === label ? null : label)}
                                            className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                                                skillLabelFilter === label
                                                    ? 'bg-indigo-100 text-indigo-700'
                                                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                            }`}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            )}

                            {/* Select All bar */}
                            <SelectAllBar
                                total={filteredSkills.length}
                                selected={filteredSkills.filter(s => selectedSkills.has(s.name)).length}
                                onSelectAll={() => setSelectedSkills(prev => {
                                    const next = new Set(prev);
                                    filteredSkills.forEach(s => next.add(s.name));
                                    return next;
                                })}
                                onDeselectAll={() => setSelectedSkills(prev => {
                                    const next = new Set(prev);
                                    filteredSkills.forEach(s => next.delete(s.name));
                                    return next;
                                })}
                            />

                            {/* List */}
                            {filteredSkills.length === 0 ? (
                                <p className="text-sm text-gray-400 py-4 text-center">No skills match</p>
                            ) : (
                                <div className="space-y-0.5">
                                    {filteredSkills.map(skill => (
                                        <label
                                            key={skill.name}
                                            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selectedSkills.has(skill.name)}
                                                onChange={() => toggleSkill(skill.name)}
                                                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                            />
                                            <span className="text-sm text-gray-900 flex-1 truncate">{skill.name}</span>
                                            {skill.labels && skill.labels.length > 0 && (
                                                <span className="text-xs text-gray-400 truncate max-w-[120px]">
                                                    {skill.labels.join(', ')}
                                                </span>
                                            )}
                                            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 shrink-0">{skill.scope}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* ── Tools Tab ── */}
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
                                        <label
                                            key={tool}
                                            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                                        >
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

                    {/* ── Access Tab (Credentials + Environments combined) ── */}
                    {tab === 'access' && (
                        <div className="space-y-5">
                            {/* K8s Clusters section */}
                            <div>
                                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                                    K8s Clusters
                                </h3>
                                {filteredClusters.length === 0 ? (
                                    <p className="text-sm text-gray-400 py-2 text-center">No clusters available</p>
                                ) : (
                                    <div className="space-y-0.5">
                                        {filteredClusters.map(env => (
                                            <label
                                                key={env.id}
                                                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedClusters.has(env.id)}
                                                    onChange={() => toggleCluster(env.id)}
                                                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                                />
                                                <span className="text-sm text-gray-900 flex-1">{env.name}</span>
                                                <span className={`text-xs px-1.5 py-0.5 rounded ${
                                                    env.isTest
                                                        ? 'bg-amber-50 text-amber-600'
                                                        : 'bg-blue-50 text-blue-600'
                                                }`}>
                                                    {env.isTest ? 'test' : 'prod'}
                                                </span>
                                                <span className="text-xs text-gray-400 font-mono">{env.apiServer}</span>
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Credentials section */}
                            <div>
                                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                                    Credentials (SSH / API)
                                </h3>
                                {allCreds.length === 0 ? (
                                    <p className="text-sm text-gray-400 py-2 text-center">No credentials available</p>
                                ) : (
                                    <div className="space-y-0.5">
                                        {allCreds.map(cred => (
                                            <label
                                                key={cred.id}
                                                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 cursor-pointer"
                                            >
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

                {/* Footer */}
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
                            disabled={saving || !name.trim()}
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
