import { useState } from 'react';
import { Search, CheckCircle2, Send, X, MessageSquare, ChevronRight, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/Markdown';
import type { PilotMessage } from '@/hooks/usePilot';

// --- Types ---

interface ParsedHypothesis {
    index: number;
    title: string;
    confidence?: number;
    description?: string;     // one-line summary
    detailLines: string[];    // validation methods, tools, etc.
}

// --- Parser ---

/**
 * Parse hypotheses from LLM-generated markdown.
 *
 * Strategy 1: Split by `---` separators (structured output from propose_hypotheses).
 *   Each block contains description, confidence, validation tools.
 * Strategy 2: Numbered/bulleted list fallback.
 */
function parseHypotheses(input: string): ParsedHypothesis[] {
    if (!input) return [];

    // Strategy 1: Split by --- separators
    const blocks = input.split(/\n---\s*\n/).filter(b => b.trim());
    if (blocks.length >= 2) {
        return blocks.map((block, i) => parseBlock(block.trim(), i + 1));
    }

    // Strategy 2: Try structured headers (## Hypothesis N / ## H N)
    const headerSplit = input.split(/\n(?=#{2,3}\s*(?:Hypothesis|H)\s*\d)/i).filter(b => b.trim());
    if (headerSplit.length >= 2) {
        return headerSplit.map((block, i) => parseBlock(block.trim(), i + 1));
    }

    // Strategy 2.5: Generic numbered headings (### 1. title / ## 1. title)
    // Catches both Chinese and English formats like "### 1. L40节点..." or "### 1. Node failure..."
    const numberedHeadingSplit = input.split(/\n(?=#{2,3}\s*\d+[.)]\s)/).filter(b => b.trim());
    if (numberedHeadingSplit.length >= 2) {
        const hasNumbered = (b: string) => /^#{2,3}\s*\d+[.)]\s/m.test(b);
        const hypoBlocks = numberedHeadingSplit.filter(hasNumbered);
        if (hypoBlocks.length >= 2) {
            return hypoBlocks.map((block, i) => parseBlock(block.trim(), i + 1));
        }
    }

    // Strategy 3: Bold-prefixed (**Hypothesis N: title** / **H N: title**)
    const boldSplit = input.split(/\n(?=\*{2}(?:Hypothesis|H)\s*\d)/i).filter(b => b.trim());
    if (boldSplit.length >= 2) {
        // First block may be preamble (triage context) — skip if it doesn't contain a hypothesis
        const hasHypothesis = (b: string) => /\*{2}(?:Hypothesis|H)\s*\d/i.test(b);
        const hypoBlocks = boldSplit.filter(hasHypothesis);
        if (hypoBlocks.length >= 2) {
            return hypoBlocks.map((block, i) => parseBlock(block.trim(), i + 1));
        }
    }

    // Strategy 4: Numbered list fallback
    return parseNumberedList(input);
}

/** Parse a single hypothesis block into structured data. */
function parseBlock(block: string, fallbackIndex: number): ParsedHypothesis {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);

    let confidence: number | undefined;
    let title = '';
    let description = '';
    const detailLines: string[] = [];

    for (const line of lines) {
        // Bold-prefixed hypothesis title: **Hypothesis 1: title (Confidence: N%)** or **H 1: title (N%)**
        const boldHypoMatch = line.match(/^\*{2}(?:Hypothesis|H)\s*\d+[:\s]*(.*?)\*{2}\s*$/i);
        if (boldHypoMatch) {
            const inner = boldHypoMatch[1];
            // Extract inline confidence: (Confidence: 70%) or (70%) or (置信度: 70%)
            const inlineConf = inner.match(/[(\uff08](?:confidence|置信度)[:\s：]*(\d+)\s*%[)\uff09]/i);
            if (inlineConf) confidence = parseInt(inlineConf[1], 10);
            // Title = inner without the confidence part
            title = cleanMarkdown(inner.replace(/[(\uff08](?:confidence|置信度)[:\s：]*\d+\s*%[)\uff09]/i, '').trim());
            continue;
        }

        // Heading line (## Hypothesis 1: title)
        const headingMatch = line.match(/^#{2,3}\s*(?:Hypothesis|H)\s*\d+[:\s]*(.*)/i);
        if (headingMatch) {
            const inner = headingMatch[1];
            const inlineConf = inner.match(/[(\uff08](?:confidence|置信度)[:\s：]*(\d+)\s*%[)\uff09]/i);
            if (inlineConf) confidence = parseInt(inlineConf[1], 10);
            title = cleanMarkdown(inner.replace(/[(\uff08](?:confidence|置信度)[:\s：]*\d+\s*%[)\uff09]/i, '').trim());
            continue;
        }

        // Generic numbered heading (### 1. title (置信度: 75%))
        const genericHeadingMatch = line.match(/^#{2,3}\s*\d+[.)]\s*(.*)/);
        if (genericHeadingMatch) {
            const inner = genericHeadingMatch[1];
            const inlineConf = inner.match(/[(\uff08](?:confidence|置信度)[:\s：]*(\d+)\s*%[)\uff09]/i);
            if (inlineConf) confidence = parseInt(inlineConf[1], 10);
            title = cleanMarkdown(inner.replace(/[(\uff08](?:confidence|置信度)[:\s：]*\d+\s*%[)\uff09]/i, '').trim());
            continue;
        }

        // Extract confidence: **Confidence**: 85% or (85%) or 置信度: 85% patterns (standalone line)
        const confMatch = line.match(/^\*{0,2}(?:confidence|置信度)\*{0,2}[:\s：]*(\d+)\s*%/i);
        if (confMatch) {
            confidence = parseInt(confMatch[1], 10);
            continue;
        }

        // Skip raw tool references (these are for the agent, not the user)
        if (line.match(/^\*{0,2}(?:validation tools?|verification tools?)\*{0,2}[:\s]/i)) continue;
        if (line.match(/`(node_exec|pod_exec|bash|run_skill|node_script)[:\s]/)) {
            detailLines.push(cleanMarkdown(line));
            continue;
        }

        // Strip leading bullet for metadata matching
        const stripped = line.replace(/^[-*]\s+/, '');

        // Description header: Description: ... or 描述: ... or - Description: ...
        const descMatch = stripped.match(/^\*{0,2}(?:description|描述)\*{0,2}[:\s：]*(.*)/i);
        if (descMatch && descMatch[1]) {
            const cleaned = cleanMarkdown(descMatch[1]);
            if (!title) title = cleaned;
            else if (!description) description = cleaned;
            else detailLines.push(cleaned);
            continue;
        }

        // Validation / verification method lines
        if (stripped.match(/^(?:\*{0,2})(?:validation method|validation|expected result|验证方法|验证|预期结果)(?:\*{0,2})[:\s：]/i)) {
            detailLines.push(cleanMarkdown(stripped));
            continue;
        }

        // First substantial non-metadata line becomes title if not set
        if (!title && stripped.length > 10 && !stripped.startsWith('**Validation') && !stripped.startsWith('**Confidence') && !stripped.startsWith('**验证') && !stripped.startsWith('**置信度')) {
            title = cleanMarkdown(stripped);
            continue;
        }

        // Remaining lines are details
        if (title) {
            const cleaned = cleanMarkdown(stripped);
            if (cleaned.length > 5) {
                if (!description) {
                    description = cleaned;
                } else {
                    detailLines.push(cleaned);
                }
            }
        }
    }

    // If no confidence found inline, try the whole block
    if (confidence == null) {
        const blockConfMatch = block.match(/(\d+)\s*%/);
        if (blockConfMatch) confidence = parseInt(blockConfMatch[1], 10);
    }

    return {
        index: fallbackIndex,
        title: title || `Hypothesis ${fallbackIndex}`,
        confidence,
        description: description || undefined,
        detailLines,
    };
}

/** Fallback parser for numbered lists. */
function parseNumberedList(input: string): ParsedHypothesis[] {
    const hypotheses: ParsedHypothesis[] = [];
    const lines = input.split('\n');
    let current: ParsedHypothesis | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const numberedMatch = trimmed.match(/^(\d+)[.)]\s+(.+)/);
        if (numberedMatch) {
            if (current) hypotheses.push(current);
            const text = cleanMarkdown(numberedMatch[2]);
            const confMatch = text.match(/(\d+)\s*%/);
            current = {
                index: parseInt(numberedMatch[1], 10),
                title: text.replace(/\(\d+%\)/, '').trim(),
                confidence: confMatch ? parseInt(confMatch[1], 10) : undefined,
                detailLines: [],
            };
        } else if (current && (trimmed.startsWith('-') || trimmed.startsWith('*') || /^\s/.test(line))) {
            const detail = cleanMarkdown(trimmed.replace(/^[-*]\s+/, ''));
            if (detail.length > 5) current.detailLines.push(detail);
        }
    }
    if (current) hypotheses.push(current);
    return hypotheses;
}

function cleanMarkdown(text: string): string {
    return text
        .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^[#\s]+/, '')
        .trim();
}

// --- Component ---

export interface ConfirmedHypothesis {
    id: string;
    text: string;
    confidence: number;
}

export interface HypothesesCardProps {
    message: PilotMessage;
    sendMessage?: (text: string) => void;
    abortResponse?: () => void;
    onHypothesesConfirmed?: (hypotheses: ConfirmedHypothesis[]) => void;
    superseded?: boolean;
}

export function HypothesesCard({ message, sendMessage, abortResponse, onHypothesesConfirmed, superseded }: HypothesesCardProps) {
    const [feedbackMode, setFeedbackMode] = useState(false);
    const [feedbackText, setFeedbackText] = useState('');
    const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const isRunning = message.toolStatus === 'running';
    const isDone = message.toolStatus === 'success';

    // Parse hypotheses: prefer toolDetails.hypotheses (gateway mode), fallback to toolInput
    const hypothesesSource = (message.toolDetails?.hypotheses as string) || message.toolInput || '';
    const hypotheses = parseHypotheses(hypothesesSource);

    // Superseded: a newer propose_hypotheses exists — render collapsed
    if (superseded) {
        return (
            <div className="pl-12">
                <div className="rounded-lg border border-gray-200 bg-gray-50/50 px-4 py-2 max-w-2xl opacity-50">
                    <div className="flex items-center gap-2">
                        <Search className="w-4 h-4 text-gray-400 shrink-0" />
                        <span className="text-sm text-gray-500">Hypotheses</span>
                        <span className="text-xs text-gray-400">{hypotheses.length} items</span>
                        <span className="ml-auto text-xs text-gray-400">Superseded</span>
                    </div>
                </div>
            </div>
        );
    }

    // Check if auto-confirmed (TUI mode) or user-confirmed (web mode)
    const isAutoConfirmed = isDone && (message.toolDetails?.autoConfirmed === true);
    const showActions = isDone && !isRunning && !feedbackMode && !isAutoConfirmed && !confirmed;

    const emitConfirmed = () => {
        if (onHypothesesConfirmed && hypotheses.length > 0) {
            onHypothesesConfirmed(hypotheses.map(h => ({
                id: `H${h.index}`,
                text: h.title,
                confidence: h.confidence ?? 0,
            })));
        }
    };

    const handleConfirm = () => {
        if (sendMessage) {
            sendMessage('The user has confirmed hypotheses. Please call deep_search to validate them.');
            setConfirmed(true);
            emitConfirmed();
        }
    };

    const handleSendFeedback = () => {
        if (feedbackText.trim() && sendMessage) {
            sendMessage(`User feedback: ${feedbackText.trim()}. Please revise the hypotheses based on this feedback, then call propose_hypotheses again to present the updated hypotheses and wait for user confirmation before calling deep_search.`);
            setFeedbackMode(false);
            setFeedbackText('');
            setConfirmed(true);
            // Don't call emitConfirmed() here — the LLM will re-propose hypotheses for user review.
        }
    };

    const handleExit = () => {
        if (abortResponse) {
            abortResponse();
        }
    };

    const toggleExpand = (idx: number) => {
        setExpandedIdx(expandedIdx === idx ? null : idx);
    };

    return (
        <div className="pl-12">
            <div className={cn(
                "rounded-lg border px-4 py-3 max-w-2xl transition-colors",
                isDone ? "border-indigo-200 bg-indigo-50/50" : "border-blue-200 bg-blue-50/50"
            )}>
                {/* Header */}
                <div className="flex items-center gap-2 mb-3">
                    <Search className="w-4 h-4 text-indigo-500 shrink-0" />
                    <span className="text-sm font-semibold text-gray-800">Deep Investigation</span>
                    <span className="text-xs text-gray-500">Hypothesis Review</span>
                    {isDone && (isAutoConfirmed || confirmed) && (
                        <span className="ml-auto text-xs font-medium px-1.5 py-0.5 rounded flex items-center gap-1 bg-indigo-100 text-indigo-700">
                            <CheckCircle2 className="w-3 h-3" />
                            Confirmed
                        </span>
                    )}
                    {isDone && !isAutoConfirmed && !confirmed && !feedbackMode && (
                        <span className="ml-auto text-xs text-amber-600 font-medium px-1.5 py-0.5 rounded bg-amber-50">
                            Awaiting review
                        </span>
                    )}
                </div>

                {/* Hypotheses list */}
                {hypotheses.length > 0 ? (
                    <div className="space-y-1 mb-3">
                        {hypotheses.map((h) => {
                            const isExpanded = expandedIdx === h.index;
                            const hasDetails = h.detailLines.length > 0 || h.description;
                            return (
                                <div key={h.index}>
                                    {/* Hypothesis row */}
                                    <button
                                        type="button"
                                        className={cn(
                                            "flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md transition-colors",
                                            hasDetails ? "hover:bg-indigo-100/60 cursor-pointer" : "cursor-default",
                                            isExpanded && "bg-indigo-100/60"
                                        )}
                                        onClick={() => hasDetails && toggleExpand(h.index)}
                                    >
                                        {/* Expand arrow */}
                                        {hasDetails ? (
                                            <ChevronRight className={cn(
                                                "w-3 h-3 text-gray-400 shrink-0 transition-transform",
                                                isExpanded && "rotate-90"
                                            )} />
                                        ) : (
                                            <span className="w-3 shrink-0" />
                                        )}

                                        {/* Index badge */}
                                        <span className="text-xs font-semibold text-indigo-500 bg-indigo-100 rounded-full w-5 h-5 flex items-center justify-center shrink-0">
                                            {h.index}
                                        </span>

                                        {/* Title */}
                                        <span className="flex-1 text-sm text-gray-700 min-w-0 truncate">
                                            {h.title}
                                        </span>

                                        {/* Confidence badge */}
                                        {h.confidence != null && (
                                            <span className={cn(
                                                "text-xs font-semibold px-1.5 py-0.5 rounded shrink-0",
                                                h.confidence >= 70 ? "bg-indigo-100 text-indigo-700" :
                                                h.confidence >= 40 ? "bg-blue-100 text-blue-600" :
                                                "bg-gray-100 text-gray-500"
                                            )}>
                                                {h.confidence}%
                                            </span>
                                        )}
                                    </button>

                                    {/* Expanded details */}
                                    {isExpanded && hasDetails && (
                                        <div className="ml-10 pl-2 border-l-2 border-indigo-200 mt-1 mb-2 space-y-1">
                                            {h.description && (
                                                <p className="text-xs text-gray-600 leading-relaxed">{h.description}</p>
                                            )}
                                            {h.detailLines.map((line, i) => (
                                                <p key={i} className="text-xs text-gray-500 leading-relaxed">{line}</p>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="mb-3 text-sm text-gray-600">
                        <Markdown>{hypothesesSource}</Markdown>
                    </div>
                )}

                {/* Feedback input */}
                {feedbackMode && (
                    <div className="mb-3 flex gap-2">
                        <input
                            type="text"
                            value={feedbackText}
                            onChange={(e) => setFeedbackText(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSendFeedback()}
                            placeholder="Add/modify hypotheses..."
                            className="flex-1 text-sm border border-indigo-200 rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                            autoFocus
                        />
                        <button
                            type="button"
                            onClick={handleSendFeedback}
                            disabled={!feedbackText.trim()}
                            className="text-xs font-medium px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1 cursor-pointer"
                        >
                            <Send className="w-3 h-3" />
                            Send
                        </button>
                        <button
                            type="button"
                            onClick={() => { setFeedbackMode(false); setFeedbackText(''); }}
                            className="text-xs font-medium px-2 py-1.5 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors cursor-pointer"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}

                {/* Action buttons */}
                {showActions && (
                    <div className="flex items-center gap-2 pt-2 border-t border-indigo-100">
                        <button
                            type="button"
                            onClick={handleConfirm}
                            className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 transition-colors cursor-pointer"
                        >
                            <Play className="w-3 h-3" />
                            Confirm & Run
                        </button>
                        <button
                            type="button"
                            onClick={() => setFeedbackMode(true)}
                            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-md text-indigo-600 hover:bg-indigo-100 transition-colors cursor-pointer"
                        >
                            <MessageSquare className="w-3 h-3" />
                            Modify
                        </button>
                        <button
                            type="button"
                            onClick={handleExit}
                            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-red-600 transition-colors cursor-pointer"
                        >
                            <X className="w-3 h-3" />
                            Cancel
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
