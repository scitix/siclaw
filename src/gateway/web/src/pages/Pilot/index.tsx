import { SessionList } from './components/SessionList';
import { PilotArea } from './components/PilotArea';
import { SkillPanel } from './components/SkillPanel';
import { SchedulePanel } from './components/SchedulePanel';
import { History, X, Plus } from 'lucide-react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { usePilot, type PilotMessage } from '@/hooks/usePilot';


export function PilotPage() {
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [panelMessage, setPanelMessage] = useState<PilotMessage | null>(null);
    const navigate = useNavigate();
    const pilot = usePilot();

    // Track which tool content we've already auto-opened the panel for
    // Uses content hash instead of message ID (IDs change when DB ID replaces temp ID)
    const autoOpenedRef = useRef<Set<string>>(new Set());

    const handleSkillSaved = useCallback(() => {
        pilot.clearEditSkill();
        pilot.loadSkills();
    }, [pilot]);

    const handlePanelSave = useCallback(async (msg: PilotMessage) => {
        if (msg.toolName === 'create_skill' || msg.toolName === 'update_skill') {
            await pilot.loadSkills();
        }
        setPanelMessage(null);
    }, [pilot]);

    const handlePanelDismiss = useCallback((_msg: PilotMessage) => {
        setPanelMessage(null);
    }, []);

    const handleOpenSkillPanel = useCallback((msg: PilotMessage) => {
        setPanelMessage(msg);
    }, []);

    // Keep panelMessage in sync with pilot.messages (temp ID → DB ID transition only).
    // Only sync when panelMessage still has a temporary ID (tool-xxx / msg-xxx).
    // Once it has a stable DB UUID, stop syncing to avoid matching wrong messages
    // (e.g. an older saved message with the same content).
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

    // Auto-open panel when new skill tool messages arrive (non-streaming).
    // Only auto-open for messages from the LIVE session (no isoTimestamp).
    // History-loaded messages have isoTimestamp — users can click "View" on the in-chat card instead.
    // Note: manage_schedule is NOT auto-opened — schedules are auto-executed by the bot.
    useEffect(() => {
        const msgs = pilot.messages;
        if (msgs.length === 0) return;

        for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            if (msg.role !== 'tool' || msg.isStreaming || !msg.content) continue;

            // Skip messages loaded from history (they have isoTimestamp set by mapMessages)
            if (msg.isoTimestamp) continue;

            if (msg.toolName !== 'create_skill' && msg.toolName !== 'update_skill') continue;

            // Use content as dedup key (stable across ID changes)
            const contentKey = `${msg.toolName}:${msg.content.slice(0, 200)}`;
            if (autoOpenedRef.current.has(contentKey)) continue;

            // Validate content
            try {
                const parsed = JSON.parse(msg.content);
                if (!parsed?.skill) continue;
            } catch { continue; }

            // Don't auto-open if already saved/dismissed
            const meta = msg.metadata as Record<string, unknown> | undefined;
            if (meta?.skillCard === 'saved' || meta?.skillCard === 'dismissed') continue;

            autoOpenedRef.current.add(contentKey);
            setPanelMessage(msg);
            break;
        }
    }, [pilot.messages]);

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
                        skills={pilot.skills}
                        editingSkill={pilot.editingSkill}
                        onEditSkill={pilot.startEditSkill}
                        onClearEditSkill={pilot.clearEditSkill}
                        onSkillSaved={handleSkillSaved}
                        onOpenSkillPanel={handleOpenSkillPanel}
                        onOpenSchedulePanel={handleOpenSkillPanel}
                        panelMessage={panelMessage}
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
                    />
                </div>
            </div>

            {/* 3. Panel (Right Side) — Skill or Schedule */}
            {panelMessage && (() => {
                if (panelMessage.toolName === 'create_skill' || panelMessage.toolName === 'update_skill') {
                    return (
                        <SkillPanel
                            message={panelMessage}
                            sendRpc={pilot.sendRpc}
                            skills={pilot.skills}
                            onSave={handlePanelSave}
                            onDismiss={handlePanelDismiss}
                            onClose={() => setPanelMessage(null)}
                            updateMessageMeta={pilot.updateMessageMeta}
                        />
                    );
                }
                if (panelMessage.toolName === 'manage_schedule') {
                    return (
                        <SchedulePanel
                            message={panelMessage}
                            sendRpc={pilot.sendRpc}
                            onSave={handlePanelSave}
                            onDismiss={handlePanelDismiss}
                            onClose={() => setPanelMessage(null)}
                            updateMessageMeta={pilot.updateMessageMeta}
                            selectedEnvId={undefined}
                        />
                    );
                }
                return null;
            })()}
        </div>
    );
}
