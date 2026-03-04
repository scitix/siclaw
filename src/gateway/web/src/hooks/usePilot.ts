import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket, type WsMessage } from './useWebSocket';
import { rpcGetSkills, type Skill } from '@/pages/Skills/skillsData';
import { useWorkspace } from '@/contexts/WorkspaceContext';

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
const SELECTED_BRAIN_STORAGE = 'siclaw_selected_brain';

export type BrainType = "pi-agent" | "claude-sdk";

type DpChecklistItem = { id: string; label: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' | 'error'; summary?: string };

function createDefaultDpChecklist(): DpChecklistItem[] {
    return [
        { id: 'triage', label: 'Quick triage', status: 'pending' },
        { id: 'hypotheses', label: 'Propose hypotheses', status: 'pending' },
        { id: 'deep_search', label: 'Deep search validation', status: 'pending' },
        { id: 'conclusion', label: 'Present findings', status: 'pending' },
    ];
}

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
    if (name === 'pod_nsenter_exec') {
        const pod = (args.pod as string) || '';
        const ns = (args.namespace as string) || '';
        const cmd = (args.command as string) || '';
        const target = ns ? `${pod} -n ${ns}` : pod;
        return target && cmd ? `${target} $ ${cmd}` : target || cmd;
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
    if (name === 'create_skill') {
        return (args.name as string) || '';
    }
    if (name === 'run_skill') {
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
    const [investigationProgress, setInvestigationProgress] = useState<InvestigationProgress | null>(null);
    const [dpFocus, setDpFocus] = useState<string | null>(null);
    const [dpChecklist, setDpChecklist] = useState<DpChecklistItem[] | null>(null);
    const DP_ACTIVE_STORAGE = 'siclaw_dp_active';
    const [dpActive, setDpActive] = useState(() => {
        return localStorage.getItem(DP_ACTIVE_STORAGE) === 'true';
    });
    const [sessions, setSessions] = useState<Session[]>([]);
    const [currentSessionKey, setCurrentSessionKey] = useState<string | null>(() => {
        return localStorage.getItem(SESSION_KEY_STORAGE);
    });
    const [isLoading, setIsLoading] = useState(false);
    const [pendingMessages, setPendingMessages] = useState<string[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
    const [isCompacting, setIsCompacting] = useState(false);
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

    /** Reset all DP-related state (checklist, focus, progress) — toggle is user preference, not reset */
    const resetDpState = () => {
        setDpChecklist(null);
        setDpFocus(null);
        setInvestigationProgress(null);
    };

    // Persist currentSessionKey to localStorage
    useEffect(() => {
        if (currentSessionKey) {
            localStorage.setItem(SESSION_KEY_STORAGE, currentSessionKey);
        } else {
            localStorage.removeItem(SESSION_KEY_STORAGE);
        }
    }, [currentSessionKey]);

    // Persist dpActive to localStorage
    useEffect(() => {
        localStorage.setItem(DP_ACTIVE_STORAGE, String(dpActive));
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
            lastAgentEventRef.current = Date.now();
            const payload = msg.payload as Record<string, unknown>;
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
                    const hidden = toolName === 'update_plan' || toolName === 'manage_checklist' || toolName === 'end_investigation';
                    // Initialize investigation progress for deep_search (preserve optimistic state if present)
                    if (toolName === 'deep_search') {
                        setInvestigationProgress(prev => prev ?? { hypotheses: [] });
                    }
                    // Handle manage_checklist status updates
                    if (toolName === 'manage_checklist') {
                        const updates: Array<{ id: string; status?: string; summary?: string }> =
                            (args?.updates as any[]) || [];

                        setDpChecklist(prev => {
                            const items: DpChecklistItem[] = prev
                                ? prev.map(i => ({ ...i }))
                                : createDefaultDpChecklist();

                            for (const upd of updates) {
                                const item = items.find(i => i.id === upd.id);
                                if (!item) continue;
                                if (upd.status && (upd.status === 'done' || upd.status === 'skipped' || upd.status === 'in_progress' || upd.status === 'pending')) {
                                    item.status = upd.status;
                                }
                                if (upd.summary) item.summary = upd.summary;
                            }

                            // Derive dpFocus: first in_progress item
                            const focus = items.find(i => i.status === 'in_progress');
                            setDpFocus(focus ? focus.id : null);

                            // Auto-clear checklist when all steps are done
                            const allDone = items.every(i => i.status === 'done' || i.status === 'skipped');
                            if (allDone) {
                                dpTimeout(() => resetDpState(), 3000);
                            }
                            return items;
                        });
                    }
                    // Handle end_investigation: immediately reset all DP state
                    if (toolName === 'end_investigation') {
                        resetDpState();
                    }
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
                    }]);
                    break;
                }

                case 'tool_execution_end': {
                    const result = payload.result as { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> } | undefined;
                    const resultText = result?.content
                        ?.filter((c: { type: string }) => c.type === 'text')
                        .map((c: { text?: string }) => c.text ?? '')
                        .join('') ?? '';
                    const toolDetails = result?.details;
                    const isError = payload.isError as boolean | undefined;
                    // Use real DB message ID if available (enables metadata persistence)
                    const dbMessageId = payload.dbMessageId as string | undefined;
                    setMessages(prev => {
                        const last = prev[prev.length - 1];
                        if (last?.role === 'tool' && last.isStreaming) {
                            // Delayed clear of investigation progress — let DpChecklistCard show final state.
                            // Definitive clear happens on manage_checklist(deep_search, done).
                            if (last.toolName === 'deep_search') {
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
                            return [
                                ...prev.slice(0, -1),
                                {
                                    ...last,
                                    content: resultText,
                                    toolStatus: isError ? 'error' as const : 'success' as const,
                                    isStreaming: false,
                                    ...(toolDetails ? { toolDetails } : {}),
                                    ...(dbMessageId ? { id: dbMessageId } : {}),
                                }
                            ];
                        }
                        return prev;
                    });
                    break;
                }

                case 'tool_progress': {
                    const progress = payload.progress as Record<string, unknown> | undefined;
                    if (payload.toolName === 'deep_search' && progress) {
                        setInvestigationProgress(prev => {
                            const state = prev ?? { hypotheses: [] };
                            return reduceInvestigationProgress(state, progress);
                        });
                    }
                    break;
                }

                case 'message_start': {
                    const msg = payload.message as { role?: string; customType?: string; details?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> } | undefined;
                    // Handle dp-checklist-sync: backend auto-completed items on agent_end
                    if (msg?.customType === 'dp-checklist-sync' && msg.details?.items) {
                        const syncItems = msg.details.items as Array<{ id: string; status: string; summary?: string }>;
                        setDpChecklist(prev => {
                            if (!prev) return prev;
                            const items = prev.map(i => ({ ...i }));
                            for (const sync of syncItems) {
                                const item = items.find(i => i.id === sync.id);
                                if (item) {
                                    item.status = sync.status as DpChecklistItem['status'];
                                    if (sync.summary) item.summary = sync.summary;
                                }
                            }
                            const allDone = items.every(i => i.status === 'done' || i.status === 'skipped');
                            if (allDone) {
                                dpTimeout(() => resetDpState(), 3000);
                            }
                            return items;
                        });
                        break;
                    }

                    // Show steer (user) messages injected mid-conversation.
                    // The initial prompt's user message is already displayed by sendMessage,
                    // so only create a PilotMessage if the text is in pendingMessages (= steer).
                    if (msg?.role === 'user') {
                        const text = msg.content
                            ?.filter(c => c.type === 'text')
                            .map(c => c.text ?? '')
                            .join('') ?? '';
                        if (text) {
                            setPendingMessages(prev => {
                                const idx = prev.indexOf(text);
                                if (idx < 0) return prev; // not a steer — already displayed
                                // Steer message: add to chat and remove from pending
                                setMessages(msgs => [...msgs, {
                                    id: `msg-${Date.now()}`,
                                    role: 'user' as const,
                                    content: text,
                                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                }]);
                                return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
                            });
                        }
                    }
                    break;
                }

                case 'message_end':
                    // Mark current streaming assistant message as complete
                    setMessages(prev => prev.map(m =>
                        m.isStreaming && m.role === 'assistant' ? { ...m, isStreaming: false } : m
                    ));
                    break;

                case 'auto_compaction_start':
                    setIsCompacting(true);
                    break;

                case 'auto_compaction_end':
                    setIsCompacting(false);
                    fetchContextRef.current();
                    break;

                case 'turn_end':
                    // Mark streaming messages as complete after each agentic turn,
                    // but do NOT set isLoading=false — the agent may have more turns.
                    setMessages(prev => prev.map(m =>
                        m.isStreaming ? { ...m, isStreaming: false } : m
                    ));
                    // A steer message was consumed — pop the first pending
                    setPendingMessages(prev => prev.length > 0 ? prev.slice(1) : prev);
                    break;

                case 'prompt_done':
                    // Agent prompt truly finished (SSE stream closed)
                    setMessages(prev => prev.map(m =>
                        m.isStreaming ? { ...m, isStreaming: false } : m
                    ));
                    // During abort, don't unlock here — abortResponse will do it after RPC completes
                    if (!isAbortingRef.current) {
                        setIsLoading(false);
                    }
                    setPendingMessages([]);
                    loadSessionsRef.current();
                    fetchContextRef.current();
                    loadModelsRef.current();
                    fetchModelRef.current();

                    // DP safety-net: auto-complete checklist when agent ends.
                    // The backend agent_end handler sends dp-checklist-sync, but
                    // it's async and may not arrive before SSE closes (race condition).
                    // Mirror the backend logic here to ensure frontend consistency.
                    // Skip if hypotheses phase isn't done yet — model is waiting
                    // for user confirmation (gate blocked), not truly finished.
                    setDpChecklist(prev => {
                        if (!prev) return prev;
                        const dsItem = prev.find(i => i.id === 'deep_search');
                        // If deep_search hasn't been done, the investigation is still in progress
                        // (either waiting for hypothesis confirmation or hasn't started deep_search yet)
                        if (!dsItem || dsItem.status !== 'done') return prev;
                        const hasIncomplete = prev.some(i => i.status === 'pending' || i.status === 'in_progress');
                        if (!hasIncomplete) return prev;
                        const completed = prev.map(i =>
                            i.status === 'pending' || i.status === 'in_progress'
                                ? { ...i, status: 'done' as const, summary: i.summary || 'Auto-completed' }
                                : i
                        );
                        dpTimeout(() => resetDpState(), 3000);
                        return completed;
                    });
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

    // Keep ref in sync
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
        setCurrentSessionKey(sessionKey);
        setMessages([]);
        setHasMore(false);
        setIsLoadingHistory(true);
        clearDpTimers();
        resetDpState();
        try {
            const result = await sendRpc<{ messages: PilotMessage[]; hasMore: boolean }>('chat.history', { sessionId: sessionKey });
            setMessages(mapMessages(result.messages ?? []));
            setHasMore(result.hasMore ?? false);
        } catch (err) {
            console.error('Failed to load history:', err);
        } finally {
            setIsLoadingHistory(false);
        }
        // Fetch current model + brain type for this session
        try {
            const result = await sendRpc<{ model: ModelInfo | null; brainType?: BrainType }>('model.get', { sessionId: sessionKey });
            if (result.model) setSelectedModel(result.model);
            if (result.brainType) setSessionBrainType(result.brainType);
        } catch { /* ignore */ }
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
                await sendRpc('chat.steer', { text });
                setPendingMessages(prev => [...prev, text]);
            } catch (err) {
                console.error('Failed to steer:', err);
            }
            return;
        }

        // Eagerly init DP checklist when starting a Deep Investigation
        if (text.startsWith('[Deep Investigation]')) {
            setDpChecklist(createDefaultDpChecklist().map(i =>
                i.id === 'triage' ? { ...i, status: 'in_progress' as const } : i
            ));
            setDpFocus('triage');
        }

        const userMsg: PilotMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        setMessages(prev => [...prev, userMsg]);
        setIsLoading(true);

        try {
            const result = await sendRpc<{ sessionId: string; brainType?: BrainType }>('chat.send', {
                sessionId: currentSessionKey,
                message: text,
                modelProvider: selectedModel?.provider,
                modelId: selectedModel?.id,
                brainType: selectedBrain,
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
    }, [isConnected, isLoading, currentSessionKey, selectedModel, selectedBrain, sendRpc]);

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
            await sendRpc('chat.abort');
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
            await sendRpc('chat.clearQueue');
        } catch (err) {
            console.error('Failed to clear queue:', err);
        }
    }, [isConnected, sendRpc]);

    const removePendingMessage = useCallback(async (index: number) => {
        setPendingMessages(prev => {
            const next = [...prev];
            next.splice(index, 1);
            return next;
        });
        // Clear server queue and re-steer remaining messages
        if (!isConnected) return;
        try {
            await sendRpc('chat.clearQueue');
            // Re-steer remaining messages (get fresh state after splice)
            setPendingMessages(prev => {
                for (const msg of prev) {
                    sendRpc('chat.steer', { text: msg }).catch(() => {});
                }
                return prev;
            });
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

    /** Optimistic UI: immediately show hypothesis tree + deep_search in_progress */
    const confirmHypotheses = useCallback((hypotheses: Array<{ id: string; text: string; confidence: number }>) => {
        // Mark triage+hypotheses as done, deep_search as in_progress
        setDpChecklist(prev => {
            if (!prev) return prev;
            return prev.map(item => {
                if (item.id === 'triage' && item.status !== 'done') {
                    return { ...item, status: 'done' as const, summary: item.summary || 'Done' };
                }
                if (item.id === 'hypotheses' && item.status !== 'done') {
                    return { ...item, status: 'done' as const, summary: item.summary || 'Confirmed' };
                }
                if (item.id === 'deep_search') {
                    return { ...item, status: 'in_progress' as const };
                }
                return item;
            });
        });
        setDpFocus('deep_search');
        // Populate hypothesis tree with pending status
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
    }, []);

    const createSession = useCallback(() => {
        // Don't create a DB session yet — just reset UI to "new chat" state.
        // The backend will create the session lazily on first chat.send.
        setCurrentSessionKey(null);
        setMessages([]);
        setContextUsage(null);
        setIsCompacting(false);
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

    // Reset loading state when WebSocket disconnects mid-generation
    // (e.g. model API error, backend crash, network drop)
    useEffect(() => {
        if (!isConnected && isLoading) {
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
            setInvestigationProgress(null);
            dpTimeout(() => resetDpState(), 10_000);
        }
    }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

    // Stale-loading watchdog: if isLoading but no agent events for too long,
    // the backend likely died silently — reset UI so user isn't stuck.
    // DP phases send frequent progress events, so use a shorter timeout (45s).
    // Non-DP conversations keep the original 120s timeout.
    const staleTimeoutMs = dpChecklist ? 45_000 : 120_000;
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
                    setInvestigationProgress(null);
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

    /** Restore deep_search progress from gateway snapshot after WS reconnect */
    const restoreDpProgress = useCallback(async () => {
        if (!isConnected) return;
        try {
            const snap = await sendRpc<{ sessionId?: string; events: Array<Record<string, unknown>> | null }>('chat.dpProgress');
            if (!snap.events || snap.events.length === 0) return;
            // Replay events through the same reducer used for live progress
            let state: InvestigationProgress = { hypotheses: [] };
            for (const ev of snap.events) {
                state = reduceInvestigationProgress(state, ev);
            }
            setInvestigationProgress(state);
        } catch {
            // Ignore — gateway may not support this RPC yet
        }
    }, [isConnected, sendRpc]);

    // When workspace changes: clear messages, reload sessions for new workspace
    useEffect(() => {
        if (prevWorkspaceIdRef.current !== workspaceId && prevWorkspaceIdRef.current !== undefined) {
            setCurrentSessionKey(null);
            setMessages([]);
            setContextUsage(null);
            setIsCompacting(false);
            setSessionBrainType(null);
            clearDpTimers();
            resetDpState();
            if (isConnected) {
                loadSessions();
            }
        }
        prevWorkspaceIdRef.current = workspaceId;
    }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Load sessions, skills, and models on connect; reload history for persisted session
    useEffect(() => {
        if (isConnected) {
            loadSessions();
            loadSkills();
            loadModels();
            loadSystemStatus();
            if (currentSessionKey) {
                loadHistory(currentSessionKey).then(() => restoreDpProgress());
            }
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
    };
}
