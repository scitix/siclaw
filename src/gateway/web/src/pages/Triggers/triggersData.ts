import { Zap, Wifi, Activity, Server, Database, Cloud, Box, Terminal, Cpu, Globe, MessageSquare, Bell } from 'lucide-react';

export type TriggerType = 'webhook' | 'websocket';

export const ICON_OPTIONS = [
    { id: 'zap', icon: Zap, label: 'Zap' },
    { id: 'wifi', icon: Wifi, label: 'WiFi' },
    { id: 'activity', icon: Activity, label: 'Activity' },
    { id: 'server', icon: Server, label: 'Server' },
    { id: 'database', icon: Database, label: 'Database' },
    { id: 'cloud', icon: Cloud, label: 'Cloud' },
    { id: 'box', icon: Box, label: 'Box' },
    { id: 'terminal', icon: Terminal, label: 'Terminal' },
    { id: 'cpu', icon: Cpu, label: 'CPU' },
    { id: 'globe', icon: Globe, label: 'Globe' },
    { id: 'message', icon: MessageSquare, label: 'Message' },
    { id: 'bell', icon: Bell, label: 'Bell' },
];

export const getIconComponent = (id: string) => {
    return ICON_OPTIONS.find(opt => opt.id === id)?.icon || Zap;
};

export interface TriggerEndpoint {
    id: string;
    name: string;
    description: string;
    type: TriggerType;
    status: 'active' | 'inactive';
    endpointUrl: string;
    secret?: string;
    createdAt: string;
    lastActive?: string;
    icon: string;
}
