import { Cpu, Globe, Terminal, Database, Code2 } from 'lucide-react';

export type Script = {
    id: string;
    info: 'shell' | 'python';
    name: string;
    content: string;
};

export type ReviewFinding = {
    category: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    lineRef?: string;
    snippet?: string;
};

export type SkillReview = {
    id: string;
    skillId: string;
    version: number;
    reviewerType: 'ai' | 'admin';
    reviewerId?: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    summary: string;
    findings: ReviewFinding[];
    decision: 'approve' | 'reject' | 'info';
    createdAt: string;
};

export type Skill = {
    id: number | string;
    name: string;
    description: string;
    type: string;
    icon: any;
    status: string;
    version: string;
    specs?: string;
    scripts?: Script[];
    labels?: string[];
    scope: 'builtin' | 'team' | 'personal' | 'global' | 'skillset';
    author?: string;
    authorId?: string;
    contributionStatus?: 'none' | 'pending' | 'approved';
    reviewStatus?: 'draft' | 'approved' | 'pending';
    upvotes?: number;
    downvotes?: number;
    userVote?: 1 | -1 | null;
    enabled: boolean;
    latestReview?: SkillReview | null;
    publishedFiles?: { specs?: string; scripts?: Array<{ name: string; content: string }> } | null;
    publishedVersion?: number | null;
    teamSourceSkillId?: string | null;
    teamPinnedVersion?: number | null;
    stagingVersion?: number;
    skillSetId?: string | null;
    skillSetName?: string;
    isSetMember?: boolean;
    forkedFromId?: string | null;
};

// Icon mapping for skills loaded from backend
const ICON_MAP: Record<string, any> = {
    Core: Cpu,
    Network: Globe,
    Security: Terminal,
    Database: Database,
    Utility: Code2,
    Custom: Code2,
    Monitoring: Cpu,
    Automation: Terminal,
};

export const getIconForType = (type: string) => ICON_MAP[type] || Code2;

// ─── RPC-based functions (used via WebSocket) ───

export type RpcSendFn = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

export interface SkillListParams {
    limit?: number;
    offset?: number;
    scope?: string;
    search?: string;
    pendingOnly?: boolean;
}

export interface SkillListResult {
    skills: Skill[];
    hasMore: boolean;
}

export async function rpcGetSkills(
    sendRpc: RpcSendFn,
    params?: SkillListParams,
): Promise<SkillListResult> {
    const result = await sendRpc<{ skills: any[]; hasMore: boolean }>(
        'skill.list',
        params as Record<string, unknown>,
    );
    const skills = (result.skills ?? []).map(s => ({
        ...s,
        icon: getIconForType(s.type || 'Custom'),
        version: `v${s.version || 1}`,
        enabled: s.enabled ?? true,
    }));
    return { skills, hasMore: result.hasMore ?? false };
}

export async function rpcGetSkillById(sendRpc: RpcSendFn, id: string): Promise<Skill | null> {
    const result = await sendRpc<any>('skill.get', { id });
    if (!result) return null;
    return {
        ...result,
        icon: getIconForType(result.type || 'Custom'),
        version: `v${result.version || 1}`,
        enabled: result.enabled ?? true,
        specs: result.files?.specs,
        scripts: result.files?.scripts?.map((s: any, i: number) => ({
            id: `s-${i}`,
            info: s.name.endsWith('.py') ? 'python' : 'shell',
            name: s.name,
            content: s.content,
        })),
        publishedFiles: result.publishedFiles ?? null,
        stagingVersion: result.stagingVersion,
    };
}

export async function rpcSaveSkill(
    sendRpc: RpcSendFn,
    skill: Skill,
    isNew: boolean,
): Promise<void> {
    const scripts = skill.scripts?.map(s => ({ name: s.name, content: s.content }));
    if (isNew) {
        await sendRpc('skill.create', {
            name: skill.name,
            type: skill.type,
            specs: skill.specs,
            scripts,
            labels: skill.labels,
        });
    } else {
        await sendRpc('skill.update', {
            id: String(skill.id),
            name: skill.name,
            type: skill.type,
            specs: skill.specs,
            scripts,
        });
    }
}

export async function rpcDeleteSkill(sendRpc: RpcSendFn, id: string): Promise<void> {
    await sendRpc('skill.delete', { id });
}

export async function rpcVoteSkill(
    sendRpc: RpcSendFn,
    id: string,
    vote: 1 | -1,
): Promise<{ upvotes: number; downvotes: number; userVote: 1 | -1 | null }> {
    return sendRpc('skill.vote', { id, vote });
}

export async function rpcRevertSkill(
    sendRpc: RpcSendFn,
    id: string,
    reason?: string,
): Promise<{ status: string }> {
    return sendRpc('skill.revert', { id, reason });
}

export async function rpcReviewDecision(
    sendRpc: RpcSendFn,
    id: string,
    decision: 'approve' | 'reject',
    reason?: string,
    stagingVersion?: number,
): Promise<{ status: string }> {
    return sendRpc('skill.review', { id, decision, reason, stagingVersion });
}

export async function rpcRequestPublish(
    sendRpc: RpcSendFn,
    id: string,
    contributeToTeam?: boolean,
): Promise<{ status: string }> {
    return sendRpc('skill.submit', { id, contributeToTeam });
}

