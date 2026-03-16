import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { TimeseriesBucket } from './hooks/useMetrics';

interface TokenChartProps {
    buckets: TimeseriesBucket[];
}

function formatTokens(n: number): string {
    if (n === 0) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(Math.round(n));
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TokenChart({ buckets }: TokenChartProps) {
    const data = buckets.map((b) => ({
        time: b.timestamp,
        input: b.tokensInput,
        output: b.tokensOutput,
        cache: b.tokensCacheRead + b.tokensCacheWrite,
    }));

    return (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 min-w-0">
            <div className="text-sm font-semibold text-gray-900 mb-4">Token Usage</div>
            <div className="min-w-0">
                <ResponsiveContainer width="100%" height={200}>
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
                            tickFormatter={formatTokens}
                            tick={{ fontSize: 12, fill: '#94a3b8' }}
                            axisLine={false}
                            tickLine={false}
                            width={50}
                        />
                        <Tooltip
                            labelFormatter={(label) => formatTime(Number(label))}
                            formatter={(value, name) => [formatTokens(Number(value)), name]}
                        />
                        <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8} />
                        <Area
                            type="monotone"
                            dataKey="input"
                            name="Input"
                            stroke="#6366f1"
                            fill="#6366f1"
                            fillOpacity={0.1}
                            strokeWidth={2}
                        />
                        <Area
                            type="monotone"
                            dataKey="output"
                            name="Output"
                            stroke="#a78bfa"
                            fill="#a78bfa"
                            fillOpacity={0.1}
                            strokeWidth={2}
                        />
                        <Area
                            type="monotone"
                            dataKey="cache"
                            name="Cache"
                            stroke="#cbd5e1"
                            fill="#cbd5e1"
                            fillOpacity={0.1}
                            strokeWidth={2}
                            strokeDasharray="4 4"
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
