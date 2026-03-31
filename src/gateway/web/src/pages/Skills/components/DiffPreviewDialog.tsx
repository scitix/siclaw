/**
 * DiffPreviewDialog — shows a diff preview before publish/submit/contribute.
 * Used by both SkillSpaceDetail and index.tsx.
 */

import { useState, type ReactNode } from 'react';
import { Loader2, ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PreviewDiffResult } from '../skillsData';

export interface DiffPreviewDialogProps {
    isOpen: boolean;
    title: string;
    loading: boolean;
    diff: PreviewDiffResult | null;
    onClose: () => void;
    onConfirm: (message?: string) => void;
}

const CONTEXT_LINES = 3;

export function DiffBlock({ content }: { content: string }) {
    const lines = content.split('\n');
    const [expandedRanges, setExpandedRanges] = useState<Set<string>>(new Set());

    // Find which lines are changed
    const changedSet = new Set<number>();
    lines.forEach((line, i) => {
        if (line.startsWith('+') || line.startsWith('-')) changedSet.add(i);
    });

    // Build visible ranges: changed lines + context
    const visibleSet = new Set<number>();
    for (const idx of changedSet) {
        for (let j = Math.max(0, idx - CONTEXT_LINES); j <= Math.min(lines.length - 1, idx + CONTEXT_LINES); j++) {
            visibleSet.add(j);
        }
    }

    // If all lines are changed or very few lines, show everything
    if (changedSet.size === 0 || lines.length <= 20 || visibleSet.size >= lines.length * 0.8) {
        return (
            <div className="text-xs font-mono max-h-80 overflow-y-auto">
                {lines.map((line, i) => (
                    <DiffLine key={i} line={line} num={i + 1} />
                ))}
            </div>
        );
    }

    // Build chunks: visible lines + collapsed ranges
    const chunks: Array<{ type: 'lines'; start: number; end: number } | { type: 'collapsed'; start: number; end: number; key: string }> = [];
    let i = 0;
    while (i < lines.length) {
        if (visibleSet.has(i) || expandedRanges.has(`${i}`)) {
            const start = i;
            while (i < lines.length && (visibleSet.has(i) || expandedRanges.has(`${start}`))) i++;
            chunks.push({ type: 'lines', start, end: i });
        } else {
            const start = i;
            while (i < lines.length && !visibleSet.has(i) && !expandedRanges.has(`${start}`)) i++;
            chunks.push({ type: 'collapsed', start, end: i, key: `${start}` });
        }
    }

    return (
        <div className="text-xs font-mono max-h-80 overflow-y-auto">
            {chunks.map((chunk) => {
                if (chunk.type === 'collapsed') {
                    const count = chunk.end - chunk.start;
                    return (
                        <button
                            key={`collapse-${chunk.key}`}
                            onClick={() => setExpandedRanges(prev => new Set(prev).add(chunk.key))}
                            className="w-full flex items-center gap-2 px-2 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors border-y border-blue-100"
                        >
                            <ChevronDown className="w-3 h-3" />
                            <span>Show {count} hidden line{count > 1 ? 's' : ''}</span>
                        </button>
                    );
                }
                return lines.slice(chunk.start, chunk.end).map((line, j) => (
                    <DiffLine key={chunk.start + j} line={line} num={chunk.start + j + 1} />
                ));
            })}
        </div>
    );
}

function DiffLine({ line, num }: { line: string; num: number }) {
    return (
        <div className={cn(
            "flex",
            line.startsWith('+') ? 'bg-green-50' :
            line.startsWith('-') ? 'bg-red-50' : ''
        )}>
            <span className="w-8 shrink-0 text-right pr-2 text-gray-300 select-none border-r border-gray-100">{num}</span>
            <span className={cn(
                "pl-2 whitespace-pre-wrap flex-1",
                line.startsWith('+') ? 'text-green-700' :
                line.startsWith('-') ? 'text-red-700' : 'text-gray-600'
            )}>{line || '\u00A0'}</span>
        </div>
    );
}

