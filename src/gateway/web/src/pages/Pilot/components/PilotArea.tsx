import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Terminal, User, Cpu, Wifi, WifiOff, Loader2, ChevronRight, FileCode, SearchCode, CheckCircle2, XCircle, Ban } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/Markdown';
import { InputArea } from './InputArea';
import { ScheduleCard, type ScheduleCardStatus } from './ScheduleCard';
import { SkillCard } from './SkillCard';
import { InvestigationCard } from './InvestigationCard';
import { HypothesesCard } from './HypothesesCard';

const THINKING_TIPS = [
    'Thinking...',
    'Tip: Use + to provide session feedback and help the AI improve',
    'Tip: Enable Deep Investigation for hypothesis-driven root cause analysis',
    'Tip: Siclaw remembers findings across sessions \u2014 ask about past investigations',
    'Analyzing the situation...',
    'Tip: Use Skills to run reusable diagnostic scripts',
    'Tip: You can queue your next message while the AI is responding',
    'Working on it...',
];
import { DpChecklistCard, type DpChecklistItem } from './DpChecklistCard';
import { WelcomeArea } from './WelcomeArea';
import type { PilotMessage, ContextUsage, InvestigationProgress, SystemStatus } from '@/hooks/usePilot';
import type { WsStatus } from '@/hooks/useWebSocket';

type RpcSendFn = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

export interface PilotAreaProps {
    messages: PilotMessage[];
    isLoading: boolean;
    isLoadingHistory?: boolean;
    wsStatus: WsStatus;
    isConnected: boolean;
    hasMore?: boolean;
    isLoadingMore?: boolean;
    sendMessage: (text: string) => void;
    abortResponse?: () => void;
    loadMoreHistory?: () => void;
    sendRpc?: RpcSendFn;
    contextUsage?: ContextUsage | null;
    isCompacting?: boolean;
    onOpenSchedulePanel?: (msg: PilotMessage) => void;
    onOpenSkillPanel?: (msg: PilotMessage) => void;
    updateMessageMeta?: (messageId: string, meta: Record<string, unknown>) => Promise<void>;
    pendingMessages?: string[];
    onRemovePending?: (index: number) => void;
    investigationProgress?: InvestigationProgress | null;
    dpActive?: boolean;
    onSetDpActive?: (active: boolean) => void;
    dpFocus?: string | null;
    dpChecklist?: DpChecklistItem[] | null;
    onHypothesesConfirmed?: (hypotheses: Array<{ id: string; text: string; confidence: number }>) => void;
    onExitDp?: () => void;
    systemStatus?: SystemStatus | null;
    onNavigateModels?: () => void;
    onNavigateCredentials?: () => void;
    /** Current session key — used to reset scroll position on session switch */
    sessionKey?: string | null;
    /** Current workspace ID for cron job operations */
    selectedWorkspaceId?: string | null;
    isAdmin?: boolean;
}

/** Compute superseded status for schedule messages */
function computeScheduleStatuses(messages: PilotMessage[]): Map<string, ScheduleCardStatus> {
    const statuses = new Map<string, ScheduleCardStatus>();
    const scheduleGroups = new Map<string, string[]>(); // scheduleName -> [messageId, ...]

    for (const msg of messages) {
        if (msg.role !== 'tool') continue;
        if (msg.toolName !== 'manage_schedule') continue;

        let parsed: { action?: string; schedule?: { name: string }; id?: string } | null = null;
        try { parsed = JSON.parse(msg.content); } catch { continue; }
        if (!parsed) continue;

        const key = parsed.schedule?.name || parsed.id || msg.id;
        if (!scheduleGroups.has(key)) scheduleGroups.set(key, []);
        scheduleGroups.get(key)!.push(msg.id);

        const meta = msg.metadata as Record<string, unknown> | undefined;
        if (meta?.scheduleCard === 'saved') {
            statuses.set(msg.id, 'saved');
        } else if (meta?.scheduleCard === 'dismissed') {
            statuses.set(msg.id, 'dismissed');
        } else {
            statuses.set(msg.id, 'pending');
        }
    }

    // Mark superseded: in each group, only the latest pending message is active
    for (const [, msgIds] of scheduleGroups) {
        let latestPendingIdx = -1;
        for (let i = msgIds.length - 1; i >= 0; i--) {
            if (statuses.get(msgIds[i]) === 'pending') {
                latestPendingIdx = i;
                break;
            }
        }
        for (let i = 0; i < msgIds.length; i++) {
            if (statuses.get(msgIds[i]) === 'pending' && i !== latestPendingIdx) {
                statuses.set(msgIds[i], 'superseded');
            }
        }
    }

    return statuses;
}

