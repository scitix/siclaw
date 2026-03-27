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
    scope: 'builtin' | 'global' | 'personal' | 'skillset';
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
    globalSourceSkillId?: string | null;
    globalPinnedVersion?: number | null;
    stagingVersion?: number;
    skillSpaceId?: string | null;
    skillSpaceName?: string;
    isSpaceMember?: boolean;
    isSpaceMaintainer?: boolean;
    isSpaceOwner?: boolean;
    forkedFromId?: string | null;
    globalSkillId?: string | null;
    hasUnpublishedChanges?: boolean;
};

export type SkillSystemCapabilities = {
    isK8sMode: boolean;
    skillSpaceEnabled: boolean;
};

export type SkillDiffMetadataChange = {
    field: 'name' | 'description' | 'type' | 'labels';
    before: string | string[] | null;
    after: string | string[] | null;
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
    workspaceId?: string;
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

export async function rpcGetSkillById(sendRpc: RpcSendFn, id: string, workspaceId?: string): Promise<Skill | null> {
    const result = await sendRpc<any>('skill.get', { id, workspaceId });
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
        hasUnpublishedChanges: result.hasUnpublishedChanges ?? false,
    };
}

export async function rpcSaveSkill(
    sendRpc: RpcSendFn,
    skill: Skill,
    isNew: boolean,
    workspaceId?: string,
): Promise<void> {
    const scripts = skill.scripts?.map(s => ({ name: s.name, content: s.content }));
    if (isNew) {
        await sendRpc('skill.create', {
            name: skill.name,
            type: skill.type,
            specs: skill.specs,
            scripts,
            labels: skill.labels,
            workspaceId,
        });
    } else {
        await sendRpc('skill.update', {
            id: String(skill.id),
            name: skill.name,
            type: skill.type,
            specs: skill.specs,
            scripts,
            workspaceId,
        });
    }
}

export async function rpcDeleteSkill(sendRpc: RpcSendFn, id: string, workspaceId?: string): Promise<void> {
    await sendRpc('skill.delete', { id, workspaceId });
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
    workspaceId?: string,
): Promise<{ status: string }> {
    return sendRpc('skill.review', { id, decision, reason, stagingVersion, workspaceId });
}

export async function rpcRequestPublish(
    sendRpc: RpcSendFn,
    id: string,
    contributeToGlobal?: boolean,
    workspaceId?: string,
): Promise<{ status: string }> {
    return sendRpc('skill.submit', { id, contributeToGlobal, workspaceId });
}

export async function rpcWithdrawSkill(
    sendRpc: RpcSendFn,
    id: string,
    workspaceId?: string,
): Promise<{ status: string; wasNew: boolean }> {
    return sendRpc('skill.withdraw', { id, workspaceId });
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
    globalDiff?: boolean,
    workspaceId?: string,
    targetScope?: 'global',
): Promise<{ diff: string; baselineLabel?: string; compareLabel?: string; metadataChanges?: SkillDiffMetadataChange[] }> {
    return sendRpc('skill.diff', { id, globalDiff, workspaceId, targetScope });
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

/** Fork a builtin/global skill to personal or skill space scope (server-side content copy) */
export async function rpcForkSkill(
    sendRpc: RpcSendFn,
    sourceId: string,
    overrides?: { name?: string; description?: string; type?: string; specs?: string; scripts?: Array<{ name: string; content?: string }>; targetSkillSpaceId?: string; workspaceId?: string },
): Promise<{ id: string; dirName: string; name: string; forkedFromId: string; skillSpaceId?: string }> {
    return sendRpc('skill.fork', { sourceId, ...overrides });
}

/** @deprecated Use rpcForkSkill instead */
export async function rpcCopySkillToPersonal(sendRpc: RpcSendFn, id: string): Promise<{ id: string }> {
    return rpcForkSkill(sendRpc, String(id));
}

// ─── Skill Space RPC ───

export interface SkillSpace {
    id: string;
    name: string;
    description?: string;
    ownerId: string;
    memberRole?: string;
    createdAt: string;
    updatedAt: string;
}

export interface SkillSpaceMember {
    id: string;
    skillSpaceId: string;
    userId: string;
    role: string;
    username?: string;
    joinedAt: string;
}

export async function rpcListSkillSpaces(sendRpc: RpcSendFn, workspaceId: string): Promise<SkillSpace[]> {
    const result = await sendRpc<{ skillSpaces: SkillSpace[] }>('skillSpace.list', { workspaceId });
    return result.skillSpaces ?? [];
}

export async function rpcCreateSkillSpace(sendRpc: RpcSendFn, workspaceId: string, name: string, description?: string): Promise<{ id: string; name: string }> {
    return sendRpc('skillSpace.create', { workspaceId, name, description });
}

export async function rpcGetSkillSpace(sendRpc: RpcSendFn, workspaceId: string, id: string): Promise<SkillSpace & { members: SkillSpaceMember[]; skills: Skill[] }> {
    return sendRpc('skillSpace.get', { workspaceId, id });
}

export async function rpcUpdateSkillSpace(sendRpc: RpcSendFn, workspaceId: string, id: string, updates: { name?: string; description?: string }): Promise<{ status: string }> {
    return sendRpc('skillSpace.update', { workspaceId, id, ...updates });
}

export async function rpcDeleteSkillSpace(sendRpc: RpcSendFn, workspaceId: string, id: string): Promise<{ status: string }> {
    return sendRpc('skillSpace.delete', { workspaceId, id });
}

export async function rpcAddSkillSpaceMember(sendRpc: RpcSendFn, workspaceId: string, skillSpaceId: string, username: string): Promise<{ status: string; userId: string; username: string }> {
    return sendRpc('skillSpace.addMember', { workspaceId, skillSpaceId, username });
}

export async function rpcRemoveSkillSpaceMember(sendRpc: RpcSendFn, workspaceId: string, skillSpaceId: string, userId: string): Promise<{ status: string }> {
    return sendRpc('skillSpace.removeMember', { workspaceId, skillSpaceId, userId });
}

export async function rpcListSkillSpaceMembers(sendRpc: RpcSendFn, workspaceId: string, skillSpaceId: string): Promise<{ members: SkillSpaceMember[] }> {
    return sendRpc('skillSpace.listMembers', { workspaceId, skillSpaceId });
}

/** Move a personal skill into a skill space */
export async function rpcMoveSkillToSpace(sendRpc: RpcSendFn, skillId: string, targetSkillSpaceId: string, workspaceId?: string): Promise<{ status: string }> {
    return sendRpc('skill.moveToSpace', { skillId, targetSkillSpaceId, workspaceId });
}


export async function rpcGetSkillSystemCapabilities(sendRpc: RpcSendFn, workspaceId?: string): Promise<SkillSystemCapabilities> {
    return sendRpc('system.capabilities', workspaceId ? { workspaceId } : {});
}
