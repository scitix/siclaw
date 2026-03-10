import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
    Sparkles,
    Settings,
    Timer,
    Command,
    ChevronRight,
    ChevronDown,
    Shield,
    Zap,
    Share2,
    LayoutGrid,
    Boxes,
    Plug,
    Cpu,
    Compass,
    // BrainCircuit,  // hidden until claude-sdk brain is polished
    Globe,
    Wrench,
    BarChart3,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useEffect, useRef } from 'react';
import { getUser } from '../../pages/Settings/userData';
import { NotificationBell } from '../NotificationBell';
import { getCurrentUser } from '../../auth';
import { useWorkspace } from '../../contexts/WorkspaceContext';

interface NavItem {
    icon: LucideIcon;
    label: string;
    to: string;
    adminOnly?: boolean;
}

interface NavGroup {
    icon: LucideIcon;
    label: string;
    key: string;
    items: NavItem[];
}

const topItems: NavItem[] = [
    { icon: Compass, label: 'Pilot', to: '/pilot' },
    { icon: Boxes, label: 'Workspace', to: '/workspace' },
    { icon: Timer, label: 'Cron Jobs', to: '/cron' },
    { icon: Zap, label: 'Triggers', to: '/triggers' },
];

const groups: NavGroup[] = [
    {
        icon: Sparkles,
        label: 'Agent',
        key: 'agent',
        items: [
            { icon: LayoutGrid, label: 'Skills', to: '/skills' },
            { icon: Plug, label: 'MCP', to: '/mcp' },
        ],
    },
    {
        icon: Settings,
        label: 'Settings',
        key: 'settings',
        items: [
            { icon: Share2, label: 'Channels', to: '/channels', adminOnly: true },
            // { icon: BrainCircuit, label: 'Brains', to: '/brains' },  // hidden until claude-sdk brain is polished
            { icon: Cpu, label: 'Models', to: '/models', adminOnly: true },
            { icon: Globe, label: 'Environments', to: '/environments' },
            { icon: Shield, label: 'Permissions', to: '/permissions', adminOnly: true },
            { icon: Wrench, label: 'System', to: '/settings/system', adminOnly: true },
        ],
    },
];

function useGroupExpanded(key: string, isActive: boolean) {
    const storageKey = `sidebar-${key}-expanded`;
    const [expanded, setExpanded] = useState(() => {
        if (isActive) return true;
        const stored = localStorage.getItem(storageKey);
        // Default to expanded if no stored preference
        return stored === null ? true : stored === 'true';
    });

    useEffect(() => {
        if (isActive && !expanded) {
            setExpanded(true);
            localStorage.setItem(storageKey, 'true');
        }
    }, [isActive]);

    const toggle = () => {
        const next = !expanded;
        setExpanded(next);
        localStorage.setItem(storageKey, String(next));
    };

    return { expanded, toggle };
}

const COLORS: Record<string, string> = {
    indigo: 'bg-indigo-500',
    blue: 'bg-blue-500',
    green: 'bg-green-500',
    amber: 'bg-amber-500',
    rose: 'bg-rose-500',
    purple: 'bg-purple-500',
    teal: 'bg-teal-500',
    gray: 'bg-gray-400',
};

