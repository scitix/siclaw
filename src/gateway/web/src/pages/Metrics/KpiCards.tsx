import { Zap, MessageSquare, Wrench, LayoutGrid, Users } from 'lucide-react';
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

export function KpiCards({ buckets, snapshot, range }: KpiCardsProps) {
    const totalTokens = buckets.reduce((s, b) => s + b.tokensInput + b.tokensOutput, 0);
    const tokenTrend = getTrend(buckets, (b) => b.tokensInput + b.tokensOutput);

    const totalPrompts = buckets.reduce((s, b) => s + b.promptCount + b.promptErrors, 0);
    const promptErrors = buckets.reduce((s, b) => s + b.promptErrors, 0);
    const promptErrorRate = totalPrompts > 0 ? ((promptErrors / totalPrompts) * 100).toFixed(1) : '0';

    const totalToolCalls = buckets.reduce((s, b) => s + b.toolCalls + b.toolErrors, 0);
    const toolErrors = buckets.reduce((s, b) => s + b.toolErrors, 0);
    const toolTrend = getTrend(buckets, (b) => b.toolCalls + b.toolErrors);

    const totalSkillCalls = buckets.reduce((s, b) => s + b.skillSuccesses + b.skillErrors, 0);
    const skillErrors = buckets.reduce((s, b) => s + b.skillErrors, 0);
    const skillErrorRate = totalSkillCalls > 0 ? ((skillErrors / totalSkillCalls) * 100).toFixed(1) : '0';

    return (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {/* Total Tokens */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <div className="flex items-center justify-between mb-3">
                    <span className="text-sm text-gray-500">Total Tokens</span>
                    <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                        <Zap className="w-4 h-4 text-indigo-600" />
                    </div>
                </div>
                <div className="text-2xl font-bold text-gray-900">{formatTokens(totalTokens)}</div>
                {tokenTrend && (
                    <div className="flex items-center gap-1 mt-1">
                        <span className={`text-xs font-medium ${tokenTrend.color}`}>{tokenTrend.label}</span>
                        {!tokenTrend.label.includes('Not enough') && !tokenTrend.label.includes('New') && (
                            <span className="text-xs text-gray-400 ml-1">vs prev {range}</span>
                        )}
                    </div>
                )}
            </div>

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
                    {promptErrors > 0 ? (
                        <>
                            <span className="text-xs text-red-500 font-medium">{promptErrors} errors</span>
                            <span className="text-xs text-gray-400 ml-1">({promptErrorRate}% error rate)</span>
                        </>
                    ) : (
                        <span className="text-xs text-green-600 font-medium">No errors</span>
                    )}
                </div>
            </div>

            {/* Tool Calls */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <div className="flex items-center justify-between mb-3">
                    <span className="text-sm text-gray-500">Tool Calls</span>
                    <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
                        <Wrench className="w-4 h-4 text-emerald-600" />
                    </div>
                </div>
                <div className="text-2xl font-bold text-gray-900">{formatTokens(totalToolCalls)}</div>
                <div className="flex items-center gap-1 mt-1">
                    {toolErrors > 0 ? (
                        <span className="text-xs text-red-500 font-medium">{toolErrors} errors</span>
                    ) : toolTrend ? (
                        <span className={`text-xs font-medium ${toolTrend.color}`}>{toolTrend.label}</span>
                    ) : (
                        <span className="text-xs text-gray-400">No data</span>
                    )}
                </div>
            </div>

            {/* Skill Calls */}
            <div className="rounded-2xl border border-gray-200 bg-white p-5">
                <div className="flex items-center justify-between mb-3">
                    <span className="text-sm text-gray-500">Skill Calls</span>
                    <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center">
                        <LayoutGrid className="w-4 h-4 text-purple-600" />
                    </div>
                </div>
                <div className="text-2xl font-bold text-gray-900">{totalSkillCalls}</div>
                <div className="flex items-center gap-1 mt-1">
                    {skillErrors > 0 ? (
                        <>
                            <span className="text-xs text-red-500 font-medium">{skillErrors} errors</span>
                            <span className="text-xs text-gray-400 ml-1">({skillErrorRate}%)</span>
                        </>
                    ) : totalSkillCalls > 0 ? (
                        <span className="text-xs text-green-600 font-medium">No errors</span>
                    ) : (
                        <span className="text-xs text-gray-400">No data</span>
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