export function PilotArea({ messages, isLoading, isLoadingHistory, wsStatus, isConnected, hasMore, isLoadingMore, sendMessage, abortResponse, loadMoreHistory, sendRpc, contextUsage, isCompacting, onOpenSchedulePanel, onOpenSkillPanel, updateMessageMeta, pendingMessages, onRemovePending, investigationProgress, dpActive, onSetDpActive, dpFocus, dpChecklist, onHypothesesConfirmed, onExitDp, systemStatus, onNavigateModels, onNavigateCredentials, sessionKey, selectedWorkspaceId, isAdmin }: PilotAreaProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const prevScrollHeightRef = useRef(0);
    const prevMsgCountRef = useRef(0);
    // Track whether user has manually scrolled away from bottom
    const userScrolledAwayRef = useRef(false);
    // Flag: session switched, force scroll to bottom when messages arrive
    const needsScrollOnLoadRef = useRef(false);
    // During session restore, DP cards can continue growing after messages load.
    // Keep auto-scrolling briefly until restored content settles.
    const pendingRestoreScrollRef = useRef(false);
    const restoreScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevSessionKeyRef = useRef(sessionKey);
    useEffect(() => {
        if (prevSessionKeyRef.current !== sessionKey) {
            prevSessionKeyRef.current = sessionKey;
            userScrolledAwayRef.current = false;
            prevMsgCountRef.current = 0;
            needsScrollOnLoadRef.current = true;
            hasShownFeedbackHintRef.current = false;
            pendingRestoreScrollRef.current = true;
            if (restoreScrollTimerRef.current) {
                clearTimeout(restoreScrollTimerRef.current);
                restoreScrollTimerRef.current = null;
            }
        }
    }, [sessionKey]);

    // Suggested reply draft — chip click populates input instead of sending immediately
    const [chipSeq, setChipSeq] = useState(0);
    const [chipDraft, setChipDraft] = useState<string | null>(null);
    const [showHypothesesLocator, setShowHypothesesLocator] = useState(false);

    // Feedback hint: show once per session after agent finishes first response
    const hasShownFeedbackHintRef = useRef(false);
    const prevIsLoadingRef = useRef(isLoading);
    const [showFeedbackHint, setShowFeedbackHint] = useState(false);

    useEffect(() => {
        const wasLoading = prevIsLoadingRef.current;
        prevIsLoadingRef.current = isLoading;

        if (wasLoading && !isLoading && !hasShownFeedbackHintRef.current && messages.length > 0) {
            hasShownFeedbackHintRef.current = true;
            setShowFeedbackHint(true);
            const timer = setTimeout(() => setShowFeedbackHint(false), 7000);
            return () => clearTimeout(timer);
        }
    }, [isLoading, messages.length]);

    useEffect(() => {
        return () => {
            if (restoreScrollTimerRef.current) {
                clearTimeout(restoreScrollTimerRef.current);
            }
        };
    }, []);

    const scrollToBottom = useCallback((smooth = true) => {
        requestAnimationFrame(() => {
            scrollRef.current?.scrollIntoView(smooth ? { behavior: 'smooth' } : undefined);
        });
    }, []);

    const scheduleStatuses = useMemo(() => computeScheduleStatuses(messages), [messages]);

    // Find the latest propose_hypotheses message (older ones will be rendered as superseded)
    const latestHypothesesId = useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].toolName === 'propose_hypotheses' && !messages[i].isStreaming) {
                return messages[i].id;
            }
        }
        return null;
    }, [messages]);

    // Find last assistant message id — used to show suggested reply chips only on the latest reply
    const lastAssistantMsgId = useMemo(() => {
        const visible = messages.filter(m => !m.hidden);
        for (let i = visible.length - 1; i >= 0; i--) {
            if (visible[i].role === 'assistant') return visible[i].id;
            if (visible[i].role === 'user') return null;
        }
        return null;
    }, [messages]);

    // Show "Dig deeper" button when agent finished a diagnostic turn with a conclusion
    const showTraceButton = useMemo(() => {
        if (isLoading) return false;
        // Don't show during active Deep Investigation — DP checklist is the continuation mechanism
        if (dpActive || (dpChecklist && dpChecklist.length > 0)) return false;
        // Find the last user message to delimit the current turn
        let turnStart = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') { turnStart = i; break; }
        }
        if (turnStart < 0) return false;
        // Filter hidden messages (update_plan, end_investigation) to avoid false lastToolIdx
        const turnMessages = messages.slice(turnStart + 1).filter(m => !m.hidden);
        // Must have at least one diagnostic tool call (excluding deep_search — already the deepest path)
        const DIAGNOSTIC_TOOLS = new Set(['bash', 'pod_exec', 'node_exec', 'node_script', 'pod_script', 'local_script']);
        const hasDiagnostic = turnMessages.some(m => m.role === 'tool' && DIAGNOSTIC_TOOLS.has(m.toolName ?? ''));
        // The conclusion must come AFTER the last tool call — if the agent ran tools
        // but never gave a summary, it didn't conclude (e.g. "let me analyze" + tools + silence)
        let lastAssistantIdx = -1;
        let lastToolIdx = -1;
        for (let i = turnMessages.length - 1; i >= 0; i--) {
            if (lastAssistantIdx < 0 && turnMessages[i].role === 'assistant') lastAssistantIdx = i;
            if (lastToolIdx < 0 && turnMessages[i].role === 'tool') lastToolIdx = i;
            if (lastAssistantIdx >= 0 && lastToolIdx >= 0) break;
        }
        const hasConclusion = lastAssistantIdx > lastToolIdx && lastToolIdx >= 0
            && (turnMessages[lastAssistantIdx]?.content?.trim().length ?? 0) > 0;
        const stillStreaming = turnMessages.some(m => m.isStreaming);
        return hasDiagnostic && hasConclusion && !stillStreaming;
    }, [messages, isLoading, dpActive, dpChecklist]);

    // Check if latest hypotheses were already confirmed.
    // Three signals (any one is sufficient):
    // 1. deep_search tool message exists after hypotheses (works when complete or in live session)
    // 2. User confirmation message exists ("confirmed hypotheses") — always persisted immediately
    // 3. dpChecklist has deep_search in progress/done (works on refresh when deep_search isn't in history yet)
    const latestHypothesesConfirmed = useMemo(() => {
        if (!latestHypothesesId) return false;
        const hypoIdx = messages.findIndex(m => m.id === latestHypothesesId);
        if (hypoIdx < 0) return false;
        const afterHypo = messages.slice(hypoIdx + 1);
        if (afterHypo.some(m => m.toolName === 'deep_search')) return true;
        if (afterHypo.some(m => m.role === 'user' && m.content.includes('confirmed hypotheses'))) return true;
        if (dpChecklist?.some(i => i.id === 'deep_search' && (i.status === 'in_progress' || i.status === 'done'))) return true;
        return false;
    }, [messages, latestHypothesesId, dpChecklist]);

    const latestHypothesesAwaitingReview = useMemo(() => {
        return latestHypothesesId != null && !latestHypothesesConfirmed;
    }, [latestHypothesesConfirmed, latestHypothesesId]);

    // Handles three cases:
    // 1. Initial load / session switch (0 → N): force scroll to bottom
    // 2. Prepend (load more): restore scroll position so view doesn't jump
    // 3. Append (new message/streaming): auto-scroll unless user scrolled away
    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        if (prevScrollHeightRef.current) {
            // Prepend case: older messages were inserted at top
            const diff = container.scrollHeight - prevScrollHeightRef.current;
            if (diff > 0) container.scrollTop += diff;
            prevScrollHeightRef.current = 0;
        } else if (needsScrollOnLoadRef.current && messages.length > 0) {
            // Session switch: force scroll to bottom when messages finish loading
            needsScrollOnLoadRef.current = false;
            userScrolledAwayRef.current = false;
            scrollToBottom(false);
        } else if (prevMsgCountRef.current === 0 && messages.length > 0) {
            // Initial load (page refresh): scroll to bottom after DOM renders
            userScrolledAwayRef.current = false;
            scrollToBottom(false);
        } else if (messages.length > prevMsgCountRef.current) {
            // New message added — check if it's a user message (force scroll)
            const latest = messages[messages.length - 1];
            if (latest?.role === 'user') {
                // User just sent a message — always scroll to bottom
                userScrolledAwayRef.current = false;
                scrollToBottom(false);
            } else if (!userScrolledAwayRef.current) {
                // Bot message / streaming — scroll if user hasn't scrolled away
                scrollToBottom(true);
            }
        } else if (!userScrolledAwayRef.current) {
            // Same count but content changed (streaming update)
            scrollToBottom(true);
        }
        prevMsgCountRef.current = messages.length;
    }, [messages, scrollToBottom]);

    useEffect(() => {
        if (!latestHypothesesAwaitingReview || !latestHypothesesId) {
            setShowHypothesesLocator(false);
            return;
        }

        const root = scrollContainerRef.current;
        if (!root) return;

        let observer: IntersectionObserver | null = null;
        const rafId = requestAnimationFrame(() => {
            const card = document.querySelector<HTMLElement>(
                `[data-hypotheses-card-id="${latestHypothesesId}"]`,
            );
            if (!card) {
                setShowHypothesesLocator(false);
                return;
            }

            observer = new IntersectionObserver(
                ([entry]) => {
                    setShowHypothesesLocator(!entry.isIntersecting || entry.intersectionRatio < 0.2);
                },
                {
                    root,
                    threshold: [0, 0.2, 0.6, 1],
                },
            );
            observer.observe(card);
        });

        return () => {
            cancelAnimationFrame(rafId);
            observer?.disconnect();
        };
    }, [latestHypothesesAwaitingReview, latestHypothesesId, messages.length]);

    const scrollToLatestHypothesesCard = useCallback(() => {
        if (!latestHypothesesId) return;
        const card = document.querySelector<HTMLElement>(
            `[data-hypotheses-card-id="${latestHypothesesId}"]`,
        );
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, [latestHypothesesId]);

    // Session restore is multi-step: messages load first, then DP progress restores,
    // and the checklist card may grow as hypotheses/current action arrive. Keep the
    // viewport pinned during this short restore window unless the user scrolls away.
    useEffect(() => {
        if (!pendingRestoreScrollRef.current) return;
        if (userScrolledAwayRef.current) {
            pendingRestoreScrollRef.current = false;
            if (restoreScrollTimerRef.current) {
                clearTimeout(restoreScrollTimerRef.current);
                restoreScrollTimerRef.current = null;
            }
            return;
        }
        if (messages.length === 0) return;

        scrollToBottom(false);

        if (restoreScrollTimerRef.current) {
            clearTimeout(restoreScrollTimerRef.current);
        }
        restoreScrollTimerRef.current = setTimeout(() => {
            pendingRestoreScrollRef.current = false;
            restoreScrollTimerRef.current = null;
        }, 180);
    }, [
        messages.length,
        dpChecklist?.length,
        investigationProgress?.phase,
        investigationProgress?.hypotheses.length,
        investigationProgress?.currentAction,
        isLoadingHistory,
        scrollToBottom,
    ]);

    // Detect if user manually scrolls away from bottom
    const handleScroll = useCallback(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        const { scrollTop, scrollHeight, clientHeight } = container;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        // User is "at bottom" if within 300px (generous threshold for input area height)
        userScrolledAwayRef.current = distanceFromBottom > 300;
        if (userScrolledAwayRef.current) {
            pendingRestoreScrollRef.current = false;
            if (restoreScrollTimerRef.current) {
                clearTimeout(restoreScrollTimerRef.current);
                restoreScrollTimerRef.current = null;
            }
        }

        // Load more when near top
        if (!hasMore || isLoadingMore || !loadMoreHistory) return;
        if (container.scrollTop < 80) {
            prevScrollHeightRef.current = container.scrollHeight;
            loadMoreHistory();
        }
    }, [hasMore, isLoadingMore, loadMoreHistory]);

    return (
        <div className="flex-1 flex flex-col h-full bg-white">
            {/* Connection status indicator */}
            <div className="absolute top-4 right-16 z-30">
                <div className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium transition-colors",
                    isConnected
                        ? "bg-green-50 text-green-600"
                        : wsStatus === 'connecting'
                            ? "bg-yellow-50 text-yellow-600"
                            : "bg-red-50 text-red-600"
                )}>
                    {isConnected ? (
                        <Wifi className="w-3 h-3" />
                    ) : wsStatus === 'connecting' ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                        <WifiOff className="w-3 h-3" />
                    )}
                    <span>{isConnected ? 'Connected' : wsStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}</span>
                </div>
            </div>


            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 lg:px-8 py-8" onScroll={handleScroll}>
                <div className="max-w-5xl mx-auto space-y-8">
                    {isLoadingHistory ? (
                        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                            <Loader2 className="w-8 h-8 animate-spin text-gray-300 mb-4" />
                            <p className="text-sm">Loading messages...</p>
                        </div>
                    ) : messages.length === 0 ? (
                        <WelcomeArea
                            systemStatus={systemStatus ?? null}
                            onSendPrompt={sendMessage}
                            onNavigateModels={onNavigateModels ?? (() => {})}
                            onNavigateCredentials={onNavigateCredentials ?? (() => {})}
                            isAdmin={isAdmin}
                        />
                    ) : (
                        <>
                            {isLoadingMore && (
                                <div className="flex justify-center py-2">
                                    <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                </div>
                            )}

                            {!hasMore && messages.length > 0 && (
                                <div className="flex justify-center">
                                    <span className="text-xs font-semibold text-gray-400 bg-gray-100 px-3 py-1 rounded-full">Start of conversation</span>
                                </div>
                            )}

                            {messages.filter(m => !m.hidden).map((msg) => (
                                <MessageItem
                                    key={msg.id}
                                    message={msg}
                                    sendRpc={sendRpc}
                                    scheduleStatus={scheduleStatuses.get(msg.id)}
                                    onOpenSchedulePanel={onOpenSchedulePanel}
                                    onOpenSkillPanel={onOpenSkillPanel}
                                    updateMessageMeta={updateMessageMeta}
                                    investigationProgress={investigationProgress}
                                    sendMessage={sendMessage}
                                    dpFocus={dpFocus}
                                    dpChecklistActive={dpChecklist != null && dpChecklist.length > 0}
                                    onHypothesesConfirmed={onHypothesesConfirmed}
                                    hypothesesSuperseded={latestHypothesesId != null && msg.toolName === 'propose_hypotheses' && msg.id !== latestHypothesesId}
                                    hypothesesAlreadyConfirmed={msg.id === latestHypothesesId && latestHypothesesConfirmed}
                                    selectedWorkspaceId={selectedWorkspaceId}
                                    showSuggestedReplies={msg.id === lastAssistantMsgId && !isLoading}
                                    onChipClick={(key) => { setChipSeq(s => s + 1); setChipDraft(key + ' '); }}
                                />
                            ))}

                            {/* Trace root cause button — shown when agent stopped at intermediate cause */}
                            {showTraceButton && (
                                <div className="flex justify-start pl-12 my-2">
                                    <button
                                        type="button"
                                        disabled={isLoading}
                                        onClick={() => sendMessage('Your conclusion may not be the root cause. Please dig deeper — trace where the problematic values, configurations, or states come from. Check the upstream resources, dependencies, and configuration sources until you find the original cause.')}
                                        className="flex items-center gap-2 px-5 py-2 rounded-full bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white text-sm font-medium shadow-sm hover:shadow-md transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        <SearchCode className="w-4 h-4" />
                                        Dig deeper
                                    </button>
                                </div>
                            )}

                            {/* DP Checklist Card — persistent progress during Deep Investigation */}
                            {dpChecklist && dpChecklist.length > 0 && (
                                <DpChecklistCard items={dpChecklist} investigationProgress={investigationProgress} onDismiss={onExitDp} />
                            )}

                            {isLoading && <ThinkingIndicator />}

                            {showFeedbackHint && (
                                <div className={cn(
                                    "text-center text-xs text-gray-400 py-2 transition-opacity duration-500",
                                    showFeedbackHint ? "opacity-100" : "opacity-0"
                                )}>
                                    Was this helpful? Tap <span className="font-medium text-gray-500">+</span> below to share feedback
                                </div>
                            )}
                        </>
                    )}
                    <div ref={scrollRef} />
                </div>
            </div>
            {showHypothesesLocator && (
                <div className="px-4 pb-2">
                    <div className="max-w-5xl mx-auto flex justify-end">
                        <button
                            type="button"
                            onClick={scrollToLatestHypothesesCard}
                            className="flex items-center gap-1.5 rounded-full border border-indigo-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-indigo-700 shadow-sm backdrop-blur-sm transition-colors hover:bg-indigo-50 hover:text-indigo-800 cursor-pointer"
                        >
                            <SearchCode className="w-3.5 h-3.5" />
                            <span>Review hypotheses</span>
                            <ChevronRight className="w-3 h-3 -rotate-90" />
                        </button>
                    </div>
                </div>
            )}
            <InputArea onSend={sendMessage} onAbort={abortResponse} disabled={!isConnected} isLoading={isLoading} contextUsage={contextUsage} isCompacting={isCompacting} pendingMessages={pendingMessages} onRemovePending={onRemovePending} dpFocus={dpFocus} dpActive={dpActive} onSetDpActive={onSetDpActive} hasMessages={messages.length > 0} draft={chipDraft} draftSeq={chipSeq} />
        </div>
    );
}

