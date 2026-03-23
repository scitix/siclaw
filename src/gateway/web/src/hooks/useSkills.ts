import { useState, useCallback } from 'react';
import type { Skill } from '../pages/Skills/skillsData';
import { rpcGetSkills, rpcCopySkillToPersonal, rpcVoteSkill, rpcRevertSkill, rpcReviewDecision, rpcWithdrawSkill, rpcRequestPublish, rpcRollbackSkill } from '../pages/Skills/skillsData';
import type { RpcSendFn } from '../pages/Skills/skillsData';

const PAGE_SIZE = 30;

export interface UseSkillsResult {
    skills: Skill[];
    isLoading: boolean;
    isLoadingMore: boolean;
    hasMore: boolean;
    loadSkills: (scope?: string, search?: string) => Promise<void>;
    loadMore: () => Promise<void>;
    toggleEnabled: (skill: Skill) => Promise<void>;
    publishSkill: (skill: Skill, contributeToTeam?: boolean) => Promise<void>;
    requestPublish: (skill: Skill) => Promise<void>;
    approveSkill: (skill: Skill) => Promise<void>;
    rejectSkill: (skill: Skill, reason?: string) => Promise<void>;
    deleteSkill: (skill: Skill) => Promise<void>;
    copyToPersonal: (skill: Skill) => Promise<void>;
    voteSkill: (skill: Skill, vote: 1 | -1) => Promise<void>;
    revertSkill: (skill: Skill, reason?: string) => Promise<void>;
    reviewSkill: (skill: Skill, decision: 'approve' | 'reject', reason?: string, stagingVersion?: number) => Promise<void>;
    withdrawSkill: (skill: Skill) => Promise<void>;
    rollbackSkill: (skill: Skill, version: number) => Promise<void>;
}

