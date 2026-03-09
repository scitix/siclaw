import type { TimeseriesResponse, TimeRange } from './hooks/useMetrics';
import { KpiCards } from './KpiCards';
import { TokenChart } from './TokenChart';
import { LatencyChart } from './LatencyChart';
import { SessionsChart } from './SessionsChart';
import { ToolCallsPanel } from './ToolCallsPanel';
import { CumulativePanel } from './CumulativePanel';

interface DashboardTabProps {
    data: TimeseriesResponse | null;
    range: TimeRange;
    loading: boolean;
}

export function DashboardTab({ data, range, loading }: DashboardTabProps) {
    if (loading && !data) {
        return (
            <div className="flex-1 flex items-center justify-center text-gray-400">
                <div className="text-sm">Loading metrics...</div>
            </div>
        );
    }

    const buckets = data?.buckets ?? [];
    const snapshot = data?.snapshot ?? { activeSessions: 0, wsConnections: 0 };
    const topTools = data?.topTools ?? [];

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="px-6 py-6 max-w-[1400px] mx-auto w-full space-y-6">
                {/* Row 1: KPI Cards */}
                <KpiCards buckets={buckets} snapshot={snapshot} range={range} />

                {/* Row 2: Token Usage + Prompt Latency */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <TokenChart buckets={buckets} />
                    <LatencyChart buckets={buckets} />
                </div>

                {/* Row 3: Sessions & Connections + Tool Calls Top 10 */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <SessionsChart buckets={buckets} />
                    <ToolCallsPanel topTools={topTools} />
                </div>

                {/* Row 4: Cumulative Statistics (full width) */}
                <CumulativePanel />
            </div>
        </div>
    );
}
