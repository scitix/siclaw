import { X, Save, Copy, Check, Info } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { TriggerEndpoint, ICON_OPTIONS } from '../triggersData';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface TriggerDrawerProps {
    trigger: TriggerEndpoint | null;
    isOpen: boolean;
    onClose: () => void;
    onSave: (trigger: Partial<TriggerEndpoint>) => Promise<void>;
}

export function TriggerDrawer({ trigger, isOpen, onClose, onSave }: TriggerDrawerProps) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [type, setType] = useState<'webhook' | 'websocket'>('webhook');
    const [icon, setIcon] = useState('zap');
    const [copied, setCopied] = useState(false);
    const [saving, setSaving] = useState(false);

    // Reset or load data when drawer opens
    useEffect(() => {
        if (isOpen) {
            if (trigger) {
                setName(trigger.name);
                setDescription(trigger.description);
                setType(trigger.type);
                setIcon(trigger.icon || 'zap');
            } else {
                // New trigger defaults
                setName('');
                setDescription('');
                setType('webhook');
                setIcon('zap');
            }
        }
    }, [isOpen, trigger]);

    const handleSave = async () => {
        if (!name.trim() || saving) return;

        setSaving(true);
        try {
            await onSave({
                id: trigger?.id,
                name,
                description,
                type,
                status: trigger?.status || 'active',
                icon,
            });
        } finally {
            setSaving(false);
        }
    };

    const handleCopy = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

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
                            <div>
                                <h2 className="text-lg font-bold text-gray-900">{trigger ? 'Endpoint Details' : 'New Endpoint'}</h2>
                                <p className="text-xs text-gray-400">Configure inbound integration</p>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6">
                            {/* Type Selection */}
                            <div className="space-y-3">
                                <label className="text-sm font-medium text-gray-700">Endpoint Type</label>
                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        onClick={() => setType('webhook')}
                                        disabled={!!trigger} // Type immutable after creation
                                        className={cn(
                                            "p-3 rounded-lg border text-left transition-all relative overflow-hidden",
                                            type === 'webhook'
                                                ? "border-primary-500 bg-primary-50/50 text-primary-700 ring-1 ring-primary-500"
                                                : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
                                            !!trigger && type !== 'webhook' && "opacity-50 cursor-not-allowed"
                                        )}
                                    >
                                        <div className="font-semibold text-sm mb-0.5">Webhook</div>
                                        <div className="text-[10px] opacity-70">HTTP POST payloads</div>
                                    </button>
                                    <button
                                        onClick={() => setType('websocket')}
                                        disabled={!!trigger}
                                        className={cn(
                                            "p-3 rounded-lg border text-left transition-all relative overflow-hidden",
                                            type === 'websocket'
                                                ? "border-primary-500 bg-primary-50/50 text-primary-700 ring-1 ring-primary-500"
                                                : "border-gray-200 hover:border-gray-300 hover:bg-gray-50",
                                            !!trigger && type !== 'websocket' && "opacity-50 cursor-not-allowed"
                                        )}
                                    >
                                        <div className="font-semibold text-sm mb-0.5">WebSocket</div>
                                        <div className="text-[10px] opacity-70">Coming Soon</div>
                                    </button>
                                </div>
                            </div>

                            {/* Icon Selection */}
                            <div className="space-y-3">
                                <label className="text-sm font-medium text-gray-700">Display Icon</label>
                                <div className="grid grid-cols-6 gap-2">
                                    {ICON_OPTIONS.map((option) => (
                                        <button
                                            key={option.id}
                                            onClick={() => setIcon(option.id)}
                                            className={cn(
                                                "aspect-square flex flex-col items-center justify-center rounded-lg border transition-all hover:bg-gray-50",
                                                icon === option.id
                                                    ? "border-primary-500 bg-primary-50 text-primary-600 ring-1 ring-primary-500"
                                                    : "border-gray-200 text-gray-500"
                                            )}
                                            title={option.label}
                                        >
                                            <option.icon className="w-5 h-5" />
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Basic Info */}
                            <div className="space-y-4">
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-700">Name <span className="text-red-500">*</span></label>
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        placeholder="e.g. Grafana Production"
                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium text-gray-700">Description</label>
                                    <textarea
                                        value={description}
                                        onChange={(e) => setDescription(e.target.value)}
                                        placeholder="Optional description..."
                                        rows={3}
                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none"
                                    />
                                </div>
                            </div>

                            {/* Connection Details (Only if editing existing trigger) */}
                            {trigger && trigger.endpointUrl && (
                                <div className="mt-6 space-y-4 pt-6 border-t border-gray-100">
                                    <h3 className="text-sm font-semibold text-gray-900">Connection Details</h3>

                                    <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 space-y-4">
                                        <div>
                                            <div className="flex items-center justify-between mb-1.5">
                                                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                                                    {type === 'webhook' ? 'Endpoint URL' : 'Stream URL'}
                                                </label>
                                                <button
                                                    onClick={() => handleCopy(trigger.endpointUrl)}
                                                    className="text-primary-600 hover:text-primary-700 text-xs font-medium flex items-center gap-1"
                                                >
                                                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                                    {copied ? 'Copied' : 'Copy'}
                                                </button>
                                            </div>
                                            <div className="font-mono text-xs text-gray-700 bg-white border border-gray-200 rounded p-2 break-all select-all">
                                                {trigger.endpointUrl}
                                            </div>
                                        </div>

                                        {trigger.secret && (
                                            <div>
                                                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                                                    Authentication Header
                                                </div>
                                                <div className="bg-white border border-gray-200 rounded p-3">
                                                    <div className="flex gap-2 font-mono text-xs text-blue-600">
                                                        <span className="shrink-0 selection:bg-blue-100">Authorization: Bearer</span>
                                                        <span className="text-gray-600 break-all select-all">{trigger.secret}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex gap-3 p-3 bg-blue-50 text-blue-700 rounded-lg text-xs leading-relaxed">
                                        <Info className="w-4 h-4 shrink-0 mt-0.5" />
                                        Use the URL and Secret above to configure your third-party service provider. Incoming events will be processed by the Rules Engine.
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="p-6 border-t border-gray-100 bg-white flex items-center justify-end gap-3">
                            <button
                                onClick={onClose}
                                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-50 rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={!name.trim() || saving}
                                className="px-4 py-2 text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 rounded-lg shadow-sm flex items-center gap-2 disabled:opacity-50"
                            >
                                <Save className="w-4 h-4" />
                                {saving ? 'Saving...' : trigger ? 'Save Changes' : 'Create Endpoint'}
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