export async function rpcWithdrawSkill(
    sendRpc: RpcSendFn,
    id: string,
): Promise<{ status: string; wasNew: boolean }> {
    return sendRpc('skill.withdraw', { id });
}

export async function rpcGetSkillReview(
    sendRpc: RpcSendFn,
    id: string,
): Promise<{ reviews: SkillReview[] }> {
    return sendRpc('skill.getReview', { id });
}

export async function rpcGetSkillHistory(
    sendRpc: RpcSendFn,
    id: string,
): Promise<{ versions: Array<{ hash: string; version: number; message: string; author: string; date: string }> }> {
    return sendRpc('skill.history', { id });
}

export async function rpcGetSkillDiff(
    sendRpc: RpcSendFn,
    id: string,
    teamDiff?: boolean,
): Promise<{ diff: string }> {
    return sendRpc('skill.diff', { id, teamDiff });
}

export async function rpcRollbackSkill(
    sendRpc: RpcSendFn,
    id: string,
    version: number,
): Promise<{ version: number }> {
    return sendRpc('skill.rollback', { id, version });
}

// ─── Label RPC ───

export interface LabelInfo {
    label: string;
    count: number;
}

export async function rpcListLabels(sendRpc: RpcSendFn): Promise<LabelInfo[]> {
    const result = await sendRpc<{ labels: LabelInfo[] }>('label.list');
    return result.labels ?? [];
}

export async function rpcUpdateSkillLabels(sendRpc: RpcSendFn, id: string, labels: string[]): Promise<{ id: string; labels: string[] }> {
    return sendRpc('skill.updateLabels', { id, labels });
}

/** Fork a builtin/team skill to personal or skill set scope (server-side content copy) */
export async function rpcForkSkill(
    sendRpc: RpcSendFn,
    sourceId: string,
    overrides?: { name?: string; description?: string; type?: string; specs?: string; scripts?: Array<{ name: string; content?: string }>; targetSkillSetId?: string },
): Promise<{ id: string; dirName: string; name: string; forkedFromId: string; skillSetId?: string }> {
    return sendRpc('skill.fork', { sourceId, ...overrides });
}

/** @deprecated Use rpcForkSkill instead */
export async function rpcCopySkillToPersonal(sendRpc: RpcSendFn, id: string): Promise<{ id: string }> {
    return rpcForkSkill(sendRpc, String(id));
}

// ─── Skill Set RPC ───

export interface SkillSet {
    id: string;
    name: string;
    description?: string;
    ownerId: string;
    memberRole?: string;
    createdAt: string;
    updatedAt: string;
}

export interface SkillSetMember {
    id: string;
    skillSetId: string;
    userId: string;
    role: string;
    username?: string;
    joinedAt: string;
}

export async function rpcListSkillSets(sendRpc: RpcSendFn): Promise<SkillSet[]> {
    const result = await sendRpc<{ skillSets: SkillSet[] }>('skillSet.list');
    return result.skillSets ?? [];
}

export async function rpcCreateSkillSet(sendRpc: RpcSendFn, name: string, description?: string): Promise<{ id: string; name: string }> {
    return sendRpc('skillSet.create', { name, description });
}

export async function rpcGetSkillSet(sendRpc: RpcSendFn, id: string): Promise<SkillSet & { members: SkillSetMember[]; skills: Skill[] }> {
    return sendRpc('skillSet.get', { id });
}

export async function rpcUpdateSkillSet(sendRpc: RpcSendFn, id: string, updates: { name?: string; description?: string }): Promise<{ status: string }> {
    return sendRpc('skillSet.update', { id, ...updates });
}

export async function rpcDeleteSkillSet(sendRpc: RpcSendFn, id: string): Promise<{ status: string }> {
    return sendRpc('skillSet.delete', { id });
}

export async function rpcAddSkillSetMember(sendRpc: RpcSendFn, skillSetId: string, username: string): Promise<{ status: string; userId: string; username: string }> {
    return sendRpc('skillSet.addMember', { skillSetId, username });
}

export async function rpcRemoveSkillSetMember(sendRpc: RpcSendFn, skillSetId: string, userId: string): Promise<{ status: string }> {
    return sendRpc('skillSet.removeMember', { skillSetId, userId });
}

export async function rpcListSkillSetMembers(sendRpc: RpcSendFn, skillSetId: string): Promise<{ members: SkillSetMember[] }> {
    return sendRpc('skillSet.listMembers', { skillSetId });
}

/** Move a personal skill into a skill set */
export async function rpcMoveSkillToSet(sendRpc: RpcSendFn, skillId: string, targetSkillSetId: string): Promise<{ status: string }> {
    return sendRpc('skill.moveToSet', { skillId, targetSkillSetId });
}

/** Toggle share link for a skill set (owner only) */
export async function rpcToggleShareLink(sendRpc: RpcSendFn, skillSetId: string, enabled: boolean): Promise<{ token: string | null }> {
    return sendRpc('skillSet.toggleShareLink', { skillSetId, enabled });
}

/** Join a skill set via invite token */
export async function rpcJoinByToken(sendRpc: RpcSendFn, token: string): Promise<{ setId: string; joined?: boolean; alreadyMember?: boolean }> {
    return sendRpc('skillSet.joinByToken', { token });
}
