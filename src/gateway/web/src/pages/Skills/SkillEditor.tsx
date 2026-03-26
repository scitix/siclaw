import { X, Terminal, Plus, Trash2, Code2, Loader2, FileUp, FileCode, ArrowLeft, Save, LayoutTemplate, ChevronDown, GitFork, Lock, Users, Eye, ShieldAlert, History, RotateCcw } from 'lucide-react';
import { Tooltip } from '../../components/Tooltip';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/themes/prism-dark.css';
import { useParams, useNavigate, useSearchParams, useBlocker, useLocation } from 'react-router-dom';
import type { Skill, Script } from './skillsData';
import { rpcGetSkillById, rpcSaveSkill, rpcDeleteSkill, rpcCopySkillToPersonal, rpcGetSkillHistory, rpcRollbackSkill, rpcUpdateSkillLabels } from './skillsData';
import { getCurrentUser } from '../../auth';
import { useWebSocket } from '../../hooks/useWebSocket';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const DEFAULT_SPEC_TEMPLATE = `---
name: new-skill
description: Describe what this skill does
---

# New Skill

inputs:
  - name: target
    description: The target resource to analyze
    required: true

outputs:
  - name: analysis_report
    description: Markdown formatted analysis result

troubleshooting:
  - "Ensure network connectivity to the target"

examples:
  - "run analysis --target=payment-service"`;

// Custom Prism styles
const style = document.createElement('style');
style.textContent = `
    code[class*="language-"], pre[class*="language-"] {
        text-shadow: none !important;
        font-family: "JetBrains Mono", "Fira Code", monospace !important;
    }
    .token.comment, .token.prolog, .token.doctype, .token.cdata { color: #6a9955; }
    .token.punctuation { color: #d4d4d4; }
    .token.namespace { opacity: .7; }
    .token.property, .token.tag, .token.boolean, .token.number, .token.constant, .token.symbol, .token.deleted { color: #b5cea8; }
    .token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: #ce9178; }
    .token.operator, .token.entity, .token.url, .language-css .token.string, .style .token.string { color: #d4d4d4; }
    .token.atrule, .token.attr-value, .token.keyword { color: #c586c0; }
    .token.function, .token.class-name { color: #dcdcaa; }
    .token.regex, .token.important, .token.variable { color: #d16969; }
`;
if (!document.head.querySelector('style[data-prism-custom]')) {
    style.setAttribute('data-prism-custom', 'true');
    document.head.appendChild(style);
}

const PRESET_CATEGORIES = ['Custom', 'Database', 'Security', 'Network', 'Core', 'Utility', 'Monitoring', 'Automation'];

// --- Draft auto-save helpers ---
const DRAFT_KEY_PREFIX = 'siclaw_skill_draft:';

interface SkillDraft {
    name: string;
    type: string;
    version: string;
    specs: string;
    scripts: Array<{ id: string; info: 'shell' | 'python'; name: string; content: string }>;
    savedAt: number;
}

function saveDraft(id: string, formData: Skill) {
    const draft: SkillDraft = {
        name: formData.name,
        type: formData.type,
        version: formData.version,
        specs: formData.specs || '',
        scripts: (formData.scripts || []).map(s => ({ id: s.id, info: s.info, name: s.name, content: s.content })),
        savedAt: Date.now(),
    };
    try { localStorage.setItem(DRAFT_KEY_PREFIX + id, JSON.stringify(draft)); } catch { /* quota */ }
}

