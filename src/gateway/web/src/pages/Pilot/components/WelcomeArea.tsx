import { BookOpen, SearchCode, Cpu, Timer, CheckCircle2, Circle, ArrowRight, KeyRound } from 'lucide-react';
import type { SystemStatus } from '@/hooks/usePilot';

export interface WelcomeAreaProps {
    systemStatus: SystemStatus | null;
    onSendPrompt: (text: string) => void;
    onNavigateModels: () => void;
    onNavigateCredentials: () => void;
}

const CAPABILITIES = [
    {
        icon: BookOpen,
        title: 'Skills',
        description: 'Reusable diagnostic scripts for common SRE tasks',
    },
    {
        icon: SearchCode,
        title: 'Deep Investigation',
        description: 'Hypothesis-driven root cause analysis with evidence',
    },
    {
        icon: Cpu,
        title: 'Memory',
        description: 'Remembers findings and context across sessions',
    },
    {
        icon: Timer,
        title: 'Scheduled Jobs',
        description: 'Automated health checks on a cron schedule',
    },
];

/** Prompts shown to every user on every empty session */
const SUGGESTED_PROMPTS = [
    'Check my cluster health',
    'List available skills',
    'What happened since my last session?',
];

/** Extra onboarding prompt shown only for first-time users (no PROFILE.md) */
const ONBOARDING_PROMPT = 'Introduce yourself and help me get started';

const CREDENTIAL_LABELS: Record<string, string> = {
    kubeconfig: 'Kubeconfig',
    ssh_password: 'SSH',
    ssh_key: 'SSH Key',
    api_token: 'API Token',
    api_basic_auth: 'API Auth',
};

