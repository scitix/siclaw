import { useState, useCallback } from 'react';
import type { ChannelView } from '../pages/Channels/channelsData';

interface UseChannelsResult {
    channels: ChannelView[];
    loading: boolean;
    loadChannels: () => Promise<void>;
    saveChannel: (id: string, enabled: boolean, config: Record<string, unknown>) => Promise<void>;
}

export function useChannels(
    sendRpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>,
): UseChannelsResult {
    const [channels, setChannels] = useState<ChannelView[]>([]);
    const [loading, setLoading] = useState(true);

    const loadChannels = useCallback(async () => {
        try {
            const result = await sendRpc<{ channels: ChannelView[] }>('channels.list');
            setChannels(result.channels);
        } catch (err) {
            console.error('[useChannels] Failed to load:', err);
        } finally {
            setLoading(false);
        }
    }, [sendRpc]);

    const saveChannel = useCallback(async (
        id: string,
        enabled: boolean,
        config: Record<string, unknown>,
    ) => {
        await sendRpc('channels.save', { id, enabled, config });
        await loadChannels();
    }, [sendRpc, loadChannels]);

    return { channels, loading, loadChannels, saveChannel };
}