function ThinkingIndicator() {
    const [tipIndex, setTipIndex] = useState(0);
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        const interval = setInterval(() => {
            setVisible(false);
            setTimeout(() => {
                setTipIndex(i => (i + 1) % THINKING_TIPS.length);
                setVisible(true);
            }, 300);
        }, 8000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-white border border-gray-200 flex items-center justify-center text-primary-600 shadow-sm">
                <Cpu className="w-5 h-5" />
            </div>
            <div className="flex items-center gap-2 text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className={cn(
                    "text-sm transition-opacity duration-300",
                    visible ? "opacity-100" : "opacity-0"
                )}>
                    {THINKING_TIPS[tipIndex]}
                </span>
            </div>
        </div>
    );
}

// Parse [User Script: name (lang)] references from user messages
interface ScriptRef { name: string; lang: string; }

function parseScriptRefs(content: string): { scripts: ScriptRef[]; text: string } {
    const scripts: ScriptRef[] = [];
    const regex = /\[User Script: ([^\s]+) \((\w+)\)\]\n*/g;
    const text = content.replace(regex, (_, name, lang) => {
        scripts.push({ name, lang });
        return '';
    }).trim();
    return { scripts, text };
}

/** Parse [Skill: name] or legacy [Editing Skill: name]...--- block from user messages */
function parseSkillRef(content: string): { skillName: string | null; text: string } {
    // New compact format: [Skill: name]
    const compactMatch = content.match(/\[Skill: ([^\]]+)\]\n*/);
    if (compactMatch) {
        return { skillName: compactMatch[1], text: content.replace(compactMatch[0], '').trim() };
    }
    // Legacy verbose format: [Editing Skill: name]\n...---\n
    const legacyMatch = content.match(/\[Editing Skill: ([^\]]+)\]\n(?:.*\n)*?---\n*/);
    if (legacyMatch) {
        return { skillName: legacyMatch[1], text: content.replace(legacyMatch[0], '').trim() };
    }
    return { skillName: null, text: content };
}

