import { useContext, useEffect, useRef } from 'react';
import { WebSocketContext } from '../contexts/WebSocketContext';
import type { WsMessage, WsStatus } from '../contexts/WebSocketContext';

export type { WsStatus, WsMessage };

interface UseWebSocketOptions {
    onMessage?: (msg: WsMessage) => void;
    onStatusChange?: (status: WsStatus) => void;
    autoConnect?: boolean;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
    const ctx = useContext(WebSocketContext);
    if (!ctx) throw new Error('useWebSocket must be used within WebSocketProvider');

    // onMessage subscription via ref to avoid re-subscribing on callback identity change
    const onMessageRef = useRef(options.onMessage);
    onMessageRef.current = options.onMessage;
    useEffect(() => {
        if (!onMessageRef.current) return;
        const handler = (msg: WsMessage) => onMessageRef.current?.(msg);
        return ctx.subscribe(handler);
    }, [ctx.subscribe]);

    // Forward status changes
    const onStatusChangeRef = useRef(options.onStatusChange);
    onStatusChangeRef.current = options.onStatusChange;
    useEffect(() => {
        onStatusChangeRef.current?.(ctx.status);
    }, [ctx.status]);

    return {
        status: ctx.status,
        connect: ctx.connect,
        disconnect: ctx.disconnect,
        sendRpc: ctx.sendRpc,
        isConnected: ctx.isConnected,
    };
}
