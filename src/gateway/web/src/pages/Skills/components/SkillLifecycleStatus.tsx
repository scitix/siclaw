/**
 * SkillLifecycleStatus — shows a horizontal pipeline of the skill's lifecycle stages.
 *
 * Skill Space:  Draft → Published (Dev) → Approved (Prod) → Global
 * My Skills:    Draft → Approved (Prod) → Global
 */

import { cn } from '@/lib/utils';
import type { Skill } from '../skillsData';

interface Stage {
    key: string;
    label: string;
    state: 'done' | 'active' | 'upcoming';
    detail?: string;
}

function resolveStages(skill: Skill): Stage[] {
    const isSkillset = skill.scope === 'skillset';
    const hasPublished = skill.publishedVersion != null && skill.publishedVersion > 0;
    const hasApproved = skill.approvedVersion != null && skill.approvedVersion > 0;
    const isPending = skill.reviewStatus === 'pending';
    const isContributionPending = skill.contributionStatus === 'pending';
    const isContributed = skill.contributionStatus === 'approved';
    const hasUnpublished = skill.hasUnpublishedChanges;

    const stages: Stage[] = [];

    // Stage 1: Draft — done if not actively editing, active if has unsaved changes
    stages.push({
        key: 'draft',
        label: 'Draft',
        state: hasUnpublished ? 'active' : 'done',
        detail: hasUnpublished ? 'Edited' : undefined,
    });

    // Stage 2 (skillset only): Dev — done if published
    if (isSkillset) {
        stages.push({
            key: 'published',
            label: 'Dev',
            state: hasPublished ? 'done' : 'upcoming',
            detail: hasPublished ? 'Published' : undefined,
        });
    }

    // Stage 3: Approved (Prod)
    stages.push({
        key: 'approved',
        label: 'Prod',
        state: hasApproved ? 'done' : (isPending ? 'active' : 'upcoming'),
        detail: isPending ? 'Reviewing' : (hasApproved ? 'Approved' : undefined),
    });

    // Stage 4: Global
    stages.push({
        key: 'global',
        label: 'Global',
        state: isContributed ? 'done' : (isContributionPending ? 'active' : 'upcoming'),
        detail: isContributionPending ? 'Reviewing' : (isContributed ? 'Contributed' : undefined),
    });

    return stages;
}

const STATE_DOT: Record<Stage['state'], string> = {
    done: 'bg-green-500',
    active: 'bg-blue-500 ring-2 ring-blue-200',
    upcoming: 'bg-gray-200',
};

const STATE_TEXT: Record<Stage['state'], string> = {
    done: 'text-green-700',
    active: 'text-blue-700',
    upcoming: 'text-gray-400',
};


export function SkillLifecycleStatus({ skill }: { skill: Skill }) {
    const stages = resolveStages(skill);

    // Don't render for builtin/global — they don't have a lifecycle
    if (skill.scope === 'builtin' || skill.scope === 'global') return null;

    return (
        <div className="w-full pt-2 pb-1">
            {/* Row 1: dots + lines (fixed height, always aligned) */}
            <div className="flex items-center">
                {stages.map((stage, i) => {
                    const isLast = i === stages.length - 1;
                    const lineColor = !isLast
                        ? (stage.state === 'done' && stages[i + 1].state !== 'upcoming' ? 'bg-green-500' : 'bg-gray-200')
                        : '';
                    return (
                        <div key={stage.key} className={cn("flex items-center", !isLast && "flex-1")}>
                            <div className={cn("w-2 h-2 rounded-full shrink-0 transition-all", STATE_DOT[stage.state])} />
                            {!isLast && <div className={cn("h-px flex-1 mx-1", lineColor)} />}
                        </div>
                    );
                })}
            </div>
            {/* Row 2: labels (same flex distribution, independent of dots) */}
            <div className="flex mt-1">
                {stages.map((stage, i) => {
                    const isLast = i === stages.length - 1;
                    return (
                        <div key={stage.key} className={cn("flex flex-col shrink-0", !isLast && "flex-1")}>
                            <span className={cn("text-[10px] font-semibold whitespace-nowrap leading-none", STATE_TEXT[stage.state])}>
                                {stage.label}
                            </span>
                            <span className={cn("text-[9px] whitespace-nowrap leading-none mt-0.5 min-h-[12px]", stage.state === 'upcoming' ? 'text-gray-300' : 'text-gray-400')}>
                                {stage.detail || '\u00A0'}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
