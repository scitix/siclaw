import type { MouseEvent, ReactNode } from 'react';
import { Check, Code2, FileCode, Lock, ShieldAlert, Users, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip } from '../../../components/Tooltip';
import type { Skill } from '../skillsData';

export type SkillCardBadge = {
    label: string;
    className: string;
    icon?: LucideIcon;
};

export type SkillCardActionTone = 'default' | 'blue' | 'purple' | 'orange' | 'red' | 'cyan' | 'indigo' | 'primary';

export type SkillCardAction = {
    key: string;
    tooltip: string;
    icon: LucideIcon;
    onClick: (e: MouseEvent<HTMLButtonElement>) => void;
    hidden?: boolean;
    disabled?: boolean;
    tone?: SkillCardActionTone;
};

export const DEFAULT_SKILL_LABEL_COLORS: Record<string, string> = {
    kubernetes: 'bg-blue-50 text-blue-700 border-blue-200',
    'bare-metal': 'bg-blue-50 text-blue-700 border-blue-200',
    switch: 'bg-blue-50 text-blue-700 border-blue-200',
    network: 'bg-purple-50 text-purple-700 border-purple-200',
    rdma: 'bg-purple-50 text-purple-700 border-purple-200',
    scheduling: 'bg-purple-50 text-purple-700 border-purple-200',
    storage: 'bg-purple-50 text-purple-700 border-purple-200',
    compute: 'bg-purple-50 text-purple-700 border-purple-200',
    general: 'bg-purple-50 text-purple-700 border-purple-200',
    diagnostic: 'bg-green-50 text-green-700 border-green-200',
    monitoring: 'bg-green-50 text-green-700 border-green-200',
    performance: 'bg-green-50 text-green-700 border-green-200',
    configuration: 'bg-green-50 text-green-700 border-green-200',
    sre: 'bg-orange-50 text-orange-700 border-orange-200',
    developer: 'bg-orange-50 text-orange-700 border-orange-200',
};

type ScopePill = {
    label: string;
    className: string;
    icon?: LucideIcon;
};

type SelectionMode = {
    selected: boolean;
    onToggle: () => void;
};

function getActionClasses(tone: SkillCardActionTone = 'default'): string {
    switch (tone) {
        case 'blue':
            return 'text-gray-400 hover:text-blue-600 hover:bg-blue-50';
        case 'purple':
            return 'text-gray-400 hover:text-purple-600 hover:bg-purple-50';
        case 'orange':
            return 'text-gray-400 hover:text-orange-600 hover:bg-orange-50';
        case 'red':
            return 'text-gray-400 hover:text-red-600 hover:bg-red-50';
        case 'cyan':
            return 'text-gray-400 hover:text-cyan-600 hover:bg-cyan-50';
        case 'indigo':
            return 'text-gray-400 hover:text-indigo-600 hover:bg-indigo-50';
        case 'primary':
            return 'text-gray-400 hover:text-primary-600 hover:bg-primary-50';
        default:
            return 'text-gray-400 hover:text-gray-600 hover:bg-gray-50';
    }
}

export function getDefaultSkillBadges(skill: Skill): SkillCardBadge[] {
    const badges: SkillCardBadge[] = [];
    if (skill.contributionStatus === 'pending') {
        badges.push({
            label: 'Global Pending',
            className: 'bg-orange-50 text-orange-600 border-orange-100',
            icon: Users,
        });
    }
    if (skill.reviewStatus === 'draft') {
        badges.push({
            label: 'Draft',
            className: 'bg-gray-50 text-gray-500 border-gray-200',
        });
    }
    if (skill.reviewStatus === 'pending') {
        badges.push({
            label: 'Pending Publish',
            className: 'bg-amber-50 text-amber-700 border-amber-200',
            icon: ShieldAlert,
        });
    }
    if (skill.reviewStatus === 'approved' && (skill.scope === 'personal' || skill.scope === 'global')) {
        if (skill.hasUnpublishedChanges) {
            badges.push({
                label: 'Modified',
                className: 'bg-blue-50 text-blue-600 border-blue-200',
                icon: FileCode,
            });
        } else {
            badges.push({
                label: 'Approved',
                className: 'bg-green-50 text-green-600 border-green-200',
                icon: Check,
            });
        }
    }
    if (skill.scope === 'builtin') {
        badges.push({
            label: 'System',
            className: 'bg-gray-100 text-gray-600 border-gray-200',
            icon: Lock,
        });
    }
    return badges;
}

function ToggleSwitch({ enabled, onToggle, disabled }: { enabled: boolean; onToggle: (e: MouseEvent<HTMLButtonElement>) => void; disabled?: boolean }) {
    return (
        <button
            onClick={onToggle}
            disabled={disabled}
            className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                enabled ? "bg-green-500" : "bg-gray-200"
            )}
        >
            <span
                className={cn(
                    "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                    enabled ? "translate-x-6" : "translate-x-1"
                )}
            />
        </button>
    );
}

