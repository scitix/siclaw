import { useMemo } from 'react';
import { X, FileCode2, ArrowRightLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SkillDiffMetadataChange } from '../pages/Skills/skillsData';

type DiffLineType = 'context' | 'add' | 'remove' | 'meta';

type ParsedDiffLine = {
    type: DiffLineType;
    leftNumber: number | null;
    rightNumber: number | null;
    content: string;
};

type ParsedDiffFile = {
    oldPath: string;
    newPath: string;
    hunks: Array<{
        header: string;
        lines: ParsedDiffLine[];
    }>;
};

function parseRangeStart(value: string): number {
    const raw = value.slice(1).split(',')[0];
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
    const lines = diffText.split('\n');
    const files: ParsedDiffFile[] = [];
    let currentFile: ParsedDiffFile | null = null;
    let currentHunk: ParsedDiffFile['hunks'][number] | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
        if (!currentFile && (line.startsWith('===================================================================') || line.startsWith('Index: ') || line.trim() === '')) {
            continue;
        }

        if (line.startsWith('--- ')) {
            currentFile = {
                oldPath: line.slice(4).trim(),
                newPath: line.slice(4).trim(),
                hunks: [],
            };
            currentHunk = null;
            files.push(currentFile);
            continue;
        }

        if (line.startsWith('+++ ')) {
            if (currentFile) {
                currentFile.newPath = line.slice(4).trim();
            }
            continue;
        }

        if (line.startsWith('@@')) {
            if (!currentFile) {
                currentFile = { oldPath: 'before', newPath: 'after', hunks: [] };
                files.push(currentFile);
            }
            const match = line.match(/^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@/);
            oldLine = match ? parseRangeStart(`-${match[1]}`) : 0;
            newLine = match ? parseRangeStart(`+${match[2]}`) : 0;
            currentHunk = { header: line, lines: [] };
            currentFile.hunks.push(currentHunk);
            continue;
        }

        if (!currentFile) {
            currentFile = { oldPath: 'before', newPath: 'after', hunks: [] };
            files.push(currentFile);
        }
        if (!currentHunk) {
            currentHunk = { header: '', lines: [] };
            currentFile.hunks.push(currentHunk);
        }

        if (line.startsWith('+') && !line.startsWith('+++')) {
            currentHunk.lines.push({ type: 'add', leftNumber: null, rightNumber: newLine, content: line.slice(1) });
            newLine += 1;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            currentHunk.lines.push({ type: 'remove', leftNumber: oldLine, rightNumber: null, content: line.slice(1) });
            oldLine += 1;
        } else if (line.startsWith('\\')) {
            currentHunk.lines.push({ type: 'meta', leftNumber: null, rightNumber: null, content: line });
        } else {
            const content = line.startsWith(' ') ? line.slice(1) : line;
            currentHunk.lines.push({ type: 'context', leftNumber: oldLine, rightNumber: newLine, content });
            oldLine += 1;
            newLine += 1;
        }
    }

    return files;
}

function lineStyles(type: DiffLineType): string {
    switch (type) {
        case 'add':
            return 'bg-emerald-50 text-emerald-950';
        case 'remove':
            return 'bg-rose-50 text-rose-950';
        case 'meta':
            return 'bg-amber-50 text-amber-900 italic';
        default:
            return 'bg-white text-slate-700';
    }
}

function gutterStyles(type: DiffLineType): string {
    switch (type) {
        case 'add':
            return 'bg-emerald-100/80 text-emerald-700';
        case 'remove':
            return 'bg-rose-100/80 text-rose-700';
        case 'meta':
            return 'bg-amber-100/80 text-amber-700';
        default:
            return 'bg-slate-50 text-slate-400';
    }
}

function DiffUnifiedView({ files }: { files: ParsedDiffFile[] }) {
    return (
        <div className="space-y-6">
            {files.map((file, fileIndex) => (
                <div key={`${file.oldPath}-${file.newPath}-${fileIndex}`} className="rounded-2xl border border-slate-200 overflow-hidden bg-white">
                    <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center gap-2 text-sm text-slate-700">
                        <FileCode2 className="w-4 h-4 text-slate-400" />
                        <span className="font-medium">{file.newPath}</span>
                    </div>
                    {file.hunks.map((hunk, hunkIndex) => (
                        <div key={`${fileIndex}-${hunkIndex}`} className="border-b border-slate-100 last:border-b-0">
                            {hunk.header && (
                                <div className="px-4 py-2 bg-sky-50 text-sky-700 text-xs font-medium border-b border-sky-100">
                                    {hunk.header}
                                </div>
                            )}
                            <div className="overflow-x-auto">
                                <table className="min-w-full border-collapse text-[12px] font-mono">
                                    <tbody>
                                        {hunk.lines.map((line, lineIndex) => (
                                            <tr key={`${fileIndex}-${hunkIndex}-${lineIndex}`} className={lineStyles(line.type)}>
                                                <td className={cn('w-14 px-3 py-1.5 text-right border-r border-slate-100 select-none', gutterStyles(line.type))}>{line.leftNumber ?? ''}</td>
                                                <td className={cn('w-14 px-3 py-1.5 text-right border-r border-slate-100 select-none', gutterStyles(line.type))}>{line.rightNumber ?? ''}</td>
                                                <td className="px-4 py-1.5 whitespace-pre">{line.content || ' '}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

interface DiffViewerModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    subtitle?: string;
    diffText: string | null;
    metadataChanges?: SkillDiffMetadataChange[];
    isLoading?: boolean;
}

function formatMetadataValue(value: string | string[] | null): string {
    if (Array.isArray(value)) {
        return value.length > 0 ? value.join(', ') : 'None';
    }
    if (value === null || value === '') return 'None';
    return value;
}

export function DiffViewerModal({
    isOpen,
    onClose,
    title,
    subtitle,
    diffText,
    metadataChanges = [],
    isLoading = false,
}: DiffViewerModalProps) {
    const files = useMemo(() => parseUnifiedDiff(diffText ?? ''), [diffText]);
    const hasFileDiff = !!diffText && !!diffText.trim() && diffText !== 'No changes detected.';
    const hasMetadataChanges = metadataChanges.length > 0;

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-7xl h-[88vh] bg-[#f7f8fa] rounded-[28px] shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
                <div className="px-6 py-4 border-b border-slate-200 bg-white flex items-center gap-4">
                    <div className="w-11 h-11 rounded-2xl bg-slate-900 text-white flex items-center justify-center">
                        <ArrowRightLeft className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
                        {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
                    </div>
                    <button onClick={onClose} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-6">
                    {isLoading ? (
                        <div className="h-full flex items-center justify-center text-sm text-slate-500">Loading diff...</div>
                    ) : !hasFileDiff && !hasMetadataChanges ? (
                        <div className="h-full flex items-center justify-center text-sm text-slate-500">No changes detected.</div>
                    ) : (
                        <div className="space-y-6">
                            {hasMetadataChanges && (
                                <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
                                    <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 text-sm font-medium text-slate-700">
                                        Metadata changes
                                    </div>
                                    <div className="divide-y divide-slate-100">
                                        {metadataChanges.map((change) => (
                                            <div key={`${change.field}-${JSON.stringify(change.before)}-${JSON.stringify(change.after)}`} className="px-4 py-3 text-sm">
                                                <div className="font-medium text-slate-800 capitalize">{change.field}</div>
                                                <div className="mt-1 text-slate-500">{formatMetadataValue(change.before)}</div>
                                                <div className="mt-1 text-slate-800">{formatMetadataValue(change.after)}</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {hasFileDiff && <DiffUnifiedView files={files} />}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
