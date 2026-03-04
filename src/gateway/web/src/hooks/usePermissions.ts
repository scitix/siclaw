import { useState, useEffect } from 'react';

interface PermissionState {
    isAdmin: boolean;
    permissions: string[];
    isReviewer: boolean;
    loaded: boolean;
}

export function usePermissions(
    sendRpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>,
    isConnected: boolean,
): PermissionState {
    const [state, setState] = useState<PermissionState>({
        isAdmin: false,
        permissions: [],
        isReviewer: false,
        loaded: false,
    });

    useEffect(() => {
        if (!isConnected) return;

        sendRpc<{ isAdmin: boolean; permissions: string[] }>('permission.mine')
            .then((result) => {
                const isAdmin = result.isAdmin;
                const permissions = result.permissions;
                setState({
                    isAdmin,
                    permissions,
                    isReviewer: isAdmin || permissions.includes('skill_reviewer'),
                    loaded: true,
                });
            })
            .catch((err) => {
                console.warn('[usePermissions] Failed to fetch permissions:', err);
                setState(prev => ({ ...prev, loaded: true }));
            });
    }, [isConnected, sendRpc]);

    return state;
}