function loadDraft(id: string): SkillDraft | null {
    try {
        const raw = localStorage.getItem(DRAFT_KEY_PREFIX + id);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function clearDraft(id: string) {
    localStorage.removeItem(DRAFT_KEY_PREFIX + id);
}

function hasUnsavedChanges(formData: Skill | null, serverData: Skill | null): boolean {
    if (!formData || !serverData) return false;
    return formData.name !== serverData.name
        || formData.specs !== serverData.specs
        || formData.type !== serverData.type
        || formData.version !== serverData.version
        || JSON.stringify((formData.scripts || []).map(s => ({ id: s.id, info: s.info, name: s.name, content: s.content })))
            !== JSON.stringify((serverData.scripts || []).map(s => ({ id: s.id, info: s.info, name: s.name, content: s.content })));
}

function formatTimeAgo(ts: number): string {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

export function SkillEditor() {
    const { id } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const { sendRpc, isConnected } = useWebSocket();
    const { currentWorkspace } = useWorkspace();
    const [isExpanded, setIsExpanded] = useState(false);
    const [formData, setFormData] = useState<Skill | null>(null);
    const [activeScriptId, setActiveScriptId] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [showAddMenu, setShowAddMenu] = useState(false);
    const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const loadedIdRef = useRef<string | null>(null);
    const [isCopying, setIsCopying] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [versions, setVersions] = useState<Array<{ hash: string; version: number; message: string; author: string; date: string }>>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [rollbackConfirm, setRollbackConfirm] = useState<number | null>(null);
    const [serverData, setServerData] = useState<Skill | null>(null);
    const [draftRestored, setDraftRestored] = useState<{ savedAt: number } | null>(null);
    const isNew = id === 'new';
    const isReadOnly = !!formData && formData.scope !== 'personal' && !(formData.scope === 'skillset' && formData.isSpaceMember);
    const currentUser = getCurrentUser();
    const isAdmin = currentUser?.username === 'admin';
    const isOwner = formData?.authorId === currentUser?.id;
    const fromSkillSpaceId = (location.state as { fromSkillSpaceId?: string } | null)?.fromSkillSpaceId;
    const backTarget = fromSkillSpaceId ? `/skills/spaces/${fromSkillSpaceId}` : '/skills';

    const handleFork = async () => {
        if (!formData || !id) return;
        try {
            setIsCopying(true);
            const result = await rpcCopySkillToPersonal(sendRpc, String(formData.id));
            navigate(`/skills/${result.id}`);
        } catch (err) {
            console.error('[SkillEditor] Fork failed:', err);
        } finally {
            setIsCopying(false);
        }
    };

    const handleLoadHistory = async () => {
        if (!id || isNew) return;
        if (showHistory) { setShowHistory(false); return; }
        setHistoryLoading(true);
        try {
            const result = await rpcGetSkillHistory(sendRpc, id);
            setVersions(result.versions);
            setShowHistory(true);
        } catch (err) {
            console.error('[SkillEditor] Failed to load history:', err);
        } finally {
            setHistoryLoading(false);
        }
    };

    const handleRollback = async (version: number) => {
        if (!id || isNew) return;
        try {
            await rpcRollbackSkill(sendRpc, id, version);
            const skill = await rpcGetSkillById(sendRpc, id, currentWorkspace?.id);
            if (skill) {
                const loaded = {
                    ...skill,
                    specs: skill.specs || DEFAULT_SPEC_TEMPLATE,
                    scripts: skill.scripts || [],
                };
                setFormData(loaded);
                setServerData(loaded);
                clearDraft(id);
            }
            setShowHistory(false);
            setRollbackConfirm(null);
        } catch (err) {
            console.error('[SkillEditor] Rollback failed:', err);
        }
    };

    const canRollback = (formData?.scope === 'personal' && isOwner) || (formData?.scope === 'team' && isAdmin);

    useEffect(() => {
        // Reset transient UI states when ID changes
        setShowAddMenu(false);
        setShowCategoryDropdown(false);
        setDraftRestored(null);

        if (!id) return;

        const applyWithDraftCheck = (skill: Skill) => {
            setServerData(skill);
            const draft = loadDraft(id);
            if (draft && draft.savedAt > 0) {
                // Apply draft data to formData and show restore banner
                setFormData({ ...skill, name: draft.name, type: draft.type, version: draft.version, specs: draft.specs, scripts: draft.scripts });
                setDraftRestored({ savedAt: draft.savedAt });
            } else {
                setFormData(skill);
            }
        };

        if (id === 'new') {
            loadedIdRef.current = null;
            const newSkill: Skill = {
                id: `new-${Date.now()}`,
                name: 'New Custom Skill',
                description: 'Describe what this skill does...',
                type: 'Custom',
                icon: Code2,
                status: 'not_installed',
                version: '0.0.1',
                specs: DEFAULT_SPEC_TEMPLATE.replace(/^name:\s*.+$/m, 'name: New Custom Skill'),
                scripts: [],
                scope: 'personal',
                author: 'Current User',
                contributionStatus: 'none',
                enabled: true,
            };
            applyWithDraftCheck(newSkill);
            setIsExpanded(false);
            setActiveScriptId(null);
            return;
        }

        if (!isConnected) return;
        if (loadedIdRef.current === id) return; // Skip reconnect reload
        loadedIdRef.current = id;

        let cancelled = false;
        rpcGetSkillById(sendRpc, id, currentWorkspace?.id).then(skill => {
            if (cancelled) return;
            if (skill) {
                const loaded = {
                    ...skill,
                    specs: skill.specs || DEFAULT_SPEC_TEMPLATE,
                    scripts: skill.scripts || [],
                };
                applyWithDraftCheck(loaded);
            } else {
                navigate(backTarget);
            }
        });
        return () => { cancelled = true; };
    }, [id, navigate, isConnected, sendRpc, currentWorkspace?.id]);

    // Auto-open history panel when navigated with ?history=true
    useEffect(() => {
        if (searchParams.get('history') === 'true' && !showHistory && !isNew) {
            handleLoadHistory();
        }
    }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

    // --- isDirty computation ---
    const isDirty = useMemo(() => hasUnsavedChanges(formData, serverData), [formData, serverData]);

    // --- Auto-save draft (debounced) ---
    useEffect(() => {
        if (!id || !formData || !serverData || isReadOnly) return;
        const timer = setTimeout(() => {
            if (hasUnsavedChanges(formData, serverData)) {
                saveDraft(id, formData);
            } else {
                clearDraft(id);
            }
        }, 1000);
        return () => clearTimeout(timer);
    }, [id, formData, serverData, isReadOnly]);

    // --- beforeunload protection ---
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (isDirty) { e.preventDefault(); }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [isDirty]);

    // --- React Router leave protection ---
    const isSaveNavigatingRef = useRef(false);
    const blocker = useBlocker(() => isDirty && !isSaveNavigatingRef.current);

    // --- Draft restore handlers ---
    const handleDiscardDraft = useCallback(() => {
        if (id && serverData) {
            clearDraft(id);
            setFormData(serverData);
            setDraftRestored(null);
        }
    }, [id, serverData]);

    const handleDismissDraftBanner = useCallback(() => {
        setDraftRestored(null);
    }, []);

    const handleSave = async () => {
        if (!formData) return;
        try {
            setIsSaving(true);
            setSaveError(null);
            await rpcSaveSkill(sendRpc, formData, isNew, currentWorkspace?.id);
            if (id) clearDraft(id);
            setServerData(formData); // Mark current state as "saved" so isDirty becomes false
            isSaveNavigatingRef.current = true;
            navigate(backTarget);
        } catch (err: any) {
            console.error('[SkillEditor] Save failed:', err);
            setSaveError(err?.message || 'Save failed');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDeleteClick = () => {
        if (!formData) return;
        setShowDeleteConfirm(true);
    };

    const handleDeleteConfirm = async () => {
        if (!formData) return;
        try {
            await rpcDeleteSkill(sendRpc, String(formData.id), currentWorkspace?.id);
            if (id) clearDraft(id);
            isSaveNavigatingRef.current = true;
            navigate(backTarget);
        } catch (err) {
            console.error('[SkillEditor] Delete failed:', err);
        }
    };

    const [creatingScriptType, setCreatingScriptType] = useState<'shell' | 'python' | null>(null);
    const [newScriptName, setNewScriptName] = useState('');

    const initiateAddScript = (type: 'shell' | 'python') => {
        setCreatingScriptType(type);
        setNewScriptName(type === 'python' ? 'script.py' : 'script.sh');
        setShowAddMenu(false);
    };

    const handleAddScriptConfirm = () => {
        if (!creatingScriptType || !newScriptName.trim()) return;

        const newScript: Script = {
            id: `new-${Date.now()}`,
            info: creatingScriptType,
            name: newScriptName.trim(),
            content: creatingScriptType === 'python' ? 'print("New Python Script")' : '#!/bin/bash\n\necho "New Shell Script"'
        };

        setFormData(prev => prev ? ({ ...prev, scripts: [...(prev.scripts || []), newScript] }) : null);
        setActiveScriptId(newScript.id);
        setCreatingScriptType(null);
        setNewScriptName('');
    };

    const handleDeleteScript = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (!formData?.scripts) return;
        const newScripts = formData.scripts.filter(s => s.id !== id);
        setFormData({ ...formData, scripts: newScripts });
        if (activeScriptId === id && newScripts.length > 0) {
            setActiveScriptId(newScripts[0].id);
        } else if (activeScriptId === id && newScripts.length === 0) {
            setActiveScriptId(null);
        }
    };

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const content = event.target?.result as string;
            const isPy = file.name.endsWith('.py');
            const newScript: Script = {
                id: `upload-${Date.now()}`,
                info: isPy ? 'python' : 'shell',
                name: file.name,
                content: content
            };
            setFormData(prev => prev ? ({ ...prev, scripts: [...(prev.scripts || []), newScript] }) : null);
            setActiveScriptId(newScript.id);
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (formData) {
            const newName = e.target.value;
            // Sync name into specs frontmatter
            let specs = formData.specs || '';
            const fmMatch = specs.match(/^(---\n)([\s\S]*?)(\n---)/);
            if (fmMatch) {
                const yaml = fmMatch[2];
                const updatedYaml = yaml.match(/^name:\s*.+$/m)
                    ? yaml.replace(/^name:\s*.+$/m, `name: ${newName}`)
                    : `name: ${newName}\n${yaml}`;
                specs = `${fmMatch[1]}${updatedYaml}${fmMatch[3]}${specs.slice(fmMatch[0].length)}`;
            }
            setFormData({ ...formData, name: newName, specs });
        }
    };

    if (!formData) return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin text-gray-400" /></div>;

    return (
        <div className="h-full bg-white flex flex-col relative">
            <AnimatePresence>
                {creatingScriptType && (
                    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/20 backdrop-blur-[1px]">
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            className="bg-white rounded-xl shadow-2xl border border-gray-100 p-5 w-80 space-y-4"
                        >
                            <div>
                                <h3 className="text-sm font-bold text-gray-900">New {creatingScriptType === 'python' ? 'Python' : 'Shell'} Script</h3>
                                <p className="text-xs text-gray-500 mt-1">Enter a filename for your script.</p>
                            </div>
                            <input
                                autoFocus
                                type="text"
                                value={newScriptName}
                                onChange={(e) => setNewScriptName(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddScriptConfirm()}
                                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500/50"
                                placeholder={creatingScriptType === 'python' ? 'script.py' : 'script.sh'}
                            />
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={() => setCreatingScriptType(null)}
                                    className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleAddScriptConfirm}
                                    disabled={!newScriptName.trim()}
                                    className="px-3 py-1.5 text-xs font-medium bg-primary-600 text-white hover:bg-primary-700 rounded-lg shadow-sm disabled:opacity-50 transition-all"
                                >
                                    Create Script
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            <header className="flex items-center justify-between px-6 py-3 border-b border-gray-100 bg-white shrink-0 h-14">
                <div className="flex items-center gap-4">
                    <Tooltip content="Back to Skills">
                        <button onClick={() => navigate(backTarget)} className="p-2 -ml-2 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors">
                            <ArrowLeft className="w-5 h-5" />
                        </button>
                    </Tooltip>
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5">
                            {isReadOnly ? (
                                <span className="text-base font-bold text-gray-900 px-1 -ml-1 h-6 flex items-center">{formData.name}</span>
                            ) : (
                                <input
                                    type="text"
                                    value={formData.name}
                                    onChange={handleNameChange}
                                    className="text-base font-bold text-gray-900 bg-transparent border-none focus:ring-0 p-0 hover:bg-gray-50 rounded px-1 -ml-1 transition-colors w-64 h-6"
                                />
                            )}
                            {isDirty && <span className="text-amber-500 text-lg leading-none" title="Unsaved changes">●</span>}
                        </div>
                        {formData.scope && formData.scope !== 'personal' && (
                            <span className={cn(
                                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium",
                                formData.scope === 'builtin' ? "bg-gray-100 text-gray-700"
                                    : formData.scope === 'skillset' ? "bg-green-50 text-green-700"
                                    : "bg-blue-50 text-blue-700"
                            )}>
                                {formData.scope === 'builtin' ? <Lock className="w-2.5 h-2.5" />
                                    : <Users className="w-2.5 h-2.5" />}
                                {formData.scope === 'builtin' ? 'System Skills'
                                    : formData.scope === 'skillset' ? (formData.skillSpaceName || 'Skill Space')
                                    : 'Global Skills'}
                                {isReadOnly && <span className="text-gray-400 ml-0.5">· Read-only</span>}
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-1">
                    <Tooltip content={isExpanded ? "Hide Scripts" : "Show Scripts"}>
                        <button
                            onClick={() => setIsExpanded(!isExpanded)}
                            className={cn(
                                "p-2 rounded-lg text-gray-400 transition-all border border-transparent hover:border-gray-200 hover:bg-gray-50",
                                isExpanded ? "text-primary-600 bg-primary-50 hover:bg-primary-100 hover:border-primary-200" : ""
                            )}
                        >
                            <LayoutTemplate className="w-5 h-5" />
                        </button>
                    </Tooltip>

                    {!isNew && (
                        <Tooltip content={showHistory ? "Hide History" : "Version History"}>
                            <button
                                onClick={handleLoadHistory}
                                disabled={historyLoading}
                                className={cn(
                                    "p-2 rounded-lg text-gray-400 transition-all border border-transparent hover:border-gray-200 hover:bg-gray-50",
                                    showHistory ? "text-indigo-600 bg-indigo-50 hover:bg-indigo-100 hover:border-indigo-200" : ""
                                )}
                            >
                                {historyLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <History className="w-5 h-5" />}
                            </button>
                        </Tooltip>
                    )}

                    <div className="h-5 w-px bg-gray-200 mx-1" />

                    {isReadOnly ? (
                        <Tooltip content="Fork to Personal">
                            <button
                                onClick={handleFork}
                                disabled={isCopying}
                                className="p-2 text-purple-600 hover:bg-purple-50 rounded-lg transition-colors disabled:opacity-50"
                            >
                                {isCopying ? <Loader2 className="w-5 h-5 animate-spin" /> : <GitFork className="w-5 h-5" />}
                            </button>
                        </Tooltip>
                    ) : (
                        <>
                            <Tooltip content={isSaving ? "Saving..." : "Save Changes"}>
                                <button
                                    onClick={handleSave}
                                    disabled={isSaving}
                                    className="p-2 text-primary-600 hover:bg-primary-50 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                                </button>
                            </Tooltip>
                            <Tooltip content="Delete Skill">
                                <button
                                    onClick={handleDeleteClick}
                                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                >
                                    <Trash2 className="w-5 h-5" />
                                </button>
                            </Tooltip>
                        </>
                    )}
                </div>
            </header>

            {/* Save error banner */}
            {saveError && (
                <div className="px-6 py-2.5 bg-red-50 border-b border-red-200 flex items-center gap-2 shrink-0">
                    <span className="text-sm text-red-800">{saveError}</span>
                    <button onClick={() => setSaveError(null)} className="ml-auto text-red-400 hover:text-red-600"><X className="w-4 h-4" /></button>
                </div>
            )}

            {/* Draft restore banner */}
            {draftRestored && (
                <div className="px-6 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center gap-2 shrink-0">
                    <span className="text-sm text-amber-800">Unsaved draft found ({formatTimeAgo(draftRestored.savedAt)})</span>
                    <div className="flex-1" />
                    <button
                        onClick={handleDismissDraftBanner}
                        className="px-3 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 rounded-md transition-colors"
                    >
                        Keep Draft
                    </button>
                    <button
                        onClick={handleDiscardDraft}
                        className="px-3 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 rounded-md transition-colors"
                    >
                        Discard
                    </button>
                </div>
            )}

            {/* Review status banners */}
            {formData.reviewStatus === 'pending' && (
                <div className="px-6 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center gap-2 shrink-0">
                    <ShieldAlert className="w-4 h-4 text-amber-600" />
                    <span className="text-sm text-amber-800 font-medium">This skill is pending publish review. Test environment has the latest version.</span>
                </div>
            )}
            {formData.reviewStatus === 'approved' && formData.scope === 'personal' && formData.publishedVersion != null
                && Number(String(formData.version).replace(/^v/, '')) > formData.publishedVersion && (
                <div className="px-6 py-2.5 bg-blue-50 border-b border-blue-200 flex items-center gap-2 shrink-0">
                    <FileCode className="w-4 h-4 text-blue-500" />
                    <span className="text-sm text-blue-800 font-medium">Modified since published v{formData.publishedVersion}. Submit for review to publish changes to production.</span>
                </div>
            )}
            {formData.reviewStatus === 'draft' && formData.scope === 'personal' && (
                <div className="px-6 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center gap-2 shrink-0">
                    <ShieldAlert className="w-4 h-4 text-gray-400" />
                    <span className="text-sm text-gray-600 font-medium">Draft — available in test environments only. Request publish to use in production.</span>
                </div>
            )}

            <div className="flex flex-1 overflow-hidden min-h-0 bg-gray-50/50">
                {/* LEFT PANEL: Metadata & Config */}
                <div className={cn(
                    "flex flex-col transition-all duration-300 relative bg-white border-r border-gray-200",
                    isExpanded ? "w-[70%] max-w-[70%]" : "w-full"
                )}>
                    <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 block">Category</label>
                                <div className="relative group/cat">
                                    <input
                                        type="text"
                                        value={formData.type}
                                        onChange={(e) => !isReadOnly && setFormData({ ...formData, type: e.target.value })}
                                        onFocus={() => !isReadOnly && setShowCategoryDropdown(true)}
                                        readOnly={isReadOnly}
                                        className={cn(
                                            "w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 outline-none transition-all placeholder:text-gray-400",
                                            isReadOnly ? "bg-gray-50 cursor-default" : "bg-gray-50/50 focus:ring-1 focus:ring-primary-500/50 focus:bg-white focus:border-primary-500"
                                        )}
                                        placeholder="Select or type..."
                                    />
                                    {!isReadOnly && (
                                        <button
                                            onClick={() => setShowCategoryDropdown(!showCategoryDropdown)}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
                                        >
                                            <ChevronDown className="w-4 h-4" />
                                        </button>
                                    )}

                                    {showCategoryDropdown && !isReadOnly && (
                                        <>
                                            <div className="fixed inset-0 z-10" onClick={() => setShowCategoryDropdown(false)} />
                                            <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1 max-h-48 overflow-y-auto">
                                                {PRESET_CATEGORIES.map(cat => (
                                                    <button
                                                        key={cat}
                                                        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 text-gray-700 hover:text-primary-600 transition-colors"
                                                        onClick={() => {
                                                            setFormData({ ...formData, type: cat });
                                                            setShowCategoryDropdown(false);
                                                        }}
                                                    >
                                                        {cat}
                                                    </button>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                            <div>
                                <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 block">Version</label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        value={formData.version}
                                        readOnly
                                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 outline-none bg-gray-50 cursor-default"
                                        placeholder="e.g. v1"
                                    />
                                    {formData.publishedVersion != null && String(formData.publishedVersion) !== formData.version?.replace(/^v/, '') && (
                                        <span className="text-xs text-green-600 whitespace-nowrap">(published: v{formData.publishedVersion})</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Labels */}
                        <div>
                            <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 block">Labels</label>
                            <div className="flex flex-wrap gap-1.5 items-center">
                                {(formData.labels ?? []).map(lbl => (
                                    <span
                                        key={lbl}
                                        className={cn(
                                            "px-1.5 py-0.5 rounded text-[10px] font-medium border bg-gray-50 text-gray-600 border-gray-200 inline-flex items-center gap-1",
                                            !isReadOnly && "pr-0.5"
                                        )}
                                    >
                                        {lbl}
                                        {!isReadOnly && (
                                            <button
                                                onClick={() => {
                                                    const next = (formData.labels ?? []).filter(l => l !== lbl);
                                                    setFormData({ ...formData, labels: next });
                                                    if (!isNew) rpcUpdateSkillLabels(sendRpc, String(formData.id), next).catch(() => {});
                                                }}
                                                className="ml-0.5 p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors"
                                            >
                                                <X className="w-2.5 h-2.5" />
                                            </button>
                                        )}
                                    </span>
                                ))}
                                {!isReadOnly && (
                                    <input
                                        type="text"
                                        placeholder="+ Add label"
                                        className="text-[11px] px-1.5 py-0.5 border border-transparent rounded bg-transparent text-gray-500 outline-none w-20 focus:border-gray-200 focus:bg-white placeholder:text-gray-300"
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ',') {
                                                e.preventDefault();
                                                const val = (e.target as HTMLInputElement).value.trim();
                                                if (val && !(formData.labels ?? []).includes(val)) {
                                                    const next = [...(formData.labels ?? []), val];
                                                    setFormData({ ...formData, labels: next });
                                                    if (!isNew) rpcUpdateSkillLabels(sendRpc, String(formData.id), next).catch(() => {});
                                                }
                                                (e.target as HTMLInputElement).value = '';
                                            }
                                        }}
                                    />
                                )}
                            </div>
                        </div>

                        <div className="flex-1 flex flex-col min-h-[400px]">
                            <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2 flex justify-between group px-1">
                                Skill Specification (YAML)
                                <span className="text-[10px] text-gray-400 font-medium normal-case group-hover:text-primary-600 cursor-pointer transition-colors opacity-0 group-hover:opacity-100">Reset Template</span>
                            </label>
                            <div className="relative flex-1 group/editor">
                                <textarea
                                    value={formData.specs}
                                    onChange={(e) => {
                                        if (isReadOnly) return;
                                        const newSpecs = e.target.value;
                                        // Sync frontmatter name → UI name
                                        const fmMatch = newSpecs.match(/^---\n([\s\S]*?)\n---/);
                                        const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m);
                                        const fmName = nameMatch ? nameMatch[1].trim() : undefined;
                                        setFormData({ ...formData, specs: newSpecs, ...(fmName !== undefined ? { name: fmName } : {}) });
                                    }}
                                    readOnly={isReadOnly}
                                    className={cn(
                                        "w-full h-full px-4 py-3 border border-gray-200 rounded-lg text-xs font-mono text-gray-700 outline-none resize-none leading-relaxed transition-all",
                                        isReadOnly ? "bg-gray-50 cursor-default" : "bg-gray-50/50 focus:ring-1 focus:ring-primary-500/50 focus:bg-white focus:border-primary-500"
                                    )}
                                    spellCheck={false}
                                />
                            </div>
                        </div>
                    </div>

                </div>

                {/* RIGHT PANEL: Script Manager (List View) */}
                {isExpanded && (
                    <div className="flex-1 flex flex-col bg-white">
                        {/* Header Actions */}
                        <div className="px-6 py-4 flex items-center justify-between border-b border-gray-100 bg-white">
                            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Scripts ({formData.scripts?.length || 0})</h3>
                            {!isReadOnly && (
                            <div className="flex items-center gap-1">
                                <Tooltip content="Upload Script">
                                    <button
                                        onClick={() => fileInputRef.current?.click()}
                                        className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                                    >
                                        <FileUp className="w-4 h-4" />
                                    </button>
                                </Tooltip>
                                <div className="relative">
                                    <Tooltip content="New Script">
                                        <button
                                            onClick={() => setShowAddMenu(!showAddMenu)}
                                            className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                                        >
                                            <Plus className="w-4 h-4" />
                                        </button>
                                    </Tooltip>
                                    {showAddMenu && (
                                        <>
                                            <div className="fixed inset-0 z-10" onClick={() => setShowAddMenu(false)} />
                                            <div className="absolute right-0 top-full mt-1 w-40 bg-white border border-gray-100 rounded-lg shadow-xl z-20 py-1 flex flex-col overflow-hidden">
                                                <button
                                                    onClick={() => initiateAddScript('shell')}
                                                    className="px-3 py-2.5 text-left text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                                                >
                                                    <Terminal className="w-3.5 h-3.5 text-green-600" />
                                                    Shell Script
                                                </button>
                                                <button
                                                    onClick={() => initiateAddScript('python')}
                                                    className="px-3 py-2.5 text-left text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                                                >
                                                    <FileCode className="w-3.5 h-3.5 text-blue-600" />
                                                    Python Script
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    className="hidden"
                                    accept=".sh,.py,.txt"
                                    onChange={handleFileUpload}
                                />
                            </div>
                            )}
                        </div>

                        {/* Script List Grid */}
                        <div className="flex-1 overflow-y-auto p-6 pt-2">
                            {(!formData.scripts || formData.scripts.length === 0) ? (
                                <div className="h-40 flex flex-col items-center justify-center border-2 border-dashed border-gray-200 rounded-xl bg-gray-50/50">
                                    <div className="p-3 bg-white rounded-full shadow-sm mb-3">
                                        <Code2 className="w-6 h-6 text-gray-300" />
                                    </div>
                                    <p className="text-sm text-gray-500 font-medium">No scripts yet</p>
                                    <p className="text-xs text-gray-400 mt-1">Add or upload a script to get started</p>
                                </div>
                            ) : (
                                <div className="flex flex-col gap-2">
                                    {formData.scripts.map((script) => (
                                        <div
                                            key={script.id}
                                            onClick={() => setActiveScriptId(script.id)}
                                            className="group flex items-center justify-between p-3 bg-white border border-gray-200 hover:border-primary-500/50 hover:shadow-sm rounded-lg cursor-pointer transition-all duration-200"
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className={cn(
                                                    "w-8 h-8 rounded-md flex items-center justify-center shrink-0",
                                                    script.info === 'python' ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'
                                                )}>
                                                    {script.info === 'python' ? <FileCode className="w-4 h-4" /> : <Terminal className="w-4 h-4" />}
                                                </div>
                                                <div className="flex flex-col">
                                                    <h4 className="text-sm font-medium text-gray-900 group-hover:text-primary-600 transition-colors">{script.name}</h4>
                                                    <span className="text-[10px] text-gray-400 font-mono">
                                                        {script.info === 'python' ? 'Python' : 'Bash'} · {script.content.length}B
                                                    </span>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity pl-4">
                                                <Tooltip content={isReadOnly ? "View Script" : "Edit Script"}>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setActiveScriptId(script.id);
                                                        }}
                                                        className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
                                                    >
                                                        {isReadOnly ? <Eye className="w-4 h-4" /> : <Code2 className="w-4 h-4" />}
                                                    </button>
                                                </Tooltip>
                                                {!isReadOnly && (
                                                    <Tooltip content="Delete Script">
                                                        <button
                                                            onClick={(e) => handleDeleteScript(e, script.id)}
                                                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                    </Tooltip>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* VERSION HISTORY PANEL */}
                <AnimatePresence>
                    {showHistory && (
                        <motion.div
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: 320, opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="border-l border-gray-200 bg-white flex flex-col overflow-hidden shrink-0"
                        >
                            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                                <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Version History</h3>
                                <button onClick={() => setShowHistory(false)} className="p-1 text-gray-400 hover:text-gray-700 rounded">
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                                {versions.length === 0 ? (
                                    <p className="text-sm text-gray-400 text-center py-8">No published versions yet</p>
                                ) : versions.map((v) => (
                                    <div key={v.hash} className="p-3 rounded-lg border border-gray-100 hover:border-gray-200 transition-colors">
                                        <div className="flex items-center justify-between mb-1">
                                            <span className="text-sm font-bold text-gray-900">v{v.version}</span>
                                            {canRollback && (
                                                <Tooltip content="Rollback to this version">
                                                    <button
                                                        onClick={() => setRollbackConfirm(v.version)}
                                                        className="p-1 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded transition-colors"
                                                    >
                                                        <RotateCcw className="w-3.5 h-3.5" />
                                                    </button>
                                                </Tooltip>
                                            )}
                                        </div>
                                        <p className="text-xs text-gray-500 truncate">{v.message}</p>
                                        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-gray-400">
                                            <span>{v.author}</span>
                                            {v.date && <span>{new Date(v.date).toLocaleDateString()}</span>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* OVERLAY EDITOR */}
                <AnimatePresence>
                    {activeScriptId && (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.98 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            transition={{ duration: 0.15 }}
                            className="absolute inset-0 z-50 bg-[#1e1e1e] flex flex-col"
                        >
                            {/* Editor Header */}
                            <div className="flex items-center justify-between px-4 py-3 bg-[#252526] border-b border-[#1e1e1e]">
                                <div className="flex items-center gap-3">
                                    <div className={cn(
                                        "w-8 h-8 rounded flex items-center justify-center",
                                        formData.scripts?.find(s => s.id === activeScriptId)?.info === 'python' ? 'bg-[#37373d] text-yellow-400' : 'bg-[#37373d] text-green-400'
                                    )}>
                                        {formData.scripts?.find(s => s.id === activeScriptId)?.info === 'python' ? <FileCode className="w-4 h-4" /> : <Terminal className="w-4 h-4" />}
                                    </div>
                                    <span className="text-sm font-medium text-gray-200 font-mono">
                                        {formData.scripts?.find(s => s.id === activeScriptId)?.name}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2">
                                    {!isReadOnly && (
                                        <Tooltip content="Save Script">
                                            <button
                                                onClick={handleSave}
                                                className="p-1.5 text-gray-400 hover:text-white hover:bg-[#333] rounded transition-colors"
                                            >
                                                <Save className="w-5 h-5" />
                                            </button>
                                        </Tooltip>
                                    )}
                                    <Tooltip content="Close Editor">
                                        <button
                                            onClick={() => setActiveScriptId(null)}
                                            className="p-1.5 text-gray-400 hover:text-white hover:bg-[#333] rounded transition-colors"
                                        >
                                            <X className="w-5 h-5" />
                                        </button>
                                    </Tooltip>
                                </div>
                            </div>

                            {/* Editor Content */}
                            <div className="flex-1 relative font-mono text-sm overflow-y-auto custom-scrollbar">
                                <Editor
                                    value={formData.scripts?.find(s => s.id === activeScriptId)?.content || ''}
                                    onValueChange={(code) => {
                                        if (isReadOnly) return;
                                        setFormData({
                                            ...formData,
                                            scripts: formData.scripts?.map(s =>
                                                s.id === activeScriptId ? { ...s, content: code } : s
                                            )
                                        });
                                    }}
                                    highlight={code => {
                                        const script = formData.scripts?.find(s => s.id === activeScriptId);
                                        const grammar = script?.info === 'python' ? Prism.languages.python : Prism.languages.bash;
                                        return Prism.highlight(code, grammar || Prism.languages.js, script?.info || 'javascript');
                                    }}
                                    padding={24}
                                    style={{
                                        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                                        fontSize: 14,
                                        backgroundColor: '#1e1e1e',
                                        color: '#d4d4d4',
                                        minHeight: '100%',
                                    }}
                                    className="min-h-full"
                                    textareaClassName="focus:outline-none"
                                />
                            </div>

                            {/* Editor Status Bar */}
                            <div className="h-6 bg-[#007acc] text-white flex items-center px-4 text-[11px] font-medium gap-6 select-none border-t border-[#007acc]">
                                <div className="flex items-center gap-2">
                                    <Code2 className="w-3 h-3 opacity-70" />
                                    <span>{formData.scripts?.find(s => s.id === activeScriptId)?.info === 'python' ? 'Python 3.10' : 'Bash 5.0'}</span>
                                </div>
                                <span className="flex-1"></span>
                                <span>UTF-8</span>
                                <span>Ln {formData.scripts?.find(s => s.id === activeScriptId)?.content.split('\n').length}, Col 1</span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <ConfirmDialog
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={handleDeleteConfirm}
                title="Delete Skill"
                description="Are you sure you want to delete this skill? This action cannot be undone."
                confirmText="Delete"
                variant="danger"
            />

            <ConfirmDialog
                isOpen={rollbackConfirm !== null}
                onClose={() => setRollbackConfirm(null)}
                onConfirm={() => rollbackConfirm !== null && handleRollback(rollbackConfirm)}
                title="Rollback Version"
                description={`Are you sure you want to rollback to v${rollbackConfirm}? This will overwrite the current working copy and published snapshot.`}
                confirmText="Rollback"
                variant="warning"
            />

            <ConfirmDialog
                isOpen={blocker.state === 'blocked'}
                onClose={() => blocker.state === 'blocked' && blocker.reset?.()}
                onConfirm={() => blocker.state === 'blocked' && blocker.proceed?.()}
                title="Unsaved Changes"
                description="You have unsaved changes. Your draft has been auto-saved and can be restored next time you open this skill."
                confirmText="Leave"
                cancelText="Keep Editing"
                variant="warning"
            />
        </div>
    );
}
