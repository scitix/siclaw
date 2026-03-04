import { useState } from 'react';
import { Timer, ThumbsUp, ThumbsDown, Undo2, Bell, ChevronRight, X, ShieldCheck, ShieldX, XCircle, ShieldAlert, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useNavigate } from 'react-router-dom';
import type { Notification, NotificationGroup } from '../hooks/useNotifications';

// ─── Type config ────────────────────────────────────

interface TypeConfig {
    icon: React.ComponentType<{ className?: string }>;
    chipLabel: string;
    bgClass: string;
    textClass: string;
    chipBg: string;
    chipText: string;
}

const TYPE_CONFIG: Record<string, TypeConfig> = {
    cron_result: {
        icon: Timer,
        chipLabel: 'Scheduled Task',
        bgClass: 'bg-blue-100',
        textClass: 'text-blue-600',
        chipBg: 'bg-blue-50',
        chipText: 'text-blue-700',
    },
    vote_up: {
        icon: ThumbsUp,
        chipLabel: 'Vote',
        bgClass: 'bg-green-100',
        textClass: 'text-green-600',
        chipBg: 'bg-green-50',
        chipText: 'text-green-700',
    },
    vote_down: {
        icon: ThumbsDown,
        chipLabel: 'Vote',
        bgClass: 'bg-red-100',
        textClass: 'text-red-600',
        chipBg: 'bg-red-50',
        chipText: 'text-red-700',
    },
    skill_reverted: {
        icon: Undo2,
        chipLabel: 'Skill Reverted',
        bgClass: 'bg-orange-100',
        textClass: 'text-orange-600',
        chipBg: 'bg-orange-50',
        chipText: 'text-orange-700',
    },
    skill_approved: {
        icon: ShieldCheck,
        chipLabel: 'Approved',
        bgClass: 'bg-green-100',
        textClass: 'text-green-600',
        chipBg: 'bg-green-50',
        chipText: 'text-green-700',
    },
    skill_rejected: {
        icon: ShieldX,
        chipLabel: 'Rejected',
        bgClass: 'bg-red-100',
        textClass: 'text-red-600',
        chipBg: 'bg-red-50',
        chipText: 'text-red-700',
    },
    contribution_rejected: {
        icon: XCircle,
        chipLabel: 'Rejected',
        bgClass: 'bg-red-100',
        textClass: 'text-red-600',
        chipBg: 'bg-red-50',
        chipText: 'text-red-700',
    },
    skill_review_requested: {
        icon: ShieldAlert,
        chipLabel: 'Publish Review',
        bgClass: 'bg-amber-100',
        textClass: 'text-amber-600',
        chipBg: 'bg-amber-50',
        chipText: 'text-amber-700',
    },
    contribution_review_requested: {
        icon: Users,
        chipLabel: 'Team Review',
        bgClass: 'bg-blue-100',
        textClass: 'text-blue-600',
        chipBg: 'bg-blue-50',
        chipText: 'text-blue-700',
    },
};

const DEFAULT_CONFIG: TypeConfig = {
    icon: Bell,
    chipLabel: 'Notification',
    bgClass: 'bg-gray-100',
    textClass: 'text-gray-600',
    chipBg: 'bg-gray-50',
    chipText: 'text-gray-700',
};

function getConfig(type: string): TypeConfig {
    return TYPE_CONFIG[type] ?? DEFAULT_CONFIG;
}

// ─── Time format ────────────────────────────────────

function formatTime(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    return d.toLocaleDateString();
}

// ─── Single notification item ───────────────────────

/** Notification types that link to a skill detail page */
const SKILL_NAV_TYPES = new Set([
    'skill_approved', 'skill_rejected', 'contribution_rejected', 'skill_reverted',
]);

/** Notification types that link to the approvals tab */
const APPROVAL_NAV_TYPES = new Set([
    'skill_review_requested',
    'contribution_review_requested',
]);

/** Only collapse messages longer than this */
const MESSAGE_COLLAPSE_LEN = 300;

interface SingleItemProps {
    notif: Notification;
    onMarkRead: (id: string) => void;
    onDelete: (id: string) => void;
    onClose?: () => void;
    nested?: boolean;
}