export function WelcomeArea({ systemStatus, onSendPrompt, onNavigateModels, onNavigateCredentials }: WelcomeAreaProps) {
    const isFirstTime = systemStatus?.hasProfile === false;
    const hasModels = systemStatus?.hasModels ?? false;
    const credentials = systemStatus?.credentials ?? {};
    const hasCredentials = Object.keys(credentials).length > 0;
    const sessionCount = systemStatus?.sessionCount ?? 0;

    const allChecklistDone = hasModels && hasCredentials && sessionCount > 0;

    const handlePromptClick = (text: string) => {
        if (!hasModels) {
            onNavigateModels();
            return;
        }
        onSendPrompt(text);
    };

    return (
        <div className="flex flex-col items-center justify-center py-12 px-4 max-w-2xl mx-auto space-y-8">

            {/* ── Onboarding block: only shown once (no PROFILE.md) ── */}
            {isFirstTime && (
                <>
                    {/* Hero */}
                    <div className="text-center space-y-2">
                        <h1 className="text-2xl font-semibold text-gray-800">Welcome to Siclaw</h1>
                        <p className="text-gray-500 text-sm">
                            Your personal SRE assistant that learns, remembers, and grows with you
                        </p>
                    </div>

                    {/* Setup Checklist — replaces old model warning + env card */}
                    {systemStatus && !allChecklistDone && (
                        <div className="w-full bg-white border border-gray-200 rounded-2xl shadow-sm p-5 space-y-3">
                            <h2 className="text-sm font-semibold text-gray-700">Getting Started</h2>
                            <div className="space-y-2">
                                {/* Step 1: Configure AI Model */}
                                <ChecklistStep
                                    step={1}
                                    done={hasModels}
                                    label="Configure AI Model"
                                    subtitle="Add a model provider to start chatting"
                                    onClick={onNavigateModels}
                                />
                                {/* Step 2: Add Credentials */}
                                <ChecklistStep
                                    step={2}
                                    done={hasCredentials}
                                    label="Add Credentials"
                                    subtitle="Connect to your clusters and servers via SSH or Kubeconfig"
                                    onClick={onNavigateCredentials}
                                />
                                {/* Step 3: Start a conversation */}
                                <ChecklistStep
                                    step={3}
                                    done={sessionCount > 0}
                                    label="Start your first conversation"
                                    subtitle="Ask Siclaw to diagnose an issue or run a skill"
                                />
                            </div>
                        </div>
                    )}

                    {/* Capability Grid */}
                    <div className="w-full grid grid-cols-2 gap-3">
                        {CAPABILITIES.map((cap) => (
                            <div
                                key={cap.title}
                                className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 space-y-1.5"
                            >
                                <cap.icon className="w-5 h-5 text-gray-400" />
                                <p className="text-sm font-medium text-gray-700">{cap.title}</p>
                                <p className="text-xs text-gray-500 leading-relaxed">{cap.description}</p>
                            </div>
                        ))}
                    </div>

                    {/* Credentials Summary — shown when checklist is all done */}
                    {allChecklistDone && hasCredentials && (
                        <CredentialsSummary credentials={credentials} />
                    )}
                </>
            )}

            {/* ── Returning user: Credentials summary (if any) ── */}
            {!isFirstTime && hasCredentials && (
                <CredentialsSummary credentials={credentials} />
            )}

            {/* ── Suggested Prompts: shown on every empty session ── */}
            {systemStatus && (
                <div className="w-full space-y-3">
                    <p className="text-xs text-center text-gray-400">Try asking</p>
                    <div className="flex flex-wrap gap-2 justify-center">
                        {/* Onboarding CTA — only for first-time users */}
                        {isFirstTime && (
                            <button
                                onClick={() => handlePromptClick(ONBOARDING_PROMPT)}
                                className="rounded-full px-4 py-2 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-sm text-blue-700 transition-colors"
                            >
                                {ONBOARDING_PROMPT}
                            </button>
                        )}
                        {SUGGESTED_PROMPTS.map((prompt) => (
                            <button
                                key={prompt}
                                onClick={() => handlePromptClick(prompt)}
                                className="rounded-full px-4 py-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 text-sm text-gray-700 transition-colors"
                            >
                                {prompt}
                            </button>
                        ))}
                    </div>
                    {!hasModels && (
                        <p className="text-xs text-center text-amber-600">
                            Configure a model first to start chatting
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

/* ── Subcomponents ── */

function ChecklistStep({ step, done, label, subtitle, onClick }: {
    step: number;
    done: boolean;
    label: string;
    subtitle: string;
    onClick?: () => void;
}) {
    const content = (
        <div className="flex items-start gap-3">
            {done ? (
                <CheckCircle2 className="w-5 h-5 text-green-500 mt-0.5 shrink-0" />
            ) : (
                <Circle className="w-5 h-5 text-gray-300 mt-0.5 shrink-0" />
            )}
            <div className="min-w-0">
                <p className={`text-sm font-medium ${done ? 'text-gray-400' : 'text-gray-800'}`}>
                    {step}. {label}
                </p>
                <p className={`text-xs mt-0.5 ${done ? 'text-gray-300' : 'text-gray-500'}`}>
                    {subtitle}
                </p>
            </div>
            {!done && onClick && (
                <ArrowRight className="w-4 h-4 text-gray-400 mt-0.5 ml-auto shrink-0" />
            )}
        </div>
    );

    if (onClick) {
        return (
            <button
                onClick={onClick}
                className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-gray-50 transition-colors"
            >
                {content}
            </button>
        );
    }

    return <div className="px-3 py-2.5">{content}</div>;
}

function CredentialsSummary({ credentials }: { credentials: Record<string, number> }) {
    const entries = Object.entries(credentials);
    if (entries.length === 0) return null;

    return (
        <div className="w-full bg-white border border-gray-200 rounded-2xl shadow-sm p-4">
            <div className="flex items-center gap-2 mb-3">
                <KeyRound className="w-4 h-4 text-gray-400" />
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Credentials</span>
            </div>
            <div className="flex flex-wrap gap-2">
                {entries.map(([type, count]) => (
                    <span
                        key={type}
                        className="inline-flex items-center text-xs bg-gray-50 text-gray-600 border border-gray-200 rounded-full px-2.5 py-1"
                    >
                        {CREDENTIAL_LABELS[type] || type} &times;{count}
                    </span>
                ))}
            </div>
        </div>
    );
}
