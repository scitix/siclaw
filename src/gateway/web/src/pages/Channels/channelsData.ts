import { MessageCircle, Terminal } from 'lucide-react';

export type ChannelType = 'feishu' | 'dingtalk';

export interface BaseConfig {
    enabled: boolean;
}

export interface FeishuConfig extends BaseConfig {
    domain: 'feishu' | 'lark';
    appId: string;
    appSecret: string;
}

export interface DingTalkConfig extends BaseConfig {
    clientId: string;
    clientSecret: string;
}

export type ChannelConfig = FeishuConfig | DingTalkConfig;

export interface ChannelView {
    id: ChannelType;
    enabled: boolean;
    config: Record<string, unknown>;
    status: 'connected' | 'disconnected' | 'error';
    error?: string;
}

export interface Channel {
    id: ChannelType;
    name: string;
    description: string;
    icon: any;
    comingSoon?: boolean;
    status: 'connected' | 'disconnected' | 'error';
    error?: string;
    config: Record<string, unknown>;
    enabled: boolean;
}

/** Static channel metadata (icon, name, description) */
export const CHANNEL_META: Omit<Channel, 'status' | 'config' | 'enabled' | 'error'>[] = [
    {
        id: 'feishu',
        name: 'Feishu / Lark',
        description: 'Enterprise bot for Feishu with interactive cards and approval flows.',
        icon: MessageCircle,
    },
    {
        id: 'dingtalk',
        name: 'DingTalk',
        description: 'Push notifications and basic command support for DingTalk groups.',
        icon: Terminal,
        comingSoon: true,
    },
];

/** Merge backend ChannelView data with static metadata */
export function mergeChannels(views: ChannelView[]): Channel[] {
    return CHANNEL_META.map((meta) => {
        const view = views.find((v) => v.id === meta.id);
        return {
            ...meta,
            status: view?.status ?? 'disconnected',
            error: view?.error,
            config: view?.config ?? {},
            enabled: view?.enabled ?? false,
        };
    });
}
