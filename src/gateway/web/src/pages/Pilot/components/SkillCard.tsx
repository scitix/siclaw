import { BookOpen, Check, X, Clock, Eye, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PilotMessage } from '@/hooks/usePilot';

interface SkillData {
    name: string;
    description: string;
    type: string;
}

export type SkillRefStatus = 'pending' | 'saved' | 'dismissed' | 'superseded';

export function SkillCard({ message, status, onOpenPanel }: {
    message: PilotMessage;
    status: SkillRefStatus;
    onOpenPanel?: (msg: PilotMessage) => void;
}) {
    // Parse skill data
    let parsed: { skill: SkillData; skillId?: string } | null = null;
    try {
        parsed = JSON.parse(message.content);
    } catch {
        // ignore
    }

    if (!parsed?.skill) {
        return null;
    }

    const { skill } = parsed;
    const isUpdate = message.toolName === 'update_skill';
    return (
        <div className="pl-12">
            <div className={cn(
                "inline-flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors",
                status === 'saved' && "border-green-200 bg-green-50/50",
                status === 'dismissed' && "border-gray-200 bg-gray-50/50 opacity-60",
                status === 'superseded' && "border-gray-200 bg-gray-50/50 opacity-40",
                status === 'pending' && "border-indigo-200 bg-indigo-50/50",
            )}>
                <BookOpen className={cn(
                    "w-4 h-4 shrink-0",
                    status === 'saved' ? "text-green-500" :
                    status === 'dismissed' ? "text-gray-400" :
                    status === 'superseded' ? "text-gray-300" :
                    "text-indigo-500"
                )} />
                <span className={cn(
                    "text-sm font-medium",
                    status === 'superseded' ? "text-gray-400" : "text-gray-800"
                )}>
                    {skill.name}
                </span>

                {/* Status badge */}
                {status === 'saved' && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">
                        <Check className="w-2.5 h-2.5" />
                        {isUpdate ? 'Updated' : 'Saved'}
                    </span>
                )}
                {status === 'dismissed' && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">
                        <X className="w-2.5 h-2.5" />
                        Dismissed
                    </span>
                )}
                {status === 'superseded' && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-400">
                        <Layers className="w-2.5 h-2.5" />
                        Superseded
                    </span>
                )}
                {status === 'pending' && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-600">
                        <Clock className="w-2.5 h-2.5" />
                        Pending
                    </span>
                )}

                {/* View button */}
                {status !== 'superseded' && onOpenPanel && (
                    <button
                        onClick={() => onOpenPanel(message)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                    >
                        <Eye className="w-3 h-3" />
                        View
                    </button>
                )}
            </div>
        </div>
    );
}
