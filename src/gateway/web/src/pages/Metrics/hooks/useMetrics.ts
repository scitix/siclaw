import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';

export interface TimeseriesBucket {
    timestamp: number;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    costUsd: number;
    promptCount: number;
    promptErrors: number;
    promptDurationAvg: number;
    promptDurationMax: number;
    activeSessions: number;
    wsConnections: number;
    toolCalls: number;
    toolErrors: number;
}

export interface ToolCallStats {
    toolName: string;
    success: number;
    error: number;
    total: number;
}

export interface TimeseriesResponse {
    buckets: TimeseriesBucket[];
    snapshot: { activeSessions: number; wsConnections: number };
    topTools: ToolCallStats[];
}

export interface SummaryResponse {
    totalTokens: number;
    totalCostUsd: number;
    totalPrompts: number;
    totalSessions: number;
    byModel: Array<{
        provider: string;
        model: string;
        tokens: number;
        costUsd: number;
        percentage: number;
    }>;
}

export type TimeRange = '1h' | '6h' | '24h';
export type SummaryPeriod = 'today' | '7d' | '30d';

export function useMetrics(range: TimeRange) {
    const { sendRpc, isConnected } = useWebSocket();
    const [data, setData] = useState<TimeseriesResponse | null>(null);
    const [loading, setLoading] = useState(true);

    const fetch = useCallback(async () => {
        if (!isConnected) return;
        try {
            const result = await sendRpc<TimeseriesResponse>('metrics.timeseries', { range });
            setData(result);
        } catch (err) {
            console.warn('[useMetrics] fetch error:', err);
        } finally {
            setLoading(false);
        }
    }, [sendRpc, isConnected, range]);

    // Initial load + range change
    useEffect(() => {
        setLoading(true);
        fetch();
    }, [fetch]);

    // Auto-refresh every 30s
    useEffect(() => {
        const interval = setInterval(fetch, 30_000);
        return () => clearInterval(interval);
    }, [fetch]);

    return { data, loading, refresh: fetch };
}

export function useSummary(period: SummaryPeriod) {
    const { sendRpc, isConnected } = useWebSocket();
    const [data, setData] = useState<SummaryResponse | null>(null);
    const [loading, setLoading] = useState(true);

    const fetch = useCallback(async () => {
        if (!isConnected) return;
        try {
            const result = await sendRpc<SummaryResponse>('metrics.summary', { period });
            setData(result);
        } catch (err) {
            console.warn('[useSummary] fetch error:', err);
        } finally {
            setLoading(false);
        }
    }, [sendRpc, isConnected, period]);

    useEffect(() => {
        setLoading(true);
        fetch();
    }, [fetch]);

    return { data, loading, refresh: fetch };
}
