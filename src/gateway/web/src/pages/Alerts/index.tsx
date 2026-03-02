import { Plus, AlertTriangle, Zap, MoreVertical } from 'lucide-react';
import { cn } from '@/lib/utils';


const rules = [
    {
        id: 1,
        name: 'Pod Crash Loop',
        description: 'Trigger when any pod restarts > 5 times in 10 minutes',
        severity: 'critical',
        enabled: true,
        lastTriggered: '2 mins ago',
        scope: 'All Clusters'
    },
    {
        id: 2,
        name: 'High Latency API',
        description: 'P99 latency > 500ms for /api/v1/* endpoints',
        severity: 'warning',
        enabled: true,
        lastTriggered: '1 hour ago',
        scope: 'Production'
    },
    {
        id: 3,
        name: 'Node Disk Pressure',
        description: 'Node disk usage exceeds 85%',
        severity: 'info',
        enabled: false,
        lastTriggered: '2 days ago',
        scope: 'All Clusters'
    }
];

export function AlertsPage() {


    return (
        <div className="h-full bg-white flex flex-col">
            {/* Header */}
            <header className="h-16 flex items-center justify-end px-6 bg-white sticky top-0 z-10">

                <div className="flex items-center gap-2">
                    <button className="p-2 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-all" title="Add Rule">
                        <Plus className="w-5 h-5" />
                    </button>
                </div>
            </header>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-6xl mx-auto">
                    {/* Table Container */}
                    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                        {/* Table Header */}
                        <div className="grid grid-cols-12 gap-4 px-6 py-3 bg-gray-50/50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                            <div className="col-span-4">Rule Name</div>
                            <div className="col-span-2">Severity</div>
                            <div className="col-span-2">Scope</div>
                            <div className="col-span-2">Last Fired</div>
                            <div className="col-span-2 text-right">Status</div>
                        </div>

                        {/* Table Body */}
                        <div className="divide-y divide-gray-100">
                            {rules.map((rule) => (
                                <div key={rule.id} className="grid grid-cols-12 gap-4 px-6 py-4 items-center hover:bg-gray-50/50 transition-colors">
                                    <div className="col-span-4 pr-4">
                                        <div className="font-bold text-sm text-gray-900">{rule.name}</div>
                                        <div className="text-xs text-gray-500 mt-0.5 truncate">{rule.description}</div>
                                    </div>

                                    <div className="col-span-2">
                                        <SeverityBadge severity={rule.severity} />
                                    </div>

                                    <div className="col-span-2">
                                        <div className="text-sm text-gray-600">{rule.scope}</div>
                                    </div>

                                    <div className="col-span-2">
                                        <span className="text-sm font-mono text-gray-500">{rule.lastTriggered}</span>
                                    </div>

                                    <div className="col-span-2 flex items-center justify-end gap-4">
                                        <div className={cn(
                                            "w-9 h-5 rounded-full relative cursor-pointer transition-colors",
                                            rule.enabled ? "bg-primary-600" : "bg-gray-200"
                                        )}>
                                            <div className={cn(
                                                "absolute top-1 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-200",
                                                rule.enabled ? "left-5" : "left-1"
                                            )} />
                                        </div>
                                        <button className="text-gray-400 hover:text-gray-600">
                                            <MoreVertical className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Table Footer */}
                        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50/50 flex items-center justify-between text-xs text-gray-500">
                            <span>Showing 3 rules</span>
                            <div className="flex gap-2">
                                <button className="hover:text-gray-900">1</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function SeverityBadge({ severity }: { severity: string }) {
    if (severity === 'critical') {
        return (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-100">
                <AlertTriangle className="w-3 h-3" />
                Critical
            </span>
        );
    }
    if (severity === 'warning') {
        return (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-100">
                <AlertTriangle className="w-3 h-3" />
                Warning
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100">
            <Zap className="w-3 h-3" />
            Info
        </span>
    );
}
