import { useState } from 'react';
import { X, BookOpen, Tag, ChevronRight, FileText, Terminal, FileCode, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PilotMessage } from '@/hooks/usePilot';

interface SkillData {
    name: string;
    description: string;
    type: string;
    specs: string;
    scripts: Array<{ name: string; content: string }>;
}

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async (e: React.MouseEvent) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    return (
        <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
        >
            {copied ? (
                <><Check className="w-3 h-3 text-green-500" /><span className="text-green-600">Copied</span></>
            ) : (
                <><Copy className="w-3 h-3" />Copy</>
            )}
        </button>
    );
}

function getFileIcon(name: string) {
    if (name === 'SKILL.md') return <FileText className="w-3.5 h-3.5 text-indigo-500 shrink-0" />;
    if (name.endsWith('.py')) return <FileCode className="w-3.5 h-3.5 text-blue-500 shrink-0" />;
    return <Terminal className="w-3.5 h-3.5 text-green-500 shrink-0" />;
}

function FileEntry({ name, content, defaultExpanded }: { name: string; content: string; defaultExpanded?: boolean }) {
    const [expanded, setExpanded] = useState(defaultExpanded ?? false);

    return (
        <div className="border-t border-gray-100">
            <button
                type="button"
                className="flex items-center gap-2 w-full px-4 py-2 hover:bg-gray-50 transition-colors text-left"
                onClick={() => setExpanded(!expanded)}
            >
                <ChevronRight className={cn(
                    "w-3 h-3 text-gray-400 transition-transform shrink-0",
                    expanded && "rotate-90"
                )} />
                {getFileIcon(name)}
                <span className="text-xs font-mono text-gray-700 truncate">{name}</span>
                <span className="ml-auto shrink-0">
                    <CopyButton text={content} />
                </span>
            </button>
            {expanded && (
                <div className="px-4 pb-3">
                    <pre className="text-xs font-mono leading-relaxed text-gray-600 whitespace-pre-wrap bg-gray-50 rounded p-3 max-h-[40vh] overflow-y-auto">{content}</pre>
                </div>
            )}
        </div>
    );
}

export interface SkillPanelProps {
    message: PilotMessage;
    onClose: () => void;
}

export function SkillPanel({ message, onClose }: SkillPanelProps) {
    let parsed: { skill: SkillData } | null = null;
    try {
        parsed = JSON.parse(message.content);
    } catch {
        // ignore
    }

    const skill = parsed?.skill;

    if (!skill) {
        return (
            <div className="w-[480px] border-l border-gray-200 bg-white flex flex-col shrink-0">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                    <span className="text-sm text-gray-500">Invalid skill data</span>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X className="w-4 h-4 text-gray-400" />
                    </button>
                </div>
            </div>
        );
    }

    // Flat file list: SKILL.md first, then scripts
    const files: Array<{ name: string; content: string }> = [];
    if (skill.specs) files.push({ name: 'SKILL.md', content: skill.specs });
    for (const s of skill.scripts ?? []) {
        if (s.content) files.push({ name: s.name, content: s.content });
    }

    return (
        <div className="w-[480px] border-l border-gray-200 bg-white flex flex-col shrink-0 h-full">
            {/* Header */}
            <div className="px-4 py-3 border-b border-gray-200 bg-gradient-to-r from-indigo-50 to-purple-50 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                    <BookOpen className="w-4 h-4 text-indigo-600 shrink-0" />
                    <span className="font-semibold text-sm text-gray-900 truncate">{skill.name}</span>
                    {skill.type && skill.type !== 'Custom' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 text-indigo-700 shrink-0">
                            <Tag className="w-2.5 h-2.5" />
                            {skill.type}
                        </span>
                    )}
                </div>
                <button onClick={onClose} className="p-1 rounded hover:bg-white/60 transition-colors shrink-0">
                    <X className="w-4 h-4 text-gray-500" />
                </button>
            </div>

            {skill.description && (
                <div className="px-4 py-2 border-b border-gray-100 text-xs text-gray-600">
                    {skill.description}
                </div>
            )}

            {/* File list */}
            <div className="overflow-y-auto">
                {files.map((f, i) => (
                    <FileEntry key={f.name} name={f.name} content={f.content} defaultExpanded={i === 0} />
                ))}
            </div>
        </div>
    );
}
