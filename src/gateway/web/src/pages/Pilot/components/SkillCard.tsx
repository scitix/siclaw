import { BookOpen, Eye } from 'lucide-react';
import type { PilotMessage } from '@/hooks/usePilot';

export function SkillCard({ message, onOpenPanel }: {
    message: PilotMessage;
    onOpenPanel?: (msg: PilotMessage) => void;
}) {
    let parsed: { skill: { name: string } } | null = null;
    try {
        parsed = JSON.parse(message.content);
    } catch {
        return null;
    }
    if (!parsed?.skill) return null;

    return (
        <div className="pl-12 my-1">
            <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50/50">
                <BookOpen className="w-4 h-4 text-indigo-500 shrink-0" />
                <span className="text-sm font-medium text-gray-800">{parsed.skill.name}</span>
                {onOpenPanel && (
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
