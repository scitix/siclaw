import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket, type WsMessage } from './useWebSocket';
import { rpcGetSkills, type Skill } from '@/pages/Skills/skillsData';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { parseHypotheses as parseHypothesesText } from '@/pages/Pilot/components/HypothesesCard';
import { findPendingSteerIndex, removePendingAt, extractUserMessageText } from './steer-pending';

export interface ModelInfo {
    id: string;
    name: string;
    provider: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
}

export type MessageRole = 'user' | 'assistant' | 'tool';

export type ToolStatus = 'running' | 'success' | 'error' | 'aborted';

export interface PilotMessage {
    id: string;
    role: MessageRole;
    content: string;
    toolName?: string;
    toolInput?: string;
    toolStatus?: ToolStatus;
    /** Structured details from tool result (e.g. deep_search hypotheses + evidence) */
    toolDetails?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    timestamp: string;
    /** Original ISO timestamp for pagination cursor */
    isoTimestamp?: string;
    isStreaming?: boolean;
    /** Hidden from chat bubbles (e.g. update_plan tool messages) */
    hidden?: boolean;
    /** performance.now() when tool_execution_start was received — drives live stopwatch */
    startedAt?: number;
    /** Elapsed ms from tool_execution_start to tool_execution_end */
    durationMs?: number;
    /** Elapsed ms for LLM thinking (message_start to message_end) — on assistant messages */
    llmDurationMs?: number;
    /** ms from last anchor event (tool_execution_end or send) to message_start — TTFT approximation */
    waitMs?: number;
}

export interface Session {
    key: string;
    title?: string;
    preview: string;
    createdAt: string;
    lastActiveAt?: string;
    messageCount?: number;
}

export interface ContextUsage {
    tokens: number;
    contextWindow: number;
    percent: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
}

// --- Deep Investigation progress types ---

export interface InvestigationHypothesisProgress {
    id: string;
    text: string;
    status: string; // "pending" | "validating" | "validated" | "invalidated" | "inconclusive" | "skipped"
    confidence: number;
    callsUsed: number;
    maxCalls: number;
    lastAction?: string;
}

export interface InvestigationProgress {
    phase?: string;
    hypotheses: InvestigationHypothesisProgress[];
    currentAction?: string;
}

export interface SystemStatus {
    hasModels: boolean;
    hasProfile: boolean;
    sessionCount: number;
    credentials: Record<string, number>;
}

/** Reduce individual progress events into accumulated investigation state */
function reduceInvestigationProgress(
    state: InvestigationProgress,
    event: Record<string, unknown>,
): InvestigationProgress {
    const next = { ...state, hypotheses: [...state.hypotheses] };

    switch (event.type) {
        case 'phase':
            next.phase = event.phase as string;
            if (event.detail) next.currentAction = event.detail as string;
            break;

        case 'hypothesis': {
            const id = event.id as string;
            const idx = next.hypotheses.findIndex(h => h.id === id);
            const update = {
                id,
                text: (event.text as string) || (idx >= 0 ? next.hypotheses[idx].text : ''),
                status: event.status as string,
                confidence: event.confidence as number,
                callsUsed: idx >= 0 ? next.hypotheses[idx].callsUsed : 0,
                maxCalls: idx >= 0 ? next.hypotheses[idx].maxCalls : 10,
            };
            if (idx >= 0) {
                next.hypotheses[idx] = { ...next.hypotheses[idx], ...update };
            } else {
                next.hypotheses.push(update);
            }
            break;
        }

        case 'tool_exec': {
            const hId = event.hypothesisId as string | undefined;
            const callsUsed = event.callsUsed as number;
            const maxCalls = event.maxCalls as number;
            const tool = event.tool as string;
            const command = event.command as string;
            const cmdShort = command.length > 60 ? command.slice(0, 57) + '...' : command;
            next.currentAction = `${hId ? hId + ' ' : ''}[${callsUsed}/${maxCalls}] ${tool}: ${cmdShort}`;
            if (hId) {
                const idx = next.hypotheses.findIndex(h => h.id === hId);
                if (idx >= 0) {
                    next.hypotheses[idx] = {
                        ...next.hypotheses[idx],
                        callsUsed,
                        maxCalls,
                        lastAction: `[${callsUsed}/${maxCalls}] ${tool}: ${cmdShort}`,
                        status: next.hypotheses[idx].status === 'pending' ? 'validating' : next.hypotheses[idx].status,
                    };
                }
            }
            break;
        }

        case 'budget_exhausted': {
            const hId = event.hypothesisId as string | undefined;
            if (hId) {
                const idx = next.hypotheses.findIndex(h => h.id === hId);
                if (idx >= 0) {
                    next.hypotheses[idx] = {
                        ...next.hypotheses[idx],
                        callsUsed: event.callsUsed as number,
                    };
                }
            }
            break;
        }
    }

    return next;
}

const SESSION_KEY_STORAGE = 'siclaw_current_session';

const TIMING_MAX_SAMPLES = 200;
function appendTimingSample(key: string, ms: number): void {
    try {
        const arr = JSON.parse(localStorage.getItem(key) ?? '[]') as number[];
        arr.push(Math.round(ms));
        if (arr.length > TIMING_MAX_SAMPLES) arr.splice(0, arr.length - TIMING_MAX_SAMPLES);
        localStorage.setItem(key, JSON.stringify(arr));
        window.dispatchEvent(new CustomEvent('siclaw_timing_update'));
    } catch { /* ignore storage errors */ }
}
const SESSION_WORKSPACE_STORAGE = 'siclaw_session_workspace';
const SELECTED_BRAIN_STORAGE = 'siclaw_selected_brain';

export type BrainType = "pi-agent" | "claude-sdk";

