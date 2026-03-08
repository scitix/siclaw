import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useSummary, type SummaryPeriod } from './hooks/useMetrics';

const MODEL_COLORS = ['bg-indigo-500', 'bg-violet-400', 'bg-emerald-400', 'bg-amber-400'];

function formatTokens(n: number): string {
    if (n === 0) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(Math.round(n));
}

function formatCost(n: number): string {
    if (n < 1) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
}

export function CumulativePanel() {
    const [period, setPeriod] = useState<SummaryPeriod>('today');
    const { data, loading } = useSummary(period);

    const periods: SummaryPeriod[] = ['today', '7d', '30d'];

    return (
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between mb-4">
                <div className="text-sm font-semibold text-gray-900">Cumulative Statistics</div>
                <div className="flex rounded-lg overflow-hidden border border-gray-200">
                    {periods.map((p) => (
                        <button
                            key={p}
                            onClick={() => setPeriod(p)}
                            className={cn(
                                'px-2.5 py-1 text-xs font-medium transition',
                                period === p
                                    ? 'bg-primary-600 text-white'
                                    : 'bg-gray-50 text-gray-600 hover:bg-gray-200',
                            )}
                        >
                            {p === 'today' ? 'Today' : p}
                        </button>
                    ))}
                </div>
            </div>

            {loading && !data ? (
                <div className="text-sm text-gray-400 text-center py-8">Loading...</div>
            ) : (
                <>
                    {/* Summary cards */}
                    <div className="grid grid-cols-3 gap-3 mb-4">
                        <div className="rounded-xl bg-gray-50 p-3 text-center">
                            <div className="text-xs text-gray-400 mb-1">Tokens</div>
                            <div className="text-lg font-bold text-gray-900">
                                {formatTokens(data?.totalTokens ?? 0)}
                            </div>
                        </div>
                        <div className="rounded-xl bg-gray-50 p-3 text-center">
                            <div className="text-xs text-gray-400 mb-1">Cost</div>
                            <div className="text-lg font-bold text-gray-900">
                                {formatCost(data?.totalCostUsd ?? 0)}
                            </div>
                        </div>
                        <div className="rounded-xl bg-gray-50 p-3 text-center">
                            <div className="text-xs text-gray-400 mb-1">Sessions</div>
                            <div className="text-lg font-bold text-gray-900">
                                {data?.totalSessions ?? 0}
                            </div>
                        </div>
                    </div>

                    {/* Model distribution */}
                    <div className="text-xs text-gray-400 mb-2">Model Distribution</div>
                    <div className="space-y-3">
                        {(!data?.byModel || data.byModel.length === 0) && (
                            <div className="text-sm text-gray-400 text-center py-4">No data</div>
                        )}
                        {data?.byModel?.map((m, i) => (
                            <div key={`${m.provider}-${m.model}`}>
                                <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs font-medium text-gray-700 truncate">
                                        {m.provider}/{m.model}
                                    </span>
                                    <span className="text-xs text-gray-400 ml-2 shrink-0">
                                        {formatTokens(m.tokens)} · {formatCost(m.costUsd)} · {m.percentage.toFixed(1)}%
                                    </span>
                                </div>
                                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                                    <div
                                        className={cn('h-full rounded-full', MODEL_COLORS[Math.min(i, MODEL_COLORS.length - 1)])}
                                        style={{ width: `${m.percentage}%` }}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
