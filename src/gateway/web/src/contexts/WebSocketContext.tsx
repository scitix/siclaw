import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getWsUrl, isAuthenticated, logout } from '../auth';

export type WsStatus = 'disconnected' | 'connecting' | 'connected';

export interface WsMessage {
    type: string;
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { code: string; message: string; details?: unknown; retryable?: boolean; retryAfterMs?: number };
    event?: string;
    seq?: number;
    payload?: Record<string, unknown>;
}

export interface WebSocketContextValue {
    status: WsStatus;
    isConnected: boolean;
    sendRpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
    connect: () => void;
    disconnect: () => void;
    subscribe: (handler: (msg: WsMessage) => void) => () => void;
}

export const WebSocketContext = createContext<WebSocketContextValue | null>(null);

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export function WebSocketProvider({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<WsStatus>('disconnected');
    const wsRef = useRef<WebSocket | null>(null);
    const requestIdRef = useRef(0);
    const callbacksRef = useRef<Map<string, (result: unknown, error?: { code: string; message: string }) => void>>(new Map());
    const subscribersRef = useRef<Set<(msg: WsMessage) => void>>(new Set());

    const reconnectAttemptRef = useRef(0);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const intentionalCloseRef = useRef(false);
    const connectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

    const statusRef = useRef<WsStatus>('disconnected');
    const updateStatus = useCallback((s: WsStatus) => {
        statusRef.current = s;
        setStatus(s);
    }, []);

    const scheduleReconnect = useCallback(() => {
        if (intentionalCloseRef.current || !isAuthenticated()) return;
        // Exponential backoff with jitter: base * 2^attempt + random jitter, capped at max
        const exponential = RECONNECT_BASE_MS * Math.pow(2, reconnectAttemptRef.current);
        const jitter = Math.random() * RECONNECT_BASE_MS;
        const delay = Math.min(exponential + jitter, RECONNECT_MAX_MS);
        reconnectAttemptRef.current++;
        console.log(`[ws] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttemptRef.current})`);
        reconnectTimerRef.current = setTimeout(() => {
            connect();
        }, delay);
    }, []);

    const connect = useCallback(() => {
        if (wsRef.current) {
            wsRef.current.onopen = null;
            wsRef.current.onclose = null;
            wsRef.current.onerror = null;
            wsRef.current.onmessage = null;
            if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
                wsRef.current.close();
            }
            wsRef.current = null;
        }
        if (connectTimeoutRef.current) {
            clearTimeout(connectTimeoutRef.current);
        }

        if (!isAuthenticated()) {
            console.warn('[ws] Not authenticated, skipping connect');
            return;
        }

        updateStatus('connecting');

        const url = getWsUrl();
        console.log(`[ws] Connecting to: ${url} (attempt ${reconnectAttemptRef.current})`);
        const ws = new WebSocket(url);
        wsRef.current = ws;

        connectTimeoutRef.current = setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                console.warn(`[ws] Connection timeout (15s), readyState=${ws.readyState}, retrying...`);
                ws.onclose = null;
                ws.close();
                wsRef.current = null;
                updateStatus('disconnected');
                scheduleReconnect();
            }
        }, 15_000);

        ws.onopen = () => {
            clearTimeout(connectTimeoutRef.current);
            console.log('[ws] Connected');
            reconnectAttemptRef.current = 0;
            updateStatus('connected');
        };

        ws.onmessage = (event) => {
            try {
                const msg: WsMessage = JSON.parse(event.data);

                // Handle RPC response
                if (msg.type === 'res' && msg.id) {
                    const callback = callbacksRef.current.get(msg.id);
                    if (callback) {
                        const rpcError = msg.error
                            ? { code: msg.error.code, message: msg.error.message ?? 'Unknown error' }
                            : undefined;
                        callback(msg.payload ?? msg.result, rpcError);
                        callbacksRef.current.delete(msg.id);
                    }
                }

                // Broadcast to all subscribers
                for (const fn of Array.from(subscribersRef.current)) {
                    fn(msg);
                }
            } catch (err) {
                console.error('[ws] Failed to parse message:', err);
            }
        };

        ws.onclose = (event) => {
            clearTimeout(connectTimeoutRef.current);
            console.log(`[ws] Closed: code=${event.code} reason=${event.reason}`);
            wsRef.current = null;

            // Reject all pending RPC callbacks so hooks' loading states can resolve
            // (otherwise orphaned promises keep loading=true forever)
            for (const [, callback] of callbacksRef.current) {
                callback(undefined, { code: 'WS_CLOSED', message: 'WebSocket closed before response' });
            }
            callbacksRef.current.clear();

            updateStatus('disconnected');
            scheduleReconnect();
        };

        ws.onerror = (err) => {
            console.error('[ws] Error:', err);
        };
    }, [updateStatus, scheduleReconnect]);

    const disconnect = useCallback(() => {
        intentionalCloseRef.current = true;
        if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = undefined;
        }
        wsRef.current?.close();
        wsRef.current = null;
        updateStatus('disconnected');
    }, [updateStatus]);

    const sendRpc = useCallback(<T = unknown,>(
        method: string,
        params?: Record<string, unknown>
    ): Promise<T> => {
        return new Promise((resolve, reject) => {
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not connected'));
                return;
            }

            const id = String(++requestIdRef.current);
            callbacksRef.current.set(id, (result, error) => {
                if (error) {
                    if (error.message?.includes('Unauthorized')) {
                        logout();
                        return;
                    }
                    reject(new Error(error.message));
                } else {
                    resolve(result as T);
                }
            });

            wsRef.current.send(JSON.stringify({
                type: 'req',
                id,
                method,
                params: params ?? {},
            }));
        });
    }, []);

    const subscribe = useCallback((handler: (msg: WsMessage) => void) => {
        subscribersRef.current.add(handler);
        return () => {
            subscribersRef.current.delete(handler);
        };
    }, []);

    // Auto-connect on mount
    useEffect(() => {
        if (isAuthenticated()) {
            intentionalCloseRef.current = false;
            connect();
        }
        return () => {
            disconnect();
        };
    }, [connect, disconnect]);

    const value: WebSocketContextValue = {
        status,
        isConnected: status === 'connected',
        sendRpc,
        connect,
        disconnect,
        subscribe,
    };

    return (
        <WebSocketContext.Provider value={value}>
            {children}
        </WebSocketContext.Provider>
    );
}
