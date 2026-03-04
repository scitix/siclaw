import { X, Save, Trash2, Plus } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { McpServer, McpTransport } from '../mcpServerData';
import { MCP_TRANSPORT_OPTIONS } from '../mcpServerData';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface McpServerDrawerProps {
    server: McpServer | null;
    isOpen: boolean;
    onClose: () => void;
    onSave: (data: {
        name: string;
        transport: McpTransport;
        url?: string;
        command?: string;
        argsJson?: string[];
        envJson?: Record<string, string>;
        headersJson?: Record<string, string>;
        description?: string;
    }) => Promise<void>;
    onUpdate: (id: string, data: {
        name?: string;
        transport?: string;
        url?: string;
        command?: string;
        argsJson?: string[];
        envJson?: Record<string, string>;
        headersJson?: Record<string, string>;
        description?: string;
    }) => Promise<void>;
}

interface KVPair { key: string; value: string }

function kvToRecord(pairs: KVPair[]): Record<string, string> | undefined {
    const filtered = pairs.filter(p => p.key.trim());
    if (filtered.length === 0) return undefined;
    const obj: Record<string, string> = {};
    for (const p of filtered) obj[p.key.trim()] = p.value;
    return obj;
}

function recordToKv(rec?: Record<string, string> | null): KVPair[] {
    if (!rec || Object.keys(rec).length === 0) return [{ key: '', value: '' }];
    return [...Object.entries(rec).map(([key, value]) => ({ key, value })), { key: '', value: '' }];
}