export function useSkills(sendRpc: RpcSendFn): UseSkillsResult {
    const [skills, setSkills] = useState<Skill[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [currentScope, setCurrentScope] = useState<string>('all');
    const [searchQuery, setSearchQuery] = useState('');

    // Map UI tab name → RPC scope filter
    const mapTabToScope = (tab: string): string | undefined => {
        switch (tab) {
            case 'all': return undefined;
            case 'approvals': return undefined;
            case 'global': return undefined; // fetch all, filter client-side
            case 'myskills': return undefined; // fetch all, filter client-side
            default: return tab;
        }
    };

    // Client-side filter for virtual tabs
    const filterByTab = (skills: Skill[], tab: string): Skill[] => {
        switch (tab) {
            case 'global':
                return skills.filter(s => s.scope === 'builtin' || s.scope === 'team' || s.scope === 'global');
            case 'myskills':
                return skills.filter(s => s.scope === 'personal' || s.scope === 'skillset');
            default:
                return skills;
        }
    };

    // Load first page (resets list)
    const loadSkills = useCallback(async (scope?: string, search?: string) => {
        const s = scope ?? currentScope;
        const q = search ?? searchQuery;
        setCurrentScope(s);
        setSearchQuery(q);
        setIsLoading(true);
        try {
            const result = await rpcGetSkills(sendRpc, {
                limit: PAGE_SIZE,
                offset: 0,
                scope: mapTabToScope(s),
                search: q || undefined,
                pendingOnly: s === 'approvals' ? true : undefined,
            });
            setSkills(filterByTab(result.skills, s));
            setHasMore(result.hasMore);
        } catch (err) {
            console.error('[useSkills] Failed to load:', err);
        } finally {
            setIsLoading(false);
        }
    }, [sendRpc, currentScope, searchQuery]);

    // Load next page (append to list)
    const loadMore = useCallback(async () => {
        if (isLoadingMore || !hasMore) return;
        setIsLoadingMore(true);
        try {
            const result = await rpcGetSkills(sendRpc, {
                limit: PAGE_SIZE,
                offset: skills.length,
                scope: mapTabToScope(currentScope),
                search: searchQuery || undefined,
                pendingOnly: currentScope === 'approvals' ? true : undefined,
            });
            const newSkills = filterByTab(result.skills, currentScope);
            setSkills(prev => [...prev, ...newSkills]);
            setHasMore(result.hasMore);
        } catch (err) {
            console.error('[useSkills] Failed to load more:', err);
        } finally {
            setIsLoadingMore(false);
        }
    }, [sendRpc, skills.length, currentScope, searchQuery, isLoadingMore, hasMore]);

    const toggleEnabled = useCallback(async (skill: Skill) => {
        const newEnabled = !skill.enabled;
        try {
            await sendRpc('skill.setEnabled', { name: skill.name, enabled: newEnabled });
            setSkills(prev => prev.map(s =>
                s.name === skill.name ? { ...s, enabled: newEnabled } : s
            ));
        } catch (err) {
            console.error('[useSkills] toggleEnabled failed:', err);
        }
    }, [sendRpc]);

    const publishSkill = useCallback(async (skill: Skill, contributeToTeam?: boolean) => {
        await sendRpc('skill.submit', { id: String(skill.id), contributeToTeam });
        await loadSkills();
    }, [sendRpc, loadSkills]);

    const requestPublish = useCallback(async (skill: Skill) => {
        await rpcRequestPublish(sendRpc, String(skill.id));
        await loadSkills();
    }, [sendRpc, loadSkills]);

    const approveSkill = useCallback(async (skill: Skill) => {
        try {
            await sendRpc('skill.review', { id: String(skill.id), decision: 'approve' });
            await loadSkills();
        } catch (err) {
            console.error('[useSkills] approveSkill failed:', err);
        }
    }, [sendRpc, loadSkills]);

    const rejectSkill = useCallback(async (skill: Skill, reason?: string) => {
        try {
            await sendRpc('skill.review', { id: String(skill.id), decision: 'reject', reason });
            await loadSkills();
        } catch (err) {
            console.error('[useSkills] rejectSkill failed:', err);
        }
    }, [sendRpc, loadSkills]);

    const deleteSkill = useCallback(async (skill: Skill) => {
        try {
            await sendRpc('skill.delete', { id: String(skill.id) });
            // Remove from local state immediately (no need to refetch)
            setSkills(prev => prev.filter(s => s.id !== skill.id));
        } catch (err) {
            console.error('[useSkills] deleteSkill failed:', err);
        }
    }, [sendRpc]);

    const copyToPersonal = useCallback(async (skill: Skill) => {
        try {
            await rpcCopySkillToPersonal(sendRpc, String(skill.id));
            await loadSkills();
        } catch (err) {
            console.error('[useSkills] copyToPersonal failed:', err);
        }
    }, [sendRpc, loadSkills]);

    const voteSkill = useCallback(async (skill: Skill, vote: 1 | -1) => {
        try {
            const result = await rpcVoteSkill(sendRpc, String(skill.id), vote);
            // Locally update the skill in state to avoid full reload
            setSkills(prev => prev.map(s =>
                s.id === skill.id
                    ? { ...s, upvotes: result.upvotes, downvotes: result.downvotes, userVote: result.userVote }
                    : s
            ));
        } catch (err) {
            console.error('[useSkills] voteSkill failed:', err);
        }
    }, [sendRpc]);

    const revertSkill = useCallback(async (skill: Skill, reason?: string) => {
        try {
            await rpcRevertSkill(sendRpc, String(skill.id), reason);
            await loadSkills();
        } catch (err) {
            console.error('[useSkills] revertSkill failed:', err);
        }
    }, [sendRpc, loadSkills]);

    const reviewSkill = useCallback(async (skill: Skill, decision: 'approve' | 'reject', reason?: string, stagingVersion?: number) => {
        await rpcReviewDecision(sendRpc, String(skill.id), decision, reason, stagingVersion);
        await loadSkills();
    }, [sendRpc, loadSkills]);

    const rollbackSkill = useCallback(async (skill: Skill, version: number) => {
        try {
            await rpcRollbackSkill(sendRpc, String(skill.id), version);
            await loadSkills();
        } catch (err) {
            console.error('[useSkills] rollbackSkill failed:', err);
        }
    }, [sendRpc, loadSkills]);

    const withdrawSkill = useCallback(async (skill: Skill) => {
        try {
            const result = await rpcWithdrawSkill(sendRpc, String(skill.id));
            if (result.wasNew) {
                // New skill was deleted entirely — remove from local state
                setSkills(prev => prev.filter(s => s.id !== skill.id));
            } else {
                // Staged update withdrawn — reload to show restored status
                await loadSkills();
            }
        } catch (err) {
            console.error('[useSkills] withdrawSkill failed:', err);
        }
    }, [sendRpc, loadSkills]);

    return {
        skills,
        isLoading,
        isLoadingMore,
        hasMore,
        loadSkills,
        loadMore,
        toggleEnabled,
        publishSkill,
        requestPublish,
        approveSkill,
        rejectSkill,
        deleteSkill,
        copyToPersonal,
        voteSkill,
        revertSkill,
        reviewSkill,
        withdrawSkill,
        rollbackSkill,
    };
}
