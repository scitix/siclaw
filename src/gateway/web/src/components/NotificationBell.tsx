import { useState, useEffect, useRef, useMemo } from 'react';
import { Bell, Check, Trash2 } from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useNotifications, groupNotifications } from '../hooks/useNotifications';
import { NotificationGroupItem } from './NotificationItem';

export function NotificationBell() {
    const { sendRpc, isConnected } = useWebSocket({
        onMessage: (msg) => handleWsEvent(msg),
    });
    const {
        notifications,
        unreadCount,
        loadNotifications,
        markRead,
        markAllRead,
        dismissOne,
        dismissAll,
        handleWsEvent,
    } = useNotifications(sendRpc);

    const [isOpen, setIsOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);

    const groups = useMemo(() => groupNotifications(notifications), [notifications]);

    useEffect(() => {
        if (isConnected) loadNotifications();
    }, [isConnected, loadNotifications]);

    // Close panel on outside click
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [isOpen]);

    return (
        <div className="relative" ref={panelRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="relative p-1.5 rounded-md text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-colors"
            >
                <Bell className="w-4.5 h-4.5" />
                {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </button>

            {isOpen && (
                <div className="absolute top-full left-0 mt-2 w-[28rem] bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden z-50">
                    {/* Header */}
                    <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
                        <div className="flex items-center gap-2">
                            {unreadCount > 0 && (
                                <button
                                    onClick={markAllRead}
                                    className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
                                >
                                    <Check className="w-3 h-3" />
                                    Mark all read
                                </button>
                            )}
                            {notifications.length > 0 && (
                                <button
                                    onClick={dismissAll}
                                    className="flex items-center gap-1 text-xs text-red-500 hover:text-red-600 font-medium"
                                    title="Clear all notifications"
                                >
                                    <Trash2 className="w-3 h-3" />
                                    Clear all
                                </button>
                            )}
                        </div>
                    </div>

                    {/* List */}
                    <div className="max-h-[480px] overflow-y-auto">
                        {groups.length === 0 ? (
                            <div className="py-8 text-center text-sm text-gray-400">
                                No notifications
                            </div>
                        ) : (
                            groups.map((group) => (
                                <NotificationGroupItem
                                    key={group.key}
                                    group={group}
                                    onMarkRead={markRead}
                                    onDelete={dismissOne}
                                    onClose={() => setIsOpen(false)}
                                />
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
