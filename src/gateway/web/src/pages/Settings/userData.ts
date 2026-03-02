
// User profile data — with RPC backend support + localStorage fallback

import { getCurrentUser } from '../../auth';

export type UserProfile = {
    name: string;
    role: string;
    initials: string;
    avatarBg: string;
};

// Default initial state
let currentUser: UserProfile = {
    name: getCurrentUser()?.username || 'User',
    role: '',
    initials: computeInitials(getCurrentUser()?.username || 'User'),
    avatarBg: 'bg-primary-100' // tailwind class
};

function computeInitials(name: string): string {
    const parts = name.split(' ');
    if (parts.length >= 2) {
        return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
}

export const getUser = (): UserProfile => {
    // Try to load from localStorage for persistence across reloads
    const saved = localStorage.getItem('siclaw_user_profile');
    if (saved) {
        return JSON.parse(saved);
    }
    return currentUser;
};

export const updateUser = (updates: Partial<UserProfile>): UserProfile => {
    const current = getUser();
    const updated = { ...current, ...updates };

    // Update initials if name changes
    if (updates.name) {
        updated.initials = computeInitials(updates.name);
    }

    currentUser = updated;
    localStorage.setItem('siclaw_user_profile', JSON.stringify(updated));

    // Dispatch a custom event to notify components (like Sidebar) to update
    window.dispatchEvent(new Event('user-profile-updated'));

    return updated;
};

// ─── RPC-based functions ───

export type RpcSendFn = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

export async function rpcGetProfile(sendRpc: RpcSendFn): Promise<UserProfile | null> {
    try {
        const result = await sendRpc<{ profile: any }>('profile.get');
        if (!result.profile) return null;
        const p = result.profile;
        const name = p.name || 'User';
        return {
            name,
            role: p.role || '',
            initials: computeInitials(name),
            avatarBg: p.avatarBg || 'bg-primary-100',
        };
    } catch {
        return null;
    }
}

export async function rpcUpdateProfile(
    sendRpc: RpcSendFn,
    updates: Partial<UserProfile>,
): Promise<void> {
    await sendRpc('profile.update', updates as Record<string, unknown>);
    // Also update local cache
    updateUser(updates);
}

/**
 * Initialize profile from server, falling back to auth username.
 * Call once on app mount to hydrate the profile.
 */
export async function initializeProfile(sendRpc: RpcSendFn): Promise<void> {
    const authUser = getCurrentUser();
    const serverProfile = await rpcGetProfile(sendRpc);

    if (serverProfile) {
        updateUser(serverProfile);
    } else if (authUser) {
        // No server profile yet — seed from auth username
        const current = getUser();
        if (current.name === 'User' || current.name === 'SRE Admin') {
            updateUser({ name: authUser.username });
        }
    }
}