export function SkillCard({
    skill,
    badges,
    footerScope,
    actions,
    selectionMode,
    showToggle = false,
    onToggleEnabled,
    onToggleLabel,
    labelColors = DEFAULT_SKILL_LABEL_COLORS,
    bottomContent,
    showVersion = true,
    descriptionFallback = '',
}: {
    skill: Skill;
    badges: SkillCardBadge[];
    footerScope: ScopePill;
    actions: SkillCardAction[];
    selectionMode?: SelectionMode;
    showToggle?: boolean;
    onToggleEnabled?: (e: MouseEvent<HTMLButtonElement>) => void;
    onToggleLabel?: (label: string, e: MouseEvent<HTMLSpanElement>) => void;
    labelColors?: Record<string, string>;
    bottomContent?: ReactNode;
    showVersion?: boolean;
    descriptionFallback?: string;
}) {
    const Icon = skill.icon || Code2;
    const visibleActions = actions.filter(action => !action.hidden);

    return (
        <div
            className={cn(
                "group rounded-xl border p-6 hover:shadow-md transition-all duration-200 flex flex-col relative overflow-hidden",
                skill.reviewStatus === 'pending'
                    ? "bg-amber-50/30 border-amber-100"
                    : skill.reviewStatus === 'draft'
                        ? "bg-gray-50/50 border-gray-200"
                        : skill.enabled
                            ? "bg-white border-gray-200"
                            : "bg-gray-50/80 border-gray-100",
            )}
        >
            <div className="flex justify-between items-start mb-4">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                    {selectionMode && (
                        <button
                            onClick={selectionMode.onToggle}
                            className={cn(
                                'mt-1 w-4 h-4 rounded border flex items-center justify-center transition-colors',
                                selectionMode.selected
                                    ? 'bg-slate-900 border-slate-900 text-white'
                                    : 'border-slate-300 bg-white text-transparent hover:border-slate-400'
                            )}
                        >
                            <Check className="w-3 h-3" />
                        </button>
                    )}
                    <div className={cn(
                        "w-8 h-8 rounded-lg border flex items-center justify-center transition-colors shrink-0",
                        skill.enabled
                            ? "bg-gray-50 border-gray-100 group-hover:border-gray-200 group-hover:bg-gray-100"
                            : "bg-gray-100 border-gray-100",
                    )}>
                        <Icon className={cn("w-4 h-4", skill.enabled ? "text-gray-700" : "text-gray-400")} />
                    </div>
                </div>
                {showToggle && onToggleEnabled && (
                    <ToggleSwitch
                        enabled={skill.enabled}
                        onToggle={onToggleEnabled}
                        disabled={skill.reviewStatus === 'pending'}
                    />
                )}
            </div>

            <div className="mb-4">
                <h3 className={cn("font-bold mb-1", skill.enabled ? "text-gray-900" : "text-gray-400")}>{skill.name}</h3>
                <div className="flex items-center gap-1.5 flex-wrap mb-2">
                    {badges.map((badge) => {
                        const BadgeIcon = badge.icon;
                        return (
                            <span
                                key={`${badge.label}-${badge.className}`}
                                className={cn("inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap", badge.className)}
                            >
                                {BadgeIcon && <BadgeIcon className="w-2.5 h-2.5" />}
                                {badge.label}
                            </span>
                        );
                    })}
                </div>
                <p className={cn("text-sm leading-relaxed line-clamp-2", skill.enabled ? "text-gray-500" : "text-gray-400")}>
                    {skill.description || descriptionFallback}
                </p>
                {skill.labels && skill.labels.length > 0 && (() => {
                    const MAX_CARD_LABELS = 3;
                    const visible = skill.labels.slice(0, MAX_CARD_LABELS);
                    const overflow = skill.labels.length - MAX_CARD_LABELS;
                    return (
                        <div className="flex flex-wrap gap-1 mt-2">
                            {visible.map(label => (
                                <span
                                    key={label}
                                    onClick={onToggleLabel ? (e) => onToggleLabel(label, e) : undefined}
                                    className={cn(
                                        "px-1.5 py-0.5 rounded text-[10px] font-medium border transition-opacity",
                                        labelColors[label] || 'bg-gray-50 text-gray-600 border-gray-200',
                                        onToggleLabel && 'cursor-pointer hover:opacity-80',
                                    )}
                                >
                                    {label}
                                </span>
                            ))}
                            {overflow > 0 && (
                                <Tooltip content={skill.labels.slice(MAX_CARD_LABELS).join(', ')} position="bottom">
                                    <span
                                        className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 border border-gray-200"
                                    >
                                        +{overflow}
                                    </span>
                                </Tooltip>
                            )}
                        </div>
                    );
                })()}
            </div>

            {bottomContent}

            <div className={cn("pt-4 border-t border-gray-50 flex items-center justify-between", !bottomContent && "mt-auto")}>
                <div className="flex items-center gap-2 text-xs font-medium text-gray-400">
                    <span className={cn("px-2 py-0.5 rounded flex items-center gap-1", footerScope.className)}>
                        {footerScope.icon && <footerScope.icon className="w-3 h-3" />}
                        {footerScope.label}
                    </span>
                    {showVersion && (
                        <span className="px-1.5 py-0.5 rounded bg-gray-50 text-gray-500 text-[10px] font-medium border border-gray-100">
                            {skill.version}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-1">
                    {visibleActions.map((action) => {
                        const ActionIcon = action.icon;
                        return (
                            <Tooltip key={action.key} content={action.tooltip}>
                                <button
                                    onClick={action.onClick}
                                    disabled={action.disabled}
                                    className={cn(
                                        "p-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
                                        getActionClasses(action.tone),
                                    )}
                                >
                                    <ActionIcon className="w-4 h-4" />
                                </button>
                            </Tooltip>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
