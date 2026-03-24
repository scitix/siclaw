import { ArrowUp, Square, X, Loader2, BookOpen, SearchCode, MessageSquareHeart, Plus, Check } from 'lucide-react';
import type { ContextUsage } from '@/hooks/usePilot';
import { useState, useCallback, useRef, useEffect, KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

/** Format token count: 0 → "0", 1234 → "1.2k", 12345 → "12.3k", 123456 → "123k" */
function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + 'k';
    if (n < 100000) return (n / 1000).toFixed(1) + 'k';
    return Math.round(n / 1000) + 'k';
}

/** Format cost: $0.0012 → "$0.001", $1.23 → "$1.23" */
function formatCost(cost: number): string {
    if (cost < 0.01) return '$' + cost.toFixed(3);
    return '$' + cost.toFixed(2);
}

interface InputAreaProps {
    onSend: (message: string) => void;
    onAbort?: () => void;
    disabled?: boolean;
    isLoading?: boolean;
    contextUsage?: ContextUsage | null;
    isCompacting?: boolean;
    editingSkill?: { id: string; name: string } | null;
    onClearEditSkill?: () => void;
    pendingMessages?: string[];
    onRemovePending?: (index: number) => void;
    dpFocus?: string | null;
    dpActive?: boolean;
    onSetDpActive?: (active: boolean) => void;
    /** Whether the session has messages — gates feedback button visibility */
    hasMessages?: boolean;
    /** External draft text — when changed, populates the input and focuses it */
    draft?: string | null;
    /** Sequence counter — ensures useEffect fires even for repeated same-value drafts */
    draftSeq?: number;
}