/** Parse [Deep Investigation] and DP control markers from user messages */
function parseDeepInvestigation(content: string): { isDeepInvestigation: boolean; text: string } {
    // Strip activation marker
    const dpMatch = content.match(/\[Deep Investigation\]\n*/);
    if (dpMatch) {
        return { isDeepInvestigation: true, text: content.replace(dpMatch[0], '').trim() };
    }
    // Strip DP state control markers (confirm/adjust/skip)
    const controlMatch = content.match(/\[DP_(?:CONFIRM|ADJUST|REINVESTIGATE|SKIP|EXIT)\]\n*/);
    if (controlMatch) {
        return { isDeepInvestigation: true, text: content.replace(controlMatch[0], '').trim() };
    }
    return { isDeepInvestigation: false, text: content };
}

/** Parse <!-- suggested-replies: A|Label A, B|Label B --> from assistant messages */
interface SuggestedReply { key: string; label: string; }

/** Auto-detect option patterns from agent output.
 *  Primary:  `- **X.** Label` (bullet + bold)
 *  Fallback: `X. Label` (plain, letter-only keys — catches agent format drift) */
function detectOptionReplies(content: string): SuggestedReply[] {
    // Primary: - **X.** label (bullet + bold)
    const primary: SuggestedReply[] = [];
    const regex = /[-*]\s+\*\*([A-Za-z\d]+)\.\*\*\s+(.+?)(?:\s+[—\-–]\s+.*)?$/gm;
    for (const match of content.matchAll(regex)) {
        primary.push({ key: match[1], label: match[2].trim() });
    }
    if (primary.length >= 2 && primary.length <= 8) return primary;

    // Fallback: X. label (uppercase letter keys only, avoids matching numbered lists)
    const fallback: SuggestedReply[] = [];
    const fallbackRegex = /^([A-Z])\.\s+(.+?)(?:\s+[—\-–]\s+.*)?$/gm;
    for (const match of content.matchAll(fallbackRegex)) {
        fallback.push({ key: match[1], label: match[2].trim() });
    }
    return fallback.length >= 2 && fallback.length <= 8 ? fallback : [];
}

