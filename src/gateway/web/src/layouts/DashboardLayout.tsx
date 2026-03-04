import { Outlet } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import { Sidebar } from '../components/ui/Sidebar';
import { useWebSocket } from '../hooks/useWebSocket';
import { initializeProfile } from '../pages/Settings/userData';
import { WebSocketProvider } from '../contexts/WebSocketContext';
import { WorkspaceProvider } from '../contexts/WorkspaceContext';

function DashboardContent() {
    const { sendRpc, isConnected } = useWebSocket();

    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (isConnected && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            initializeProfile(sendRpc);
        }
    }, [isConnected, sendRpc]);

    return (
        <div className="flex h-screen bg-white overflow-hidden">
            <Sidebar />
            <main className="flex-1 flex flex-col relative overflow-hidden bg-white">
                <Outlet />
            </main>
        </div>
    );
}

export function DashboardLayout() {
    return (
        <WebSocketProvider>
            <WorkspaceProvider>
                <DashboardContent />
            </WorkspaceProvider>
        </WebSocketProvider>
    );
}
