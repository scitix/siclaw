/**
 * Authentication module
 *
 * Handles login, logout, and auth state management.
 */

export interface User {
    id: string;
    username: string;
}

export interface AuthState {
    isAuthenticated: boolean;
    token?: string;
    user?: User;
}

export interface LoginCredentials {
    username: string;
    password: string;
}

export interface LoginResult {
    ok: boolean;
    token?: string;
    user?: User;
    error?: string;
}

const STORAGE_KEY = 'siclaw_auth';

/**
 * Get current auth state from localStorage
 */
export const getAuth = (): AuthState => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch {
        // Invalid JSON, clear storage
        localStorage.removeItem(STORAGE_KEY);
    }
    return { isAuthenticated: false };
};

/**
 * Save auth state to localStorage
 */
const saveAuth = (state: AuthState): void => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

/**
 * Login with username and password
 */
export const login = async (credentials: LoginCredentials): Promise<LoginResult> => {
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credentials),
        });

        const data = await response.json();

        if (data.ok && data.token) {
            const state: AuthState = {
                isAuthenticated: true,
                token: data.token,
                user: data.user,
            };
            saveAuth(state);
            return { ok: true, token: data.token, user: data.user };
        }

        return { ok: false, error: data.error || 'Login failed' };
    } catch (err) {
        return { ok: false, error: 'Network error' };
    }
};

/**
 * Logout and clear auth state
 */
export const logout = (): void => {
    localStorage.removeItem(STORAGE_KEY);
    window.location.href = '/login';
};

/**
 * Get auth token for API requests
 */
export const getToken = (): string | undefined => {
    return getAuth().token;
};

/**
 * Get current user
 */
export const getCurrentUser = (): User | undefined => {
    return getAuth().user;
};

/**
 * Check if a JWT token is expired (with 60s grace).
 */
function isTokenExpired(token: string): boolean {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (!payload.exp) return true; // treat missing exp as expired (fail-safe)
        return payload.exp * 1000 < Date.now() - 60_000;
    } catch {
        return true;
    }
}

/**
 * Check if user is authenticated (token present and not expired).
 * Automatically clears auth state and redirects to login if token is expired.
 */
export const isAuthenticated = (): boolean => {
    const auth = getAuth();
    if (!auth.isAuthenticated || !auth.token) return false;

    if (isTokenExpired(auth.token)) {
        localStorage.removeItem(STORAGE_KEY);
        window.location.href = '/login';
        return false;
    }
    return true;
};

/**
 * Create headers with auth token
 */
export const authHeaders = (): Record<string, string> => {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
};

/**
 * Get WebSocket URL with token
 */
export const getWsUrl = (): string => {
    const token = getToken();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = `${protocol}//${window.location.host}/ws`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
};
