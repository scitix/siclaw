import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import { DashboardLayout } from './layouts/DashboardLayout';
import { ProtectedRoute } from './components/ProtectedRoute';

import { LoginPage } from './pages/Login';
import { SsoCallback } from './pages/Login/SsoCallback';
import { PilotPage } from './pages/Pilot';
import { SkillsPage } from './pages/Skills';
import { SkillEditor } from './pages/Skills/SkillEditor';
import { JoinSkillSetPage } from './pages/Skills/JoinSkillSetPage';
import { ChannelsPage } from './pages/Channels';
import { TriggersPage } from './pages/Triggers';
import { CronPage } from './pages/Cron';
import { SettingsPage } from './pages/Settings';
import { SettingsLayout } from './pages/Settings/SettingsLayout';
import { SystemSettings } from './pages/Settings/SystemSettings';
import { PermissionsPage } from './pages/Permissions';
import { ModelsPage } from './pages/Models';
// import { BrainsPage } from './pages/Brains';  // hidden until claude-sdk brain is polished
import { WorkspacesPage } from './pages/Workspaces';
import { McpServersPage } from './pages/McpServers';
import { KnowledgePage } from './pages/Knowledge';
import { CredentialsPage } from './pages/Environments';
import { MetricsPage } from './pages/Metrics';

function ComingSoonPage({ title }: { title: string }) {
    return (
        <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
                <div className="text-lg font-medium text-gray-500 mb-1">{title}</div>
                <div className="text-sm">Coming soon</div>
            </div>
        </div>
    );
}

const router = createBrowserRouter([
    // Public routes
    { path: '/login', element: <LoginPage /> },
    { path: '/login/sso-callback', element: <SsoCallback /> },

    // Protected routes
    {
        element: <ProtectedRoute />,
        children: [
            {
                path: '/',
                element: <DashboardLayout />,
                children: [
                    { index: true, element: <Navigate to="/pilot" replace /> },
                    { path: 'pilot', element: <PilotPage /> },
                    {
                        path: 'skills',
                        children: [
                            { index: true, element: <SkillsPage /> },
                            { path: 'sets/join/:token', element: <JoinSkillSetPage /> },
                            { path: ':id', element: <SkillEditor /> },
                        ],
                    },
                    { path: 'channels', element: <ChannelsPage /> },
                    { path: 'triggers', element: <TriggersPage /> },
                    { path: 'cron', element: <CronPage /> },
                    { path: 'permissions', element: <PermissionsPage /> },
                    {
                        path: 'settings',
                        element: <SettingsLayout />,
                        children: [
                            { index: true, element: <SettingsPage /> },
                            { path: 'system', element: <SystemSettings /> },
                        ],
                    },
                    { path: 'credentials', element: <CredentialsPage /> },
                    { path: 'sessions', element: <ComingSoonPage title="Sessions" /> },
                    { path: 'workspace', element: <WorkspacesPage /> },
                    { path: 'mcp', element: <McpServersPage /> },
                    { path: 'knowledge', element: <KnowledgePage /> },
                    { path: 'environments', element: <Navigate to="/credentials" replace /> },
                    // { path: 'brains', element: <BrainsPage /> },  // hidden until claude-sdk brain is polished
                    { path: 'models', element: <ModelsPage /> },
                    { path: 'monitoring', element: <MetricsPage /> },
                ],
            },
        ],
    },

    // Catch-all
    { path: '*', element: <Navigate to="/login" replace /> },
]);

function App() {
    return <RouterProvider router={router} />;
}

export default App;