export function InputArea({ onSend, onAbort, disabled, isLoading, contextUsage, isCompacting, editingSkill, onClearEditSkill, pendingMessages, onRemovePending, dpFocus, dpActive, onSetDpActive, hasMessages, draft, draftSeq }: InputAreaProps) {
    const [value, setValue] = useState('');
    const [isFocused, setIsFocused] = useState(false);
    const isComposingRef = useRef(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // When external draft changes, populate input and focus
    useEffect(() => {
        if (draft) {
            setValue(draft);
            setTimeout(() => {
                const el = textareaRef.current;
                if (el) {
                    el.focus();
                    el.setSelectionRange(draft.length, draft.length);
                }
            }, 0);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft, draftSeq]);

    // Deep investigation toggle — controlled by parent (usePilot manages state)
    const deepInvestigation = dpActive ?? false;
    const setDeepInvestigation = onSetDpActive ?? (() => {});


    // Action menu state
    const [showActionMenu, setShowActionMenu] = useState(false);

    const handleSend = useCallback(async () => {
        const text = value.trim();
        if (!text || disabled) return;

        let fullMessage = '';

        // If DP toggle is on, always prepend marker.
        // Backend extension decides behavior based on dpStatus (idle → activate, else → strip and passthrough).
        if (deepInvestigation) {
            fullMessage += '[Deep Investigation]\n';
        }

        // If a skill is selected, prepend a compact reference marker
        if (editingSkill) {
            fullMessage += `[Skill: ${editingSkill.name}]\n`;
        }

        fullMessage += text;

        onSend(fullMessage.trim());
        setValue('');
        // Don't clear editingSkill here — keep it for SkillCard to know it's an update
    }, [value, disabled, onSend, editingSkill, deepInvestigation]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current && !e.nativeEvent.isComposing) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    const hasContent = value.trim();

    return (
        <>
            <div className="w-full px-4 pb-2 z-20 bg-gradient-to-t from-gray-50 via-gray-50 to-transparent pt-10">
                <div className="max-w-5xl mx-auto">
                    <div
                        className={cn(
                            "relative bg-white rounded-[24px] shadow-lg border transition-all duration-200",
                            isFocused
                                ? "border-gray-300 shadow-xl"
                                : "border-gray-200",
                            disabled && "opacity-60"
                        )}
                    >
                        {/* Toolbar */}
                        <div className="flex items-center gap-1 px-4 pt-3 pb-1 min-w-0">
                            <div className="relative">
                                <button
                                    type="button"
                                    onClick={() => setShowActionMenu(!showActionMenu)}
                                    disabled={disabled}
                                    className={cn(
                                        "p-1.5 rounded-lg transition-colors disabled:opacity-50",
                                        showActionMenu
                                            ? "text-gray-600 bg-gray-100"
                                            : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                                    )}
                                    title="Actions"
                                >
                                    <Plus className="w-4 h-4" />
                                </button>

                                {showActionMenu && (
                                    <>
                                        <div className="fixed inset-0 z-10" onClick={() => setShowActionMenu(false)} />
                                        <div className="absolute bottom-full left-0 mb-1 bg-white rounded-xl shadow-xl border border-gray-200 z-20 w-[220px]">
                                            <div className="py-1">
                                                {/* Deep Investigation */}
                                                <button
                                                    type="button"
                                                    onClick={() => setDeepInvestigation(!deepInvestigation)}
                                                    className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-gray-50 transition-colors"
                                                >
                                                    <SearchCode className="w-4 h-4 text-blue-500 shrink-0" />
                                                    <span className="flex-1 text-sm text-gray-700">Deep Investigation</span>
                                                    {deepInvestigation && <Check className="w-4 h-4 text-blue-500 shrink-0" />}
                                                </button>

                                                {/* Session Feedback — only visible when session has messages */}
                                                {!isLoading && hasMessages && (
                                                    <button
                                                        type="button"
                                                        onClick={() => { onSend("[Feedback]"); setShowActionMenu(false); }}
                                                        className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-gray-50 transition-colors"
                                                    >
                                                        <MessageSquareHeart className="w-4 h-4 text-emerald-500 shrink-0" />
                                                        <span className="flex-1 text-sm text-gray-700">Session Feedback</span>
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                            <div className="ml-auto flex items-center gap-3 shrink-0" />
                        </div>

                        {/* Mode chips */}
                        {(deepInvestigation || editingSkill) && (
                            <div className="flex flex-wrap gap-2 px-4 pb-1">
                                {deepInvestigation && (
                                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium bg-blue-50 border-blue-200 text-blue-700">
                                        <SearchCode className="w-3.5 h-3.5 text-blue-500" />
                                        <span>Deep Investigation</span>
                                        {dpFocus && (
                                            <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 text-[10px] font-semibold uppercase">
                                                {dpFocus.replace(/_/g, ' ')}
                                            </span>
                                        )}
                                        <button
                                            type="button"
                                            className="ml-0.5 p-0.5 rounded hover:bg-blue-200 transition-colors"
                                            onClick={() => setDeepInvestigation(false)}
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Skill editing chip */}
                        {editingSkill && (
                            <div className="flex flex-wrap gap-2 px-4 pb-1">
                                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium bg-indigo-50 border-indigo-200 text-indigo-700">
                                    <BookOpen className="w-3.5 h-3.5 text-indigo-500" />
                                    <span>{editingSkill.name}</span>
                                    <button
                                        type="button"
                                        className="ml-0.5 p-0.5 rounded hover:bg-indigo-200 transition-colors"
                                        onClick={() => onClearEditSkill?.()}
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Pending steer messages */}
                        {pendingMessages && pendingMessages.length > 0 && (
                            <div className="flex flex-col gap-1 px-4 pb-1">
                                {pendingMessages.map((msg, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800"
                                    >
                                        <span className="flex-1 truncate">{msg}</span>
                                        <button
                                            type="button"
                                            className="p-0.5 rounded hover:bg-amber-200 transition-colors shrink-0"
                                            onClick={() => onRemovePending?.(i)}
                                            title="Remove this instruction"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="relative w-full">
                            <textarea
                                ref={textareaRef}
                                value={value}
                                onFocus={() => setIsFocused(true)}
                                onBlur={() => setIsFocused(false)}
                                onChange={(e) => setValue(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onCompositionStart={() => { isComposingRef.current = true; }}
                                onCompositionEnd={() => { isComposingRef.current = false; }}
                                placeholder={disabled ? "Connecting..." : "Reply..."}
                                disabled={disabled}
                                className="w-full bg-transparent border-none outline-none px-6 py-3 pr-14 text-[15px] text-gray-900 placeholder:text-gray-400 focus:ring-0 focus:outline-none resize-none min-h-[48px] max-h-[200px] disabled:cursor-not-allowed"
                                rows={1}
                                style={{ height: 'auto' }}
                            />
                            {draft && value.trim() === draft.trim() && (
                                <span className="absolute left-6 top-3 pointer-events-none text-[15px]">
                                    <span className="invisible">{value}</span>
                                    <span className="text-gray-400">add details or press Enter ↵</span>
                                </span>
                            )}
                        </div>

                        {isLoading && value.trim() ? (
                            <button
                                onClick={handleSend}
                                className="absolute right-3 bottom-3 p-2 rounded-lg bg-primary-600 text-white shadow-md hover:bg-primary-700 transition-all"
                                title="Send steer instruction"
                            >
                                <ArrowUp className="w-5 h-5" />
                            </button>
                        ) : isLoading ? (
                            <button
                                onClick={onAbort}
                                className="absolute right-3 bottom-3 p-2 rounded-lg bg-red-500 text-white shadow-md hover:bg-red-600 transition-all"
                                title="Stop generating"
                            >
                                <Square className="w-5 h-5" />
                            </button>
                        ) : (
                            <button
                                onClick={handleSend}
                                disabled={!hasContent || disabled}
                                className={cn(
                                    "absolute right-3 bottom-3 p-2 rounded-lg transition-all",
                                    hasContent && !disabled
                                        ? "bg-primary-600 text-white shadow-md hover:bg-primary-700"
                                        : "bg-gray-100 text-gray-300 cursor-not-allowed"
                                )}
                            >
                                <ArrowUp className="w-5 h-5" />
                            </button>
                        )}
                    </div>

                    <div className="mt-4 flex items-center justify-between px-1">
                        <p className="text-xs text-gray-400">
                            AI may make mistakes. Please verify important information.
                        </p>
                        {isCompacting ? (
                            <div className="flex items-center gap-1.5 text-xs text-amber-500">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                <span>Compacting...</span>
                            </div>
                        ) : contextUsage && contextUsage.percent > 0 ? (
                            <div className="flex items-center gap-3 text-xs text-gray-400 font-mono cursor-default">
                                {/* Token I/O stats */}
                                <span title={`Input: ${contextUsage.inputTokens.toLocaleString()} tokens`}>
                                    ↑ {formatTokens(contextUsage.inputTokens)}
                                </span>
                                <span title={`Output: ${contextUsage.outputTokens.toLocaleString()} tokens`}>
                                    ↓ {formatTokens(contextUsage.outputTokens)}
                                </span>
                                {/* Cost */}
                                {contextUsage.cost > 0 && (
                                    <span title={`API cost this session`}>
                                        {formatCost(contextUsage.cost)}
                                    </span>
                                )}
                                {/* Context % with color dot */}
                                <span
                                    className="flex items-center gap-1"
                                    title={`Context: ${contextUsage.tokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()} tokens`}
                                >
                                    {Math.round(contextUsage.percent)}%
                                    <span className={cn(
                                        "inline-block w-1.5 h-1.5 rounded-full",
                                        contextUsage.percent > 75 ? "bg-red-400" :
                                        contextUsage.percent > 50 ? "bg-yellow-400" :
                                        "bg-green-400"
                                    )} />
                                </span>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </>
    );
}
