import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

export interface Workspace {
    id: string;
    userId: string;
    name: string;
    isDefault: boolean;
    envType?: string;
    configJson: {
        defaultModel?: { provider: string; modelId: string };
        systemPrompt?: string;
        icon?: string;
        color?: string;
        skillComposer?: {
            globalSkillRefs?: string[];
            personalSkillIds?: string[];
            skillSpaces?: Array<{
                skillSpaceId: string;
                disabledSkillIds?: string[];
            }>;
        };
    } | null;
    createdAt: string;
    updatedAt: string;
}

interface WorkspaceContextValue {
    workspaces: Workspace[];
    currentWorkspace: Workspace | null;
    setCurrentWorkspace: (ws: Workspace) => void;
    reload: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const WORKSPACE_STORAGE_KEY = 'siclaw_workspace_id';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const { sendRpc, isConnected } = useWebSocket();
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [currentWorkspace, setCurrentWorkspaceState] = useState<Workspace | null>(null);
    const hasLoadedRef = useRef(false);

    const reload = useCallback(async () => {
        if (!isConnected) return;
        try {
            const result = await sendRpc<{ workspaces: Workspace[] }>('workspace.list');
            const list = result.workspaces ?? [];
            setWorkspaces(list);

            // Restore from localStorage or default
            const storedId = localStorage.getItem(WORKSPACE_STORAGE_KEY);
            const match = storedId ? list.find(w => w.id === storedId) : null;
            const defaultWs = list.find(w => w.isDefault) ?? list[0] ?? null;
            setCurrentWorkspaceState(match ?? defaultWs);
        } catch (err) {
            console.error('Failed to load workspaces:', err);
        }
    }, [isConnected, sendRpc]);

    const setCurrentWorkspace = useCallback((ws: Workspace) => {
        setCurrentWorkspaceState(ws);
        localStorage.setItem(WORKSPACE_STORAGE_KEY, ws.id);
    }, []);

    useEffect(() => {
        if (isConnected && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            reload();
        }
    }, [isConnected, reload]);

    return (
        <WorkspaceContext.Provider value={{ workspaces, currentWorkspace, setCurrentWorkspace, reload }}>
            {children}
        </WorkspaceContext.Provider>
    );
}

export function useWorkspace(): WorkspaceContextValue {
    const ctx = useContext(WorkspaceContext);
    if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider');
    return ctx;
}