export function NotificationSingleItem({ notif, onMarkRead, onDelete, onClose, nested }: SingleItemProps) {
    const [collapsed, setCollapsed] = useState(true);
    const navigate = useNavigate();
    const cfg = getConfig(notif.type);
    const Icon = cfg.icon;
    const isLong = (notif.message?.length ?? 0) > MESSAGE_COLLAPSE_LEN;
    const canNavigate = (SKILL_NAV_TYPES.has(notif.type) || APPROVAL_NAV_TYPES.has(notif.type)) && notif.relatedId;

    const handleClick = () => {
        if (!notif.isRead) onMarkRead(notif.id);
        if (APPROVAL_NAV_TYPES.has(notif.type) && notif.relatedId) {
            onClose?.();
            navigate('/skills?tab=approvals');
        } else if (SKILL_NAV_TYPES.has(notif.type) && notif.relatedId) {
            onClose?.();
            navigate(`/skills/${notif.relatedId}`);
        }
    };

    return (
        <div
            onClick={handleClick}
            className={cn(
                'group relative px-3 py-2.5 border-b border-gray-50 hover:bg-gray-50/80 transition-colors cursor-pointer',
                !notif.isRead && 'bg-blue-50/40',
                nested && 'pl-10 border-b-0 py-2',
            )}
        >
            <div className="flex items-start gap-2.5">
                {/* Icon circle with unread dot */}
                {!nested && (
                    <div className="relative flex-shrink-0 mt-0.5">
                        <div className={cn('w-7 h-7 rounded-full flex items-center justify-center', cfg.bgClass)}>
                            <Icon className={cn('w-3.5 h-3.5', cfg.textClass)} />
                        </div>
                        {!notif.isRead && (
                            <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-blue-500 border-2 border-white" />
                        )}
                    </div>
                )}

                {/* Content — title and message on separate rows, no truncation */}
                <div className="flex-1 min-w-0">
                    {/* Row 1: chip + time */}
                    <div className="flex items-center justify-between gap-1.5 mb-0.5">
                        <div className="flex items-center gap-1.5">
                            {!nested && (
                                <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0', cfg.chipBg, cfg.chipText)}>
                                    {cfg.chipLabel}
                                </span>
                            )}
                            <span className="text-[10px] text-gray-400">{formatTime(notif.createdAt)}</span>
                        </div>
                        {/* Delete button (hover) */}
                        <button
                            onClick={(e) => { e.stopPropagation(); onDelete(notif.id); }}
                            className="flex-shrink-0 p-1 rounded hover:bg-gray-200 text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Delete"
                        >
                            <X className="w-3 h-3" />
                        </button>
                    </div>

                    {/* Row 2: title — full display, word-wrap */}
                    <p className="text-sm text-gray-900 leading-snug break-words">{notif.title}</p>

                    {/* Row 3: message — full display by default, collapse only if very long */}
                    {notif.message && (
                        <div className="mt-1">
                            <p className={cn(
                                'text-xs text-gray-500 leading-relaxed break-words whitespace-pre-wrap',
                                collapsed && isLong && 'line-clamp-5',
                            )}>
                                {notif.message}
                            </p>
                            {isLong && (
                                <button
                                    onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}
                                    className="text-[10px] text-primary-600 hover:text-primary-700 font-medium mt-0.5"
                                >
                                    {collapsed ? 'Show more' : 'Show less'}
                                </button>
                            )}
                        </div>
                    )}

                    {/* Row 4: navigation link for skill-related notifications (hide once read/handled) */}
                    {canNavigate && !notif.isRead && (
                        <button
                            onClick={(e) => { e.stopPropagation(); handleClick(); }}
                            className="mt-1 text-[11px] text-primary-600 hover:text-primary-700 font-medium hover:underline"
                        >
                            {APPROVAL_NAV_TYPES.has(notif.type) ? 'Go to Approvals' : 'View Skill Details'} &rarr;
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── Group notification item ────────────────────────

interface GroupItemProps {
    group: NotificationGroup;
    onMarkRead: (id: string) => void;
    onDelete: (id: string) => void;
    onClose?: () => void;
}

export function NotificationGroupItem({ group, onMarkRead, onDelete, onClose }: GroupItemProps) {
    const [expanded, setExpanded] = useState(false);

    // Single item in group — render as regular item
    if (group.notifications.length === 1) {
        return (
            <NotificationSingleItem
                notif={group.notifications[0]}
                onMarkRead={onMarkRead}
                onDelete={onDelete}
                onClose={onClose}
            />
        );
    }

    const cfg = getConfig(group.type);
    const Icon = cfg.icon;

    return (
        <div className="border-b border-gray-50">
            {/* Group header */}
            <button
                onClick={() => setExpanded(!expanded)}
                className={cn(
                    'w-full text-left px-3 py-2.5 hover:bg-gray-50/80 transition-colors flex items-start gap-2.5',
                    group.unreadCount > 0 && 'bg-blue-50/40',
                )}
            >
                {/* Icon circle */}
                <div className="relative flex-shrink-0 mt-0.5">
                    <div className={cn('w-7 h-7 rounded-full flex items-center justify-center', cfg.bgClass)}>
                        <Icon className={cn('w-3.5 h-3.5', cfg.textClass)} />
                    </div>
                    {group.unreadCount > 0 && (
                        <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-blue-500 border-2 border-white" />
                    )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                        <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0', cfg.chipBg, cfg.chipText)}>
                            {cfg.chipLabel}
                        </span>
                        <span className="text-[10px] text-gray-400">{formatTime(group.latestAt)}</span>
                    </div>
                    <p className="text-sm text-gray-900 leading-snug break-words">{group.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-gray-400">{group.notifications.length} notifications</span>
                        {group.unreadCount > 0 && (
                            <span className="text-[10px] text-blue-500 font-medium">{group.unreadCount} unread</span>
                        )}
                    </div>
                </div>

                {/* Expand chevron */}
                <ChevronRight className={cn(
                    'w-4 h-4 text-gray-400 flex-shrink-0 mt-1 transition-transform duration-200',
                    expanded && 'rotate-90',
                )} />
            </button>

            {/* Expanded items */}
            {expanded && (
                <div className="bg-gray-50/50">
                    {group.notifications.map(n => (
                        <NotificationSingleItem
                            key={n.id}
                            notif={n}
                            onMarkRead={onMarkRead}
                            onDelete={onDelete}
                            onClose={onClose}
                            nested
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
