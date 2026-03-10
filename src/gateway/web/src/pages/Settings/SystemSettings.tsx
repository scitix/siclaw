import { useState, useEffect, useCallback, useRef } from 'react';
import { Save, Loader2, ShieldCheck, Globe, KeyRound, BarChart3 } from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePermissions } from '@/hooks/usePermissions';

interface FieldConfig {
    key: string;
    label: string;
    type: 'text' | 'password' | 'toggle';
    placeholder?: string;
    /** If true, never display existing value — write-only field */
    writeOnly?: boolean;
}

interface SectionConfig {
    key: string;
    title: string;
    icon: typeof ShieldCheck;
    fields: FieldConfig[];
}

const SECTIONS: SectionConfig[] = [
    {
        key: 'jwt',
        title: 'JWT Secret',
        icon: KeyRound,
        fields: [
            { key: 'secret', label: 'Secret', type: 'password', placeholder: 'Enter new JWT secret (leave empty to keep current)', writeOnly: true },
        ],
    },
    {
        key: 'sso',
        title: 'SSO Configuration',
        icon: ShieldCheck,
        fields: [
            { key: 'enabled', label: 'Enable SSO', type: 'toggle' },
            { key: 'issuer', label: 'Issuer URL', type: 'text', placeholder: 'https://dex.example.com' },
            { key: 'clientId', label: 'Client ID', type: 'text' },
            { key: 'clientSecret', label: 'Client Secret', type: 'password' },
            { key: 'redirectUri', label: 'Redirect URI', type: 'text', placeholder: 'https://your-domain/auth/callback' },
        ],
    },
    {
        key: 'system',
        title: 'System Settings',
        icon: Globe,
        fields: [
            { key: 'grafanaUrl', label: 'Grafana URL', type: 'text', placeholder: 'https://grafana.example.com/d/siclaw/overview?kiosk' },
        ],
    },
    {
        key: 'metrics',
        title: 'Metrics & Monitoring',
        icon: BarChart3,
        fields: [
            { key: 'port', label: 'Metrics Port (AgentBox only)', type: 'text', placeholder: '9090' },
            { key: 'token', label: 'Bearer Token', type: 'password', writeOnly: true },
            { key: 'includeUserId', label: 'Include User ID in Metrics', type: 'toggle' },
        ],
    },
];

