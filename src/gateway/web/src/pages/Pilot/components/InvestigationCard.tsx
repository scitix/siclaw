import { useState, useEffect, useRef } from 'react';
import { Search, CheckCircle2, XCircle, AlertTriangle, Clock, ChevronDown, ChevronUp, Loader2, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/Markdown';
import type { PilotMessage, InvestigationProgress } from '@/hooks/usePilot';

// --- Types ---

type HypothesisStatus = 'validated' | 'invalidated' | 'inconclusive' | 'pending' | 'skipped' | 'validating';

interface EvidenceItem {
    tool: string;
    command: string;
    outputPreview: string;
    interpretation: string;
}

interface ParsedHypothesis {
    id: string;
    text: string;
    status: HypothesisStatus;
    confidence: number;
    reasoning?: string;
    toolCallsUsed?: number;
    evidence?: EvidenceItem[];
}

interface ParsedInvestigation {
    conclusion: string;
    hypotheses: ParsedHypothesis[];
    stats: {
        toolCalls: number;
        duration: string;
        hypothesesSummary: string; // e.g. "1/3 validated"
    };
    reportPath?: string;
}

// --- Parser ---

const STATUS_MAP: Record<string, HypothesisStatus> = {
    'VALIDATED': 'validated',
    'INVALIDATED': 'invalidated',
    'INCONCLUSIVE': 'inconclusive',
    'PENDING': 'pending',
    'SKIPPED': 'skipped',
};

/**
 * Parse the formatSummary() output text into structured data.
 *
 * Expected format:
 * ## Deep Search Summary
 * ### Conclusion
 * [text]
 *
 * ### Hypothesis Verdicts
 * - [icon] **H1**: [text] — [N]%
 *   [reasoning]
 * ...
 *
 * ### Statistics
 * - Tool calls: N | Duration: Xs | Hypotheses: Y/Z validated
 *
 * Full report: `path`
 */
function parseInvestigationResult(content: string): ParsedInvestigation | null {
    if (!content || !content.includes('Deep Search Summary')) return null;

    // Extract conclusion
    const conclusionMatch = content.match(/### Conclusion\n([\s\S]*?)(?=\n### )/);
    const conclusion = conclusionMatch?.[1]?.trim() ?? '';

    // Extract hypotheses
    const hypotheses: ParsedHypothesis[] = [];
    const verdictsMatch = content.match(/### Hypothesis Verdicts\n([\s\S]*?)(?=\n### )/);
    if (verdictsMatch) {
        const verdictsBlock = verdictsMatch[1];
        // Match hypothesis lines: - [icon] STATUS **ID**: text — N%
        const hypoRegex = /^- (?:✅|❌|⚠️|⏳|⏭️)\s+(\w+)\s+\*\*(\w+)\*\*:\s+(.+?)\s+—\s+(\d+)%/gm;
        let match;
        while ((match = hypoRegex.exec(verdictsBlock)) !== null) {
            const statusText = match[1];
            const id = match[2];
            const text = match[3];
            const confidence = parseInt(match[4], 10);

            hypotheses.push({
                id,
                text,
                status: STATUS_MAP[statusText] ?? 'pending',
                confidence,
            });
        }

        // If regex didn't match (format variation), try a simpler approach
        if (hypotheses.length === 0) {
            const lines = verdictsBlock.split('\n');
            let currentHypothesis: ParsedHypothesis | null = null;

            for (const line of lines) {
                const simpleMatch = line.match(/^- .+?\*\*(\w+)\*\*:\s+(.+?)\s+—\s+(\d+)%/);
                if (simpleMatch) {
                    let status: HypothesisStatus = 'pending';
                    if (line.includes('VALIDATED') && !line.includes('INVALIDATED')) status = 'validated';
                    else if (line.includes('INVALIDATED')) status = 'invalidated';
                    else if (line.includes('INCONCLUSIVE')) status = 'inconclusive';
                    else if (line.includes('SKIPPED')) status = 'skipped';
                    else if (line.includes('PENDING')) status = 'pending';

                    if (currentHypothesis) hypotheses.push(currentHypothesis);
                    currentHypothesis = {
                        id: simpleMatch[1],
                        text: simpleMatch[2],
                        status,
                        confidence: parseInt(simpleMatch[3], 10),
                    };
                } else if (line.trim() && currentHypothesis && line.startsWith('  ')) {
                    currentHypothesis.reasoning = line.trim();
                }
            }
            if (currentHypothesis) hypotheses.push(currentHypothesis);
        } else {
            // Attach reasoning lines to hypotheses
            const lines = verdictsBlock.split('\n');
            let hypoIdx = -1;
            for (const line of lines) {
                if (line.startsWith('- ')) {
                    hypoIdx++;
                } else if (line.startsWith('  ') && line.trim() && hypoIdx >= 0 && hypoIdx < hypotheses.length) {
                    hypotheses[hypoIdx].reasoning = line.trim();
                }
            }
        }
    }

    // Extract statistics
    const statsMatch = content.match(/Tool calls:\s*(\d+)\s*\|\s*Duration:\s*([^\s|]+)\s*\|\s*Hypotheses:\s*(.+)/);
    const stats = {
        toolCalls: statsMatch ? parseInt(statsMatch[1], 10) : 0,
        duration: statsMatch?.[2] ?? '',
        hypothesesSummary: statsMatch?.[3]?.trim() ?? '',
    };

    // Extract report path
    const reportMatch = content.match(/Full report:\s*`([^`]+)`/);
    const reportPath = reportMatch?.[1];

    return { conclusion, hypotheses, stats, reportPath };
}

/**
 * Extract rich hypothesis data from toolDetails (structured, includes evidence).
 * Falls back to parsed markdown if toolDetails not available.
 */
function extractFromDetails(details: Record<string, unknown>): ParsedHypothesis[] | null {
    const hyps = details.hypotheses as Array<Record<string, unknown>> | undefined;
    if (!hyps || !Array.isArray(hyps)) return null;

    return hyps.map((h) => ({
        id: h.id as string,
        text: h.text as string,
        status: (h.status as HypothesisStatus) ?? 'pending',
        confidence: (h.confidence as number) ?? 0,
        reasoning: h.reasoning as string | undefined,
        toolCallsUsed: h.toolCallsUsed as number | undefined,
        evidence: (h.evidence as EvidenceItem[] | undefined)?.filter(e => e.command || e.outputPreview),
    }));
}

// --- Status display helpers ---

function StatusIcon({ status, className }: { status: HypothesisStatus; className?: string }) {
    const size = cn("w-4 h-4 shrink-0", className);
    switch (status) {
        case 'validated':
            return <CheckCircle2 className={cn(size, "text-green-500")} />;
        case 'invalidated':
            return <XCircle className={cn(size, "text-red-400")} />;
        case 'inconclusive':
            return <AlertTriangle className={cn(size, "text-amber-500")} />;
        case 'skipped':
            return <SkipForward className={cn(size, "text-gray-400")} />;
        case 'validating':
            return <Loader2 className={cn(size, "text-blue-500 animate-spin")} />;
        case 'pending':
        default:
            return <Clock className={cn(size, "text-gray-400")} />;
    }
}

const STATUS_LABEL: Record<HypothesisStatus, string> = {
    validated: 'VALIDATED',
    invalidated: 'INVALIDATED',
    inconclusive: 'INCONCLUSIVE',
    pending: 'PENDING',
    skipped: 'SKIPPED',
    validating: 'VALIDATING',
};

const STATUS_COLOR: Record<HypothesisStatus, string> = {
    validated: 'text-green-600',
    invalidated: 'text-red-500',
    inconclusive: 'text-amber-600',
    pending: 'text-gray-500',
    skipped: 'text-gray-400',
    validating: 'text-blue-500',
};

// --- Component ---

type FeedbackState = 'idle' | 'input' | 'submitted';
type FeedbackStatus = 'confirmed' | 'corrected' | 'rejected';

export interface InvestigationCardProps {
    message: PilotMessage;
    progress?: InvestigationProgress | null;
    sendMessage?: (text: string) => void;
    updateMessageMeta?: (messageId: string, meta: Record<string, unknown>) => Promise<void>;
}

function ElapsedTimer() {
    const startRef = useRef(Date.now());
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return (
        <span className="text-xs text-gray-400 font-mono tabular-nums">
            {minutes}:{seconds.toString().padStart(2, '0')}
        </span>
    );
}

export function InvestigationCard({ message, progress, sendMessage, updateMessageMeta }: InvestigationCardProps) {
    const [expanded, setExpanded] = useState(false);
    const isRunning = message.toolStatus === 'running';
    const isError = message.toolStatus === 'error';

    // Feedback state
    const savedFeedback = (message.metadata as Record<string, unknown> | undefined)?.investigationFeedback as FeedbackStatus | undefined;
    const [feedbackState, setFeedbackState] = useState<FeedbackState>(savedFeedback ? 'submitted' : 'idle');
    const [feedbackStatus, setFeedbackStatus] = useState<FeedbackStatus | null>(savedFeedback ?? null);
    const [correctionText, setCorrectionText] = useState('');
    const investigationId = message.toolDetails?.investigationId as string | undefined;

    // Parse structured data from completed result
    const parsed = !isRunning ? parseInvestigationResult(message.content) : null;

    // Prefer rich structured data from toolDetails (includes evidence)
    const richHypotheses = message.toolDetails ? extractFromDetails(message.toolDetails) : null;
    const reportPath = (message.toolDetails?.reportPath as string) ?? parsed?.reportPath;

    // Extract question from toolInput
    const question = message.toolInput || '';

    // Merge: use richHypotheses if available, fallback to parsed markdown
    const hypotheses = richHypotheses ?? parsed?.hypotheses ?? [];

    // Sort hypotheses: validated first, then by confidence descending
    const sortedHypotheses = hypotheses.slice().sort((a, b) => {
        if (a.status === 'validated' && b.status !== 'validated') return -1;
        if (b.status === 'validated' && a.status !== 'validated') return 1;
        return b.confidence - a.confidence;
    });

    // --- Running state ---
    if (isRunning) {
        const hasProgress = progress && progress.hypotheses.length > 0;

        return (
            <div className="pl-12">
                <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-4 py-3 max-w-2xl">
                    {/* Header */}
                    <div className="flex items-center gap-2 mb-2">
                        <Search className="w-4 h-4 text-blue-500 shrink-0" />
                        <span className="text-sm font-semibold text-gray-800">Deep Investigation</span>
                        {progress?.phase && (
                            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                                {progress.phase}
                            </span>
                        )}
                        <div className="ml-auto flex items-center gap-2">
                            <ElapsedTimer />
                            <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                        </div>
                    </div>

                    {/* Question */}
                    {question && (
                        <p className="text-sm text-gray-600 mb-3 line-clamp-2">&ldquo;{question}&rdquo;</p>
                    )}

                    {/* Hypothesis tree (real-time progress) */}
                    {hasProgress ? (
                        <div className="space-y-1 mb-3">
                            {progress.hypotheses.map((h) => (
                                <div key={h.id} className="flex items-start gap-2">
                                    <StatusIcon status={h.status as HypothesisStatus} className="mt-0.5" />
                                    <div className="flex-1 min-w-0">
                                        <span className="text-sm text-gray-700">
                                            <span className="font-medium">{h.id}</span>
                                            {' '}
                                            <span className="text-gray-600">{h.text}</span>
                                        </span>
                                        <span className={cn("text-xs font-medium ml-1.5", STATUS_COLOR[h.status as HypothesisStatus] || 'text-gray-500')}>
                                            {h.status === 'validating' && h.lastAction ? (
                                                <span className="text-blue-500 font-mono">{h.lastAction}</span>
                                            ) : h.status === 'validated' || h.status === 'invalidated' || h.status === 'inconclusive' ? (
                                                `${STATUS_LABEL[h.status as HypothesisStatus] || h.status} (${h.confidence}%)`
                                            ) : (
                                                STATUS_LABEL[h.status as HypothesisStatus] || h.status
                                            )}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : null}

                    {/* Current action bar */}
                    <div className="flex items-center gap-2 px-3 py-2 bg-blue-100/60 rounded-md">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
                        <span className="text-xs text-blue-700 font-mono truncate">
                            {progress?.currentAction || 'Investigating hypotheses...'}
                        </span>
                    </div>
                </div>
            </div>
        );
    }

    // --- Error state ---
    if (isError || !parsed) {
        return (
            <div className="pl-12">
                <div className="rounded-lg border border-red-200 bg-red-50/50 px-4 py-3 max-w-2xl">
                    <div className="flex items-center gap-2 mb-2">
                        <Search className="w-4 h-4 text-red-500 shrink-0" />
                        <span className="text-sm font-semibold text-gray-800">Deep Investigation</span>
                        <XCircle className="w-4 h-4 text-red-500 ml-auto shrink-0" />
                    </div>
                    {question && (
                        <p className="text-sm text-gray-600 mb-2">&ldquo;{question}&rdquo;</p>
                    )}
                    <pre className="text-xs text-red-600 whitespace-pre-wrap bg-red-100/60 rounded-md px-3 py-2">
                        {message.content || 'Investigation failed.'}
                    </pre>
                </div>
            </div>
        );
    }

    // --- Done state ---
    const allDone = sortedHypotheses.length > 0;
    const hasEvidence = sortedHypotheses.some(h => h.evidence && h.evidence.length > 0);

    return (
        <div className="pl-12">
            <div className={cn(
                "rounded-lg border px-4 py-3 max-w-2xl transition-colors",
                allDone ? "border-green-200 bg-green-50/50" : "border-gray-200 bg-gray-50/50"
            )}>
                {/* Header */}
                <div className="flex items-center gap-2 mb-2">
                    <Search className={cn(
                        "w-4 h-4 shrink-0",
                        allDone ? "text-green-500" : "text-gray-500"
                    )} />
                    <span className="text-sm font-semibold text-gray-800">Deep Investigation</span>
                    <span className={cn(
                        "ml-auto text-xs font-medium px-1.5 py-0.5 rounded flex items-center gap-1",
                        "bg-green-100 text-green-700"
                    )}>
                        <CheckCircle2 className="w-3 h-3" />
                        Done
                    </span>
                </div>

                {/* Conclusion — rendered as Markdown */}
                {parsed?.conclusion && (
                    <div className="mb-3 text-sm text-gray-700 leading-relaxed [&_p]:mb-1.5 [&_p:last-child]:mb-0 [&_strong]:text-gray-800 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-0.5">
                        <Markdown>{parsed.conclusion}</Markdown>
                    </div>
                )}

                {/* Hypothesis Verdicts — with inline reasoning */}
                {sortedHypotheses.length > 0 && (
                    <div className="space-y-1.5 mb-3">
                        {sortedHypotheses.map((h) => {
                            const isSkipped = h.status === 'skipped' || h.status === 'pending';
                            return (
                                <div key={h.id}>
                                    {/* Verdict row */}
                                    <div className="flex items-start gap-2">
                                        <StatusIcon status={h.status} className="mt-0.5" />
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-baseline gap-1.5">
                                                <span className="text-sm font-medium text-gray-800 shrink-0">{h.id}</span>
                                                <span className="text-sm text-gray-700 truncate">{h.text}</span>
                                                <span className={cn(
                                                    "text-xs font-semibold px-1.5 py-0.5 rounded shrink-0 ml-auto",
                                                    h.status === 'validated' ? "bg-green-100 text-green-700" :
                                                    h.status === 'invalidated' ? "bg-red-100 text-red-600" :
                                                    h.status === 'inconclusive' ? "bg-amber-100 text-amber-700" :
                                                    "bg-gray-100 text-gray-500"
                                                )}>
                                                    {h.confidence}%
                                                </span>
                                            </div>
                                            {/* Inline reasoning (skip for skipped/pending) */}
                                            {!isSkipped && h.reasoning && (
                                                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed line-clamp-2">
                                                    {h.reasoning}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Expanded details — evidence only (reasoning already shown inline) */}
                {expanded && sortedHypotheses.length > 0 && (
                    <div className="border-t border-green-200 pt-3 mb-3 space-y-3">
                        {sortedHypotheses
                            .filter(h => (h.evidence && h.evidence.length > 0) || h.toolCallsUsed)
                            .map((h) => (
                                <div key={h.id} className="bg-white/70 rounded-md px-3 py-2 border border-gray-100">
                                    <div className="flex items-center gap-2 mb-1">
                                        <StatusIcon status={h.status} />
                                        <span className="text-sm font-medium text-gray-800">{h.id}: {h.text}</span>
                                        <span className={cn(
                                            "ml-auto text-xs font-semibold px-1.5 py-0.5 rounded shrink-0",
                                            h.status === 'validated' ? "bg-green-100 text-green-700" :
                                            h.status === 'invalidated' ? "bg-red-100 text-red-600" :
                                            h.status === 'inconclusive' ? "bg-amber-100 text-amber-700" :
                                            "bg-gray-100 text-gray-600"
                                        )}>
                                            {STATUS_LABEL[h.status]} ({h.confidence}%)
                                        </span>
                                    </div>
                                    {/* Evidence list */}
                                    {h.evidence && h.evidence.length > 0 && (
                                        <div className="mt-2 space-y-1.5">
                                            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">Evidence</span>
                                            {h.evidence.map((e, i) => (
                                                <div key={i} className="bg-gray-50 rounded px-2.5 py-1.5 border border-gray-100">
                                                    <div className="font-mono text-[11px] text-gray-700 truncate">
                                                        <span className="text-gray-400">{e.tool}:</span> {e.command}
                                                    </div>
                                                    {e.outputPreview && (
                                                        <pre className="text-[11px] text-gray-500 mt-1 whitespace-pre-wrap line-clamp-3 leading-relaxed">{e.outputPreview}</pre>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {h.toolCallsUsed != null && (
                                        <p className="text-[11px] text-gray-400 mt-1.5">{h.toolCallsUsed} tool calls</p>
                                    )}
                                </div>
                            ))}
                    </div>
                )}

                {/* Statistics bar */}
                <div className="flex items-center justify-between text-xs text-gray-500">
                    <div className="flex items-center gap-3">
                        {(() => {
                            const calls = parsed?.stats.toolCalls ?? (message.toolDetails?.totalToolCalls as number | undefined) ?? 0;
                            return calls > 0 ? <span>{calls} calls</span> : null;
                        })()}
                        {(() => {
                            if (parsed?.stats.duration) return <span>{parsed.stats.duration}</span>;
                            const ms = message.toolDetails?.durationMs as number | undefined;
                            if (ms) return <span>{(ms / 1000).toFixed(1)}s</span>;
                            return null;
                        })()}
                        {parsed?.stats.hypothesesSummary && (
                            <span>{parsed.stats.hypothesesSummary}</span>
                        )}
                    </div>

                    {/* Only show Details button if there's evidence to show */}
                    {hasEvidence && (
                        <button
                            type="button"
                            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors cursor-pointer"
                            onClick={() => setExpanded(!expanded)}
                        >
                            {expanded ? (
                                <>
                                    <span>Collapse</span>
                                    <ChevronUp className="w-3.5 h-3.5" />
                                </>
                            ) : (
                                <>
                                    <span>Evidence</span>
                                    <ChevronDown className="w-3.5 h-3.5" />
                                </>
                            )}
                        </button>
                    )}
                </div>

                {/* Report path */}
                {expanded && reportPath && (
                    <div className="mt-2 pt-2 border-t border-green-200">
                        <span className="text-xs text-gray-400">Full report: </span>
                        <code className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{reportPath}</code>
                    </div>
                )}

                {/* Feedback strip — only for investigations with an ID */}
                {investigationId && feedbackState === 'submitted' && feedbackStatus && (
                    <div className="mt-3 pt-2 border-t border-green-200 flex items-center gap-2">
                        <span className="text-xs text-gray-400">Feedback:</span>
                        <span className={cn(
                            "text-xs font-medium px-2 py-0.5 rounded-full",
                            feedbackStatus === 'confirmed' ? "bg-green-100 text-green-700" :
                            feedbackStatus === 'corrected' ? "bg-amber-100 text-amber-700" :
                            "bg-red-100 text-red-600"
                        )}>
                            {feedbackStatus === 'confirmed' ? '✅ Correct' :
                             feedbackStatus === 'corrected' ? '🔧 Corrected' :
                             '❌ Rejected'}
                        </span>
                    </div>
                )}
                {investigationId && feedbackState === 'idle' && (
                    <div className="mt-3 pt-2 border-t border-green-200">
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400">Was this diagnosis accurate?</span>
                            <div className="flex gap-1.5 ml-auto">
                                <button
                                    type="button"
                                    className="text-xs px-2.5 py-1 rounded-md bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 transition-colors cursor-pointer"
                                    onClick={() => {
                                        setFeedbackStatus('confirmed');
                                        setFeedbackState('submitted');
                                        sendMessage?.(`[investigation feedback: confirmed] investigationId=${investigationId}`);
                                        updateMessageMeta?.(message.id, { investigationFeedback: 'confirmed' });
                                    }}
                                >
                                    ✅ Correct
                                </button>
                                <button
                                    type="button"
                                    className="text-xs px-2.5 py-1 rounded-md bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 transition-colors cursor-pointer"
                                    onClick={() => {
                                        setFeedbackStatus('corrected');
                                        setFeedbackState('input');
                                    }}
                                >
                                    🔧 Partial
                                </button>
                                <button
                                    type="button"
                                    className="text-xs px-2.5 py-1 rounded-md bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 transition-colors cursor-pointer"
                                    onClick={() => {
                                        setFeedbackStatus('rejected');
                                        setFeedbackState('input');
                                    }}
                                >
                                    ❌ Wrong
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {investigationId && feedbackState === 'input' && feedbackStatus && (
                    <div className="mt-3 pt-2 border-t border-green-200 space-y-2">
                        <span className="text-xs text-gray-500">
                            {feedbackStatus === 'corrected'
                                ? 'What was the actual root cause?'
                                : 'What was wrong with the diagnosis? (optional)'}
                        </span>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                className="flex-1 text-xs px-2.5 py-1.5 border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-300"
                                placeholder={feedbackStatus === 'corrected' ? 'The actual root cause was...' : 'Optional note...'}
                                value={correctionText}
                                onChange={(e) => setCorrectionText(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        const text = correctionText.trim();
                                        const msg = text
                                            ? `[investigation feedback: ${feedbackStatus}] investigationId=${investigationId} ${text}`
                                            : `[investigation feedback: ${feedbackStatus}] investigationId=${investigationId}`;
                                        sendMessage?.(msg);
                                        updateMessageMeta?.(message.id, { investigationFeedback: feedbackStatus });
                                        setFeedbackState('submitted');
                                    }
                                }}
                            />
                            <button
                                type="button"
                                className="text-xs px-3 py-1.5 rounded-md bg-blue-500 text-white hover:bg-blue-600 transition-colors cursor-pointer"
                                onClick={() => {
                                    const text = correctionText.trim();
                                    const msg = text
                                        ? `[investigation feedback: ${feedbackStatus}] investigationId=${investigationId} ${text}`
                                        : `[investigation feedback: ${feedbackStatus}] investigationId=${investigationId}`;
                                    sendMessage?.(msg);
                                    updateMessageMeta?.(message.id, { investigationFeedback: feedbackStatus });
                                    setFeedbackState('submitted');
                                }}
                            >
                                Submit
                            </button>
                            <button
                                type="button"
                                className="text-xs px-2 py-1.5 rounded-md text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
                                onClick={() => {
                                    setFeedbackState('idle');
                                    setFeedbackStatus(null);
                                    setCorrectionText('');
                                }}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
