import { X, Save } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { type Channel } from '../channelsData';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface ChannelDrawerProps {
    channel: Channel | null;
    isOpen: boolean;
    onClose: () => void;
    onSave: (id: string, enabled: boolean, config: Record<string, unknown>) => void;
}

export function ChannelDrawer({ channel, isOpen, onClose, onSave }: ChannelDrawerProps) {
    const [config, setConfig] = useState<Record<string, unknown>>({});
    const [enabled, setEnabled] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (channel) {
            setConfig({ ...channel.config });
            setEnabled(channel.enabled);
        }
    }, [channel]);

    const handleSave = async () => {
        if (!channel || saving) return;
        setSaving(true);
        try {
            await onSave(channel.id, enabled, config);
        } finally {
            setSaving(false);
        }
    };

    if (!channel) return null;

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
                    />
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed right-0 top-0 bottom-0 w-[480px] bg-white shadow-2xl z-50 flex flex-col border-l border-gray-100"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-white">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-gray-50 rounded-lg border border-gray-100">
                                    <channel.icon className="w-5 h-5 text-gray-700" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900">{channel.name}</h2>
                                    <p className="text-xs text-gray-400">Configuration</p>
                                </div>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6">
                            <div className="space-y-6">
                                {/* Enable Switch */}
                                <div className="flex items-center justify-between p-4 bg-gray-50/50 rounded-xl border border-gray-100">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-sm font-medium text-gray-900">Enable Integration</span>
                                        <span className="text-xs text-gray-500">Allow Siclaw to use this channel</span>
                                    </div>
                                    <button
                                        onClick={() => setEnabled(!enabled)}
                                        className={cn(
                                            "w-11 h-6 rounded-full transition-colors relative",
                                            enabled ? "bg-primary-600" : "bg-gray-200"
                                        )}
                                    >
                                        <span className={cn(
                                            "w-4 h-4 rounded-full bg-white shadow-sm absolute top-1 transition-all",
                                            enabled ? "left-6" : "left-1"
                                        )} />
                                    </button>
                                </div>

                                <div className="h-px bg-gray-100 w-full" />

                                {/* Forms based on Type */}
                                <div className="space-y-4">
                                    {channel.id === 'lark' && (
                                        <>
                                            <InputField
                                                label="App ID"
                                                value={(config.appId as string) || ''}
                                                onChange={(v: string) => setConfig({ ...config, appId: v })}
                                                placeholder="cli_..."
                                                required
                                            />
                                            <InputField
                                                label="App Secret"
                                                value={(config.appSecret as string) || ''}
                                                onChange={(v: string) => setConfig({ ...config, appSecret: v })}
                                                placeholder="Your app secret..."
                                                type="password"
                                                required
                                            />
                                        </>
                                    )}

                                    {channel.id === 'telegram' && (
                                        <InputField
                                            label="Bot Token"
                                            value={(config.botToken as string) || ''}
                                            onChange={(v: string) => setConfig({ ...config, botToken: v })}
                                            placeholder="123456:ABC-DEF..."
                                            type="password"
                                            required
                                        />
                                    )}

                                    {channel.id === 'slack' && (
                                        <>
                                            <InputField
                                                label="Bot Token"
                                                value={(config.botToken as string) || ''}
                                                onChange={(v: string) => setConfig({ ...config, botToken: v })}
                                                placeholder="xoxb-..."
                                                type="password"
                                                required
                                            />
                                            <InputField
                                                label="App Token"
                                                value={(config.appToken as string) || ''}
                                                onChange={(v: string) => setConfig({ ...config, appToken: v })}
                                                placeholder="xapp-..."
                                                type="password"
                                                required
                                            />
                                        </>
                                    )}

                                    {channel.id === 'discord' && (
                                        <InputField
                                            label="Bot Token"
                                            value={(config.token as string) || ''}
                                            onChange={(v: string) => setConfig({ ...config, token: v })}
                                            placeholder="Your bot token..."
                                            type="password"
                                            required
                                        />
                                    )}

                                    {channel.id === 'whatsapp' && (
                                        <>
                                            <InputField
                                                label="Access Token"
                                                value={(config.accessToken as string) || ''}
                                                onChange={(v: string) => setConfig({ ...config, accessToken: v })}
                                                placeholder="Your access token..."
                                                type="password"
                                                required
                                            />
                                            <InputField
                                                label="Phone Number ID"
                                                value={(config.phoneNumberId as string) || ''}
                                                onChange={(v: string) => setConfig({ ...config, phoneNumberId: v })}
                                                placeholder="Phone number ID..."
                                                required
                                            />
                                        </>
                                    )}

                                </div>

                                {/* Error display */}
                                {channel.status === 'error' && channel.error && (
                                    <div className="p-3 bg-red-50 border border-red-100 rounded-lg">
                                        <p className="text-sm text-red-700 font-medium">Connection Error</p>
                                        <p className="text-xs text-red-600 mt-1">{channel.error}</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="p-6 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between">
                            <span className="text-xs text-gray-400">
                                {channel.status === 'connected' ? 'Currently Connected' :
                                 channel.status === 'error' ? 'Connection Error' :
                                 'Not Connected'}
                            </span>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={onClose}
                                    className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="px-4 py-2 text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 rounded-lg shadow-sm flex items-center gap-2 disabled:opacity-50"
                                >
                                    <Save className="w-4 h-4" />
                                    {saving ? 'Saving...' : 'Save Configuration'}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}

function InputField({ label, value, onChange, placeholder, type = "text", required }: any) {
    return (
        <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 flex items-center gap-1">
                {label}
                {required && <span className="text-red-500">*</span>}
            </label>
            <input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all font-mono"
            />
        </div>
    );
}
