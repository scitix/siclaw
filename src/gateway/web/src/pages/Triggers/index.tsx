import { Plus, ArrowRight, Play, Pause, Search, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useEffect, useRef } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useTriggers } from '@/hooks/useTriggers';
import { TriggerEndpoint, getIconComponent } from './triggersData';
import { TriggerDrawer } from './components/TriggerDrawer';
import { Tooltip } from '../../components/Tooltip';

export function TriggersPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { triggers, loading, loadTriggers, saveTrigger, deleteTrigger } = useTriggers(sendRpc);
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [selectedTrigger, setSelectedTrigger] = useState<TriggerEndpoint | null>(null);

    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (isConnected && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadTriggers();
        }
    }, [isConnected, loadTriggers]);

    const handleCreate = () => {
        setSelectedTrigger(null);
        setIsDrawerOpen(true);
    };

    const handleEdit = (trigger: TriggerEndpoint) => {
        setSelectedTrigger(trigger);
        setIsDrawerOpen(true);
    };

    const handleSave = async (updated: Partial<TriggerEndpoint>) => {
        await saveTrigger(updated);
        setIsDrawerOpen(false);
    };

    const handleToggleStatus = async (e: React.MouseEvent, trigger: TriggerEndpoint) => {
        e.stopPropagation();
        const newStatus = trigger.status === 'active' ? 'inactive' : 'active';
        await saveTrigger({ ...trigger, status: newStatus });
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        await deleteTrigger(id);
    };

    return (
        <div className="h-full bg-white flex flex-col">
            {/* Header */}
            <header className="h-16 flex items-center justify-end px-6 bg-white sticky top-0 z-10">
                <div className="flex items-center gap-2">
                    <div className="relative group">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-primary-500 transition-colors" />
                        <input
                            type="text"
                            placeholder="Search endpoints..."
                            className="pl-9 pr-3 py-1.5 bg-gray-50 border-none rounded-md text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-200 w-48 transition-all"
                        />
                    </div>
                    <Tooltip content="New Endpoint">
                        <button
                            onClick={handleCreate}
                            className="p-2 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-all"
                        >
                            <Plus className="w-5 h-5" />
                        </button>
                    </Tooltip>
                </div>
            </header>

            {/* Content using Grid Layout for Cards (Modern) */}
            <div className="flex-1 overflow-y-auto p-8 bg-white">
                {loading ? (
                    <div className="flex items-center justify-center h-40 text-gray-400 text-sm">Loading...</div>
                ) : (
                <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {triggers.map((trigger) => (
                        <div
                            key={trigger.id}
                            onClick={() => handleEdit(trigger)}
                            className="group bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md hover:border-primary-200 transition-all cursor-pointer relative overflow-hidden"
                        >
                            <div className="flex justify-between items-start mb-4">
                                <div className={cn(
                                    "w-8 h-8 flex items-center justify-center rounded-lg border",
                                    trigger.type === 'webhook'
                                        ? "bg-purple-50 border-purple-100 text-purple-600"
                                        : "bg-emerald-50 border-emerald-100 text-emerald-600"
                                )}>
                                    {(() => {
                                        const IconComponent = getIconComponent(trigger.icon);
                                        return <IconComponent className="w-4 h-4" />;
                                    })()}
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={(e) => handleToggleStatus(e, trigger)}
                                        className={cn(
                                            "p-2 rounded-lg transition-colors border",
                                            trigger.status === 'active'
                                                ? "bg-white border-gray-200 text-gray-400 hover:text-orange-500 hover:border-orange-200"
                                                : "bg-green-50 border-green-200 text-green-600"
                                        )}
                                        title={trigger.status === 'active' ? "Deactivate Endpoint" : "Activate Endpoint"}
                                    >
                                        {trigger.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                                    </button>
                                    <button
                                        onClick={(e) => handleDelete(e, trigger.id)}
                                        className="p-2 rounded-lg transition-colors border bg-white border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-200"
                                        title="Delete Endpoint"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            <h3 className="font-bold text-gray-900 mb-1 group-hover:text-primary-600 transition-colors flex items-center gap-2">
                                {trigger.name}
                                <ArrowRight className="w-3 h-3 opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all text-primary-400" />
                            </h3>
                            <p className="text-sm text-gray-500 mb-4 line-clamp-2 min-h-[40px]">
                                {trigger.description || 'No description provided.'}
                            </p>

                            <div className="flex items-center justify-between pt-4 border-t border-gray-50 text-xs text-gray-400">
                                <span className="font-mono bg-gray-50 px-1.5 py-0.5 rounded text-gray-500">
                                    ID: {trigger.id.split('_')[1] || trigger.id}
                                </span>
                                <div>
                                    Last active: <span className="text-gray-600 font-medium">{trigger.lastActive || 'Never'}</span>
                                </div>
                            </div>
                        </div>
                    ))}

                    {/* Empty State / Add New Card */}
                    <button
                        onClick={handleCreate}
                        className="flex flex-col items-center justify-center p-6 rounded-xl border-2 border-dashed border-gray-200 text-gray-400 hover:border-primary-300 hover:text-primary-600 hover:bg-primary-50/50 transition-all gap-3 min-h-[200px]"
                    >
                        <div className="w-12 h-12 rounded-full bg-gray-50 flex items-center justify-center group-hover:bg-white transition-colors">
                            <Plus className="w-6 h-6" />
                        </div>
                        <span className="font-medium">Create New Endpoint</span>
                    </button>
                </div>
                )}
            </div>

            <TriggerDrawer
                isOpen={isDrawerOpen}
                onClose={() => setIsDrawerOpen(false)}
                trigger={selectedTrigger}
                onSave={handleSave}
            />
        </div>
    );
}