function CollapsibleSection({ title, badge, defaultOpen, children }: {
    title: string; badge?: string; defaultOpen?: boolean; children: ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen ?? false);
    const badgeColor = badge === 'added' ? 'text-green-600 bg-green-50' :
        badge === 'removed' ? 'text-red-600 bg-red-50' :
        badge === 'modified' || badge === 'changed' ? 'text-blue-600 bg-blue-50' :
        'text-gray-500 bg-gray-50';
    return (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
            <button onClick={() => setOpen(!open)}
                className={cn("w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-gray-700 transition-colors", open ? "bg-gray-50" : "hover:bg-gray-50")}>
                {open ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                <FileText className="w-3.5 h-3.5 text-gray-400" />
                <span className="font-mono">{title}</span>
                {badge && <span className={cn("ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded", badgeColor)}>{badge}</span>}
            </button>
            {open && <div className="border-t border-gray-100 p-3">{children}</div>}
        </div>
    );
}

export function DiffPreviewDialog({ isOpen, title, loading, diff, onClose, onConfirm }: DiffPreviewDialogProps) {
    const [message, setMessage] = useState('');

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[80vh]">
                <div className="px-6 py-4 border-b">
                    <h3 className="text-base font-semibold text-gray-900">{title}</h3>
                    {!loading && diff && (
                        <div className="flex items-center gap-3 mt-1">
                            <span className="text-xs text-gray-500">{diff.fromLabel} → {diff.toLabel}</span>
                            {diff.hasChanges && !diff.isNew && (
                                <span className="text-[10px] text-gray-400">
                                    {(diff.specsDiff ? 1 : 0) + diff.scriptDiffs.filter(s => s.status !== 'unchanged').length} file(s) changed
                                    {diff.metadataChanges.length > 0 && ` · ${diff.metadataChanges.length} property change(s)`}
                                </span>
                            )}
                        </div>
                    )}
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-3">
                    {loading ? (
                        <div className="flex items-center justify-center py-12">
                            <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                        </div>
                    ) : !diff ? (
                        <p className="text-sm text-gray-500">Failed to load diff.</p>
                    ) : diff.isNew ? (
                        <p className="text-sm text-gray-500">First time — no previous version to compare against.</p>
                    ) : !diff.hasChanges ? (
                        <p className="text-sm text-gray-500">No changes detected.</p>
                    ) : (
                        <>
                            {/* Metadata changes — clean table style, always visible */}
                            {diff.metadataChanges.length > 0 && (
                                <div className="rounded-lg border border-gray-200 overflow-hidden">
                                    <div className="px-3 py-2 bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider border-b border-gray-200">
                                        Labels
                                    </div>
                                    <div className="divide-y divide-gray-100">
                                        {diff.metadataChanges.map(c => (
                                            <div key={c.field} className="flex items-start px-3 py-2.5">
                                                <span className="w-20 shrink-0 text-xs font-medium text-gray-500 pt-0.5">{c.field}</span>
                                                <div className="flex-1 min-w-0">
                                                    {c.field === 'labels' && c.fromLabels && c.toLabels ? (
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {(() => {
                                                                const from = new Set(c.fromLabels);
                                                                const to = new Set(c.toLabels);
                                                                const all = [...new Set([...from, ...to])].sort();
                                                                return all.map(label => {
                                                                    const added = to.has(label) && !from.has(label);
                                                                    const removed = from.has(label) && !to.has(label);
                                                                    return (
                                                                        <span key={label} className={cn(
                                                                            "inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border",
                                                                            added ? "bg-green-50 text-green-700 border-green-200" :
                                                                            removed ? "bg-red-50 text-red-600 border-red-200 line-through" :
                                                                            "bg-gray-50 text-gray-600 border-gray-200"
                                                                        )}>
                                                                            {added && <span className="mr-0.5 text-green-500">+</span>}
                                                                            {removed && <span className="mr-0.5 text-red-400">-</span>}
                                                                            {label}
                                                                        </span>
                                                                    );
                                                                });
                                                            })()}
                                                        </div>
                                                    ) : (
                                                        <div className="space-y-0.5">
                                                            {c.from && (
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="shrink-0 w-4 h-4 rounded bg-red-100 text-red-600 text-[10px] font-bold flex items-center justify-center">-</span>
                                                                    <span className="text-xs text-red-700 line-through">{c.from}</span>
                                                                </div>
                                                            )}
                                                            {c.to && (
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="shrink-0 w-4 h-4 rounded bg-green-100 text-green-600 text-[10px] font-bold flex items-center justify-center">+</span>
                                                                    <span className="text-xs text-green-700">{c.to}</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* File diffs — collapsible sections */}
                            {(() => {
                                const sections: Array<{ key: string; title: string; badge: string; content: React.ReactNode }> = [];
                                if (diff.specsDiff) {
                                    sections.push({
                                        key: 'specs',
                                        title: 'SKILL.md',
                                        badge: 'modified',
                                        content: <DiffBlock content={diff.specsDiff} />,
                                    });
                                }
                                for (const s of diff.scriptDiffs.filter(d => d.status !== 'unchanged')) {
                                    sections.push({
                                        key: s.name,
                                        title: `scripts/${s.name}`,
                                        badge: s.status,
                                        content: s.diff ? <DiffBlock content={s.diff} /> : <p className="text-xs text-gray-400">No content changes.</p>,
                                    });
                                }
                                return sections.map((sec, i) => (
                                    <CollapsibleSection key={sec.key} title={sec.title} badge={sec.badge} defaultOpen={i === 0}>
                                        {sec.content}
                                    </CollapsibleSection>
                                ));
                            })()}
                        </>
                    )}
                </div>
                <div className="border-t px-6 py-3 space-y-2">
                    <input
                        type="text"
                        value={message}
                        onChange={e => setMessage(e.target.value)}
                        placeholder="Commit message (optional)"
                        className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-300"
                    />
                    <div className="flex items-center justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700">
                        Cancel
                    </button>
                    <button
                        onClick={() => onConfirm(message || undefined)}
                        disabled={loading}
                        className={cn(
                            "px-4 py-1.5 text-sm font-medium rounded-lg text-white transition-colors disabled:opacity-50",
                            "bg-blue-600 hover:bg-blue-700",
                        )}
                    >
                        Confirm
                    </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
