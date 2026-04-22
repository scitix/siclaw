import { SessionList } from './components/SessionList';
import { PilotArea } from './components/PilotArea';
import { SchedulePanel } from './components/SchedulePanel';
import { SkillPanel } from './components/SkillPanel';
import { History, X, Plus } from 'lucide-react';
import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { usePilot, type PilotMessage } from '@/hooks/usePilot';
import { usePermissions } from '@/hooks/usePermissions';
import { useWorkspace } from '@/contexts/WorkspaceContext';


export function PilotPage() {
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [panelMessage, setPanelMessage] = useState<PilotMessage | null>(null);
    const navigate = useNavigate();
    const location = useLocation();
    const pilot = usePilot();
    const { isAdmin } = usePermissions(pilot.sendRpc, pilot.isConnected);
    const { currentWorkspace } = useWorkspace();

    // Refresh system status on every navigation to this page (e.g. after adding credentials)
    useEffect(() => {
        pilot.loadSystemStatus();
    }, [location]);

    const handlePanelSave = useCallback(async (_msg: PilotMessage) => {
        setPanelMessage(null);
    }, []);

    const handlePanelDismiss = useCallback((_msg: PilotMessage) => {
        setPanelMessage(null);
    }, []);

    const handleOpenSchedulePanel = useCallback((msg: PilotMessage) => {
        setPanelMessage(msg);
    }, []);

    const handleOpenSkillPanel = useCallback((msg: PilotMessage) => {
        setPanelMessage(msg);
    }, []);

    // Keep panelMessage in sync with pilot.messages (temp ID → DB ID transition only).
    useEffect(() => {
        if (!panelMessage) return;
        const id = panelMessage.id;
        if (!id.startsWith('tool-') && !id.startsWith('msg-')) return;
        const current = pilot.messages.find(m =>
            m.content === panelMessage.content && m.toolName === panelMessage.toolName
        );
        if (current && current.id !== panelMessage.id) {
            setPanelMessage(current);
        }
    }, [pilot.messages, panelMessage]);

    return (
        <div className="flex h-full relative bg-white overflow-hidden font-sans">
            {/* 1. History Drawer (Left Slide-in) */}
            <AnimatePresence>
                {isDrawerOpen && (
                    <>
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setIsDrawerOpen(false)}
                            className="absolute inset-0 bg-stone-200/40 backdrop-blur-[2px] z-40 transition-all"
                        />

                        <motion.div
                            initial={{ x: -320 }}
                            animate={{ x: 0 }}
                            exit={{ x: -320 }}
                            transition={{ type: "spring", stiffness: 350, damping: 35 }}
                            className="absolute top-0 bottom-0 left-0 w-[300px] bg-[#F7F6F3] border-r border-[#E5E5E5] z-50 shadow-2xl flex flex-col"
                        >
                            <div className="flex items-center justify-between px-5 py-4 border-b border-[#E5E5E5]">
                                <span className="text-sm font-medium text-[#444]">Recent Sessions</span>
                                <button onClick={() => setIsDrawerOpen(false)} className="text-[#999] hover:text-[#333]">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            <div className="flex-1 overflow-hidden">
                                <SessionList
                                    sessions={pilot.sessions}
                                    currentSessionKey={pilot.currentSessionKey}
                                    onSelectSession={(key) => {
                                        pilot.loadHistory(key);
                                        setIsDrawerOpen(false);
                                    }}
                                    onNewSession={() => {
                                        pilot.createSession();
                                        setIsDrawerOpen(false);
                                    }}
                                    onDeleteSession={pilot.deleteSession}
                                    onClearMemory={async () => {
                                        if (!currentWorkspace) return;
                                        await pilot.sendRpc('workspace.clearMemory', { workspaceId: currentWorkspace.id });
                                    }}
                                />
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>

            {/* 2. Main Stage */}
            <div className="flex-1 relative flex flex-col bg-white min-w-0">

                {/* Minimal Header */}
                <header className="absolute top-0 left-0 right-0 h-16 flex items-center justify-between px-4 z-30">
                    {/* Left: History Trigger */}
                    <div className="flex items-center">
                        {!isDrawerOpen && (
                            <button
                                onClick={() => setIsDrawerOpen(true)}
                                className="p-2 rounded-lg text-gray-400 hover:text-gray-800 hover:bg-gray-100 transition-all"
                                title="View History"
                            >
                                <History className="w-5 h-5" />
                            </button>
                        )}
                    </div>

                    {/* Right: New Session (Primary Action) */}
                    <div className="flex items-center">
                        <button
                            onClick={() => pilot.createSession()}
                            className="p-2 rounded-lg text-gray-400 hover:text-gray-800 hover:bg-gray-100 transition-all"
                            title="New Session"
                        >
                            <Plus className="w-5 h-5" />
                        </button>
                    </div>
                </header>

                {/* Pilot Content */}
                <div className="flex-1 pt-16 flex flex-col min-h-0">
                    <PilotArea
                        messages={pilot.messages}
                        isLoading={pilot.isLoading}
                        isLoadingHistory={pilot.isLoadingHistory}
                        wsStatus={pilot.wsStatus}
                        isConnected={pilot.isConnected}
                        hasMore={pilot.hasMore}
                        isLoadingMore={pilot.isLoadingMore}
                        sendMessage={pilot.sendMessage}
                        abortResponse={pilot.abortResponse}
                        loadMoreHistory={pilot.loadMoreHistory}
                        sendRpc={pilot.sendRpc}
                        contextUsage={pilot.contextUsage}
                        isCompacting={pilot.isCompacting}
                        isRetrying={pilot.isRetrying}
                        onOpenSchedulePanel={handleOpenSchedulePanel}
                        onOpenSkillPanel={handleOpenSkillPanel}
                        selectedWorkspaceId={currentWorkspace?.id ?? null}
                        updateMessageMeta={pilot.updateMessageMeta}
                        pendingMessages={pilot.pendingMessages}
                        onRemovePending={pilot.removePendingMessage}
                        investigationProgress={pilot.investigationProgress}
                        dpActive={pilot.dpActive}
                        onSetDpActive={pilot.setDpActive}
                        dpFocus={pilot.dpFocus}
                        dpChecklist={pilot.dpChecklist}
                        onHypothesesConfirmed={pilot.confirmHypotheses}
                        onExitDp={pilot.exitDpMode}
                        systemStatus={pilot.systemStatus}
                        onNavigateModels={() => navigate('/models')}
                        onNavigateCredentials={() => navigate('/credentials')}
                        sessionKey={pilot.currentSessionKey}
                        isAdmin={isAdmin}
                        loadingStartedAt={pilot.loadingStartedAt}
                    />
                </div>
            </div>

            {/* 3. Panel (Right Side) — Schedule / Skill Preview */}
            {panelMessage && panelMessage.toolName === 'manage_schedule' && (
                <SchedulePanel
                    message={panelMessage}
                    sendRpc={pilot.sendRpc}
                    onSave={handlePanelSave}
                    onDismiss={handlePanelDismiss}
                    onClose={() => setPanelMessage(null)}
                    updateMessageMeta={pilot.updateMessageMeta}
                    selectedWorkspaceId={currentWorkspace?.id ?? null}
                />
            )}
            {panelMessage && panelMessage.toolName === 'skill_preview' && (
                <SkillPanel
                    message={panelMessage}
                    onClose={() => setPanelMessage(null)}
                />
            )}
        </div>
    );
}