export function Sidebar() {
    const navigate = useNavigate();
    const location = useLocation();
    const [user, setUser] = useState(getUser());
    const currentUser = getCurrentUser();
    const isSidebarAdmin = currentUser?.username === 'admin';
    const { workspaces, currentWorkspace, setCurrentWorkspace } = useWorkspace();
    const [wsDropdownOpen, setWsDropdownOpen] = useState(false);
    const wsDropdownRef = useRef<HTMLDivElement>(null);

    // Close dropdown on outside click
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (wsDropdownRef.current && !wsDropdownRef.current.contains(e.target as Node)) {
                setWsDropdownOpen(false);
            }
        };
        if (wsDropdownOpen) document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [wsDropdownOpen]);

    // Compute which groups are active
    const isGroupActive = (group: NavGroup) =>
        group.items
            .filter(item => !item.adminOnly || isSidebarAdmin)
            .some(item => location.pathname.startsWith(item.to));

    // Must call hooks at top level — one per group
    const agentGroup = useGroupExpanded('agent', isGroupActive(groups[0]));
    const settingsGroup = useGroupExpanded('settings', isGroupActive(groups[1]));

    const groupStates = [agentGroup, settingsGroup];

    useEffect(() => {
        const handleUpdate = () => setUser(getUser());
        window.addEventListener('user-profile-updated', handleUpdate);
        return () => window.removeEventListener('user-profile-updated', handleUpdate);
    }, []);

    return (
        <aside className="w-64 h-screen bg-gray-50 border-r border-gray-200 flex flex-col shrink-0">
            {/* Brand Header */}
            <div className="h-14 flex items-center justify-between px-4 border-b border-gray-200 bg-white">
                <div className="flex items-center gap-2.5 text-primary-600">
                    <div className="p-1 bg-primary-50 rounded-md">
                        <Command className="w-5 h-5" />
                    </div>
                    <span className="font-bold text-gray-900 tracking-tight">Siclaw</span>
                </div>
                <NotificationBell />
            </div>

            {/* Workspace Selector */}
            {workspaces.length > 0 && (
                <div className="px-3 py-2 border-b border-gray-200" ref={wsDropdownRef}>
                    <div className="relative">
                        <button
                            onClick={() => setWsDropdownOpen(!wsDropdownOpen)}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-gray-200 hover:border-gray-300 text-sm font-medium text-gray-900 shadow-sm transition-colors"
                        >
                            <span className={cn('w-2 h-2 rounded-full shrink-0', COLORS[currentWorkspace?.configJson?.color ?? 'indigo'] ?? 'bg-indigo-500')} />
                            <span className="flex-1 text-left truncate">{currentWorkspace?.name ?? 'Default'}</span>
                            <ChevronDown className={cn('w-4 h-4 text-gray-400 transition-transform', wsDropdownOpen && 'rotate-180')} />
                        </button>
                        {wsDropdownOpen && (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1 max-h-48 overflow-y-auto">
                                {workspaces.map(ws => (
                                    <button
                                        key={ws.id}
                                        onClick={() => { setCurrentWorkspace(ws); setWsDropdownOpen(false); }}
                                        className={cn(
                                            'w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50 transition-colors',
                                            currentWorkspace?.id === ws.id && 'bg-indigo-50 text-indigo-700'
                                        )}
                                    >
                                        <span className={cn('w-2 h-2 rounded-full shrink-0', COLORS[ws.configJson?.color ?? 'indigo'] ?? 'bg-indigo-500')} />
                                        <span className="truncate">{ws.name}</span>
                                        {ws.envType === 'test' && (
                                            <span className="text-xs px-1 py-0.5 rounded bg-amber-50 text-amber-600 ml-1">TEST</span>
                                        )}
                                        {ws.isDefault && <span className="text-xs text-gray-400 ml-auto">default</span>}
                                    </button>
                                ))}
                                <div className="border-t border-gray-100 mt-1 pt-1">
                                    <button
                                        onClick={() => { setWsDropdownOpen(false); navigate('/workspace'); }}
                                        className="w-full px-3 py-2 text-sm text-indigo-600 text-left hover:bg-gray-50 transition-colors"
                                    >
                                        Manage Workspaces
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Navigation */}
            <div className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
                {topItems.map(item => (
                    <NavLink
                        key={item.to}
                        to={item.to}
                        className={({ isActive }) =>
                            cn(
                                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-normal transition-all",
                                isActive
                                    ? "bg-primary-50 text-primary-700"
                                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                            )
                        }
                    >
                        <item.icon className="w-[18px] h-[18px] stroke-[1.25]" />
                        {item.label}
                    </NavLink>
                ))}
                {groups.map((group, idx) => {
                    const visibleItems = group.items.filter(item => !item.adminOnly || isSidebarAdmin);
                    if (visibleItems.length === 0) return null;
                    const { expanded, toggle } = groupStates[idx];
                    const active = isGroupActive(group);

                    return (
                        <div key={group.key} className="pt-2">
                            <button
                                onClick={toggle}
                                className={cn(
                                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-normal transition-all w-full text-left",
                                    active
                                        ? "text-gray-900"
                                        : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                )}
                            >
                                <group.icon className="w-[18px] h-[18px] stroke-[1.25]" />
                                <span className="flex-1">{group.label}</span>
                                <ChevronRight className={cn("w-3.5 h-3.5 stroke-[1.5] text-gray-400 transition-transform", expanded && "rotate-90")} />
                            </button>
                            {expanded && visibleItems.map((item) => (
                                <NavLink
                                    key={item.to}
                                    to={item.to}
                                    className={({ isActive }) =>
                                        cn(
                                            "flex items-center gap-3 pl-9 pr-3 py-2 rounded-lg text-sm font-normal transition-all",
                                            isActive
                                                ? "bg-primary-50 text-primary-700"
                                                : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                                        )
                                    }
                                >
                                    <item.icon className="w-[18px] h-[18px] stroke-[1.25]" />
                                    {item.label}
                                </NavLink>
                            ))}
                        </div>
                    );
                })}
            </div>

            {/* Metrics — fixed above user footer, does not scroll */}
            <div className="px-3 pb-2">
                <NavLink
                    to="/metrics"
                    className={({ isActive }) =>
                        cn(
                            "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-normal transition-all",
                            isActive
                                ? "bg-primary-50 text-primary-700"
                                : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                        )
                    }
                >
                    <BarChart3 className="w-[18px] h-[18px] stroke-[1.25]" />
                    Metrics
                </NavLink>
            </div>

            {/* User Footer */}
            <div className="p-3 border-t border-gray-200 bg-white">
                <button
                    onClick={() => navigate('/settings')}
                    className="flex items-center gap-3 w-full p-2 rounded-md hover:bg-gray-50 transition-colors text-left group"
                >
                    <div className={cn("w-8 h-8 rounded-full flex items-center justify-center text-primary-700 font-semibold text-xs ring-2 ring-white shadow-sm", user.avatarBg)}>
                        {user.initials}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 group-hover:text-primary-600 transition-colors truncate">{user.name}</div>
                        <div className="text-xs text-gray-500 truncate">@{currentUser?.username ?? 'user'}</div>
                    </div>
                    <Settings className="w-4 h-4 text-gray-400 group-hover:text-gray-600" />
                </button>
            </div>
        </aside>
    );
}
