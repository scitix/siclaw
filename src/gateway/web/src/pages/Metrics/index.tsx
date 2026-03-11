import { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useMetrics, type TimeRange } from './hooks/useMetrics';
import { DashboardTab } from './DashboardTab';
import { AuditTab } from './AuditTab';
import { GrafanaTab } from './GrafanaTab';

type Tab = 'dashboard' | 'audit' | 'grafana';

export function MetricsPage() {
    const [tab, setTab] = useState<Tab>('dashboard');
    const [range, setRange] = useState<TimeRange>('1h');
    const [grafanaUrl, setGrafanaUrl] = useState<string | null>(null);
    const { sendRpc, isConnected } = useWebSocket();
    const { data, loading, refresh } = useMetrics(range);

    // Load grafanaUrl from system config
    useEffect(() => {
        if (!isConnected) return;
        sendRpc<{ config: Record<string, string> }>('system.getConfig')
            .then((result) => {
                setGrafanaUrl(result.config?.['system.grafanaUrl'] || null);
            })
            .catch(() => {});
    }, [sendRpc, isConnected]);

    const [spinning, setSpinning] = useState(false);

    const handleRefresh = useCallback(() => {
        setSpinning(true);
        refresh();
        setTimeout(() => setSpinning(false), 600);
    }, [refresh]);

    const ranges: TimeRange[] = ['1h', '6h', '24h'];

    return (
        <div className="flex-1 flex flex-col overflow-hidden bg-white">
            {/* Header */}
            <div className="h-14 flex items-center justify-between px-6 border-b border-gray-200 shrink-0">
                <div className="flex items-center gap-4">
                    <h1 className="text-lg font-semibold text-gray-900">Metrics</h1>
                    <div className="flex gap-4 ml-4">
                        <button
                            onClick={() => setTab('dashboard')}
                            className={cn(
                                'pb-[13px] pt-[14px] text-sm px-1 transition border-b-2',
                                tab === 'dashboard'
                                    ? 'border-primary-600 text-primary-600 font-semibold'
                                    : 'border-transparent text-gray-500 hover:text-gray-700',
                            )}
                        >
                            Dashboard
                        </button>
                        <button
                            onClick={() => setTab('audit')}
                            className={cn(
                                'pb-[13px] pt-[14px] text-sm px-1 transition border-b-2',
                                tab === 'audit'
                                    ? 'border-primary-600 text-primary-600 font-semibold'
                                    : 'border-transparent text-gray-500 hover:text-gray-700',
                            )}
                        >
                            Audit
                        </button>
                        {grafanaUrl && (
                            <button
                                onClick={() => setTab('grafana')}
                                className={cn(
                                    'pb-[13px] pt-[14px] text-sm px-1 transition border-b-2',
                                    tab === 'grafana'
                                        ? 'border-primary-600 text-primary-600 font-semibold'
                                        : 'border-transparent text-gray-500 hover:text-gray-700',
                                )}
                            >
                                Grafana
                            </button>
                        )}
                    </div>
                </div>
                {tab === 'dashboard' && (
                    <div className="flex items-center gap-2">
                        <div className="flex rounded-lg overflow-hidden border border-gray-200">
                            {ranges.map((r) => (
                                <button
                                    key={r}
                                    onClick={() => setRange(r)}
                                    className={cn(
                                        'px-3 py-1.5 text-xs font-medium transition',
                                        range === r
                                            ? 'bg-primary-600 text-white'
                                            : 'bg-gray-50 text-gray-600 hover:bg-gray-200',
                                    )}
                                >
                                    {r}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={handleRefresh}
                            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition"
                        >
                            <RefreshCw className={cn("w-4 h-4 transition-transform duration-500", spinning && "animate-spin")} />
                        </button>
                    </div>
                )}
            </div>

            {/* Content */}
            {tab === 'dashboard' ? (
                <DashboardTab data={data} range={range} loading={loading} />
            ) : tab === 'audit' ? (
                <AuditTab />
            ) : (
                <GrafanaTab grafanaUrl={grafanaUrl} />
            )}
        </div>
    );
}
