import { useState, useCallback } from 'react';
import type { Skill } from '../pages/Skills/skillsData';
import { rpcGetSkills, rpcCopySkillToPersonal, rpcVoteSkill, rpcRevertSkill, rpcReviewDecision, rpcWithdrawSubmit, rpcWithdrawContribute, rpcRequestPublish, rpcContribute, rpcRollbackSkill } from '../pages/Skills/skillsData';
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
    requestPublish: (skill: Skill, message?: string) => Promise<void>;
    contributeSkill: (skill: Skill, message?: string) => Promise<void>;
    approveSkill: (skill: Skill) => Promise<void>;
    rejectSkill: (skill: Skill, reason?: string) => Promise<void>;
    deleteSkill: (skill: Skill) => Promise<void>;
    copyToPersonal: (skill: Skill) => Promise<void>;
    voteSkill: (skill: Skill, vote: 1 | -1) => Promise<void>;
    revertSkill: (skill: Skill, reason?: string) => Promise<void>;
    reviewSkill: (skill: Skill, decision: 'approve' | 'reject', reason?: string, stagingVersion?: number) => Promise<void>;
    withdrawSubmit: (skill: Skill) => Promise<void>;
    withdrawContribute: (skill: Skill) => Promise<void>;
    rollbackSkill: (skill: Skill, version: number) => Promise<void>;
}

export function useSkills(sendRpc: RpcSendFn, workspaceId?: string): UseSkillsResult {
    const [skills, setSkills] = useState<Skill[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [currentScope, setCurrentScope] = useState<string>('all');
    const [searchQuery, setSearchQuery] = useState('');

    // Map UI tab name → RPC scope filter (server-side filtering for correct pagination)
    const mapTabToScope = (tab: string): string | undefined => {
        switch (tab) {
            case 'all': return undefined;
            case 'approvals': return undefined;
            case 'global': return 'global';
            case 'myskills': return 'myskills';
            default: return tab;
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
                workspaceId,
            });
            setSkills(result.skills);
            setHasMore(result.hasMore);
        } catch (err) {
            console.error('[useSkills] Failed to load:', err);
        } finally {
            setIsLoading(false);
        }
    }, [sendRpc, currentScope, searchQuery, workspaceId]);

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
                workspaceId,
            });
            setSkills(prev => [...prev, ...result.skills]);
            setHasMore(result.hasMore);
        } catch (err) {
            console.error('[useSkills] Failed to load more:', err);
        } finally {
            setIsLoadingMore(false);
        }
    }, [sendRpc, skills.length, currentScope, searchQuery, isLoadingMore, hasMore, workspaceId]);

    const toggleEnabled = useCallback(async (skill: Skill) => {
        const newEnabled = !skill.enabled;
        try {
            await sendRpc('skill.setEnabled', { id: String(skill.id), enabled: newEnabled });
            setSkills(prev => prev.map(s =>
                s.id === skill.id ? { ...s, enabled: newEnabled } : s
            ));
        } catch (err) {
            console.error('[useSkills] toggleEnabled failed:', err);
        }
    }, [sendRpc]);

    const requestPublish = useCallback(async (skill: Skill, message?: string) => {
        await rpcRequestPublish(sendRpc, String(skill.id), workspaceId, message);
        await loadSkills();
    }, [sendRpc, loadSkills, workspaceId]);

    const contributeSkill = useCallback(async (skill: Skill, message?: string) => {
        await rpcContribute(sendRpc, String(skill.id), workspaceId, message);
        await loadSkills();
    }, [sendRpc, loadSkills, workspaceId]);

    const approveSkill = useCallback(async (skill: Skill) => {
        try {
            await sendRpc('skill.review', { id: String(skill.id), decision: 'approve', workspaceId });
            await loadSkills();
        } catch (err) {
            console.error('[useSkills] approveSkill failed:', err);
        }
    }, [sendRpc, loadSkills, workspaceId]);

    const rejectSkill = useCallback(async (skill: Skill, reason?: string) => {
        try {
            await sendRpc('skill.review', { id: String(skill.id), decision: 'reject', reason, workspaceId });
            await loadSkills();
        } catch (err) {
            console.error('[useSkills] rejectSkill failed:', err);
        }
    }, [sendRpc, loadSkills, workspaceId]);

    const deleteSkill = useCallback(async (skill: Skill) => {
        try {
            await sendRpc('skill.delete', { id: String(skill.id), workspaceId });
            // Remove from local state immediately (no need to refetch)
            setSkills(prev => prev.filter(s => s.id !== skill.id));
        } catch (err) {
            console.error('[useSkills] deleteSkill failed:', err);
        }
    }, [sendRpc, workspaceId]);

    const copyToPersonal = useCallback(async (skill: Skill) => {
        await rpcCopySkillToPersonal(sendRpc, String(skill.id));
        await loadSkills();
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
        await rpcReviewDecision(sendRpc, String(skill.id), decision, reason, stagingVersion, workspaceId);
        await loadSkills();
    }, [sendRpc, loadSkills, workspaceId]);

    const rollbackSkill = useCallback(async (skill: Skill, version: number) => {
        try {
            await rpcRollbackSkill(sendRpc, String(skill.id), version);
            await loadSkills();
        } catch (err) {
            console.error('[useSkills] rollbackSkill failed:', err);
        }
    }, [sendRpc, loadSkills]);

    const withdrawSubmit = useCallback(async (skill: Skill) => {
        await rpcWithdrawSubmit(sendRpc, String(skill.id), workspaceId);
        await loadSkills();
    }, [sendRpc, loadSkills, workspaceId]);

    const withdrawContribute = useCallback(async (skill: Skill) => {
        await rpcWithdrawContribute(sendRpc, String(skill.id), workspaceId);
        await loadSkills();
    }, [sendRpc, loadSkills, workspaceId]);

    return {
        skills,
        isLoading,
        isLoadingMore,
        hasMore,
        loadSkills,
        loadMore,
        toggleEnabled,
        requestPublish,
        contributeSkill,
        approveSkill,
        rejectSkill,
        deleteSkill,
        copyToPersonal,
        voteSkill,
        revertSkill,
        reviewSkill,
        withdrawSubmit,
        withdrawContribute,
        rollbackSkill,
    };
}
