import { Search, Plus, Settings, Users, Shield, User, LayoutGrid, Lock, ClipboardCheck, X, Check, Eye, Loader2, ThumbsUp, ThumbsDown, Undo2, Trash2, ShieldAlert, ChevronDown, ChevronUp, AlertTriangle, Info, FileCode, Terminal, GitCommitHorizontal, FilePlus2, RotateCcw, SendHorizontal, Upload, Tag, GitFork } from 'lucide-react';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Skill, SkillReview, SkillSpace, SkillDiffMetadataChange } from './skillsData';
import { rpcGetSkillById, rpcGetSkillReview, rpcGetSkillDiff, rpcListSkillSpaces, rpcCreateSkillSpace, type SkillSpaceMember } from './skillsData';
import { getCurrentUser } from '../../auth';
import { Tooltip } from '../../components/Tooltip';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DiffViewerModal } from '../../components/DiffViewerModal';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useSkills } from '../../hooks/useSkills';
import { usePermissions } from '../../hooks/usePermissions';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { rpcGetSkillSystemCapabilities } from './skillsData';
import { DEFAULT_SKILL_LABEL_COLORS, getDefaultSkillBadges, SkillCard, type SkillCardAction } from './components/SkillCard';

export function SkillsPage() {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const { sendRpc, isConnected } = useWebSocket();
    const { currentWorkspace } = useWorkspace();
    const {
        skills, isLoading, isLoadingMore, hasMore, loadSkills, loadMore,
        toggleEnabled, requestPublish, publishSkill, copyToPersonal,
        approveSkill: doApprove, rejectSkill: doReject,
        deleteSkill: doDelete, voteSkill, revertSkill, reviewSkill,
        withdrawSkill: doWithdraw,
    } = useSkills(sendRpc, currentWorkspace?.id);

    const currentUser = getCurrentUser();
    const isAdmin = currentUser?.username === 'admin';
    const { isReviewer } = usePermissions(sendRpc, isConnected);

    const validTabs = new Set(['all', 'global', 'myskills', 'approvals'] as const);
    type SkillTab = 'all' | 'global' | 'myskills' | 'approvals';
    const tabFromUrl = searchParams.get('tab') as SkillTab | null;
    const savedTab = sessionStorage.getItem('skills_tab') as SkillTab | null;
    const resolvedTab: SkillTab = (tabFromUrl && validTabs.has(tabFromUrl) ? tabFromUrl : null) || (savedTab && validTabs.has(savedTab) ? savedTab : null) || 'all';
    const [activeTab, setActiveTab] = useState<SkillTab>(resolvedTab);
    const [searchInput, setSearchInput] = useState('');
    const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
    const [labelDropdownOpen, setLabelDropdownOpen] = useState(false);
    const [skillSpaces, setSkillSpaces] = useState<SkillSpace[]>([]);
    const [myView, setMyView] = useState<'personal' | 'shared'>('personal');
    const [skillSpaceEnabled, setSkillSpaceEnabled] = useState(false);
    const [skillSpaceDialog, setSkillSpaceDialog] = useState<{
        isOpen: boolean;
        mode: 'create' | 'manage';
        skillSpace?: SkillSpace;
        members?: SkillSpaceMember[];
        newName?: string;
        newDescription?: string;
        newMemberUsername?: string;
    }>({ isOpen: false, mode: 'create' });
    const labelDropdownRef = useRef<HTMLDivElement>(null);
    const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const contentRef = useRef<HTMLDivElement>(null);
    const [personalDiffModal, setPersonalDiffModal] = useState<{
        isOpen: boolean;
        title: string;
        subtitle: string;
        diffText: string | null;
        metadataChanges: SkillDiffMetadataChange[];
        isLoading: boolean;
    }>({ isOpen: false, title: '', subtitle: '', diffText: null, metadataChanges: [], isLoading: false });

    const handleSkillDiff = async (skill: Skill) => {
        const useGlobalContributionBaseline =
            skill.scope === 'personal' &&
            skill.reviewStatus === 'approved' &&
            !skill.hasUnpublishedChanges &&
            skill.contributionStatus !== 'approved';
        setPersonalDiffModal({
            isOpen: true,
            title: `${skill.name} Diff`,
            subtitle: 'Loading comparison...',
            diffText: null,
            metadataChanges: [],
            isLoading: true,
        });
        try {
            const result = await rpcGetSkillDiff(
                sendRpc,
                String(skill.id),
                useGlobalContributionBaseline,
                undefined,
                useGlobalContributionBaseline ? 'global' : undefined,
            );
            setPersonalDiffModal({
                isOpen: true,
                title: `${skill.name} Diff`,
                subtitle: result.baselineLabel && result.compareLabel
                    ? `${result.baselineLabel} -> ${result.compareLabel}`
                    : useGlobalContributionBaseline
                        ? 'Latest global -> Contribution candidate'
                        : 'Personal diff',
                diffText: result.diff || 'No changes detected.',
                metadataChanges: result.metadataChanges ?? [],
                isLoading: false,
            });
        } catch (err: any) {
            setPersonalDiffModal({
                isOpen: true,
                title: `${skill.name} Diff`,
                subtitle: useGlobalContributionBaseline
                    ? 'Latest global -> Contribution candidate'
                    : 'Personal diff',
                diffText: 'Failed to load diff.',
                metadataChanges: [],
                isLoading: false,
            });
            console.error('[Skills] Failed to load skill diff:', err);
        }
    };

    // Label category grouping
    const LABEL_GROUPS: Record<string, string[]> = {
        Environment: ['kubernetes', 'bare-metal', 'switch'],
        Domain: ['network', 'rdma', 'scheduling', 'storage', 'compute', 'general'],
        Operation: ['diagnostic', 'monitoring', 'performance', 'configuration'],
        ...(isAdmin ? { Role: ['sre', 'developer'] } : {}),
    };

    // Compute label infos from currently visible skills (respects active tab)
    const visibleLabelInfos = useMemo(() => {
        const counts = new Map<string, number>();
        for (const s of skills) {
            for (const l of s.labels ?? []) {
                counts.set(l, (counts.get(l) ?? 0) + 1);
            }
        }
        return [...counts.entries()].map(([label, count]) => ({ label, count }));
    }, [skills]);

    // Group available labels by category for the dropdown
    const groupedLabels = useMemo(() => {
        const available = new Set(visibleLabelInfos.map(l => l.label));
        const countMap = new Map(visibleLabelInfos.map(l => [l.label, l.count]));
        const groups: { group: string; labels: { label: string; count: number }[] }[] = [];
        const categorized = new Set<string>();

        for (const [group, members] of Object.entries(LABEL_GROUPS)) {
            const matching = members
                .filter(l => available.has(l))
                .map(l => ({ label: l, count: countMap.get(l) ?? 0 }));
            if (matching.length > 0) {
                groups.push({ group, labels: matching });
                matching.forEach(m => categorized.add(m.label));
            }
        }

        // Uncategorized labels
        const uncategorized = visibleLabelInfos
            .filter(l => !categorized.has(l.label))
            .map(l => ({ label: l.label, count: l.count }));
        if (uncategorized.length > 0) {
            groups.push({ group: 'Other', labels: uncategorized });
        }

        return groups;
    }, [visibleLabelInfos, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

    const toggleLabel = (label: string) => {
        setSelectedLabels(prev => {
            const next = new Set(prev);
            if (next.has(label)) next.delete(label);
            else next.add(label);
            return next;
        });
    };

    // Close dropdown on outside click
    useEffect(() => {
        if (!labelDropdownOpen) return;
        const handler = (e: MouseEvent) => {
            if (labelDropdownRef.current && !labelDropdownRef.current.contains(e.target as Node)) {
                setLabelDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [labelDropdownOpen]);

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setSearchInput(val);
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => {
            loadSkills(activeTab, val);
        }, 300);
    };

    const handleTabChange = (tab: string) => {
        setActiveTab(tab as any);
        sessionStorage.setItem('skills_tab', tab);
        setSelectedLabels(new Set()); // Clear label filter on tab change
        if (tab === 'all') {
            setSearchParams({});
        } else {
            setSearchParams({ tab });
        }
        loadSkills(tab, searchInput);
    };

    const handleScroll = useCallback(() => {
        const el = contentRef.current;
        if (!el || isLoadingMore || !hasMore) return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
            loadMore();
        }
    }, [isLoadingMore, hasMore, loadMore]);

    // Revert dialog state (with reason textarea)
    const [revertDialog, setRevertDialog] = useState<{
        isOpen: boolean;
        skill: Skill | null;
        reason: string;
    }>({ isOpen: false, skill: null, reason: '' });

    // Dialog State
    const [dialogState, setDialogState] = useState<{
        isOpen: boolean;
        title: string;
        description: string;
        variant: 'primary' | 'danger' | 'warning';
        confirmText: string;
        onConfirm: () => void;
    }>({
        isOpen: false,
        title: '',
        description: '',
        variant: 'primary',
        confirmText: 'Confirm',
        onConfirm: () => { }
    });

    const closeDialog = () => setDialogState(prev => ({ ...prev, isOpen: false }));

    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (!isConnected) { hasLoadedRef.current = false; return; }
        if (!currentWorkspace?.id || hasLoadedRef.current) return;
        hasLoadedRef.current = true;
        loadSkills(activeTab, '');
        rpcGetSkillSystemCapabilities(sendRpc, currentWorkspace.id).then((caps) => {
                setSkillSpaceEnabled(caps.skillSpaceEnabled);
                if (caps.skillSpaceEnabled) {
                    rpcListSkillSpaces(sendRpc, currentWorkspace.id).then(setSkillSpaces).catch(() => {});
                } else {
                    setSkillSpaces([]);
                    if (myView === 'shared') setMyView('personal');
                }
            }).catch(() => {
                setSkillSpaceEnabled(false);
                setSkillSpaces([]);
                if (myView === 'shared') setMyView('personal');
            });
    }, [isConnected, currentWorkspace?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        hasLoadedRef.current = false;
    }, [currentWorkspace?.id]);

    // Sync activeTab from URL when searchParams change (e.g., navigation from notifications)
    useEffect(() => {
        const urlTab = searchParams.get('tab');
        if (!urlTab) return; // No explicit tab in URL — keep current/sessionStorage tab
        const tab = urlTab as typeof activeTab;
        if (tab !== activeTab) {
            setActiveTab(tab);
            sessionStorage.setItem('skills_tab', tab);
            loadSkills(tab, searchInput);
        }
    }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

    // For approvals tab, backend returns only pending skills via pendingOnly flag
    // Apply client-side label filter
    const displaySkills = selectedLabels.size === 0
        ? skills
        : skills.filter(s => {
            const sl = s.labels ?? [];
            return [...selectedLabels].every(l => sl.includes(l));
        });

    // Group skills for My Skills tab by scope (personal vs skill space)
    const skillSpaceGroups = useMemo(() => {
        const groups: Map<string, { skillSpace: SkillSpace; skills: Skill[] }> = new Map();
        for (const space of skillSpaces) {
            groups.set(space.id, { skillSpace: space, skills: [] });
        }
        for (const skill of displaySkills) {
            if (skill.scope === 'skillset' && skill.skillSpaceId) {
                const group = groups.get(skill.skillSpaceId);
                if (group) group.skills.push(skill);
            }
        }
        return [...groups.values()];
    }, [displaySkills, skillSpaces]);

    const handleCreateSkillSpace = async () => {
        const name = skillSpaceDialog.newName?.trim();
        if (!name) return;
        if (!currentWorkspace?.id) return;
        try {
            await rpcCreateSkillSpace(sendRpc, currentWorkspace.id, name, skillSpaceDialog.newDescription);
            setSkillSpaceDialog({ isOpen: false, mode: 'create' });
            const spaces = await rpcListSkillSpaces(sendRpc, currentWorkspace.id);
            setSkillSpaces(spaces);
            loadSkills(activeTab, searchInput);
        } catch (err: any) {
            showError(err.message || 'Failed to create skill space');
        }
    };




    const handleCreateNew = () => navigate('/skills/new');

    const handleToggleEnabled = (e: React.MouseEvent, skill: Skill) => {
        e.stopPropagation();
        toggleEnabled(skill);
    };

    const showError = (message: string) => {
        setDialogState({
            isOpen: true,
            title: 'Error',
            description: message,
            variant: 'warning',
            confirmText: 'OK',
            onConfirm: () => { },
        });
    };

    const handlePublish = (e: React.MouseEvent, skill: Skill) => {
        e.stopPropagation();
        const isSkillSpace = skill.scope === 'skillset';
        setDialogState({
            isOpen: true,
            title: isSkillSpace ? 'Submit Merge' : 'Publish Skill',
            description: isSkillSpace
                ? `Submit "${skill.name}" from Skill Space for merge review? Once approved, it will become the latest merged version in this Skill Space.`
                : `Are you sure you want to publish "${skill.name}"? It will be reviewed by an admin before becoming available in production.`,
            variant: 'primary',
            confirmText: isSkillSpace ? 'Submit Merge' : 'Request Publish',
            onConfirm: () => { requestPublish(skill).catch((err: any) => showError(err?.message || String(err))); }
        });
    };

    const handleContribute = (e: React.MouseEvent, skill: Skill) => {
        e.stopPropagation();
        setDialogState({
            isOpen: true,
            title: 'Contribute to Global',
            description: `Contribute the latest approved version of "${skill.name}" to global? An admin will review it before it becomes a shared global skill.`,
            variant: 'primary',
            confirmText: 'Contribute',
            onConfirm: () => { publishSkill(skill, true).catch((err: any) => showError(err?.message || String(err))); }
        });
    };

    const handleCopy = (e: React.MouseEvent, skill: Skill) => {
        e.stopPropagation();
        setDialogState({
            isOpen: true,
            title: 'Fork to Personal',
            description: `This will fork "${skill.name}" into your personal skills. You can edit and customize the fork, and optionally contribute changes back to global.`,
            variant: 'primary',
            confirmText: 'Fork Skill',
            onConfirm: () => { copyToPersonal(skill); }
        });
    };

    const handleVote = (e: React.MouseEvent, skill: Skill, vote: 1 | -1) => {
        e.stopPropagation();
        voteSkill(skill, vote);
    };

    const handleRevert = (e: React.MouseEvent, skill: Skill) => {
        e.stopPropagation();
        setRevertDialog({ isOpen: true, skill, reason: '' });
    };

    const confirmRevert = () => {
        if (revertDialog.skill) {
            revertSkill(revertDialog.skill, revertDialog.reason || undefined);
        }
        setRevertDialog({ isOpen: false, skill: null, reason: '' });
    };

    const handleWithdraw = (e: React.MouseEvent, skill: Skill) => {
        e.stopPropagation();
        const isSkillSpace = skill.scope === 'skillset';
        const isContributionRequest = skill.contributionStatus === 'pending' && skill.reviewStatus !== 'pending';
        setDialogState({
            isOpen: true,
            title: isContributionRequest
                ? 'Withdraw Contribution Request'
                : isSkillSpace
                    ? 'Withdraw Merge Request'
                    : 'Withdraw Publish Request',
            description: isContributionRequest
                ? `Withdraw the contribution request for "${skill.name}"? The latest merged/published version will stay unchanged.`
                : isSkillSpace
                    ? `Withdraw the merge request for "${skill.name}"? The working copy will stay in Skill Space.`
                    : `Withdraw the publish request for "${skill.name}"? The skill will revert to its previous state.`,
            variant: 'warning',
            confirmText: 'Withdraw',
            onConfirm: () => { doWithdraw(skill); }
        });
    };

    const handleDelete = (e: React.MouseEvent, skill: Skill) => {
        e.stopPropagation();
        setDialogState({
            isOpen: true,
            title: 'Delete Skill',
            description: `Are you sure you want to permanently delete "${skill.name}"? This action cannot be undone.`,
            variant: 'danger',
            confirmText: 'Delete',
            onConfirm: () => { doDelete(skill); }
        });
    };

    const renderSkillCard = (skill: Skill) => {
        const footerScope = {
            label: skill.scope === 'builtin' ? 'Global'
                : skill.scope === 'global' ? 'Global'
                    : skill.scope === 'skillset' ? (skill.skillSpaceName || 'Skill Space')
                        : 'Personal',
            className: skill.scope === 'builtin' ? 'bg-gray-100 text-gray-700'
                : skill.scope === 'global' ? 'bg-blue-50 text-blue-700'
                    : skill.scope === 'skillset' ? 'bg-green-50 text-green-700'
                        : 'bg-purple-50 text-purple-700',
            icon: skill.scope === 'builtin' ? Lock : skill.scope === 'skillset' ? Users : undefined,
        };

        const actions: SkillCardAction[] = [
            {
                key: 'withdraw',
                tooltip: 'Withdraw',
                icon: RotateCcw,
                tone: 'orange',
                hidden: !(skill.scope === 'personal' || skill.scope === 'skillset') || (skill.reviewStatus !== 'pending' && skill.contributionStatus !== 'pending'),
                onClick: (e) => handleWithdraw(e, skill),
            },
            {
                key: 'publish',
                tooltip: 'Request Publish',
                icon: SendHorizontal,
                tone: 'blue',
                hidden: skill.scope !== 'personal' || skill.reviewStatus === 'pending',
                onClick: (e) => handlePublish(e, skill),
            },
            {
                key: 'contribute',
                tooltip: 'Contribute to Global',
                icon: Upload,
                tone: 'blue',
                hidden: !(
                    (skill.scope === 'personal' || skill.scope === 'skillset') &&
                    skill.reviewStatus === 'approved' &&
                    !skill.hasUnpublishedChanges &&
                    skill.contributionStatus === 'none'
                ),
                onClick: (e) => handleContribute(e, skill),
            },
            {
                key: 'copy',
                tooltip: 'Fork to Personal',
                icon: GitFork,
                tone: 'purple',
                hidden: skill.scope === 'personal',
                onClick: (e) => handleCopy(e, skill),
            },
            {
                key: 'submit-promotion',
                tooltip: 'Submit Merge',
                icon: Upload,
                tone: 'blue',
                hidden: skill.scope !== 'skillset' || skill.reviewStatus === 'pending' || (skill.reviewStatus === 'approved' && !skill.hasUnpublishedChanges),
                onClick: (e) => handlePublish(e, skill),
            },
            {
                key: 'revert',
                tooltip: 'Revert to Personal',
                icon: Undo2,
                tone: 'orange',
                hidden: !(isAdmin && skill.scope === 'global'),
                onClick: (e) => handleRevert(e, skill),
            },
            {
                key: 'history',
                tooltip: 'Version History',
                icon: GitCommitHorizontal,
                tone: 'indigo',
                hidden: !(skill.scope === 'personal' || (isAdmin && skill.scope === 'global')),
                onClick: (e) => { e.stopPropagation(); navigate(`/skills/${skill.id}?history=true`); },
            },
            {
                key: 'diff',
                tooltip: 'View Diff',
                icon: Eye,
                tone: 'cyan',
                hidden: !(skill.scope === 'personal' && (skill.forkedFromId || (skill.publishedVersion && skill.publishedVersion > 0))),
                onClick: (e) => { e.stopPropagation(); handleSkillDiff(skill); },
            },
            {
                key: 'open',
                tooltip: skill.scope === 'personal' || skill.scope === 'skillset' ? 'Configure Skill' : 'View Details',
                icon: skill.scope === 'personal' || skill.scope === 'skillset' ? Settings : Eye,
                tone: 'primary',
                onClick: () => navigate(`/skills/${skill.id}`),
            },
            {
                key: 'delete',
                tooltip: 'Delete Skill',
                icon: Trash2,
                tone: 'red',
                hidden: !(skill.scope === 'personal' || skill.scope === 'skillset' || (isAdmin && skill.scope === 'global')),
                onClick: (e) => handleDelete(e, skill),
            },
        ];

        const bottomContent = skill.scope === 'global' ? (
            <div className="mt-auto pt-3 border-t border-gray-50 flex items-center gap-3">
                <button
                    onClick={(e) => handleVote(e, skill, 1)}
                    className={cn(
                        "flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors",
                        skill.userVote === 1
                            ? "bg-green-100 text-green-700 border border-green-200"
                            : "text-gray-400 hover:text-green-600 hover:bg-green-50"
                    )}
                >
                    <ThumbsUp className="w-3.5 h-3.5" />
                    <span>{skill.upvotes || 0}</span>
                </button>
                <button
                    onClick={(e) => handleVote(e, skill, -1)}
                    className={cn(
                        "flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors",
                        skill.userVote === -1
                            ? "bg-red-100 text-red-700 border border-red-200"
                            : "text-gray-400 hover:text-red-600 hover:bg-red-50"
                    )}
                >
                    <ThumbsDown className="w-3.5 h-3.5" />
                    <span>{skill.downvotes || 0}</span>
                </button>
            </div>
        ) : undefined;

        return (
            <SkillCard
                key={skill.id}
                skill={skill}
                badges={getDefaultSkillBadges(skill)}
                footerScope={footerScope}
                actions={actions}
                showToggle
                onToggleEnabled={(e) => handleToggleEnabled(e, skill)}
                onToggleLabel={(label, e) => { e.stopPropagation(); toggleLabel(label); }}
                labelColors={DEFAULT_SKILL_LABEL_COLORS}
                bottomContent={bottomContent}
            />
        );
    };

    return (
        <div className="h-full bg-white flex flex-col relative">
            <ConfirmDialog
                isOpen={dialogState.isOpen}
                onClose={closeDialog}
                onConfirm={dialogState.onConfirm}
                title={dialogState.title}
                description={dialogState.description}
                variant={dialogState.variant}
                confirmText={dialogState.confirmText}
            />

            {/* Revert Dialog with reason textarea */}
            {revertDialog.isOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div
                        className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
                        onClick={() => setRevertDialog({ isOpen: false, skill: null, reason: '' })}
                    />
                    <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                        <div className="p-6">
                            <div className="flex items-start gap-4">
                                <div className="p-3 rounded-xl bg-orange-50 flex-shrink-0">
                                    <Undo2 className="w-6 h-6 text-orange-600" />
                                </div>
                                <div className="flex-1 pt-1">
                                    <h3 className="text-lg font-semibold text-gray-900 mb-2">Revert to Personal</h3>
                                    <p className="text-sm text-gray-500 mb-4">
                                        This will move "{revertDialog.skill?.name}" back to the author's personal library.
                                    </p>
                                    <textarea
                                        value={revertDialog.reason}
                                        onChange={(e) => setRevertDialog(prev => ({ ...prev, reason: e.target.value }))}
                                        placeholder="Reason for revert (optional)"
                                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-200 resize-none"
                                        rows={3}
                                    />
                                </div>
                            </div>
                            <div className="mt-6 flex items-center justify-end gap-3">
                                <button
                                    onClick={() => setRevertDialog({ isOpen: false, skill: null, reason: '' })}
                                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={confirmRevert}
                                    className="px-4 py-2 text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 rounded-lg shadow-sm transition-all"
                                >
                                    Revert
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <header className="h-16 flex items-center justify-between px-6 bg-white sticky top-0 z-10">

                {/* Tabs */}
                <div className="flex gap-2">
                    {[
                        { id: 'all', label: 'All Skills', icon: LayoutGrid },
                        { id: 'global', label: 'Global', icon: Shield },
                        { id: 'myskills', label: 'My Skills', icon: User },
                    ].map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => handleTabChange(tab.id)}
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all border",
                                activeTab === tab.id
                                    ? "bg-gray-900 text-white border-gray-900 shadow-sm"
                                    : "bg-white text-gray-500 border-transparent hover:bg-gray-50 hover:text-gray-700"
                            )}
                        >
                            {/* <tab.icon className="w-3.5 h-3.5" /> Icon is too busy for tabs, text is enough */}
                            {tab.label}
                        </button>
                    ))}
                    {isReviewer && (
                        <>
                            <div className="w-px h-6 bg-gray-200 self-center mx-1" />
                            <button
                                onClick={() => handleTabChange('approvals')}
                                className={cn(
                                    "flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all border",
                                    activeTab === 'approvals'
                                        ? "bg-orange-50 text-orange-700 border-orange-200 shadow-sm"
                                        : "bg-white text-gray-500 border-transparent hover:bg-orange-50 hover:text-orange-600"
                                )}
                            >
                                <ClipboardCheck className="w-3.5 h-3.5" />
                                Approvals
                                {skills.filter(s => s.contributionStatus === 'pending' || s.reviewStatus === 'pending').length > 0 && (
                                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-orange-500 text-[10px] text-white">
                                        {skills.filter(s => s.contributionStatus === 'pending' || s.reviewStatus === 'pending').length}
                                    </span>
                                )}
                            </button>
                        </>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    <div className="relative group">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-primary-500 transition-colors" />
                        <input
                            type="text"
                            placeholder="Search skills..."
                            value={searchInput}
                            onChange={handleSearchChange}
                            className="pl-9 pr-3 py-1.5 bg-gray-50 border-none rounded-md text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-200 w-48 transition-all"
                        />
                    </div>
                    {(activeTab === 'myskills') && (
                        <Tooltip content="Create Skill">
                            <button
                                onClick={handleCreateNew}
                                className="p-2 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-all"
                            >
                                <Plus className="w-5 h-5" />
                            </button>
                        </Tooltip>
                    )}
                </div>
            </header>

            {/* Label filter dropdown + selected chips */}
            {visibleLabelInfos.length > 0 && activeTab !== 'approvals' && (
                <div className="px-6 py-2 border-b border-gray-100 bg-gray-50/50 flex items-center gap-2 flex-wrap">
                    <div ref={labelDropdownRef} className="relative">
                        <button
                            onClick={() => setLabelDropdownOpen(v => !v)}
                            className={cn(
                                "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-all",
                                labelDropdownOpen
                                    ? "bg-gray-100 text-gray-700 border-gray-300"
                                    : "bg-white text-gray-500 border-gray-200 hover:border-gray-300 hover:text-gray-700"
                            )}
                        >
                            <Tag className="w-3 h-3" />
                            Labels
                            {selectedLabels.size > 0 && (
                                <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-gray-700 text-[10px] text-white px-1">
                                    {selectedLabels.size}
                                </span>
                            )}
                            <ChevronDown className={cn("w-3 h-3 transition-transform", labelDropdownOpen && "rotate-180")} />
                        </button>

                        {labelDropdownOpen && (
                            <div className="absolute left-0 top-full mt-1 w-64 bg-white rounded-lg shadow-lg border border-gray-200 z-30 py-1 max-h-80 overflow-y-auto">
                                {groupedLabels.map(({ group, labels }) => (
                                    <div key={group}>
                                        <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                                            {group}
                                        </div>
                                        {labels.map(({ label, count }) => (
                                            <button
                                                key={label}
                                                onClick={() => toggleLabel(label)}
                                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50 transition-colors"
                                            >
                                                <span className={cn(
                                                    "w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0",
                                                    selectedLabels.has(label)
                                                        ? "bg-gray-700 border-gray-700 text-white"
                                                        : "border-gray-300"
                                                )}>
                                                    {selectedLabels.has(label) && <Check className="w-2.5 h-2.5" />}
                                                </span>
                                                <span className={cn(
                                                    "px-1.5 py-0.5 rounded text-[10px] font-medium border",
                                                    DEFAULT_SKILL_LABEL_COLORS[label] || 'bg-gray-50 text-gray-600 border-gray-200'
                                                )}>
                                                    {label}
                                                </span>
                                                <span className="ml-auto text-gray-400 text-[10px]">{count}</span>
                                            </button>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Selected label chips */}
                    {[...selectedLabels].map(label => (
                        <span
                            key={label}
                            className={cn(
                                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border",
                                DEFAULT_SKILL_LABEL_COLORS[label] || 'bg-gray-100 text-gray-700 border-gray-300'
                            )}
                        >
                            {label}
                            <button
                                onClick={() => toggleLabel(label)}
                                className="hover:opacity-70"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}
                    {selectedLabels.size > 0 && (
                        <button
                            onClick={() => setSelectedLabels(new Set())}
                            className="px-2 py-0.5 rounded-full text-xs text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
                        >
                            Clear all
                        </button>
                    )}
                </div>
            )}

            {/* Content */}
            <div ref={contentRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-8">
                {isLoading ? (
                    <div className="flex items-center justify-center h-full">
                        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                    </div>
                ) : activeTab === 'approvals' ? (
                    <div className="max-w-4xl mx-auto space-y-4">
                        {displaySkills.map((skill) => {
                            const isContributionReview = skill.contributionStatus === 'pending';
                            const isScriptReview = skill.reviewStatus === 'pending' && !isContributionReview;
                            return (
                                <ScriptReviewApprovalCard
                                    key={skill.id}
                                    skill={skill}
                                    isScriptReview={isScriptReview}
                                    isContributionReview={isContributionReview}
                                    isAdmin={isReviewer}
                                    sendRpc={sendRpc}
                                    onApproveContribution={async () => { await doApprove(skill); }}
                                    onRejectContribution={async (reason) => { await doReject(skill, reason); }}
                                    onReviewDecision={async (decision, reason, stagingVersion) => {
                                        await reviewSkill(skill, decision, reason, stagingVersion);
                                    }}
                                    onNavigate={() => navigate(`/skills/${skill.id}`)}
                                />
                            );
                        })}
                        {displaySkills.length === 0 && (
                            <div className="flex flex-col items-center justify-center py-20 text-gray-400 text-sm">
                                <ClipboardCheck className="w-8 h-8 mb-3 opacity-20" />
                                No pending approvals
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="max-w-6xl mx-auto">
                        {displaySkills.filter(s => activeTab === 'myskills' ? s.scope === 'personal' : true).length === 0 && !isLoading && activeTab !== 'myskills' ? (
                            <div className="flex flex-col items-center justify-center py-20 text-gray-400 text-sm">
                                <Users className="w-8 h-8 mb-3 opacity-20" />
                                No skills found.
                            </div>
                        ) : (
                        <>
                        {activeTab === 'myskills' && (
                            <div className="flex gap-1 mb-4">
                                {([{ id: 'personal' as const, label: 'Personal' }, ...(skillSpaceEnabled ? [{ id: 'shared' as const, label: 'Shared' }] : [])]).map(v => (
                                    <button key={v.id} onClick={() => setMyView(v.id)}
                                        className={cn("px-3 py-1 text-xs font-medium rounded-lg transition-colors",
                                            myView === v.id ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100")}>
                                        {v.label}{v.id === 'shared' && skillSpaceGroups.length > 0 ? ` (${skillSpaceGroups.length})` : ''}
                                    </button>
                                ))}
                            </div>
                        )}
                        {/* Shared view — skill space cards in grid */}
                        {activeTab === 'myskills' && myView === 'shared' && skillSpaceEnabled ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                                {skillSpaceGroups.map(({ skillSpace, skills: spaceSkills }) => (
                                    <div key={skillSpace.id} onClick={() => navigate(`/skills/spaces/${skillSpace.id}`)}
                                        className="group rounded-xl border p-6 hover:shadow-md transition-all duration-200 flex flex-col cursor-pointer bg-white border-gray-200 hover:border-gray-300">
                                        {(() => {
                                            const pendingCount = spaceSkills.filter(skill => skill.reviewStatus === 'pending').length;
                                            const shadowCount = spaceSkills.filter(skill => skill.globalSkillId).length;
                                            return (
                                                <>
                                        <div className="flex items-start justify-between mb-3">
                                            <div className="p-2 rounded-lg bg-green-50">
                                                <Users className="w-5 h-5 text-green-600" />
                                            </div>
                                        </div>
                                        <h3 className="font-semibold text-sm text-gray-900 mb-1 truncate">{skillSpace.name}</h3>
                                        <p className="text-xs text-gray-500 line-clamp-2 flex-1 mb-3">{skillSpace.description || 'No description'}</p>
                                        <div className="flex items-center gap-2 mt-auto">
                                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-50 text-green-600 border border-green-200">
                                                {spaceSkills.length} skills
                                            </span>
                                            {pendingCount > 0 && (
                                                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                                                    {pendingCount} pending
                                                </span>
                                            )}
                                            {shadowCount > 0 && (
                                                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                                                    {shadowCount} shadowing
                                                </span>
                                            )}
                                            <span className="text-[10px] text-gray-400">{skillSpace.memberRole || 'maintainer'}</span>
                                        </div>
                                                </>
                                            );
                                        })()}
                                    </div>
                                ))}
                                <button onClick={() => setSkillSpaceDialog({ isOpen: true, mode: 'create', newName: '', newDescription: '' })}
                                    className="group rounded-xl border-2 border-dashed border-gray-200 p-6 flex flex-col items-center justify-center text-gray-400 hover:border-green-300 hover:text-green-600 hover:bg-green-50/50 transition-all gap-3 min-h-[200px]">
                                    <div className="p-3 rounded-full bg-gray-50 group-hover:bg-white">
                                        <Plus className="w-6 h-6" />
                                    </div>
                                    <span className="font-semibold text-sm">Create Skill Space</span>
                                </button>
                            </div>
                        ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {(activeTab === 'myskills' ? displaySkills.filter(s => s.scope === 'personal') : displaySkills).map((skill) => (
                            renderSkillCard(skill)
                        ))}

                        {/* Add New Placeholder — only for personal view */}
                        {(activeTab !== 'myskills' || myView === 'personal') && (
                            <button
                                onClick={handleCreateNew}
                                className="border-2 border-dashed border-gray-200 rounded-xl p-6 flex flex-col items-center justify-center text-gray-400 hover:border-primary-300 hover:text-primary-600 hover:bg-primary-50/50 transition-all gap-3 min-h-[200px]"
                            >
                                <div className="p-3 rounded-full bg-gray-50 group-hover:bg-white">
                                    <Plus className="w-6 h-6" />
                                </div>
                                <span className="font-semibold text-sm">Create Custom Skill</span>
                            </button>
                        )}
                        </div>
                        )}
                        </>
                        )}
                    </div>
                )}

                {isLoadingMore && (
                    <div className="flex items-center justify-center py-6">
                        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                    </div>
                )}
            </div>

            {/* Skill Space Dialog */}
            {skillSpaceDialog.isOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setSkillSpaceDialog({ isOpen: false, mode: 'create' })}>
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
                        <h3 className="text-lg font-semibold mb-4">Create Skill Space</h3>
                        <div className="space-y-3">
                            <input
                                type="text"
                                placeholder="Skill space name"
                                value={skillSpaceDialog.newName || ''}
                                onChange={e => setSkillSpaceDialog(p => ({ ...p, newName: e.target.value }))}
                                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-300"
                                autoFocus
                            />
                            <textarea
                                placeholder="Description (optional)"
                                value={skillSpaceDialog.newDescription || ''}
                                onChange={e => setSkillSpaceDialog(p => ({ ...p, newDescription: e.target.value }))}
                                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-300 h-20 resize-none"
                            />
                        </div>
                        <div className="flex justify-end gap-2 mt-4">
                            <button
                                onClick={() => setSkillSpaceDialog({ isOpen: false, mode: 'create' })}
                                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border rounded-lg hover:bg-gray-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCreateSkillSpace}
                                disabled={!skillSpaceDialog.newName?.trim()}
                                className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg disabled:opacity-50"
                            >
                                Create
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <DiffViewerModal
                isOpen={personalDiffModal.isOpen}
                onClose={() => setPersonalDiffModal(prev => ({ ...prev, isOpen: false }))}
                title={personalDiffModal.title}
                subtitle={personalDiffModal.subtitle}
                diffText={personalDiffModal.diffText}
                metadataChanges={personalDiffModal.metadataChanges}
                isLoading={personalDiffModal.isLoading}
            />
        </div>
    );
}

// ─── Risk Level Colors ───────────────────────────────

const RISK_COLORS: Record<string, string> = {
    low: 'bg-green-50 text-green-700 border-green-200',
    medium: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    high: 'bg-orange-50 text-orange-700 border-orange-200',
    critical: 'bg-red-50 text-red-700 border-red-200',
};

const SEVERITY_ICONS: Record<string, typeof AlertTriangle> = {
    critical: AlertTriangle,
    high: AlertTriangle,
    medium: AlertTriangle,
    low: Info,
};

// ─── Script Review Approval Card ─────────────────────

function ScriptReviewApprovalCard({
    skill, isScriptReview, isContributionReview, isAdmin, sendRpc,
    onApproveContribution, onRejectContribution, onReviewDecision, onNavigate,
}: {
    skill: Skill;
    isScriptReview: boolean;
    isContributionReview: boolean;
    isAdmin: boolean;
    sendRpc: any;
    onApproveContribution: () => Promise<void>;
    onRejectContribution: (reason?: string) => Promise<void>;
    onReviewDecision: (decision: 'approve' | 'reject', reason?: string, stagingVersion?: number) => Promise<void>;
    onNavigate: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const [reviews, setReviews] = useState<SkillReview[]>([]);
    const [fullSkill, setFullSkill] = useState<Skill | null>(null);
    const [loading, setLoading] = useState(false);
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [expandedScripts, setExpandedScripts] = useState<Set<string>>(new Set());
    const [diffText, setDiffText] = useState<string | null>(null);
    const [metadataChanges, setMetadataChanges] = useState<SkillDiffMetadataChange[]>([]);
    const [diffLoading, setDiffLoading] = useState(false);
    const [diffModalOpen, setDiffModalOpen] = useState(false);
    const [confirmDialog, setConfirmDialog] = useState<{
        isOpen: boolean;
        title: string;
        description: string;
        variant: 'primary' | 'danger' | 'warning';
        confirmText: string;
        onConfirm: () => void;
    }>({ isOpen: false, title: '', description: '', variant: 'primary', confirmText: '', onConfirm: () => {} });
    const [errorDialog, setErrorDialog] = useState<{ isOpen: boolean; message: string }>({ isOpen: false, message: '' });
    const [deleted, setDeleted] = useState(false);

    const handleExpand = async () => {
        if (expanded) {
            setExpanded(false);
            return;
        }
        setExpanded(true);

        setLoading(true);
        try {
            const fetches: Promise<any>[] = [
                rpcGetSkillById(sendRpc, String(skill.id)),
                rpcGetSkillReview(sendRpc, String(skill.id)),
            ];

            const results = await Promise.all(fetches);
            setFullSkill(results[0]);
            if (results[1]) {
                setReviews(results[1].reviews);
            }
        } catch (err: any) {
            const msg = err?.message || String(err);
            if (msg.includes('Skill not found')) {
                setDeleted(true);
                setExpanded(false);
            } else {
                console.error('[Approvals] Failed to load review data:', err);
            }
        } finally {
            setLoading(false);
        }
    };

    const handleLoadDiff = async () => {
        if (diffText !== null) {
            setDiffModalOpen(true);
            return;
        }
        setDiffLoading(true);
        setDiffModalOpen(true);
        try {
            const diffResult = await rpcGetSkillDiff(
                sendRpc,
                String(skill.id),
                isContributionReview,
                undefined,
                isContributionReview ? 'global' : undefined,
            );
            setDiffText(diffResult.diff || 'No changes detected.');
            setMetadataChanges(diffResult.metadataChanges ?? []);
        } catch (err) {
            console.error('[Approvals] Failed to load diff:', err);
            setDiffText('Failed to load diff.');
            setMetadataChanges([]);
        } finally {
            setDiffLoading(false);
        }
    };

    const executeDecision = async (decision: 'approve' | 'reject') => {
        setSubmitting(true);
        try {
            if (isScriptReview) {
                await onReviewDecision(decision, reason || undefined, fullSkill?.stagingVersion);
            } else if (isContributionReview) {
                if (decision === 'approve') {
                    await onApproveContribution();
                } else {
                    await onRejectContribution(reason || undefined);
                }
            }
        } catch (err: any) {
            const msg = err?.message || String(err);
            if (msg.includes('STAGING_VERSION_CONFLICT')) {
                setErrorDialog({ isOpen: true, message: 'Content has changed since you reviewed it. Please reload and review again.' });
            } else {
                setErrorDialog({ isOpen: true, message: msg });
            }
        } finally {
            setSubmitting(false);
        }
    };

    const handleDecision = (decision: 'approve' | 'reject') => {
        if (decision === 'approve') {
            setConfirmDialog({
                isOpen: true,
                title: 'Approve Skill',
                description: isContributionReview
                    ? `Approve "${skill.name}" and contribute the accepted snapshot to Global?`
                    : skill.scope === 'skillset'
                        ? `Approve "${skill.name}" and merge it as the latest accepted Skill Space version?`
                        : `Are you sure you want to approve "${skill.name}"? It will become active in production.`,
                variant: 'primary',
                confirmText: isContributionReview
                    ? 'Approve & Contribute to Global'
                    : skill.scope === 'skillset'
                        ? 'Approve Merge'
                        : 'Approve',
                onConfirm: () => executeDecision('approve'),
            });
        } else {
            setConfirmDialog({
                isOpen: true,
                title: 'Reject Skill',
                description: `Are you sure you want to reject "${skill.name}"?${reason ? '' : ' You can add a reason above before confirming.'}`,
                variant: 'danger',
                confirmText: 'Reject',
                onConfirm: () => executeDecision('reject'),
            });
        }
    };

    const toggleScript = (name: string) => {
        setExpandedScripts(prev => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    };

    const aiReview = reviews.find(r => r.reviewerType === 'ai');

    // Poll for AI review while it's in progress (expanded + no AI review yet)
    useEffect(() => {
        if (!expanded || aiReview || !skill.id) return;
        const interval = setInterval(async () => {
            try {
                const result = await rpcGetSkillReview(sendRpc, String(skill.id));
                if (result?.reviews) {
                    const ai = result.reviews.find((r: any) => r.reviewerType === 'ai');
                    if (ai) {
                        setReviews(result.reviews);
                        clearInterval(interval);
                    }
                }
            } catch { /* ignore */ }
        }, 3000);
        return () => clearInterval(interval);
    }, [expanded, aiReview, skill.id, sendRpc]);

    // Scope display config
    const scopeConfigMap: Record<string, { label: string; cls: string; icon: typeof Lock }> = {
        builtin: { label: 'Global', cls: 'bg-gray-100 text-gray-700', icon: Lock },
        global: { label: 'Global', cls: 'bg-blue-50 text-blue-700 border-blue-100', icon: Users },
        personal: { label: 'Personal', cls: 'bg-purple-50 text-purple-700 border-purple-100', icon: User },
        skillset: { label: 'Skill Space', cls: 'bg-green-50 text-green-700 border-green-100', icon: Users },
    };
    const scopeConfig = scopeConfigMap[skill.scope] || { label: skill.scope, cls: 'bg-gray-100 text-gray-600', icon: User };

    if (deleted) {
        return (
            <div className="bg-gray-50 rounded-xl border border-gray-200 opacity-60 p-4 flex items-center gap-3 text-gray-400 text-sm">
                <Trash2 className="w-4 h-4" />
                <span><strong>{skill.name}</strong> — This skill has been deleted or withdrawn.</span>
            </div>
        );
    }

    return (
        <div className="bg-white rounded-xl border border-gray-200 hover:shadow-sm transition-shadow">
            <ConfirmDialog
                isOpen={confirmDialog.isOpen}
                onClose={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))}
                onConfirm={confirmDialog.onConfirm}
                title={confirmDialog.title}
                description={confirmDialog.description}
                variant={confirmDialog.variant}
                confirmText={confirmDialog.confirmText}
            />
            <ConfirmDialog
                isOpen={errorDialog.isOpen}
                onClose={() => setErrorDialog({ isOpen: false, message: '' })}
                onConfirm={() => {}}
                title="Operation Failed"
                description={errorDialog.message}
                variant="danger"
                confirmText="OK"
            />
            <DiffViewerModal
                isOpen={diffModalOpen}
                onClose={() => setDiffModalOpen(false)}
                title={`${skill.name} Diff`}
                subtitle={skill.scope === 'skillset'
                    ? (isContributionReview ? 'Latest global -> Contribution staging' : 'Merged snapshot -> Merge staging')
                    : (isContributionReview ? 'Latest global -> Contribution staging' : 'Published -> Staging')}
                diffText={diffText}
                metadataChanges={metadataChanges}
                isLoading={diffLoading}
            />
            {/* Header row */}
            <div
                className="p-4 flex items-center justify-between cursor-pointer"
                onClick={handleExpand}
            >
                <div className="flex items-center gap-4">
                    <div className={cn(
                        "w-10 h-10 rounded-lg border flex items-center justify-center",
                        isScriptReview
                            ? "bg-amber-50 border-amber-100 text-amber-600"
                            : isContributionReview
                                ? "bg-blue-50 border-blue-100 text-blue-600"
                                : "bg-orange-50 border-orange-100 text-orange-600"
                    )}>
                        {isScriptReview
                            ? <ShieldAlert className="w-5 h-5" />
                            : isContributionReview
                                ? <Users className="w-5 h-5" />
                                : <skill.icon className="w-5 h-5" />}
                    </div>
                    <div>
                        <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-bold text-gray-900">{skill.name}</h3>
                            {/* Scope badge */}
                            <span className={cn(
                                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border",
                                scopeConfig.cls
                            )}>
                                <scopeConfig.icon className="w-2.5 h-2.5" />
                                {scopeConfig.label}
                            </span>
                            {/* Review type badge */}
                            {isScriptReview && (
                                <span className={cn(
                                    "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold border",
                                    "bg-amber-50 text-amber-700 border-amber-200"
                                )}>
                                    <FilePlus2 className="w-2.5 h-2.5" /> {skill.scope === 'skillset' ? 'Merge Request' : 'Publish Request'}
                                </span>
                            )}
                            {isContributionReview && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 text-[10px] font-bold border border-blue-200">
                                    <Users className="w-2.5 h-2.5" />
                                    Contribute to Global
                                </span>
                            )}
                            {/* Risk level (when AI review available) */}
                            {aiReview && (
                                <span className={cn(
                                    "px-1.5 py-0.5 rounded-full text-[10px] font-bold border uppercase",
                                    RISK_COLORS[aiReview.riskLevel] || RISK_COLORS.low
                                )}>
                                    {aiReview.riskLevel}
                                </span>
                            )}
                            {/* Author */}
                            <span className="px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 text-[10px] font-medium border border-purple-100">
                                {skill.author || 'Unknown'}
                            </span>
                        </div>
                        <p className="text-sm text-gray-500 mt-0.5">{skill.description}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <Tooltip content="View in Editor">
                        <button onClick={(e) => { e.stopPropagation(); onNavigate(); }} className="p-2 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors">
                            <Eye className="w-4 h-4" />
                        </button>
                    </Tooltip>
                    <button className="p-2 text-gray-400 hover:text-gray-700 transition-colors">
                        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                </div>
            </div>

            {/* Expanded panel */}
            {expanded && (
                <div className="border-t border-gray-100 p-6 space-y-4 bg-gray-50/30">
                    {loading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                        </div>
                    ) : (
                        <>
                            {/* AI Review Summary */}
                            {aiReview && (
                                <div className="bg-white rounded-lg border border-gray-200 p-4">
                                    <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">AI Review Summary</h4>
                                    <div className="flex items-center gap-2 mb-3">
                                        <span className="text-sm text-gray-600">Risk Level:</span>
                                        <span className={cn(
                                            "px-2 py-0.5 rounded-full text-xs font-bold border uppercase",
                                            RISK_COLORS[aiReview.riskLevel] || RISK_COLORS.low
                                        )}>
                                            {aiReview.riskLevel}
                                        </span>
                                    </div>
                                    <p className="text-sm text-gray-600 mb-3">{aiReview.summary}</p>
                                    {aiReview.findings && aiReview.findings.length > 0 && (
                                        <div className="space-y-2">
                                            <span className="text-xs font-medium text-gray-500">{aiReview.findings.length} finding(s):</span>
                                            {aiReview.findings.map((f, i) => {
                                                const Icon = SEVERITY_ICONS[f.severity] || Info;
                                                return (
                                                    <div key={i} className={cn(
                                                        "flex items-start gap-2 p-2 rounded-md text-sm border",
                                                        f.severity === 'critical' ? "bg-red-50/50 border-red-100" :
                                                        f.severity === 'high' ? "bg-orange-50/50 border-orange-100" :
                                                        f.severity === 'medium' ? "bg-yellow-50/50 border-yellow-100" :
                                                        "bg-gray-50 border-gray-100"
                                                    )}>
                                                        <Icon className={cn(
                                                            "w-4 h-4 mt-0.5 shrink-0",
                                                            f.severity === 'critical' ? "text-red-500" :
                                                            f.severity === 'high' ? "text-orange-500" :
                                                            f.severity === 'medium' ? "text-yellow-500" :
                                                            "text-gray-400"
                                                        )} />
                                                        <div className="flex-1 min-w-0">
                                                            <span className="text-gray-700">{f.description}</span>
                                                            {f.lineRef && <span className="text-gray-400 text-xs ml-2">({f.lineRef})</span>}
                                                            {f.snippet && (
                                                                <pre className="mt-1 text-xs bg-gray-100 rounded px-2 py-1 overflow-x-auto text-gray-600">{f.snippet}</pre>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            )}

                            {!aiReview && (
                                <div className="bg-white rounded-lg border border-gray-200 p-4 text-center text-sm text-gray-400">
                                    <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                                    AI review in progress...
                                </div>
                            )}

                            {/* Diff section */}
                            {(isScriptReview || isContributionReview) && (
                                <div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center justify-between gap-4">
                                    <div>
                                        <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">Changes</h4>
                                        <p className="text-sm text-gray-500">
                                            Review this diff in a dedicated viewer with file grouping and split/unified modes.
                                        </p>
                                    </div>
                                    <button
                                        onClick={handleLoadDiff}
                                        className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 transition-colors"
                                    >
                                        {diffLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitCommitHorizontal className="w-4 h-4" />}
                                        Open Diff Viewer
                                    </button>
                                </div>
                            )}

                            {/* Scripts */}
                            {(() => {
                                const displayScripts = fullSkill?.scripts;
                                return displayScripts && displayScripts.length > 0 ? (
                                <div className="bg-white rounded-lg border border-gray-200 p-4">
                                    <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
                                        Scripts
                                    </h4>
                                    <div className="space-y-2">
                                        {displayScripts.map((script) => (
                                            <div key={script.id} className="border border-gray-100 rounded-lg overflow-hidden">
                                                <button
                                                    onClick={() => toggleScript(script.name)}
                                                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50 transition-colors"
                                                >
                                                    <div className={cn(
                                                        "w-6 h-6 rounded flex items-center justify-center shrink-0",
                                                        script.info === 'python' ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'
                                                    )}>
                                                        {script.info === 'python' ? <FileCode className="w-3 h-3" /> : <Terminal className="w-3 h-3" />}
                                                    </div>
                                                    <span className="font-medium text-gray-700 flex-1">{script.name}</span>
                                                    {expandedScripts.has(script.name)
                                                        ? <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
                                                        : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
                                                </button>
                                                {expandedScripts.has(script.name) && (
                                                    <pre className="p-3 bg-[#1e1e1e] text-[#d4d4d4] text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto">
                                                        {script.content}
                                                    </pre>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                ) : null;
                            })()}

                            {/* SKILL.md preview */}
                            {fullSkill?.specs && (
                                <div className="bg-white rounded-lg border border-gray-200 p-4">
                                    <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">SKILL.md (Specs)</h4>
                                    <pre className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">{fullSkill.specs}</pre>
                                </div>
                            )}

                            {/* Admin actions (unified for both publish and contribution reviews) */}
                            {isAdmin && (isScriptReview || isContributionReview) && (
                                <div className="space-y-3 pt-2">
                                    <textarea
                                        value={reason}
                                        onChange={(e) => setReason(e.target.value)}
                                        placeholder="Reason for rejection (optional, visible to the author)"
                                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-200 resize-none"
                                        rows={2}
                                    />
                                    <div className="flex items-center justify-end gap-3">
                                        <button
                                            onClick={() => handleDecision('reject')}
                                            disabled={submitting}
                                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 hover:bg-red-100 rounded-lg transition-all disabled:opacity-50"
                                        >
                                            <X className="w-4 h-4" />
                                            Reject
                                        </button>
                                        <button
                                            onClick={() => handleDecision('approve')}
                                            disabled={submitting}
                                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-green-700 bg-green-50 border border-green-200 hover:bg-green-100 rounded-lg transition-all disabled:opacity-50"
                                        >
                                            <Check className="w-4 h-4" />
                                            {isContributionReview ? 'Approve & Contribute to Global' : (skill.scope === 'skillset' ? 'Approve Merge' : 'Approve')}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
