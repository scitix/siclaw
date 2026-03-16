import { useState, useEffect, useRef } from 'react';
import { ShieldX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePermissions } from '@/hooks/usePermissions';
import { useChannels } from '@/hooks/useChannels';
import { mergeChannels, type Channel } from './channelsData';
import { ChannelDrawer } from './components/ChannelDrawer';

export function ChannelsPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { isAdmin, loaded } = usePermissions(sendRpc, isConnected);
    const { channels: views, loading, loadChannels, saveChannel } = useChannels(sendRpc);
    const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);

    // Load channels when WebSocket first connects
    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (isConnected && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadChannels();
        }
    }, [isConnected, loadChannels]);

    const channels = mergeChannels(views);

    const handleConfigure = (channel: Channel) => {
        if (channel.comingSoon) return;
        setSelectedChannel(channel);
        setIsDrawerOpen(true);
    };

    const handleSaveChannel = async (id: string, enabled: boolean, config: Record<string, unknown>) => {
        await saveChannel(id, enabled, config);
        setIsDrawerOpen(false);
    };

    if (loaded && !isAdmin) {
        return (
            <div className="h-full flex items-center justify-center">
                <div className="text-center">
                    <ShieldX className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Admin access required</h2>
                    <p className="text-sm text-gray-500">Only administrators can manage channels.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full bg-white flex flex-col">
            {/* Header */}
            <header className="h-16 flex items-center justify-end px-6 bg-white sticky top-0 z-10">
                <div className="flex items-center gap-2">
                    {/* Future actions */}
                </div>
            </header>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-5xl mx-auto space-y-6">
                    {loading ? (
                        <div className="text-center text-gray-400 py-12">Loading channels...</div>
                    ) : (
                        <div className="grid grid-cols-1 gap-4">
                            {channels.map((channel) => (
                                <div
                                    key={channel.id}
                                    className={cn(
                                        "group bg-white rounded-xl border border-gray-200 p-5 flex items-center justify-between transition-all",
                                        channel.comingSoon
                                            ? "opacity-60"
                                            : "hover:border-primary-200 hover:shadow-sm"
                                    )}
                                >
                                    <div className="flex items-center gap-5">
                                        <div className={cn(
                                            "w-8 h-8 rounded-lg flex items-center justify-center border transition-colors",
                                            channel.status === 'connected'
                                                ? "bg-white border-gray-200"
                                                : "bg-gray-50 border-gray-200 grayscale"
                                        )}>
                                            <channel.icon className={cn(
                                                "w-4 h-4",
                                                channel.status === 'connected' ? "text-gray-900" : "text-gray-400"
                                            )} />
                                        </div>

                                        <div>
                                            <div className="flex items-center gap-2 mb-0.5">
                                                <h3 className="font-bold text-gray-900">{channel.name}</h3>
                                                {channel.comingSoon && (
                                                    <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 text-[10px] font-bold uppercase tracking-wide border border-gray-200">
                                                        Coming Soon
                                                    </span>
                                                )}
                                                {!channel.comingSoon && channel.status === 'connected' && (
                                                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 text-[10px] font-bold uppercase tracking-wide border border-green-100">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                                                        Active
                                                    </span>
                                                )}
                                                {!channel.comingSoon && channel.status === 'error' && (
                                                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-700 text-[10px] font-bold uppercase tracking-wide border border-red-100">
                                                        Error
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-sm text-gray-500 max-w-xl">{channel.description}</p>
                                            {channel.status === 'error' && channel.error && (
                                                <p className="text-xs text-red-500 mt-1 max-w-xl truncate">{channel.error}</p>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-4">
                                        <div className="text-right hidden sm:block min-w-[100px]">
                                            <div className="text-xs font-medium text-gray-400">Status</div>
                                            <div className={cn(
                                                "text-sm font-medium",
                                                channel.status === 'connected' ? "text-green-600" :
                                                channel.status === 'error' ? "text-red-500" :
                                                "text-gray-400"
                                            )}>
                                                {channel.comingSoon ? 'Coming Soon' :
                                                 channel.status === 'connected' ? 'Operational' :
                                                 channel.status === 'error' ? 'Error' :
                                                 'Not Configured'}
                                            </div>
                                        </div>

                                        <div className="h-8 w-px bg-gray-100 hidden sm:block" />

                                        <button
                                            onClick={() => handleConfigure(channel)}
                                            disabled={channel.comingSoon}
                                            className={cn(
                                                "px-4 py-2 rounded-lg font-medium text-sm transition-colors shadow-sm border min-w-[100px]",
                                                channel.comingSoon
                                                    ? "bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed"
                                                    : channel.status === 'connected'
                                                        ? "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
                                                        : "bg-primary-600 border-primary-600 text-white hover:bg-primary-700"
                                            )}
                                        >
                                            {channel.comingSoon ? 'Coming Soon' :
                                             channel.status === 'connected' ? 'Configure' : 'Connect'}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <ChannelDrawer
                channel={selectedChannel}
                isOpen={isDrawerOpen}
                onClose={() => setIsDrawerOpen(false)}
                onSave={handleSaveChannel}
            />
        </div>
    );
}
