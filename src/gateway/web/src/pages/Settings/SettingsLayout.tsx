import { NavLink, Outlet } from 'react-router-dom';
import { User, KeyRound, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
    { icon: User, label: 'Profile', to: '/settings', end: true },
    { icon: KeyRound, label: 'Credentials', to: '/settings/credentials', end: false },
    { icon: Wrench, label: 'System', to: '/settings/system', end: false },
];

export function SettingsLayout() {
    return (
        <div className="h-full bg-white flex flex-col">
            {/* Tab bar */}
            <div className="border-b border-gray-200 px-6 bg-white shrink-0">
                <nav className="flex gap-1">
                    {tabs.map((tab) => (
                        <NavLink
                            key={tab.to}
                            to={tab.to}
                            end={tab.end}
                            className={({ isActive }) =>
                                cn(
                                    "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px",
                                    isActive
                                        ? "border-primary-600 text-primary-600"
                                        : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                                )
                            }
                        >
                            <tab.icon className="w-4 h-4" />
                            {tab.label}
                        </NavLink>
                    ))}
                </nav>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden">
                <Outlet />
            </div>
        </div>
    );
}
