import { useState, useCallback } from 'react';
import type { RpcSendFn } from '../pages/Skills/skillsData';
import type { WsMessage } from './useWebSocket';

export interface Notification {
    id: string;
    type: string;
    title: string;
    message?: string | null;
    relatedId?: string | null;
    isRead: boolean;
    createdAt?: string;
}

export interface NotificationGroup {
    key: string;
    type: string;
    title: string;
    relatedId?: string | null;
    notifications: Notification[];
    latestAt?: string;
    unreadCount: number;
}

/** Group cron_result notifications by relatedId; other types stay individual */
export function groupNotifications(notifications: Notification[]): NotificationGroup[] {
    const cronGroups = new Map<string, Notification[]>();
    const groups: NotificationGroup[] = [];

    for (const n of notifications) {
        if (n.type === 'cron_result' && n.relatedId) {
            const existing = cronGroups.get(n.relatedId);
            if (existing) {
                existing.push(n);
            } else {
                cronGroups.set(n.relatedId, [n]);
            }
        } else {
            groups.push({
                key: n.id,
                type: n.type,
                title: n.title,
                relatedId: n.relatedId,
                notifications: [n],
                latestAt: n.createdAt,
                unreadCount: n.isRead ? 0 : 1,
            });
        }
    }

    for (const [relatedId, items] of cronGroups) {
        groups.push({
            key: `cron:${relatedId}`,
            type: 'cron_result',
            title: items[0].title,
            relatedId,
            notifications: items,
            latestAt: items[0].createdAt,
            unreadCount: items.filter(n => !n.isRead).length,
        });
    }

    // Sort by latest time descending
    groups.sort((a, b) => {
        const ta = a.latestAt ? new Date(a.latestAt).getTime() : 0;
        const tb = b.latestAt ? new Date(b.latestAt).getTime() : 0;
        return tb - ta;
    });

    return groups;
}

interface UseNotificationsResult {
    notifications: Notification[];
    unreadCount: number;
    loadNotifications: () => Promise<void>;
    markRead: (id: string) => Promise<void>;
    markAllRead: () => Promise<void>;
    dismissOne: (id: string) => Promise<void>;
    dismissAll: () => Promise<void>;
    handleWsEvent: (msg: WsMessage) => void;
}

export function useNotifications(sendRpc: RpcSendFn): UseNotificationsResult {
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);

    const loadNotifications = useCallback(async () => {
        try {
            const [listResult, countResult] = await Promise.all([
                sendRpc<{ notifications: Notification[] }>('notification.list'),
                sendRpc<{ count: number }>('notification.unreadCount'),
            ]);
            setNotifications(listResult.notifications ?? []);
            setUnreadCount(countResult.count ?? 0);
        } catch (err) {
            console.error('[useNotifications] Failed to load:', err);
        }
    }, [sendRpc]);

    const markRead = useCallback(async (id: string) => {
        try {
            await sendRpc('notification.markRead', { id });
            setNotifications(prev =>
                prev.map(n => n.id === id ? { ...n, isRead: true } : n)
            );
            setUnreadCount(prev => Math.max(0, prev - 1));
        } catch (err) {
            console.error('[useNotifications] markRead failed:', err);
        }
    }, [sendRpc]);

    const markAllRead = useCallback(async () => {
        try {
            await sendRpc('notification.markRead', { id: 'all' });
            setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
            setUnreadCount(0);
        } catch (err) {
            console.error('[useNotifications] markAllRead failed:', err);
        }
    }, [sendRpc]);

    const dismissOne = useCallback(async (id: string) => {
        try {
            await sendRpc('notification.dismiss', { id });
            setNotifications(prev => {
                const target = prev.find(n => n.id === id);
                if (target && !target.isRead) {
                    setUnreadCount(c => Math.max(0, c - 1));
                }
                return prev.filter(n => n.id !== id);
            });
        } catch (err) {
            console.error('[useNotifications] dismissOne failed:', err);
        }
    }, [sendRpc]);

    const dismissAll = useCallback(async () => {
        try {
            await sendRpc('notification.dismissAll');
            setNotifications([]);
            setUnreadCount(0);
        } catch (err) {
            console.error('[useNotifications] dismissAll failed:', err);
        }
    }, [sendRpc]);

    const handleWsEvent = useCallback((msg: WsMessage) => {
        if (msg.type === 'event' && msg.event === 'notification' && msg.payload) {
            const notif = msg.payload as unknown as Notification;
            setNotifications(prev => [notif, ...prev]);
            setUnreadCount(prev => prev + 1);
        }
    }, []);

    return {
        notifications,
        unreadCount,
        loadNotifications,
        markRead,
        markAllRead,
        dismissOne,
        dismissAll,
        handleWsEvent,
    };
}
