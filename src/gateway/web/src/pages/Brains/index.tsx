import { useState, useEffect } from 'react';
import { Bot, Sparkles, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BrainType } from '@/hooks/usePilot';

const STORAGE_KEY = 'siclaw_selected_brain';

const brains: { id: BrainType; name: string; description: string; icon: typeof Bot }[] = [
    {
        id: 'pi-agent',
        name: 'PI Agent',
        description: 'Multi-turn agentic framework with tool execution and auto-compaction',
        icon: Bot,
    },
    {
        id: 'claude-sdk',
        name: 'Claude Agent SDK',
        description: "Anthropic's native agent SDK with built-in tool use",
        icon: Sparkles,
    },
];

export function BrainsPage() {
    const [selected, setSelected] = useState<BrainType>(() => {
        return (localStorage.getItem(STORAGE_KEY) as BrainType) || 'pi-agent';
    });

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, selected);
    }, [selected]);

    return (
        <div className="h-full bg-white flex flex-col">
            <div className="flex-1 overflow-y-auto px-6 py-8 max-w-5xl mx-auto w-full">
                <section>
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">Agent Engine</h2>
                    <div className="rounded-2xl border border-gray-200 bg-gray-50/50 p-6">
                        <p className="text-sm text-gray-500 mb-4">
                            Choose the agent engine used for new chat sessions. This determines how tools are executed and conversations are managed.
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {brains.map((brain) => {
                                const isSelected = selected === brain.id;
                                const Icon = brain.icon;
                                return (
                                    <button
                                        key={brain.id}
                                        type="button"
                                        onClick={() => setSelected(brain.id)}
                                        className={cn(
                                            'rounded-xl border p-5 cursor-pointer transition-all text-left',
                                            isSelected
                                                ? 'border-indigo-300 bg-indigo-50/50 ring-2 ring-indigo-200'
                                                : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm',
                                        )}
                                    >
                                        <div className="flex items-start justify-between mb-3">
                                            <div className={cn(
                                                'p-2 rounded-lg',
                                                isSelected ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-500',
                                            )}>
                                                <Icon className="w-5 h-5" />
                                            </div>
                                            {isSelected && (
                                                <span className="flex items-center gap-1 text-xs font-medium text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded-full">
                                                    <Check className="w-3 h-3" />
                                                    Active
                                                </span>
                                            )}
                                        </div>
                                        <h3 className={cn(
                                            'text-sm font-semibold mb-1',
                                            isSelected ? 'text-indigo-900' : 'text-gray-900',
                                        )}>
                                            {brain.name}
                                        </h3>
                                        <p className="text-sm text-gray-500">{brain.description}</p>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}
