import { Zap, DollarSign, MessageSquare, Users } from 'lucide-react';
import type { TimeseriesBucket, TimeRange } from './hooks/useMetrics';

interface KpiCardsProps {
    buckets: TimeseriesBucket[];
    snapshot: { activeSessions: number; wsConnections: number };
    range: TimeRange;
}

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

function getTrend(buckets: TimeseriesBucket[], getValue: (b: TimeseriesBucket) => number): { label: string; color: string } | null {
    if (buckets.length < 4) return { label: 'Not enough data', color: 'text-gray-400' };

    const mid = Math.floor(buckets.length / 2);
    const prev = buckets.slice(0, mid).reduce((sum, b) => sum + getValue(b), 0);
    const curr = buckets.slice(mid).reduce((sum, b) => sum + getValue(b), 0);

    if (prev === 0 && curr === 0) return null;
    if (prev === 0) return { label: 'New', color: 'text-green-600' };

    const pct = ((curr - prev) / prev) * 100;
    if (pct >= 0) return { label: `+${pct.toFixed(1)}%`, color: 'text-green-600' };
    return { label: `${pct.toFixed(1)}%`, color: 'text-red-500' };
}

const cards = [
    {
        title: 'Total Tokens',
        icon: Zap,
        iconBg: 'bg-indigo-50',
        iconColor: 'text-indigo-600',
        getValue: (buckets: TimeseriesBucket[]) =>
            buckets.reduce((s, b) => s + b.tokensInput + b.tokensOutput, 0),
        format: formatTokens,
        getTrend: (buckets: TimeseriesBucket[]) =>
            getTrend(buckets, (b) => b.tokensInput + b.tokensOutput),
    },
    {
        title: 'Total Cost',
        icon: DollarSign,
        iconBg: 'bg-emerald-50',
        iconColor: 'text-emerald-600',
        getValue: (buckets: TimeseriesBucket[]) =>
            buckets.reduce((s, b) => s + b.costUsd, 0),
        format: formatCost,
        getTrend: (buckets: TimeseriesBucket[]) =>
            getTrend(buckets, (b) => b.costUsd),
    },
    {
        title: 'Prompts',
        icon: MessageSquare,
        iconBg: 'bg-amber-50',
        iconColor: 'text-amber-600',
    },
    {
        title: 'Active Sessions',
        icon: Users,
        iconBg: 'bg-blue-50',
        iconColor: 'text-blue-600',
    },
];

export function KpiCards({ buckets, snapshot, range }: KpiCardsProps) {
    const totalPrompts = buckets.reduce((s, b) => s + b.promptCount + b.promptErrors, 0);
    const totalErrors = buckets.reduce((s, b) => s + b.promptErrors, 0);
    const errorRate = totalPrompts > 0 ? ((totalErrors / totalPrompts) * 100).toFixed(1) : '0';

    return (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {cards.slice(0, 2).map((card) => {
                const value = card.getValue!(buckets);
                const trend = card.getTrend!(buckets);

                return (
                    <div key={card.title} className="rounded-2xl border border-gray-200 bg-white p-5">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-sm text-gray-500">{card.title}</span>
                            <div className={`w-8 h-8 rounded-lg ${card.iconBg} flex items-center justify-center`}>
                                <card.icon className={`w-4 h-4 ${card.iconColor}`} />
                            </div>
                        </div>
                        <div className="text-2xl font-bold text-gray-900">{card.format!(value)}</div>
                        {trend && (
                            <div className="flex items-center gap-1 mt-1">
                                <span className={`text-xs font-medium ${trend.color}`}>{trend.label}</span>
                                {!trend.label.includes('Not enough') && !trend.label.includes('New') && (
                                    <span className="text-xs text-gray-400 ml-1">vs prev {range}</span>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}

            {/* Prompts */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <div className="flex items-center justify-between mb-3">
                    <span className="text-sm text-gray-500">Prompts</span>
                    <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
                        <MessageSquare className="w-4 h-4 text-amber-600" />
                    </div>
                </div>
                <div className="text-2xl font-bold text-gray-900">{totalPrompts}</div>
                <div className="flex items-center gap-1 mt-1">
                    {totalErrors > 0 ? (
                        <>
                            <span className="text-xs text-red-500 font-medium">{totalErrors} errors</span>
                            <span className="text-xs text-gray-400 ml-1">({errorRate}% error rate)</span>
                        </>
                    ) : (
                        <span className="text-xs text-green-600 font-medium">No errors</span>
                    )}
                </div>
            </div>

            {/* Active Sessions */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <div className="flex items-center justify-between mb-3">
                    <span className="text-sm text-gray-500">Active Sessions</span>
                    <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                        <Users className="w-4 h-4 text-blue-600" />
                    </div>
                </div>
                <div className="text-2xl font-bold text-gray-900">{snapshot.activeSessions}</div>
                <div className="flex items-center gap-1 mt-1">
                    <span className="text-xs text-gray-500">{snapshot.wsConnections} WebSocket connections</span>
                </div>
            </div>
        </div>
    );
}
