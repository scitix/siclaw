import { useState, useEffect, useCallback } from 'react';
import { X, Check } from 'lucide-react';
import type { Workspace } from '@/contexts/WorkspaceContext';

interface Skill {
    name: string;
    scope: string;
    dirName: string;
}

interface Credential {
    id: string;
    name: string;
    type: string;
}

type Tab = 'general' | 'skills' | 'tools' | 'credentials';

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

export function WorkspaceDialog({ workspace, onClose, onSaved, sendRpc }: Props) {
    const isNew = !workspace;
    const isDefault = workspace?.isDefault ?? false;

    const [tab, setTab] = useState<Tab>('general');
    const [name, setName] = useState(workspace?.name ?? '');
    const [color, setColor] = useState(workspace?.configJson?.color ?? 'indigo');
    const [systemPrompt, setSystemPrompt] = useState(workspace?.configJson?.systemPrompt ?? '');
    const [saving, setSaving] = useState(false);

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
        // Load skills
        sendRpc<{ skills: Skill[] }>('skill.list', { limit: 500 })
            .then(r => setAllSkills(r.skills ?? []))
            .catch(() => {});

        // Load available tools
        sendRpc<{ tools: string[] }>('workspace.availableTools')
            .then(r => setAllTools(r.tools ?? []))
            .catch(() => {});

        // Load credentials
        sendRpc<{ credentials: Credential[] }>('credential.list')
            .then(r => setAllCreds(r.credentials ?? []))
            .catch(() => {});

        // Load existing config if editing
        if (workspace && !workspace.isDefault) {
            sendRpc<{ skills: string[]; tools: string[]; credentials: string[] }>(
                'workspace.getConfig', { id: workspace.id }
            ).then(cfg => {
                setSelectedSkills(new Set(cfg.skills ?? []));
                setSelectedTools(new Set(cfg.tools ?? []));
                setSelectedCreds(new Set(cfg.credentials ?? []));
            }).catch(() => {});
        }
    }, [sendRpc, workspace]);

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

    const handleSave = async () => {
        if (!name.trim()) return;
        setSaving(true);
        try {
            if (isNew) {
                // Create
                const result = await sendRpc<{ workspace: Workspace }>('workspace.create', {
                    name: name.trim(),
                    config: {
                        color,
                        systemPrompt: systemPrompt || undefined,
                    },
                });
                const wsId = result.workspace.id;
                // Set allow-lists
                await Promise.all([
                    sendRpc('workspace.setSkills', { workspaceId: wsId, skills: [...selectedSkills] }),
                    sendRpc('workspace.setTools', { workspaceId: wsId, tools: [...selectedTools] }),
                    sendRpc('workspace.setCredentials', { workspaceId: wsId, credentialIds: [...selectedCreds] }),
                ]);
            } else if (!isDefault) {
                // Update
                await sendRpc('workspace.update', {
                    id: workspace!.id,
                    name: name.trim(),
                    config: {
                        ...workspace!.configJson,
                        color,
                        systemPrompt: systemPrompt || undefined,
                    },
                });
                // Update allow-lists
                await Promise.all([
                    sendRpc('workspace.setSkills', { workspaceId: workspace!.id, skills: [...selectedSkills] }),
                    sendRpc('workspace.setTools', { workspaceId: workspace!.id, tools: [...selectedTools] }),
                    sendRpc('workspace.setCredentials', { workspaceId: workspace!.id, credentialIds: [...selectedCreds] }),
                ]);
            }
            onSaved();
        } catch (err) {
            console.error('Failed to save workspace:', err);
        } finally {
            setSaving(false);
        }
    };

    const tabs: { key: Tab; label: string }[] = [
        { key: 'general', label: 'General' },
        ...(!isDefault ? [
            { key: 'skills' as Tab, label: `Skills (${selectedSkills.size})` },
            { key: 'tools' as Tab, label: `Tools (${selectedTools.size})` },
            { key: 'credentials' as Tab, label: `Credentials (${selectedCreds.size})` },
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
                <div className="flex-1 overflow-y-auto px-6 py-4">
                    {tab === 'general' && (
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={e => setName(e.target.value)}
                                    disabled={isDefault}
                                    placeholder="My Workspace"
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:opacity-50"
                                />
                            </div>
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

                    {tab === 'skills' && (
                        <div className="space-y-1">
                            {allSkills.length === 0 ? (
                                <p className="text-sm text-gray-400 py-4 text-center">No skills available</p>
                            ) : (
                                allSkills.map(skill => (
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
                                        <span className="text-sm text-gray-900 flex-1">{skill.name}</span>
                                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{skill.scope}</span>
                                    </label>
                                ))
                            )}
                        </div>
                    )}

                    {tab === 'tools' && (
                        <div className="space-y-1">
                            {allTools.length === 0 ? (
                                <p className="text-sm text-gray-400 py-4 text-center">No tools available</p>
                            ) : (
                                allTools.map(tool => (
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
                                ))
                            )}
                        </div>
                    )}

                    {tab === 'credentials' && (
                        <div className="space-y-1">
                            {allCreds.length === 0 ? (
                                <p className="text-sm text-gray-400 py-4 text-center">No credentials available</p>
                            ) : (
                                allCreds.map(cred => (
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
                                ))
                            )}
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
