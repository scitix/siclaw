import { Search, Plus, Trash2, Eraser } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState } from 'react';
import type { Session } from '@/hooks/usePilot';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface SessionListProps {
    sessions: Session[];
    currentSessionKey: string | null;
    onSelectSession: (key: string) => void;
    onNewSession: () => void;
    onDeleteSession?: (key: string) => void;
    onClearMemory?: () => Promise<void>;
}

export function SessionList({
    sessions,
    currentSessionKey,
    onSelectSession,
    onNewSession,
    onDeleteSession,
    onClearMemory,
}: SessionListProps) {
    const [search, setSearch] = useState('');
    const [showClearConfirm, setShowClearConfirm] = useState(false);

    const filtered = search
        ? sessions.filter(s =>
            (s.title || '').toLowerCase().includes(search.toLowerCase()) ||
            (s.preview || '').toLowerCase().includes(search.toLowerCase())
        )
        : sessions;

    const formatTime = (dateStr?: string) => {
        if (!dateStr) return '';
        try {
            const d = new Date(dateStr);
            const now = new Date();
            const diffMs = now.getTime() - d.getTime();
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

            if (diffDays === 0) {
                return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            } else if (diffDays === 1) {
                return 'Yesterday';
            } else if (diffDays < 7) {
                return d.toLocaleDateString([], { weekday: 'short' });
            }
            return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        } catch {
            return '';
        }
    };

    return (
        <div className="h-full flex flex-col bg-gray-50/50">
            {/* Search Header */}
            <div className="p-4 border-b border-gray-200 bg-white">
                <div className="relative group">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-primary-500 transition-colors" />
                    <input
                        type="text"
                        placeholder="Search..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:border-primary-500 focus:bg-white transition-all placeholder:text-gray-400"
                    />
                </div>
                <button
                    onClick={onNewSession}
                    className="w-full mt-3 flex items-center justify-center gap-2 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:border-primary-200 hover:text-primary-600 transition-all shadow-sm"
                >
                    <Plus className="w-4 h-4" />
                    New Session
                </button>
            </div>

            {/* Clear Memory Confirm Dialog */}
            <ConfirmDialog
                isOpen={showClearConfirm}
                onClose={() => setShowClearConfirm(false)}
                onConfirm={async () => {
                    if (!onClearMemory) return;
                    await onClearMemory();
                }}
                title="Clear Memory"
                description="This will permanently delete all conversation memories for this workspace. This action cannot be undone."
                confirmText="Clear Memory"
                variant="danger"
                successMessage="Memory cleared successfully."
            />

            {/* List */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
                <div className="px-2 pb-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">Recent</div>
                {filtered.length === 0 && (
                    <div className="px-2 py-8 text-center text-sm text-gray-400">
                        {search ? 'No matching sessions' : 'No sessions yet'}
                    </div>
                )}
                {filtered.map((session) => {
                    const isActive = session.key === currentSessionKey;
                    return (
                        <div
                            key={session.key}
                            onClick={() => onSelectSession(session.key)}
                            className={cn(
                                "p-3 rounded-lg cursor-pointer transition-all border group relative",
                                isActive
                                    ? "bg-white border-primary-200 shadow-sm ring-1 ring-primary-50 text-gray-900"
                                    : "bg-transparent border-transparent hover:bg-white hover:border-gray-200 hover:shadow-sm text-gray-600"
                            )}
                        >
                            <div className="flex justify-between items-start mb-1">
                                <h3 className={cn(
                                    "font-semibold text-sm truncate pr-2",
                                    isActive ? "text-primary-700" : "text-gray-900"
                                )}>
                                    {session.title || 'Untitled Session'}
                                </h3>
                                <div className="flex items-center gap-1 shrink-0">
                                    <span className="text-[10px] text-gray-400 pt-0.5">
                                        {formatTime(session.lastActiveAt || session.createdAt)}
                                    </span>
                                    {onDeleteSession && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onDeleteSession(session.key);
                                            }}
                                            className="p-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                                        >
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            <p className="text-xs text-gray-500 truncate">
                                {session.preview || '\u00A0'}
                            </p>
                        </div>
                    );
                })}
            </div>

            {/* Clear Memory */}
            {onClearMemory && (
                <div className="p-3 border-t border-gray-200 bg-white">
                    <button
                        onClick={() => setShowClearConfirm(true)}
                        className="w-full flex items-center justify-center gap-2 py-2 text-sm font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 hover:border-red-300 transition-all"
                    >
                        <Eraser className="w-4 h-4" />
                        Clear Memory
                    </button>
                </div>
            )}
        </div>
    );
}