type DpChecklistItem = { id: string; label: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' | 'error'; summary?: string };

// createDefaultDpChecklist() removed — checklist is now created by gateway via syncChecklistFromStatus().

/** Parse tool input from DB (stored as JSON string) into display string */
function parseToolInput(toolName: string, raw: string): string {
    try {
        const args = JSON.parse(raw) as Record<string, unknown>;
        return formatToolInput(toolName, args);
    } catch {
        return raw; // Already a plain string
    }
}

/** Format tool args into a readable one-liner for display */
function formatToolInput(toolName: string, args?: Record<string, unknown>): string {
    if (!args) return '';
    const name = toolName.toLowerCase();
    if (name === 'bash' || name === 'shell' || name === 'command') {
        return (args.command as string) || (args.cmd as string) || '';
    }
    if (name === 'node_exec') {
        const node = (args.node as string) || '';
        const cmd = (args.command as string) || '';
        return node && cmd ? `${node} $ ${cmd}` : node || cmd;
    }
    if (name === 'node_script') {
        const node = (args.node as string) || '';
        const skill = (args.skill as string) || '';
        const script = (args.script as string) || '';
        const sArgs = (args.args as string) || '';
        const scriptPart = [skill, script].filter(Boolean).join('/');
        const cmdPart = sArgs ? `${scriptPart} ${sArgs}` : scriptPart;
        return node && cmdPart ? `${node} $ ${cmdPart}` : node || cmdPart;
    }
    if (name === 'pod_exec') {
        const pod = (args.pod as string) || '';
        const ns = (args.namespace as string) || '';
        const cmd = (args.command as string) || '';
        const target = ns ? `${pod} -n ${ns}` : pod;
        return target && cmd ? `${target} $ ${cmd}` : target || cmd;
    }
    if (name === 'pod_script') {
        const pod = (args.pod as string) || '';
        const ns = (args.namespace as string) || '';
        const skill = (args.skill as string) || '';
        const script = (args.script as string) || '';
        const sArgs = (args.args as string) || '';
        const target = ns ? `${pod} -n ${ns}` : pod;
        const scriptPart = [skill, script].filter(Boolean).join('/');
        const cmdPart = sArgs ? `${scriptPart} ${sArgs}` : scriptPart;
        return target && cmdPart ? `${target} $ ${cmdPart}` : target || cmdPart;
    }
    if (name === 'read' || name === 'readfile') {
        return (args.file_path as string) || (args.path as string) || '';
    }
    if (name === 'write' || name === 'writefile') {
        return (args.file_path as string) || (args.path as string) || '';
    }
    if (name === 'edit') {
        return (args.file_path as string) || (args.path as string) || '';
    }
    if (name === 'grep' || name === 'search') {
        const pattern = (args.pattern as string) || '';
        const path = (args.path as string) || '';
        return path ? `${pattern} in ${path}` : pattern;
    }
    if (name === 'glob') {
        return (args.pattern as string) || '';
    }
    if (name === 'skill_preview') {
        return (args.dir as string)?.split('/').pop() || '';
    }
    if (name === 'local_script') {
        const skill = (args.skill as string) || '';
        const script = (args.script as string) || '';
        const skillArgs = (args.args as string) || '';
        const parts = [skill, script].filter(Boolean).join('/');
        return skillArgs ? `${parts} ${skillArgs}` : parts;
    }
    if (name === 'task_plan') {
        return (args.title as string) || '';
    }
    if (name === 'deep_search') {
        return (args.question as string) || '';
    }
    if (name === 'update_plan') {
        const step = args.step as number | undefined;
        const status = (args.status as string) || '';
        return step != null ? `Step ${step}: ${status}` : status;
    }
    // Fallback: show first string value or JSON
    const vals = Object.values(args).filter(v => typeof v === 'string' && v.length > 0) as string[];
    return vals[0] || JSON.stringify(args);
}

export function usePilot() {
    const { currentWorkspace } = useWorkspace();
    const workspaceId = currentWorkspace?.id;
    const prevWorkspaceIdRef = useRef<string | undefined>(workspaceId);
    const [messages, setMessages] = useState<PilotMessage[]>([]);
    const messagesRef = useRef<PilotMessage[]>([]);
    messagesRef.current = messages;
    const [investigationProgress, setInvestigationProgress] = useState<InvestigationProgress | null>(null);
    const [dpFocus, setDpFocus] = useState<string | null>(null);
    const [dpChecklist, setDpChecklist] = useState<DpChecklistItem[] | null>(null);
    const DP_ACTIVE_STORAGE = 'siclaw_dp_active';
    const [dpActive, setDpActive] = useState(() => {
        return sessionStorage.getItem(DP_ACTIVE_STORAGE) === 'true';
    });
    const [sessions, setSessions] = useState<Session[]>([]);
    const [currentSessionKey, setCurrentSessionKey] = useState<string | null>(() => {
        const storedKey = sessionStorage.getItem(SESSION_KEY_STORAGE);
        if (!storedKey) return null;
        // If workspace changed while Pilot was unmounted, discard stale session key
        const storedWs = sessionStorage.getItem(SESSION_WORKSPACE_STORAGE);
        if (storedWs !== (workspaceId ?? '')) return null;
        return storedKey;
    });
    const [isLoading, setIsLoading] = useState(false);
    const [pendingMessages, setPendingMessages] = useState<string[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
    const [isCompacting, setIsCompacting] = useState(false);
    const [isRetrying, setIsRetrying] = useState(false);
    const isAbortingRef = useRef(false);
    const [skills, setSkills] = useState<Skill[]>([]);
    const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
    const [editingSkill, setEditingSkill] = useState<{ id: string; name: string } | null>(null);
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [defaultModelRef, setDefaultModelRef] = useState<{ provider: string; modelId: string } | null>(null);
    const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
    const [selectedBrain, setSelectedBrain] = useState<BrainType>(() => {
        return (localStorage.getItem(SELECTED_BRAIN_STORAGE) as BrainType) || "pi-agent";
    });
    // The actual brain type of the current active session (from backend), null = no session / unknown
    const [sessionBrainType, setSessionBrainType] = useState<BrainType | null>(null);

    // Timing: performance.now() when the current prompt was sent (drives ThinkingIndicator stopwatch)
    const [loadingStartedAt, setLoadingStartedAt] = useState<number | null>(null);
    // Ref tracks performance.now() of last message_start for LLM duration calculation
    const llmStartRef = useRef<number>(0);
    // When LLM only emits tool calls (no text), llmDurationMs has nowhere to attach —
    // park it here until the next tool_execution_start claims it
    const pendingLlmDurationMsRef = useRef<number>(0);
    // Server-side Date.now() of last anchor event (sendMessage or tool_execution_end) — for TTFT calc
    const lastServerTsRef = useRef<number>(0);
    // Parked TTFT value (message_start.ts - lastServerTsRef) awaiting attachment to a message
    const pendingWaitMsRef = useRef<number>(0);

    // Ref for sendRpc — handleWsMessage has [] deps and can't close over sendRpc directly
    const sendRpcRef = useRef<(<T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>) | null>(null);
    // Ref to allow loadSessions calls from event handler without stale closures
    const loadSessionsRef = useRef<() => void>(() => {});
    // Ref for fetching context usage from event handler
    const fetchContextRef = useRef<() => void>(() => {});
    // Ref for loading models (needed after first prompt when AgentBox session exists)
    const loadModelsRef = useRef<() => void>(() => {});
    // Ref for fetching current session model
    const fetchModelRef = useRef<() => void>(() => {});
    // Stale-loading watchdog: reset UI if no agent events for too long while loading
    const lastAgentEventRef = useRef<number>(0);
    const staleTimerRef = useRef<ReturnType<typeof setInterval>>();
    // Ref to track current sessionKey for WS event filtering (avoids stale closures)
    const currentSessionKeyRef = useRef(currentSessionKey);
    useEffect(() => { currentSessionKeyRef.current = currentSessionKey; }, [currentSessionKey]);
    // Guards async session switches: only the latest loadHistory request may write UI state.
    const loadHistoryRequestIdRef = useRef(0);
    // Ref for restoring DP progress (used by loadHistory to call restoreDpProgress which is defined later)
    const restoreDpProgressRef = useRef<(sessionKey?: string | null, loadedMessages?: PilotMessage[]) => Promise<void>>(async () => {});
    // DP-related timeout refs (for cleanup on abort/session switch)
    const dpTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

    /** Create a tracked timeout that auto-removes itself on completion */
    const dpTimeout = (fn: () => void, ms: number) => {
        const id = setTimeout(() => {
            dpTimersRef.current.delete(id);
            fn();
        }, ms);
        dpTimersRef.current.add(id);
    };

    /** Cancel all pending DP timeouts */
    const clearDpTimers = () => {
        for (const id of dpTimersRef.current) clearTimeout(id);
        dpTimersRef.current.clear();
    };

    /** Reset all DP-related state including the active toggle */
    const resetDpState = () => {
        setDpChecklist(null);
        setDpFocus(null);
        setInvestigationProgress(null);
        setDpActive(false);
    };

    // Persist currentSessionKey + workspace to sessionStorage (per-tab isolation)
    useEffect(() => {
        if (currentSessionKey) {
            sessionStorage.setItem(SESSION_KEY_STORAGE, currentSessionKey);
            sessionStorage.setItem(SESSION_WORKSPACE_STORAGE, workspaceId ?? '');
        } else {
            sessionStorage.removeItem(SESSION_KEY_STORAGE);
            sessionStorage.removeItem(SESSION_WORKSPACE_STORAGE);
        }
    }, [currentSessionKey, workspaceId]);

    // Persist dpActive to sessionStorage (cleared on tab close / logout)
    useEffect(() => {
        sessionStorage.setItem(DP_ACTIVE_STORAGE, String(dpActive));
    }, [dpActive]);

    // Persist selectedBrain to localStorage
    useEffect(() => {
        localStorage.setItem(SELECTED_BRAIN_STORAGE, selectedBrain);
    }, [selectedBrain]);

    const selectBrain = useCallback((brain: BrainType) => {
        setSelectedBrain(brain);
    }, []);

    const handleWsMessage = useCallback((msg: WsMessage) => {
        // Event frames: { type: "event", event: "agent_event", payload: { type: "message_update", ... } }
        if (msg.type === 'event' && msg.payload) {
            const payload = msg.payload as Record<string, unknown>;

            // Filter events by sessionId — ignore events from other tabs' sessions
            const eventSessionId = payload.sessionId as string | undefined;
            if (eventSessionId && eventSessionId !== currentSessionKeyRef.current) return;

            lastAgentEventRef.current = Date.now();
            const eventType = payload.type as string;

            switch (eventType) {
                case 'message_update': {
                    const ame = payload.assistantMessageEvent as { type: string; delta?: string } | undefined;
                    if (ame?.type === 'text_delta' && ame.delta) {
                        setMessages(prev => {
                            const last = prev[prev.length - 1];
                            if (last?.isStreaming && last.role === 'assistant') {
                                return [
                                    ...prev.slice(0, -1),
                                    { ...last, content: last.content + ame.delta }
                                ];
                            }
                            return [...prev, {
                                id: `msg-${Date.now()}`,
                                role: 'assistant' as const,
                                content: ame.delta!,
                                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                isStreaming: true,
                            }];
                        });
                    }
                    break;
                }

                case 'tool_execution_start': {
                    const toolName = payload.toolName as string | undefined;
                    const args = payload.args as Record<string, unknown> | undefined;
                    const toolInput = formatToolInput(toolName ?? '', args);
                    const hidden = toolName === 'update_plan' || toolName === 'end_investigation';
                    // Initialize investigation progress for deep_search (preserve optimistic state if present)
                    if (toolName === 'deep_search') {
                        setInvestigationProgress(prev => prev ?? { hypotheses: [] });
                        // Checklist creation now handled by dp_status event from gateway.
                    }
                    // Claim pending LLM thinking duration (set when LLM only emitted tool calls, no text)
                    const thinkMs = pendingLlmDurationMsRef.current || undefined;
                    pendingLlmDurationMsRef.current = 0;
                    // Claim pending TTFT (set at message_start when LLM only emitted tool calls)
                    const waitMs = pendingWaitMsRef.current || undefined;
                    pendingWaitMsRef.current = 0;
                    if (waitMs != null) appendTimingSample('siclaw_timing_ttft', waitMs);
                    if (thinkMs != null) appendTimingSample('siclaw_timing_llm', thinkMs);
                    // end_investigation cleanup now driven by dp_status "completed" event from gateway.
                    setMessages(prev => [...prev, {
                        id: `tool-${Date.now()}`,
                        role: 'tool' as const,
                        content: '',
                        toolName: toolName ?? 'tool',
                        toolInput,
                        toolStatus: 'running' as const,
                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        isStreaming: true,
                        hidden,
                        startedAt: performance.now(),
                        llmDurationMs: thinkMs,
                        waitMs,
                    }]);
                    break;
                }

                case 'tool_execution_end': {
                    // Update anchor timestamp for next TTFT calculation
                    if (payload.ts) lastServerTsRef.current = payload.ts as number;
                    const result = payload.result as { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> } | undefined;
                    const resultText = result?.content
                        ?.filter((c: { type: string }) => c.type === 'text')
                        .map((c: { text?: string }) => c.text ?? '')
                        .join('') ?? '';
                    const toolDetails = result?.details;
                    const isError = payload.isError as boolean | undefined;
                    // Use real DB message ID if available (enables metadata persistence)
                    const dbMessageId = payload.dbMessageId as string | undefined;
                    // Check toolName before entering setMessages to avoid side effects
                    // inside the state updater (React StrictMode calls updaters twice).
                    const endedToolName = payload.toolName as string | undefined;
                    const endPerfNow = performance.now();
                    // Capture timing from the running tool BEFORE setMessages (messagesRef is last committed state)
                    const runningTool = [...messagesRef.current].reverse().find(m => m.role === 'tool' && m.isStreaming);
                    const durationMsSnap = runningTool?.startedAt != null ? Math.round(endPerfNow - runningTool.startedAt) : undefined;
                    const toolWaitMs = runningTool?.waitMs;
                    const toolLlmDurationMs = runningTool?.llmDurationMs;
                    // When deep_search completes, mark all remaining checklist items
                    // as done and auto-clear after 3s. This replaces the old
                    // manage_checklist(conclusion=done) trigger.
                    // deep_search completion: checklist update comes from dp_status event.
                    // Auto-clear hypothesis tree after all hypotheses finish.
                    if (endedToolName === 'deep_search') {
                        dpTimeout(() => {
                            setInvestigationProgress(prev => {
                                if (prev && prev.hypotheses.every(h =>
                                    h.status !== 'validating' && h.status !== 'pending'
                                )) {
                                    return null;
                                }
                                return prev;
                            });
                        }, 5000);
                    }
                    setMessages(prev => {
                        const last = prev[prev.length - 1];
                        if (last?.role === 'tool' && last.isStreaming) {
                            const durationMs = last.startedAt != null
                                ? Math.round(endPerfNow - last.startedAt)
                                : undefined;
                            return [
                                ...prev.slice(0, -1),
                                {
                                    ...last,
                                    content: resultText,
                                    toolStatus: isError ? 'error' as const : 'success' as const,
                                    isStreaming: false,
                                    durationMs,
                                    ...(toolDetails ? { toolDetails } : {}),
                                    ...(dbMessageId ? { id: dbMessageId } : {}),
                                }
                            ];
                        }
                        return prev;
                    });
                    // Collect tool execution time sample for dashboard statistics
                    if (durationMsSnap != null) appendTimingSample('siclaw_timing_tool', durationMsSnap);
                    // Persist timing + toolStatus to DB via metadata so they survive navigation and session reload
                    if (dbMessageId && sendRpcRef.current) {
                        const meta: Record<string, unknown> = {};
                        meta.toolStatus = isError ? 'error' : 'success';
                        if (durationMsSnap != null) meta.durationMs = durationMsSnap;
                        if (toolWaitMs != null) meta.waitMs = toolWaitMs;
                        if (toolLlmDurationMs != null) meta.llmDurationMs = toolLlmDurationMs;
                        sendRpcRef.current('message.updateMeta', { id: dbMessageId, metadata: meta }).catch(() => {});
                    }
                    break;
                }

                case 'tool_progress': {
                    const progress = payload.progress as Record<string, unknown> | undefined;
                    if (payload.toolName === 'deep_search' && progress) {
                        // Hypothesis-level detail (sub-agent progress tree) — kept for validating phase
                        setInvestigationProgress(prev => {
                            const state = prev ?? { hypotheses: [] };
                            return reduceInvestigationProgress(state, progress);
                        });
                        // Checklist updates now come from dp_status events (gateway-emitted).
                        // Phase N/4 mapping removed — dpStatus is the single source of truth.
                    }
                    break;
                }

                // dp_status: gateway-emitted synthetic event — single source for checklist state
                case 'dp_status': {
                    const dpStatus = payload.dpStatus as string | undefined;
                    const checklist = payload.checklist as DpChecklistItem[] | null | undefined;
                    if (!dpStatus || dpStatus === 'idle') {
                        resetDpState();
                        break;
                    }
                    setDpActive(true);
                    if (checklist) {
                        setDpChecklist(checklist);
                        const focus = checklist.find(i => i.status === 'in_progress');
                        setDpFocus(focus ? focus.id : null);
                    }
                    if (dpStatus === 'completed') {
                        dpTimeout(() => resetDpState(), 3000);
                    }
                    break;
                }

                case 'message_start': {
                    llmStartRef.current = performance.now();
                    // Compute TTFT: server ts of this event minus server ts of last anchor
                    if (payload.ts && lastServerTsRef.current > 0) {
                        pendingWaitMsRef.current = Math.max(0, Math.round((payload.ts as number) - lastServerTsRef.current));
                    } else {
                        pendingWaitMsRef.current = 0;
                    }
                    const msg = payload.message as { role?: string; customType?: string; details?: Record<string, unknown>; content?: string | Array<{ type: string; text?: string }> } | undefined;

                    // Show steer (user) messages injected mid-conversation.
                    // The initial prompt's user message is already displayed by sendMessage,
                    // so only create a PilotMessage if the text is in pendingMessages (= steer).
                    if (msg?.role === 'user') {
                        const text = extractUserMessageText(msg.content);
                        if (text) {
                            setPendingMessages(prev => {
                                const idx = findPendingSteerIndex(prev, text);
                                if (idx < 0) return prev; // not a steer — already displayed
                                // Steer message: add to chat and remove from pending
                                setMessages(msgs => [...msgs, {
                                    id: `msg-${Date.now()}`,
                                    role: 'user' as const,
                                    content: text,
                                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                }]);
                                return removePendingAt(prev, idx);
                            });
                        }
                    }
                    break;
                }

                case 'message_end': {
                    const endMsg = payload.message as { role?: string; toolName?: string; details?: Record<string, unknown> } | undefined;
                    // Stamp LLM duration + TTFT onto the last streaming assistant message.
                    // If LLM only emitted tool calls (no text), no streaming assistant message exists —
                    // park both in pending refs so tool_execution_start can claim them.
                    if (endMsg?.role === 'assistant' && llmStartRef.current > 0) {
                        const llmDurationMs = Math.round(performance.now() - llmStartRef.current);
                        llmStartRef.current = 0;
                        const waitMs = pendingWaitMsRef.current || undefined;
                        pendingWaitMsRef.current = 0;
                        const hasStreamingAssistant = messagesRef.current.some(
                            m => m.role === 'assistant' && m.isStreaming
                        );
                        if (hasStreamingAssistant) {
                            if (waitMs != null) appendTimingSample('siclaw_timing_ttft', waitMs);
                            appendTimingSample('siclaw_timing_llm', llmDurationMs);
                            setMessages(prev => {
                                for (let i = prev.length - 1; i >= 0; i--) {
                                    if (prev[i].role === 'assistant' && prev[i].isStreaming) {
                                        const updated = [...prev];
                                        updated[i] = { ...prev[i], llmDurationMs, waitMs };
                                        return updated;
                                    }
                                }
                                return prev;
                            });
                        } else {
                            pendingLlmDurationMsRef.current = llmDurationMs;
                            // waitMs stays in pendingWaitMsRef — already cleared above, restore it
                            pendingWaitMsRef.current = waitMs ?? 0;
                        }
                    }
                    if (endMsg?.role === 'toolResult' && endMsg.details && Object.keys(endMsg.details).length > 0) {
                        // Pi-agent brain: tool result details arrive via message_end (not tool_execution_end).
                        // Backfill toolDetails onto the matching tool message.
                        const tName = endMsg.toolName;
                        setMessages(prev => {
                            // Walk backwards to find the most recent tool message with this name
                            for (let i = prev.length - 1; i >= 0; i--) {
                                const m = prev[i];
                                if (m.role === 'tool' && (!tName || m.toolName === tName) && !m.toolDetails) {
                                    const updated = [...prev];
                                    updated[i] = { ...m, toolDetails: endMsg.details };
                                    return updated;
                                }
                            }
                            return prev;
                        });
                    }
                    // Mark current streaming assistant message as complete
                    setMessages(prev => prev.map(m =>
                        m.isStreaming && m.role === 'assistant' ? { ...m, isStreaming: false } : m
                    ));
                    break;
                }

                case 'auto_compaction_start':
                    setIsCompacting(true);
                    break;

                case 'auto_compaction_end':
                    setIsCompacting(false);
                    fetchContextRef.current();
                    break;

                case 'auto_retry_start':
                    setIsRetrying(true);
                    break;

                case 'auto_retry_end':
                    setIsRetrying(false);
                    break;

                case 'turn_end':
                    // Mark streaming messages as complete after each agentic turn,
                    // but do NOT set isLoading=false — the agent may have more turns.
                    setMessages(prev => prev.map(m =>
                        m.isStreaming ? { ...m, isStreaming: false } : m
                    ));
                    // Steer messages are removed from pending via message_start text matching
                    // (not here — turn_end fires for normal tool-call turns too).
                    break;

                case 'prompt_done':
                    // Agent prompt truly finished (SSE stream closed)
                    setMessages(prev => prev.map(m =>
                        m.isStreaming ? { ...m, isStreaming: false } : m
                    ));
                    // During abort, don't unlock here — abortResponse will do it after RPC completes
                    if (!isAbortingRef.current) {
                        setIsLoading(false);
                        setLoadingStartedAt(null);
                    }
                    setPendingMessages([]);
                    loadSessionsRef.current();
                    fetchContextRef.current();
                    loadModelsRef.current();
                    fetchModelRef.current();

                    // Persist timing for assistant messages — they have no dbMessageId during streaming,
                    // so we fetch the just-saved DB messages and match by role+content to update metadata.
                    if (!isAbortingRef.current && sendRpcRef.current && currentSessionKeyRef.current) {
                        const sessionId = currentSessionKeyRef.current;
                        const rpc = sendRpcRef.current;
                        const assistantsToSave = messagesRef.current.filter(m =>
                            m.role === 'assistant' && (m.llmDurationMs != null || m.waitMs != null)
                        );
                        if (assistantsToSave.length > 0) {
                            setTimeout(async () => {
                                try {
                                    const res = await rpc<{ messages: PilotMessage[] }>('chat.history', { sessionId });
                                    const dbMessages = res.messages ?? [];
                                    for (const m of assistantsToSave) {
                                        const match = dbMessages.find(d => d.role === 'assistant' && d.content === m.content);
                                        if (match) {
                                            const meta: Record<string, unknown> = {};
                                            if (m.llmDurationMs != null) meta.llmDurationMs = m.llmDurationMs;
                                            if (m.waitMs != null) meta.waitMs = m.waitMs;
                                            await rpc('message.updateMeta', { id: match.id, metadata: meta });
                                        }
                                    }
                                } catch { /* best-effort */ }
                            }, 800);
                        }
                    }

                    // DP checklist completion now handled by dp_status "completed" event from gateway.
                    // No safety-net needed — gateway emits dp_status on agent_end when status is concluding.
                    break;
            }
        }
    }, []);

    const { status, sendRpc, isConnected } = useWebSocket({
        onMessage: handleWsMessage,
    });

    const loadSkills = useCallback(async () => {
        if (!isConnected) return;
        try {
            const result = await rpcGetSkills(sendRpc);
            setSkills(result.skills);
        } catch (err) {
            console.error('Failed to load skills:', err);
        }
    }, [isConnected, sendRpc]);

    const loadModels = useCallback(async () => {
        if (!isConnected) return;
        try {
            const result = await sendRpc<{ models: ModelInfo[]; default: { provider: string; modelId: string } | null }>('model.list');
            const list = result.models ?? [];
            setModels(list);
            setDefaultModelRef(result.default ?? null);
            // Always sync to DB default model (so changes on Models page take effect immediately)
            if (list.length > 0) {
                if (result.default) {
                    const match = list.find(m => m.provider === result.default!.provider && m.id === result.default!.modelId);
                    if (match) setSelectedModel(match);
                    else setSelectedModel(prev => prev ?? list[0]);
                } else {
                    setSelectedModel(prev => prev ?? list[0]);
                }
            }
        } catch (err) {
            console.error('Failed to load models:', err);
        }
    }, [isConnected, sendRpc]);

    const loadSystemStatus = useCallback(async () => {
        if (!isConnected) return;
        try {
            const result = await sendRpc<SystemStatus>('system.status');
            setSystemStatus(result);
        } catch { /* ignore */ }
    }, [isConnected, sendRpc]);

    const fetchCurrentModel = useCallback(async () => {
        if (!isConnected || !currentSessionKey || selectedModel) return;
        try {
            const result = await sendRpc<{ model: ModelInfo | null; brainType?: BrainType }>('model.get', { sessionId: currentSessionKey });
            if (result.model) setSelectedModel(result.model);
            if (result.brainType) setSessionBrainType(result.brainType);
        } catch { /* ignore */ }
    }, [isConnected, currentSessionKey, selectedModel, sendRpc]);

    const startEditSkill = useCallback((id: string, name: string) => {
        setEditingSkill({ id, name });
    }, []);

    const clearEditSkill = useCallback(() => {
        setEditingSkill(null);
    }, []);

    const loadSessions = useCallback(async () => {
        if (!isConnected) return;
        try {
            const params: Record<string, unknown> = {};
            if (workspaceId) params.workspaceId = workspaceId;
            const result = await sendRpc<{ sessions: Session[] }>('session.list', params);
            setSessions(result.sessions ?? []);
        } catch (err) {
            console.error('Failed to load sessions:', err);
        }
    }, [isConnected, sendRpc, workspaceId]);

    // Keep refs in sync
    sendRpcRef.current = sendRpc;
    loadSessionsRef.current = loadSessions;
    loadModelsRef.current = loadModels;
    fetchModelRef.current = fetchCurrentModel;

    const fetchContextUsage = useCallback(async () => {
        if (!isConnected || !currentSessionKey) return;
        try {
            const result = await sendRpc<ContextUsage | null>('chat.context', { sessionId: currentSessionKey });
            if (result) {
                setContextUsage({
                    tokens: result.tokens,
                    contextWindow: result.contextWindow,
                    percent: result.percent,
                    inputTokens: result.inputTokens,
                    outputTokens: result.outputTokens,
                    cacheReadTokens: result.cacheReadTokens,
                    cacheWriteTokens: result.cacheWriteTokens,
                    cost: result.cost,
                });
            }
        } catch {
            // ignore
        }
    }, [isConnected, currentSessionKey, sendRpc]);

    fetchContextRef.current = fetchContextUsage;

    const mapMessages = (raw: PilotMessage[]) => raw.map(m => ({
        ...m,
        // Restore timing + toolStatus from metadata (persisted at runtime; absent on first load before any conversation)
        toolStatus: m.toolStatus ?? (m.metadata?.toolStatus as ToolStatus | undefined) ?? (m.role === 'tool' && m.content ? 'success' as ToolStatus : undefined),
        durationMs: m.durationMs ?? (m.metadata?.durationMs as number | undefined),
        llmDurationMs: m.llmDurationMs ?? (m.metadata?.llmDurationMs as number | undefined),
        waitMs: m.waitMs ?? (m.metadata?.waitMs as number | undefined),
        toolInput: m.role === 'tool' && m.toolInput
            ? parseToolInput(m.toolName ?? '', m.toolInput)
            : undefined,
        isoTimestamp: m.timestamp,
        timestamp: m.timestamp
            ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '',
        hidden: m.hidden || (m.role === 'tool' && (m.toolName === 'update_plan' || m.toolName === 'manage_checklist')),
    }));

    const loadHistory = useCallback(async (sessionKey: string) => {
        if (!isConnected) return;
        const requestId = ++loadHistoryRequestIdRef.current;
        setCurrentSessionKey(sessionKey);
        setMessages([]);
        setHasMore(false);
        setIsLoadingHistory(true);
        setIsLoading(false);
        setPendingMessages([]);
        clearDpTimers();
        resetDpState();
        let loadedMsgs: PilotMessage[] = [];
        try {
            const result = await sendRpc<{ messages: PilotMessage[]; hasMore: boolean }>('chat.history', { sessionId: sessionKey });
            if (loadHistoryRequestIdRef.current !== requestId) return;
            loadedMsgs = mapMessages(result.messages ?? []);
            setMessages(loadedMsgs);
            setHasMore(result.hasMore ?? false);
        } catch (err) {
            if (loadHistoryRequestIdRef.current === requestId) {
                console.error('Failed to load history:', err);
            }
        } finally {
            if (loadHistoryRequestIdRef.current === requestId) {
                setIsLoadingHistory(false);
            }
        }
        // Fetch current model + brain type for this session
        try {
            const result = await sendRpc<{ model: ModelInfo | null; brainType?: BrainType }>('model.get', { sessionId: sessionKey });
            if (loadHistoryRequestIdRef.current !== requestId) return;
            if (result.model) setSelectedModel(result.model);
            if (result.brainType) setSessionBrainType(result.brainType);
        } catch { /* ignore */ }
        // Restore deep investigation progress (checklist cards, hypothesis tree).
        // Pass sessionKey explicitly to avoid race with async currentSessionKeyRef update.
        if (loadHistoryRequestIdRef.current !== requestId) return;
        await restoreDpProgressRef.current(sessionKey, loadedMsgs);
    }, [isConnected, sendRpc]);

    const loadMoreHistory = useCallback(async () => {
        if (!isConnected || !currentSessionKey || !hasMore || isLoadingMore) return;
        const oldest = messages[0];
        if (!oldest) return;

        setIsLoadingMore(true);
        try {
            const result = await sendRpc<{ messages: PilotMessage[]; hasMore: boolean }>('chat.history', {
                sessionId: currentSessionKey,
                before: oldest.isoTimestamp,
            });
            const older = mapMessages(result.messages ?? []);
            setMessages(prev => [...older, ...prev]);
            setHasMore(result.hasMore ?? false);
        } catch (err) {
            console.error('Failed to load more history:', err);
        } finally {
            setIsLoadingMore(false);
        }
    }, [isConnected, currentSessionKey, hasMore, isLoadingMore, messages, sendRpc]);

    const sendMessage = useCallback(async (text: string) => {
        if (!isConnected || !text.trim()) return;

        // During agent execution: steer instead of sending a new prompt
        if (isLoading) {
            try {
                await sendRpc('chat.steer', { text, sessionId: currentSessionKeyRef.current });
                setPendingMessages(prev => [...prev, text]);
            } catch (err) {
                console.error('Failed to steer:', err);
            }
            return;
        }

        const userMsg: PilotMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        setMessages(prev => [...prev, userMsg]);
        setIsLoading(true);
        setLoadingStartedAt(performance.now());
        lastServerTsRef.current = Date.now();
        pendingWaitMsRef.current = 0;

        try {
            const result = await sendRpc<{ sessionId: string; brainType?: BrainType }>('chat.send', {
                sessionId: currentSessionKey,
                message: text,
                modelProvider: selectedModel?.provider,
                modelId: selectedModel?.id,
                brainType: currentSessionKey ? (sessionBrainType ?? undefined) : selectedBrain,
                workspaceId,
            });
            // Lock brain selector to the actual session brain type
            if (result.brainType) {
                setSessionBrainType(result.brainType);
            }
            // Update current session key from server response
            if (result.sessionId && result.sessionId !== currentSessionKey) {
                setCurrentSessionKey(result.sessionId);
                // New session was created server-side, refresh list
                loadSessionsRef.current();
            }
        } catch (err) {
            console.error('Failed to send message:', err);
            setIsLoading(false);
        }
    }, [isConnected, isLoading, currentSessionKey, selectedModel, selectedBrain, sendRpc, sessionBrainType]);

    const abortResponse = useCallback(async () => {
        if (!isConnected) return;
        isAbortingRef.current = true;
        setPendingMessages([]);
        clearDpTimers();
        resetDpState();
        // Mark all streaming messages as complete visually
        setMessages(prev => prev.map(m =>
            m.isStreaming
                ? { ...m, isStreaming: false, ...(m.role === 'tool' ? { toolStatus: 'aborted' as const } : {}) }
                : m
        ));
        try {
            // Clear backend steer queue before abort to prevent residual messages
            await sendRpc('chat.clearQueue', { sessionId: currentSessionKeyRef.current }).catch(() => {});
            await sendRpc('chat.abort', { sessionId: currentSessionKeyRef.current });
        } catch (err) {
            console.error('Failed to abort:', err);
        }
        // Only allow new input after backend confirms abort
        isAbortingRef.current = false;
        setIsLoading(false);
    }, [isConnected, sendRpc]);

    const clearPendingMessages = useCallback(async () => {
        setPendingMessages([]);
        if (!isConnected) return;
        try {
            await sendRpc('chat.clearQueue', { sessionId: currentSessionKeyRef.current });
        } catch (err) {
            console.error('Failed to clear queue:', err);
        }
    }, [isConnected, sendRpc]);

    const removePendingMessage = useCallback(async (index: number) => {
        // Capture remaining messages after removal
        let remaining: string[] = [];
        setPendingMessages(prev => {
            const next = [...prev];
            next.splice(index, 1);
            remaining = next;
            return next;
        });
        // Clear server queue and re-steer remaining messages in order
        if (!isConnected) return;
        try {
            await sendRpc('chat.clearQueue', { sessionId: currentSessionKeyRef.current });
            for (const msg of remaining) {
                await sendRpc('chat.steer', { text: msg, sessionId: currentSessionKeyRef.current });
            }
        } catch (err) {
            console.error('Failed to remove pending message:', err);
        }
    }, [isConnected, sendRpc]);

    const updateMessageMeta = useCallback(async (messageId: string, meta: Record<string, unknown>) => {
        // Always update local state immediately so UI reflects the change
        setMessages(prev => prev.map(m =>
            m.id === messageId ? { ...m, metadata: { ...m.metadata, ...meta } } : m
        ));
        // Persist to DB (best-effort — may fail if message has a temporary ID)
        if (isConnected) {
            try {
                await sendRpc('message.updateMeta', { id: messageId, metadata: meta });
            } catch (err) {
                console.error('Failed to persist message metadata:', err);
            }
        }
    }, [isConnected, sendRpc]);

    const dismissDpChecklist = useCallback(() => {
        clearDpTimers();
        resetDpState();
    }, []);

    const exitDpMode = useCallback(() => {
        dismissDpChecklist();
        sendMessage('[DP_EXIT]\nPlease briefly summarize the current investigation progress and findings.');
    }, [dismissDpChecklist, sendMessage]);

    /** Populate hypothesis tree when user confirms. Checklist update comes from dp_status event. */
    const confirmHypotheses = useCallback((hypotheses: Array<{ id: string; text: string; confidence: number }>) => {
        // Pre-populate hypothesis tree with pending status (optimistic UI for sub-agent progress)
        setInvestigationProgress({
            hypotheses: hypotheses.map(h => ({
                id: h.id,
                text: h.text,
                status: 'pending',
                confidence: h.confidence,
                callsUsed: 0,
                maxCalls: 10,
            })),
        });
        // Compat: fire-and-forget RPC (no-op on backend, kept for older gateway versions)
        sendRpc('chat.confirmHypotheses', { sessionId: currentSessionKeyRef.current }).catch(() => {});
    }, [sendRpc]);

    const createSession = useCallback(() => {
        // Don't create a DB session yet — just reset UI to "new chat" state.
        // The backend will create the session lazily on first chat.send.
        setCurrentSessionKey(null);
        setMessages([]);
        setContextUsage(null);
        setIsCompacting(false);
        setIsLoading(false);
        setPendingMessages([]);
        // Use the DB default model, fall back to first in list
        const defaultModel = defaultModelRef
            ? models.find(m => m.provider === defaultModelRef.provider && m.id === defaultModelRef.modelId)
            : null;
        setSelectedModel(defaultModel ?? models[0] ?? null);
        setSessionBrainType(null); // unlock brain selector for new session
        clearDpTimers();
        resetDpState();
        loadSystemStatus();
    }, [models, defaultModelRef, loadSystemStatus]);

    const deleteSession = useCallback(async (sessionKey: string) => {
        if (!isConnected) return;
        try {
            await sendRpc('session.delete', { sessionId: sessionKey });
            if (currentSessionKey === sessionKey) {
                setCurrentSessionKey(null);
                setMessages([]);
            }
            loadSessions();
        } catch (err) {
            console.error('Failed to delete session:', err);
        }
    }, [isConnected, sendRpc, currentSessionKey, loadSessions]);

    // Reset loading state when WebSocket disconnects mid-generation.
    // Give a grace window for WS to auto-reconnect (SSH tunnel flaps,
    // browser sleep, network blips). Backend SSE continues independently.
    // deep_search runs long sub-agent tasks — use 60s grace instead of 15s.
    const disconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const deepSearchRunning = dpChecklist?.some(i => i.id === 'deep_search' && i.status === 'in_progress');
    const disconnectGraceMs = deepSearchRunning ? 60_000 : 15_000;
    useEffect(() => {
        if (!isConnected && isLoading) {
            disconnectTimerRef.current = setTimeout(() => {
                setIsLoading(false);
                isAbortingRef.current = false;
                setPendingMessages([]);
                setMessages(prev => prev.map(m =>
                    m.isStreaming
                        ? { ...m, isStreaming: false, ...(m.role === 'tool' ? { toolStatus: 'error' as const } : {}) }
                        : m
                ));
                clearDpTimers();
                setDpChecklist(prev => {
                    if (!prev) return null;
                    return prev.map(item =>
                        item.status === 'in_progress' || item.status === 'pending'
                            ? { ...item, status: 'error' as const, summary: 'Connection lost' }
                            : item
                    );
                });
                setDpFocus(null);
                // Preserve hypothesis tree data on error — only clear the live action indicator
                setInvestigationProgress(prev => prev ? { ...prev, currentAction: undefined } : null);
                dpTimeout(() => resetDpState(), 10_000);
            }, disconnectGraceMs);
        }
        return () => {
            if (disconnectTimerRef.current) {
                clearTimeout(disconnectTimerRef.current);
                disconnectTimerRef.current = undefined;
            }
        };
    }, [isConnected, isLoading, disconnectGraceMs]);

    // Stale-loading watchdog: if isLoading but no agent events for too long,
    // the backend likely died silently — reset UI so user isn't stuck.
    // deep_search (Phase 3) runs long sub-agent LLM calls that can go 60s+
    // without events — use 5 min to avoid false positives.
    // Other DP phases use 90s; non-DP keeps 120s.
    const deepSearchActive = dpChecklist?.some(i => i.id === 'deep_search' && i.status === 'in_progress');
    const staleTimeoutMs = deepSearchActive ? 300_000 : dpChecklist ? 90_000 : 120_000;
    useEffect(() => {
        if (isLoading) {
            lastAgentEventRef.current = Date.now();
            staleTimerRef.current = setInterval(() => {
                if (Date.now() - lastAgentEventRef.current > staleTimeoutMs) {
                    console.warn('[usePilot] Stale loading detected — resetting UI');
                    setIsLoading(false);
                    isAbortingRef.current = false;
                    setPendingMessages([]);
                    setMessages(prev => prev.map(m =>
                        m.isStreaming
                            ? { ...m, isStreaming: false, ...(m.role === 'tool' ? { toolStatus: 'error' as const } : {}) }
                            : m
                    ));
                    clearDpTimers();
                    setDpChecklist(prev => {
                        if (!prev) return null;
                        return prev.map(item =>
                            item.status === 'in_progress' || item.status === 'pending'
                                ? { ...item, status: 'error' as const, summary: 'Response timeout' }
                                : item
                        );
                    });
                    setDpFocus(null);
                    // Preserve hypothesis tree data on error — only clear the live action indicator
                    setInvestigationProgress(prev => prev ? { ...prev, currentAction: undefined } : null);
                    dpTimeout(() => resetDpState(), 10_000);
                }
            }, 15_000); // check every 15s
            return () => clearInterval(staleTimerRef.current);
        }
        // Not loading — clear any running watchdog
        if (staleTimerRef.current) {
            clearInterval(staleTimerRef.current);
            staleTimerRef.current = undefined;
        }
    }, [isLoading, staleTimeoutMs]); // eslint-disable-line react-hooks/exhaustive-deps

    /** Restore DP progress from gateway snapshot after WS reconnect / page refresh.
     *  Uses dpStatus from agentbox (authoritative) or gateway cache (fallback).
     *  Accepts an explicit sessionKey to avoid race with async state updates. */
    const restoreDpProgress = useCallback(async (sessionKey?: string | null, loadedMessages?: PilotMessage[]) => {
        if (!isConnected) return;
        const targetSession = sessionKey ?? currentSessionKeyRef.current;
        if (!targetSession) return;
        try {
            const snap = await sendRpc<{
                sessionId?: string;
                events: Array<Record<string, unknown>> | null;
                promptActive?: boolean;
                dpStatus?: string | null;
                checklist?: DpChecklistItem[] | null;
                dpQuestion?: string | null;
                confirmedHypotheses?: Array<{ id: string; text: string; confidence: number }> | null;
            }>('chat.dpProgress', { sessionId: targetSession });

            // Restore loading state if prompt is still active
            if (snap.promptActive) {
                setIsLoading(true);
            }

            // Restore dpStatus/checklist regardless of promptActive.
            // awaiting_confirmation = prompt ended but DP is still alive.
            if (snap.checklist && snap.dpStatus && snap.dpStatus !== 'idle') {
                setDpActive(true);
                setDpChecklist(snap.checklist);
                const focus = snap.checklist.find(i => i.status === 'in_progress');
                setDpFocus(focus ? focus.id : null);
            }

            // Build hypothesis text lookup from the latest propose_hypotheses message in chat history.
            // This is the same data source the HypothesesCard uses — guaranteed to have correct titles.
            const hypothesesTextMap = new Map<string, string>();
            {
                // Use explicitly passed messages (avoids React batching race with messagesRef)
                const msgs = loadedMessages ?? messagesRef.current;
                for (let i = msgs.length - 1; i >= 0; i--) {
                    const m = msgs[i];
                    if (m.toolName === 'propose_hypotheses' && (m.toolDetails?.hypotheses || m.toolInput)) {
                        const raw = m.toolDetails?.hypotheses;
                        if (Array.isArray(raw)) {
                            // Structured path (SDK brain)
                            (raw as Array<{ id?: string; text?: string }>).forEach((h, idx) => {
                                hypothesesTextMap.set(h.id ?? `H${idx + 1}`, h.text ?? '');
                            });
                        } else {
                            // Pi-agent path (string) — reuse HypothesesCard's parser
                            const source = (raw as string | undefined) || m.toolInput || '';
                            if (source) {
                                const parsed = parseHypothesesText(source);
                                parsed.forEach((h, idx) => {
                                    hypothesesTextMap.set(`H${idx + 1}`, h.title);
                                });
                            }
                        }
                        break;
                    }
                }
                // Fallback: use confirmedHypotheses from agentbox dp-state (may have empty text
                // due to extension parser mismatch, but better than nothing)
                if (hypothesesTextMap.size === 0 && snap.confirmedHypotheses) {
                    snap.confirmedHypotheses.forEach(h => {
                        if (h.text) hypothesesTextMap.set(h.id, h.text);
                    });
                }
            }

            // Replay investigation progress for hypothesis tree (deep_search sub-agent detail)
            if (snap.events && snap.events.length > 0) {
                let state: InvestigationProgress = { hypotheses: [] };
                for (const ev of snap.events) {
                    state = reduceInvestigationProgress(state, ev);
                }
                // Backfill missing hypothesis titles from chat history / confirmedHypotheses
                if (hypothesesTextMap.size > 0) {
                    state = {
                        ...state,
                        hypotheses: state.hypotheses.map(h =>
                            !h.text && hypothesesTextMap.has(h.id)
                                ? { ...h, text: hypothesesTextMap.get(h.id)! }
                                : h
                        ),
                    };
                }
                setInvestigationProgress(state);
            } else if (hypothesesTextMap.size > 0 && snap.promptActive) {
                // No progress events cached, but we have hypothesis names from history.
                // Pre-populate so the tree shows titles immediately.
                const entries = snap.confirmedHypotheses ?? Array.from(hypothesesTextMap.entries()).map(
                    ([id, text]) => ({ id, text, confidence: 0 }),
                );
                setInvestigationProgress({
                    hypotheses: entries.map(h => ({
                        id: h.id,
                        text: hypothesesTextMap.get(h.id) || h.text || '',
                        status: 'validating' as const,
                        confidence: h.confidence,
                        callsUsed: 0,
                        maxCalls: 10,
                    })),
                });
            }
        } catch {
            // Gateway may not support extended dpProgress yet
        }
    }, [isConnected, sendRpc]);
    restoreDpProgressRef.current = restoreDpProgress;

    // When workspace changes: clear messages, reload sessions for new workspace,
    // and auto-select the most recent session if one exists.
    useEffect(() => {
        if (prevWorkspaceIdRef.current !== workspaceId && prevWorkspaceIdRef.current !== undefined) {
            // Invalidate any in-flight loadHistory requests from the previous workspace
            // to prevent stale responses from overwriting the cleared UI state.
            ++loadHistoryRequestIdRef.current;
            setCurrentSessionKey(null);
            setMessages([]);
            setContextUsage(null);
            setIsCompacting(false);
            setSessionBrainType(null);
            clearDpTimers();
            resetDpState();
            if (isConnected) {
                (async () => {
                    try {
                        const params: Record<string, unknown> = {};
                        if (workspaceId) params.workspaceId = workspaceId;
                        const result = await sendRpc<{ sessions: Session[] }>('session.list', params);
                        const newSessions = result.sessions ?? [];
                        setSessions(newSessions);
                        // Auto-load most recent session (first in list, sorted by recency)
                        if (newSessions.length > 0) {
                            loadHistory(newSessions[0].key);
                        }
                    } catch (err) {
                        console.error('Failed to load sessions:', err);
                    }
                })();
            }
        }
        prevWorkspaceIdRef.current = workspaceId;
    }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Load sessions, skills, and models on connect; reload history for persisted session
    useEffect(() => {
        if (isConnected) {
            // Load sessions and auto-select most recent if no persisted session key
            (async () => {
                try {
                    const params: Record<string, unknown> = {};
                    if (workspaceId) params.workspaceId = workspaceId;
                    const result = await sendRpc<{ sessions: Session[] }>('session.list', params);
                    const newSessions = result.sessions ?? [];
                    setSessions(newSessions);
                    if (currentSessionKey) {
                        loadHistory(currentSessionKey);
                    } else if (newSessions.length > 0) {
                        loadHistory(newSessions[0].key);
                    }
                } catch (err) {
                    console.error('Failed to load sessions:', err);
                }
            })();
            loadSkills();
            loadModels();
            loadSystemStatus();
        }
    }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

    // Listen for model config changes from Models page (cross-tab/cross-component)
    useEffect(() => {
        const ch = new BroadcastChannel('siclaw-model-config');
        ch.onmessage = () => { loadModelsRef.current(); };
        return () => ch.close();
    }, []);

    return {
        messages,
        investigationProgress,
        dpActive,
        setDpActive,
        dpFocus,
        dpChecklist,
        sessions,
        currentSessionKey,
        isLoading,
        isLoadingHistory,
        hasMore,
        isLoadingMore,
        contextUsage,
        isCompacting,
        isRetrying,
        skills,
        systemStatus,
        editingSkill,
        pendingMessages,
        wsStatus: status,
        isConnected,
        sendMessage,
        abortResponse,
        loadHistory,
        loadMoreHistory,
        createSession,
        deleteSession,
        loadSessions,
        setCurrentSessionKey,
        sendRpc,
        startEditSkill,
        clearEditSkill,
        loadSkills,
        loadSystemStatus,
        updateMessageMeta,
        clearPendingMessages,
        removePendingMessage,
        confirmHypotheses,
        dismissDpChecklist,
        exitDpMode,
        models,
        selectedModel,
        selectedBrain,
        selectBrain,
        sessionBrainType,
        loadingStartedAt,
    };
}
