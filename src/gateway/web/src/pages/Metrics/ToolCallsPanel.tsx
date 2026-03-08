import type { ToolCallStats } from './hooks/useMetrics';

interface ToolCallsPanelProps {
    topTools: ToolCallStats[];
}

export function ToolCallsPanel({ topTools }: ToolCallsPanelProps) {
    const totalCalls = topTools.reduce((s, t) => s + t.total, 0);
    const maxTotal = topTools.length > 0 ? topTools[0].total : 0;

    return (
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between mb-4">
                <div className="text-sm font-semibold text-gray-900">Tool Calls Top 10</div>
                <div className="text-xs text-gray-400">{totalCalls} total · Since start</div>
            </div>
            <div className="space-y-2">
                {topTools.length === 0 && (
                    <div className="text-sm text-gray-400 text-center py-8">No tool calls yet</div>
                )}
                {topTools.map((tool) => {
                    const pct = maxTotal > 0 ? (tool.total / maxTotal) * 100 : 0;
                    return (
                        <div key={tool.toolName} className="flex items-center gap-3">
                            <div className="w-32 truncate font-mono text-xs text-gray-600" title={tool.toolName}>
                                {tool.toolName}
                            </div>
                            <div className="flex-1 bg-gray-100 rounded-md h-6 relative overflow-hidden">
                                <div
                                    className="absolute inset-y-0 left-0 bg-indigo-100 rounded-md"
                                    style={{ width: `${pct}%` }}
                                />
                                <div className="absolute inset-0 flex items-center justify-between px-2">
                                    <span className="text-xs font-medium text-gray-700">{tool.total}</span>
                                    {tool.error > 0 && (
                                        <span className="text-xs font-medium text-red-500">{tool.error} err</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