function KVEditor({ label, pairs, onChange }: { label: string; pairs: KVPair[]; onChange: (p: KVPair[]) => void }) {
    const updatePair = (idx: number, field: 'key' | 'value', val: string) => {
        const next = pairs.map((p, i) => i === idx ? { ...p, [field]: val } : p);
        onChange(next);
    };
    const removePair = (idx: number) => {
        const next = pairs.filter((_, i) => i !== idx);
        if (next.length === 0) next.push({ key: '', value: '' });
        onChange(next);
    };
    const addPair = () => {
        onChange([...pairs, { key: '', value: '' }]);
    };
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">{label}</label>
                <button
                    type="button"
                    onClick={addPair}
                    className="flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-primary-600 hover:text-primary-700 hover:bg-primary-50 rounded-md transition-colors"
                >
                    <Plus className="w-3.5 h-3.5" />
                    Add
                </button>
            </div>
            <div className="space-y-2">
                {pairs.map((pair, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                        <input
                            type="text"
                            value={pair.key}
                            onChange={(e) => updatePair(idx, 'key', e.target.value)}
                            placeholder="Key"
                            className="flex-1 px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                        />
                        <input
                            type="text"
                            value={pair.value}
                            onChange={(e) => updatePair(idx, 'value', e.target.value)}
                            placeholder="Value"
                            className="flex-1 px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                        />
                        {pairs.length > 1 && (
                            <button
                                type="button"
                                onClick={() => removePair(idx)}
                                className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

export function McpServerDrawer({ server, isOpen, onClose, onSave, onUpdate }: McpServerDrawerProps) {
    const isEditing = !!server;

    const [transport, setTransport] = useState<McpTransport>('streamable-http');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [url, setUrl] = useState('');
    const [command, setCommand] = useState('');
    const [argsStr, setArgsStr] = useState('');
    const [envPairs, setEnvPairs] = useState<KVPair[]>([{ key: '', value: '' }]);
    const [headerPairs, setHeaderPairs] = useState<KVPair[]>([{ key: '', value: '' }]);

    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setError('');
            setSaving(false);
            if (server) {
                setTransport(server.transport);
                setName(server.name);
                setDescription(server.description ?? '');
                setUrl(server.url ?? '');
                setCommand(server.command ?? '');
                setArgsStr(server.argsJson?.join(' ') ?? '');
                setEnvPairs(recordToKv(server.envJson));
                setHeaderPairs(recordToKv(server.headersJson));
            } else {
                setTransport('streamable-http');
                setName('');
                setDescription('');
                setUrl('');
                setCommand('');
                setArgsStr('');
                setEnvPairs([{ key: '', value: '' }]);
                setHeaderPairs([{ key: '', value: '' }]);
            }
        }
    }, [isOpen, server]);

    const hasRequiredFields = (): boolean => {
        if (!name.trim()) return false;
        if (transport === 'stdio') return !!command.trim();
        return !!url.trim();
    };

    const handleSave = async () => {
        if (saving) return;
        setSaving(true);
        setError('');
        try {
            const data: Record<string, unknown> = {
                name,
                transport,
                description: description || undefined,
            };
            if (transport === 'stdio') {
                data.command = command;
                if (argsStr.trim()) data.argsJson = argsStr.split(/\s+/).filter(Boolean);
                data.envJson = kvToRecord(envPairs);
            } else {
                data.url = url;
                data.headersJson = kvToRecord(headerPairs);
            }

            if (isEditing) {
                await onUpdate(server!.id, data as any);
            } else {
                await onSave(data as any);
            }
            onClose();
        } catch (err: any) {
            setError(err?.message || 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const title = isEditing ? 'Edit MCP Server' : 'New MCP Server';
    const subtitle = isEditing ? server.name : 'Register a new MCP server';

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
                                <h2 className="text-lg font-bold text-gray-900">{title}</h2>
                                <p className="text-xs text-gray-400">{subtitle}</p>
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
                            {/* Transport selector */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">
                                    Transport <span className="text-red-500">*</span>
                                </label>
                                <div className="grid grid-cols-3 gap-2">
                                    {MCP_TRANSPORT_OPTIONS.map((opt) => {
                                        const selected = transport === opt.value;
                                        return (
                                            <button
                                                key={opt.value}
                                                type="button"
                                                disabled={isEditing}
                                                onClick={() => setTransport(opt.value)}
                                                className={cn(
                                                    "px-3 py-2 rounded-lg border text-sm font-medium transition-colors text-center",
                                                    selected
                                                        ? "border-primary-500 bg-primary-50 text-primary-700"
                                                        : "border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50",
                                                    isEditing && "opacity-60 cursor-not-allowed"
                                                )}
                                            >
                                                {opt.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Name */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">
                                    Name <span className="text-red-500">*</span>
                                </label>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="e.g. tools-server, filesystem"
                                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                />
                            </div>

                            {/* Description */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">Description</label>
                                <input
                                    type="text"
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    placeholder="Optional description"
                                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                />
                            </div>

                            {/* Transport-specific fields */}
                            {transport === 'stdio' ? (
                                <div className="space-y-4">
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            Command <span className="text-red-500">*</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={command}
                                            onChange={(e) => setCommand(e.target.value)}
                                            placeholder="e.g. npx, node, python"
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">Arguments</label>
                                        <input
                                            type="text"
                                            value={argsStr}
                                            onChange={(e) => setArgsStr(e.target.value)}
                                            placeholder="e.g. -y @modelcontextprotocol/server-filesystem /workspace"
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                        <p className="text-xs text-gray-400">Space-separated arguments</p>
                                    </div>
                                    <KVEditor label="Environment Variables" pairs={envPairs} onChange={setEnvPairs} />
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            URL <span className="text-red-500">*</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={url}
                                            onChange={(e) => setUrl(e.target.value)}
                                            placeholder="http://localhost:8000/mcp"
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                    <KVEditor label="Headers" pairs={headerPairs} onChange={setHeaderPairs} />
                                </div>
                            )}

                            {error && (
                                <p className="text-xs text-red-500">{error}</p>
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
                                disabled={!hasRequiredFields() || saving}
                                className="px-4 py-2 text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 rounded-lg shadow-sm flex items-center gap-2 disabled:opacity-50"
                            >
                                <Save className="w-4 h-4" />
                                {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Server'}
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
