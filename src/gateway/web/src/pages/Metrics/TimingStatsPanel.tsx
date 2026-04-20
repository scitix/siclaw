import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

function readSamples(key: string): number[] {
    try { return JSON.parse(localStorage.getItem(key) ?? '[]') as number[]; } catch { return []; }
}

function computeStats(samples: number[]) {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    const pct = (p: number) => sorted[Math.min(Math.ceil(n * p) - 1, n - 1)];
    return {
        min: sorted[0],
        avg: Math.round(samples.reduce((s, v) => s + v, 0) / n),
        p95: pct(0.95),
        p99: pct(0.99),
        max: sorted[n - 1],
        count: n,
    };
}

function fmt(ms: number | undefined): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

type StatKey = 'min' | 'avg' | 'p95' | 'p99' | 'max';
const STAT_ROWS: { key: StatKey; label: string }[] = [
    { key: 'min', label: 'MIN' },
    { key: 'avg', label: 'AVG' },
    { key: 'p95', label: 'P95' },
    { key: 'p99', label: 'P99' },
    { key: 'max', label: 'MAX' },
];

const METRICS = [
    { key: 'siclaw_timing_ttft', label: 'TTFT', color: '#6366f1' },
    { key: 'siclaw_timing_llm',  label: 'Thinking', color: '#f59e0b' },
    { key: 'siclaw_timing_tool', label: 'Tool Exec', color: '#10b981' },
] as const;

export function TimingStatsPanel() {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        const handler = () => setTick(t => t + 1);
        window.addEventListener('siclaw_timing_update', handler);
        return () => window.removeEventListener('siclaw_timing_update', handler);
    }, []);

    const stats = METRICS.map(m => ({
        ...m,
        samples: tick >= 0 ? readSamples(m.key) : [],
        stat: null as ReturnType<typeof computeStats>,
    })).map(m => ({ ...m, stat: computeStats(m.samples) }));

    const totalSamples = Math.max(...stats.map(m => m.samples.length));
    const hasData = totalSamples > 0;

    const handleClear = () => {
        METRICS.forEach(m => localStorage.removeItem(m.key));
        setTick(t => t + 1);
    };

    // Bar chart data: one bar per metric, height = avg
    const barData = stats.map(m => ({
        name: m.label,
        avg: m.stat?.avg ?? 0,
        color: m.color,
    }));

    return (
        <div className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-5">
                <div>
                    <h3 className="text-sm font-semibold text-gray-900">Response Timing Statistics</h3>
                    <p className="text-xs text-gray-400 mt-0.5">
                        TTFT, thinking, and tool execution times
                        {hasData ? ` — last ${totalSamples} / 200 calls` : ''}
                    </p>
                </div>
                {hasData && (
                    <button
                        type="button"
                        onClick={handleClear}
                        className="text-xs text-gray-400 hover:text-red-500 px-2 py-1 rounded hover:bg-red-50 transition-colors"
                    >
                        Clear
                    </button>
                )}
            </div>

            {!hasData ? (
                <div className="h-40 flex items-center justify-center text-xs text-gray-400 border border-dashed border-gray-200 rounded-lg">
                    No data yet — start a conversation to collect timing samples
                </div>
            ) : (
                <div className="flex gap-8 items-start">
                    {/* Left: bar chart comparing avg of each metric */}
                    <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-400 mb-2">Average comparison</p>
                        <ResponsiveContainer width="100%" height={200}>
                            <BarChart data={barData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                                <XAxis dataKey="name" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                                <YAxis
                                    tickFormatter={(v: number) => fmt(v)}
                                    tick={{ fontSize: 10 }}
                                    width={56}
                                    axisLine={false}
                                    tickLine={false}
                                />
                                <Tooltip
                                    formatter={(v: unknown) => [fmt(v as number), 'Average']}
                                    contentStyle={{ fontSize: 12, borderRadius: 6 }}
                                    cursor={{ fill: '#f9fafb' }}
                                />
                                <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
                                    {barData.map((entry, i) => (
                                        <Cell key={i} fill={entry.color} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>

                    {/* Right: stats table */}
                    <div className="shrink-0">
                        <p className="text-xs text-gray-400 mb-2">Percentiles</p>
                        <table className="text-xs border-collapse">
                            <thead>
                                <tr>
                                    <th className="text-left pr-4 pb-2 font-medium text-gray-400 w-10"></th>
                                    {stats.map(m => (
                                        <th key={m.key} className="text-right pr-4 pb-2 font-semibold" style={{ color: m.color }}>
                                            {m.label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {STAT_ROWS.map(({ key, label }) => (
                                    <tr key={key} className="border-t border-gray-100">
                                        <td className="pr-4 py-1.5 font-medium text-gray-400">{label}</td>
                                        {stats.map(m => (
                                            <td key={m.key} className="text-right pr-4 py-1.5 font-mono text-gray-700">
                                                {fmt(m.stat?.[key])}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                                <tr className="border-t border-gray-200">
                                    <td className="pr-4 pt-2 text-gray-400">n</td>
                                    {stats.map(m => (
                                        <td key={m.key} className="text-right pr-4 pt-2 font-mono text-gray-400">
                                            {m.stat?.count ?? 0}
                                        </td>
                                    ))}
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}
