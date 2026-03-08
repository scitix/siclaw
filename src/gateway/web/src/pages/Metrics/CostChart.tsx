import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { TimeseriesBucket } from './hooks/useMetrics';

interface CostChartProps {
    buckets: TimeseriesBucket[];
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatCost(n: number): string {
    if (n < 1) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
}

export function CostChart({ buckets }: CostChartProps) {
    let cumulative = 0;
    const data = buckets.map((b) => {
        cumulative += b.costUsd;
        return { time: b.timestamp, cost: cumulative };
    });

    return (
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="text-sm font-semibold text-gray-900 mb-4">Cost (USD)</div>
            <div className="h-[200px]">
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
                            tickFormatter={formatCost}
                            tick={{ fontSize: 12, fill: '#94a3b8' }}
                            axisLine={false}
                            tickLine={false}
                            width={60}
                        />
                        <Tooltip
                            labelFormatter={(label) => formatTime(Number(label))}
                            formatter={(value) => [formatCost(Number(value)), 'Cumulative Cost']}
                        />
                        <Area
                            type="monotone"
                            dataKey="cost"
                            name="Cost"
                            stroke="#10b981"
                            fill="#10b981"
                            fillOpacity={0.1}
                            strokeWidth={2}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
