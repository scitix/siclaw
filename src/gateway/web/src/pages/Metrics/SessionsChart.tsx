import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { TimeseriesBucket } from './hooks/useMetrics';

interface SessionsChartProps {
    buckets: TimeseriesBucket[];
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function SessionsChart({ buckets }: SessionsChartProps) {
    const data = buckets.map((b) => ({
        time: b.timestamp,
        sessions: b.activeSessions,
        ws: b.wsConnections,
    }));

    const peakSessions = buckets.reduce((m, b) => Math.max(m, b.activeSessions), 0);
    const peakWs = buckets.reduce((m, b) => Math.max(m, b.wsConnections), 0);

    return (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 min-w-0">
            <div className="text-sm font-semibold text-gray-900 mb-4">Sessions & Connections</div>
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
                            allowDecimals={false}
                            tick={{ fontSize: 12, fill: '#94a3b8' }}
                            axisLine={false}
                            tickLine={false}
                            width={30}
                        />
                        <Tooltip
                            labelFormatter={(label) => formatTime(Number(label))}
                            formatter={(value, name) => [Number(value), name]}
                        />
                        <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8} />
                        <Area
                            type="stepAfter"
                            dataKey="sessions"
                            name="Sessions"
                            stroke="#3b82f6"
                            fill="#3b82f6"
                            fillOpacity={0.1}
                            strokeWidth={2}
                        />
                        <Area
                            type="stepAfter"
                            dataKey="ws"
                            name="WebSocket"
                            stroke="#22d3ee"
                            fill="none"
                            fillOpacity={0}
                            strokeWidth={2}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-6 mt-3 pt-3 border-t border-gray-100">
                <div className="text-center">
                    <div className="text-xs text-gray-400">Peak Sessions</div>
                    <div className="text-sm font-semibold text-gray-900">{peakSessions}</div>
                </div>
                <div className="text-center">
                    <div className="text-xs text-gray-400">Peak WS</div>
                    <div className="text-sm font-semibold text-gray-900">{peakWs}</div>
                </div>
                <div className="text-center">
                    <div className="text-xs text-gray-400">Stuck</div>
                    <div className="text-sm font-semibold text-gray-900">0</div>
                </div>
            </div>
        </div>
    );
}
