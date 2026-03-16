import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { TimeseriesBucket } from './hooks/useMetrics';

interface LatencyChartProps {
    buckets: TimeseriesBucket[];
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
    if (ms === 0) return '0s';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

export function LatencyChart({ buckets }: LatencyChartProps) {
    const data = buckets.map((b) => ({
        time: b.timestamp,
        avg: b.promptDurationAvg,
        max: b.promptDurationMax,
    }));

    // Summary stats
    const nonZero = buckets.filter((b) => b.promptDurationAvg > 0);
    const avgAll = nonZero.length > 0
        ? nonZero.reduce((s, b) => s + b.promptDurationAvg, 0) / nonZero.length
        : 0;
    const maxAll = buckets.reduce((m, b) => Math.max(m, b.promptDurationMax), 0);

    // P95 approximation: sort max values, take 95th percentile
    const sorted = nonZero.map((b) => b.promptDurationMax).sort((a, b) => a - b);
    const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;

    return (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 min-w-0">
            <div className="text-sm font-semibold text-gray-900 mb-4">Prompt Latency</div>
            <div className="h-[200px] w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                        <XAxis
                            dataKey="time"
                            tickFormatter={formatTime}
                            tick={{ fontSize: 12, fill: '#94a3b8' }}
                            axisLine={false}
                            tickLine={false}
                        />
                        <YAxis
                            tickFormatter={formatDuration}
                            tick={{ fontSize: 12, fill: '#94a3b8' }}
                            axisLine={false}
                            tickLine={false}
                            width={50}
                        />
                        <Tooltip
                            labelFormatter={(label) => formatTime(Number(label))}
                            formatter={(value, name) => [formatDuration(Number(value)), name]}
                        />
                        <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8} />
                        <Area
                            type="monotone"
                            dataKey="avg"
                            name="Avg"
                            stroke="#6366f1"
                            fill="#6366f1"
                            fillOpacity={0.1}
                            strokeWidth={2}
                        />
                        <Area
                            type="monotone"
                            dataKey="max"
                            name="Max"
                            stroke="#fb7185"
                            fill="none"
                            fillOpacity={0}
                            strokeWidth={2}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-6 mt-3 pt-3 border-t border-gray-100">
                <div className="text-center">
                    <div className="text-xs text-gray-400">Avg</div>
                    <div className="text-sm font-semibold text-gray-900">{formatDuration(avgAll)}</div>
                </div>
                <div className="text-center">
                    <div className="text-xs text-gray-400">P95</div>
                    <div className="text-sm font-semibold text-gray-900">{formatDuration(p95)}</div>
                </div>
                <div className="text-center">
                    <div className="text-xs text-gray-400">Max</div>
                    <div className="text-sm font-semibold text-gray-900">{formatDuration(maxAll)}</div>
                </div>
            </div>
        </div>
    );
}