function parseSuggestedReplies(content: string): { replies: SuggestedReply[]; text: string } {
    // Priority 1: Explicit HTML comment (escape hatch for custom cases)
    const commentMatch = content.match(/<!--\s*suggested-replies:\s*(.*?)\s*-->/);
    if (commentMatch) {
        const replies: SuggestedReply[] = [];
        for (const part of commentMatch[1].split(',')) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const pipeIdx = trimmed.indexOf('|');
            if (pipeIdx > 0) {
                replies.push({ key: trimmed.slice(0, pipeIdx).trim(), label: trimmed.slice(pipeIdx + 1).trim() });
            } else {
                replies.push({ key: trimmed, label: trimmed });
            }
        }
        const text = content.replace(/<!--\s*suggested-replies:\s*.*?\s*-->/, '').trimEnd();
        return { replies, text };
    }

    // Priority 2: Auto-detect **X.** option patterns — zero agent burden
    const detected = detectOptionReplies(content);
    if (detected.length > 0) {
        return { replies: detected, text: content };
    }

    return { replies: [], text: content };
}

function MessageItem({ message, scheduleStatus, onOpenSchedulePanel, onOpenSkillPanel, sendRpc, updateMessageMeta, investigationProgress, sendMessage, dpFocus, dpChecklistActive, onHypothesesConfirmed, hypothesesSuperseded, hypothesesAlreadyConfirmed, selectedWorkspaceId, showSuggestedReplies, onChipClick }: {
    message: PilotMessage;
    sendRpc?: RpcSendFn;
    scheduleStatus?: ScheduleCardStatus;
    onOpenSchedulePanel?: (msg: PilotMessage) => void;
    onOpenSkillPanel?: (msg: PilotMessage) => void;
    updateMessageMeta?: (messageId: string, meta: Record<string, unknown>) => Promise<void>;
    isInPanel?: boolean;
    investigationProgress?: InvestigationProgress | null;
    sendMessage?: (text: string) => void;
    dpFocus?: string | null;
    /** True when DpChecklistCard is active — used to hide InvestigationCard even if dpFocus is transiently null */
    dpChecklistActive?: boolean;
    onHypothesesConfirmed?: (hypotheses: Array<{ id: string; text: string; confidence: number }>) => void;
    hypothesesSuperseded?: boolean;
    /** True when a deep_search exists after this propose_hypotheses — survives page refresh */
    hypothesesAlreadyConfirmed?: boolean;
    selectedWorkspaceId?: string | null;
    showSuggestedReplies?: boolean;
    /** Chip click populates input instead of sending immediately */
    onChipClick?: (key: string) => void;
}) {
    const isUser = message.role === 'user';
    const isTool = message.role === 'tool';

    if (isTool) {
        if (message.toolName === 'manage_schedule' && !message.isStreaming) {
            return <ScheduleCard message={message} status={scheduleStatus ?? 'pending'} onOpenPanel={onOpenSchedulePanel} sendRpc={sendRpc} updateMessageMeta={updateMessageMeta} selectedWorkspaceId={selectedWorkspaceId} />;
        }
        if (message.toolName === 'skill_preview' && !message.isStreaming) {
            return <SkillCard message={message} onOpenPanel={onOpenSkillPanel} />;
        }
        if (message.toolName === 'deep_search') {
            // In DP mode, DpChecklistCard handles the running display — hide duplicate InvestigationCard.
            // Use dpChecklistActive (not just dpFocus) to avoid brief flash when dpFocus is transiently null
            // during checklist phase transitions.
            if (message.isStreaming && (dpFocus || dpChecklistActive)) {
                return null;
            }
            return <InvestigationCard message={message} progress={message.isStreaming ? investigationProgress : undefined} sendMessage={sendMessage} updateMessageMeta={updateMessageMeta} />;
        }
        if (message.toolName === 'propose_hypotheses' && !message.isStreaming) {
            return <HypothesesCard message={message} sendMessage={sendMessage} onHypothesesConfirmed={onHypothesesConfirmed} superseded={hypothesesSuperseded} alreadyConfirmed={hypothesesAlreadyConfirmed} />;
        }
        return <ToolItem message={message} />;
    }

    // Parse references from user messages
    const { isDeepInvestigation, text: afterDeepInv } = isUser
        ? parseDeepInvestigation(message.content)
        : { isDeepInvestigation: false, text: message.content };
    const { scripts, text: afterScripts } = isUser
        ? parseScriptRefs(afterDeepInv)
        : { scripts: [] as ScriptRef[], text: afterDeepInv };
    const { skillName, text: afterSkillRef } = isUser
        ? parseSkillRef(afterScripts)
        : { skillName: null, text: afterScripts };

    // Always strip <!-- suggested-replies --> comments from assistant messages (they should never be visible)
    // Only parse replies into chips for the last non-streaming assistant message
    const strippedContent = !isUser && !isTool
        ? afterSkillRef.replace(/<!--\s*suggested-replies:\s*.*?\s*-->/g, '').trimEnd()
        : afterSkillRef;
    const { replies: suggestedReplies, text: textContent } = !isUser && !isTool && showSuggestedReplies && !message.isStreaming
        ? parseSuggestedReplies(afterSkillRef)
        : { replies: [] as SuggestedReply[], text: strippedContent };

    return (
        <div className={cn(
            "flex gap-4 group",
            isUser ? "flex-row-reverse" : "flex-row"
        )}>
            {/* Avatar */}
            <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm border",
                isUser
                    ? "bg-primary-600 border-primary-600 text-white"
                    : "bg-white border-gray-200 text-primary-600"
            )}>
                {isUser
                    ? <User className="w-4 h-4" />
                    : <Cpu className="w-5 h-5" />
                }
            </div>

            <div className={cn(
                "flex flex-col min-w-0",
                isUser ? "items-end" : "items-start"
            )}>
                <div className="flex items-baseline gap-2 mb-1">
                    <span className="text-sm font-semibold text-gray-900">
                        {isUser ? 'You' : 'Siclaw'}
                    </span>
                    <span className="text-xs text-gray-400">{message.timestamp}</span>
                    {message.isStreaming && !isUser && (
                        <Loader2 className="w-3 h-3 animate-spin text-gray-400" />
                    )}
                </div>

                {/* Reference chips (user messages only) */}
                {(isDeepInvestigation || skillName || scripts.length > 0) && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {isDeepInvestigation && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-50 border border-blue-200 text-xs font-medium text-blue-700">
                                <SearchCode className="w-3.5 h-3.5 text-blue-500" />
                                <span>Deep Investigation</span>
                                {dpFocus && (
                                    <span className="ml-1 px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 text-[10px] font-semibold uppercase">
                                        {dpFocus}
                                    </span>
                                )}
                            </div>
                        )}
                        {skillName && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-50 border border-indigo-200 text-xs font-medium text-indigo-700">
                                <FileCode className="w-3.5 h-3.5 text-indigo-500" />
                                <span>{skillName}</span>
                            </div>
                        )}
                        {scripts.map((s, i) => (
                            <div
                                key={i}
                                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-primary-50 border border-primary-200 text-xs font-medium text-primary-800"
                            >
                                {s.lang === 'python'
                                    ? <FileCode className="w-3.5 h-3.5 text-blue-600" />
                                    : <Terminal className="w-3.5 h-3.5 text-green-600" />
                                }
                                <span>{s.name}</span>
                            </div>
                        ))}
                    </div>
                )}

                {textContent && (
                    <div className={cn(
                        "px-5 py-3.5 rounded-2xl text-[15px] leading-relaxed shadow-sm max-w-3xl min-w-0 overflow-hidden",
                        isUser
                            ? "bg-primary-600 text-white rounded-tr-sm [&_pre]:bg-black/20 [&_pre]:text-white [&_code]:bg-white/15 [&_code]:text-white [&_a]:text-blue-200"
                            : "bg-white border border-gray-200 text-gray-800 rounded-tl-sm"
                    )}>
                        <Markdown>{textContent}</Markdown>
                    </div>
                )}

                {suggestedReplies.length > 0 && onChipClick && (
                    <div className="flex flex-wrap gap-2 mt-2">
                        {suggestedReplies.map((reply) => (
                            <button
                                key={reply.key}
                                type="button"
                                onClick={() => onChipClick(reply.key)}
                                className="rounded-full px-3 py-1.5 text-sm border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 transition-colors cursor-pointer"
                            >
                                <span className="font-medium text-gray-500">{reply.key}.</span> {reply.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function ToolItem({ message }: { message: PilotMessage }) {
    const [expanded, setExpanded] = useState(false);
    const isOpen = message.isStreaming || expanded;

    return (
        <div className="pl-12 min-w-0">
            <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
                <button
                    type="button"
                    className="flex items-center gap-2 w-full px-4 py-2 bg-gray-50 border-b border-gray-200 hover:bg-gray-100 transition-colors cursor-pointer text-left min-w-0"
                    onClick={() => setExpanded(!expanded)}
                >
                    <ChevronRight className={cn(
                        "w-3.5 h-3.5 text-gray-400 transition-transform shrink-0",
                        isOpen && "rotate-90"
                    )} />
                    <Terminal className="w-4 h-4 text-gray-500 shrink-0" />
                    <span className="font-mono text-xs font-semibold text-gray-700 shrink-0">{message.toolName}</span>
                    {message.toolInput && (
                        <span className="font-mono text-xs text-gray-500 truncate min-w-0">{message.toolInput}</span>
                    )}
                    {message.toolStatus === 'running' && (
                        <Loader2 className="w-3 h-3 animate-spin text-blue-400 ml-auto shrink-0" />
                    )}
                    {message.toolStatus === 'success' && (
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 ml-auto shrink-0" />
                    )}
                    {message.toolStatus === 'error' && (
                        <XCircle className="w-3.5 h-3.5 text-red-500 ml-auto shrink-0" />
                    )}
                    {message.toolStatus === 'aborted' && (
                        <Ban className="w-3.5 h-3.5 text-amber-500 ml-auto shrink-0" />
                    )}
                </button>
                {isOpen && (
                    <div className="overflow-x-auto bg-slate-50 max-h-80 overflow-y-auto">
                        {message.toolInput && (
                            <div className="px-4 pt-3 pb-2 border-b border-slate-200">
                                <pre className="text-xs font-mono leading-relaxed text-slate-800 whitespace-pre-wrap break-all">{message.toolInput}</pre>
                            </div>
                        )}
                        <div className="p-4">
                            <pre className="text-xs font-mono leading-relaxed text-slate-600 whitespace-pre-wrap">
                                {message.content || (message.toolStatus === 'aborted' ? 'Aborted.' : 'Running...')}
                            </pre>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