export function SystemSettings() {
    const { sendRpc, isConnected } = useWebSocket();
    const { isAdmin, loaded: permLoaded } = usePermissions(sendRpc, isConnected);

    const [values, setValues] = useState<Record<string, string>>({});
    const [saved, setSaved] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const hasLoadedRef = useRef(false);

    // Collect all writeOnly keys so we can strip them from loaded config
    const writeOnlyKeys = new Set(
        SECTIONS.flatMap(s => s.fields.filter(f => f.writeOnly).map(f => `${s.key}.${f.key}`))
    );
    // Track which writeOnly keys have a value in the DB (for "configured" indicator)
    const [configuredKeys, setConfiguredKeys] = useState<Set<string>>(new Set());

    const loadConfig = useCallback(async () => {
        try {
            const result = await sendRpc<{ config: Record<string, string> }>('system.getConfig');
            const config = result.config ?? {};
            // Detect which writeOnly fields have values (even masked)
            const configured = new Set<string>();
            const display: Record<string, string> = {};
            for (const [k, v] of Object.entries(config)) {
                if (writeOnlyKeys.has(k)) {
                    if (v) configured.add(k);
                    // Don't populate the input — keep it empty
                } else {
                    display[k] = v;
                }
            }
            setConfiguredKeys(configured);
            setValues(display);
            setSaved(display);
        } catch (err) {
            console.warn('[SystemSettings] Failed to load config:', err);
        }
    }, [sendRpc]);

    useEffect(() => {
        if (!isConnected || !isAdmin || hasLoadedRef.current) return;
        hasLoadedRef.current = true;
        loadConfig();
    }, [isConnected, isAdmin, loadConfig]);

    const handleChange = (fullKey: string, value: string) => {
        setValues(prev => ({ ...prev, [fullKey]: value }));
        setError(null);
    };

    const isDirty = (section: string) => {
        const sec = SECTIONS.find(s => s.key === section);
        if (!sec) return false;
        return sec.fields.some(f => {
            const key = `${section}.${f.key}`;
            // writeOnly fields: dirty when user typed something
            if (f.writeOnly) return !!(values[key]);
            return (values[key] ?? '') !== (saved[key] ?? '');
        });
    };

    const handleSave = async (section: string) => {
        setSaving(section);
        setError(null);
        try {
            const sec = SECTIONS.find(s => s.key === section)!;
            const sectionValues: Record<string, string> = {};
            for (const f of sec.fields) {
                const fullKey = `${section}.${f.key}`;
                const val = values[fullKey] ?? '';
                // Don't send masked values back — only send if user actually changed it
                if (val && !val.includes('****')) {
                    sectionValues[f.key] = val;
                } else if (!val) {
                    sectionValues[f.key] = '';
                }
            }
            await sendRpc('system.saveSection', { section, values: sectionValues });
            // Reload to get latest (including masked values)
            await loadConfig();
        } catch (err: any) {
            setError(err?.message || 'Save failed');
        } finally {
            setSaving(null);
        }
    };

    if (!permLoaded) {
        return (
            <div className="flex-1 flex items-center justify-center text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }

    if (!isAdmin) {
        return (
            <div className="flex-1 flex items-center justify-center text-gray-400">
                <div className="text-center">
                    <div className="text-lg font-medium text-gray-500 mb-1">System Settings</div>
                    <div className="text-sm">Admin access required</div>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto p-6 space-y-6">
            {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                    {error}
                </div>
            )}

            {SECTIONS.map((section) => {
                const Icon = section.icon;
                const dirty = isDirty(section.key);
                const isSaving = saving === section.key;

                return (
                    <div key={section.key} className="bg-white border border-gray-200 rounded-lg">
                        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                            <div className="flex items-center gap-2">
                                <Icon className="w-4 h-4 text-gray-500" />
                                <h3 className="text-sm font-semibold text-gray-800">{section.title}</h3>
                            </div>
                            <button
                                onClick={() => handleSave(section.key)}
                                disabled={!dirty || isSaving}
                                className={
                                    'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ' +
                                    (dirty && !isSaving
                                        ? 'bg-primary-600 text-white hover:bg-primary-700'
                                        : 'bg-gray-100 text-gray-400 cursor-not-allowed')
                                }
                            >
                                {isSaving ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <Save className="w-3.5 h-3.5" />
                                )}
                                Save
                            </button>
                        </div>
                        <div className="p-5 space-y-4">
                            {section.fields.map((field) => {
                                const fullKey = `${section.key}.${field.key}`;

                                if (field.type === 'toggle') {
                                    const isOn = values[fullKey] === 'true';
                                    return (
                                        <div key={fullKey} className="flex items-center justify-between">
                                            <label className="text-xs font-medium text-gray-600">
                                                {field.label}
                                            </label>
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={isOn}
                                                onClick={() => handleChange(fullKey, isOn ? 'false' : 'true')}
                                                className={
                                                    'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ' +
                                                    (isOn ? 'bg-primary-600' : 'bg-gray-200')
                                                }
                                            >
                                                <span
                                                    className={
                                                        'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ' +
                                                        (isOn ? 'translate-x-4' : 'translate-x-0')
                                                    }
                                                />
                                            </button>
                                        </div>
                                    );
                                }

                                // Disable non-toggle fields when section has a toggle that is off
                                const toggleField = section.fields.find(f => f.type === 'toggle');
                                const sectionDisabled = toggleField
                                    ? values[`${section.key}.${toggleField.key}`] !== 'true'
                                    : false;

                                const isWriteOnly = field.writeOnly;
                                const isConfigured = isWriteOnly && configuredKeys.has(fullKey);

                                return (
                                    <div key={fullKey} className={sectionDisabled ? 'opacity-50' : ''}>
                                        <div className="flex items-center gap-2 mb-1">
                                            <label className="block text-xs font-medium text-gray-600">
                                                {field.label}
                                            </label>
                                            {isConfigured && !(values[fullKey]) && (
                                                <span className="text-xs text-green-600 font-medium">Configured</span>
                                            )}
                                        </div>
                                        <input
                                            type={field.type}
                                            value={values[fullKey] ?? ''}
                                            onChange={(e) => handleChange(fullKey, e.target.value)}
                                            placeholder={field.placeholder}
                                            disabled={sectionDisabled}
                                            className={
                                                'w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent' +
                                                (sectionDisabled ? ' bg-gray-50 cursor-not-allowed' : '')
                                            }
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
