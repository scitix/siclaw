import { MessageCircle, Terminal, Hash, MessageSquare, Phone } from 'lucide-react';

export type ChannelType = 'lark' | 'telegram' | 'slack' | 'discord' | 'whatsapp';

export interface BaseConfig {
    enabled: boolean;
}

export interface LarkConfig extends BaseConfig {
    appId: string;
    appSecret: string;
}

export interface TelegramConfig extends BaseConfig {
    botToken: string;
}

export interface SlackConfig extends BaseConfig {
    botToken: string;
    appToken: string;
}

export interface DiscordConfig extends BaseConfig {
    token: string;
}

export interface WhatsAppConfig extends BaseConfig {
    accessToken: string;
    phoneNumberId: string;
}

export type ChannelConfig = LarkConfig | TelegramConfig | SlackConfig | DiscordConfig | WhatsAppConfig;

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
        id: 'lark',
        name: 'Lark',
        description: 'Enterprise bot for Lark with interactive cards and approval flows.',
        icon: MessageCircle,
    },
    {
        id: 'telegram',
        name: 'Telegram',
        description: 'Bot integration for Telegram groups and direct messages.',
        icon: MessageSquare,
        comingSoon: true,
    },
    {
        id: 'slack',
        name: 'Slack',
        description: 'Slack workspace bot with rich message formatting and threads.',
        icon: Hash,
        comingSoon: true,
    },
    {
        id: 'discord',
        name: 'Discord',
        description: 'Discord server bot with slash commands and channel messaging.',
        icon: Terminal,
        comingSoon: true,
    },
    {
        id: 'whatsapp',
        name: 'WhatsApp',
        description: 'WhatsApp Business API integration for customer messaging.',
        icon: Phone,
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
