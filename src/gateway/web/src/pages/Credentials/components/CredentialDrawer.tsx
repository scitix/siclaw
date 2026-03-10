import { X, Save, Terminal, Globe, KeyRound, ShieldCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Credential, CredentialType } from '../credentialData';
import { CREDENTIAL_TYPE_OPTIONS } from '../credentialData';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface CredentialDrawerProps {
    credential: Credential | null;
    isOpen: boolean;
    onClose: () => void;
    onSave: (data: {
        name: string;
        type: CredentialType;
        description?: string;
        configJson: Record<string, unknown>;
    }) => Promise<void>;
    onUpdate: (id: string, data: {
        name?: string;
        description?: string;
        configJson?: Record<string, unknown>;
    }) => Promise<void>;
}

const TYPE_ICONS: Record<CredentialType, typeof Terminal> = {
    ssh_password: Terminal,
    ssh_key: ShieldCheck,
    api_token: Globe,
    api_basic_auth: KeyRound,
};

export function CredentialDrawer({ credential, isOpen, onClose, onSave, onUpdate }: CredentialDrawerProps) {
    const isEditing = !!credential;

    const [type, setType] = useState<CredentialType>('ssh_password');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');

    // SSH Password fields
    const [sshHost, setSshHost] = useState('');
    const [sshPort, setSshPort] = useState('');
    const [sshUsername, setSshUsername] = useState('');
    const [sshPassword, setSshPassword] = useState('');

    // SSH Key fields
    const [sshKeyHost, setSshKeyHost] = useState('');
    const [sshKeyPort, setSshKeyPort] = useState('');
    const [sshKeyUsername, setSshKeyUsername] = useState('');
    const [sshKeyPrivateKey, setSshKeyPrivateKey] = useState('');
    const [sshKeyPassphrase, setSshKeyPassphrase] = useState('');

    // API Token fields
    const [tokenUrl, setTokenUrl] = useState('');
    const [tokenValue, setTokenValue] = useState('');

    // API Basic Auth fields
    const [basicUrl, setBasicUrl] = useState('');
    const [basicUsername, setBasicUsername] = useState('');
    const [basicPassword, setBasicPassword] = useState('');

    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setError('');
            setSaving(false);
            if (credential) {
                setType(credential.type);
                setName(credential.name);
                setDescription(credential.description ?? '');
                const cfg = credential.configJson ?? {};
                switch (credential.type) {
                    case 'ssh_password':
                        setSshHost((cfg.host as string) ?? '');
                        setSshPort((cfg.port as string) ?? '');
                        setSshUsername((cfg.username as string) ?? '');
                        setSshPassword('');
                        break;
                    case 'ssh_key':
                        setSshKeyHost((cfg.host as string) ?? '');
                        setSshKeyPort((cfg.port as string) ?? '');
                        setSshKeyUsername((cfg.username as string) ?? '');
                        setSshKeyPrivateKey('');
                        setSshKeyPassphrase('');
                        break;
                    case 'api_token':
                        setTokenUrl((cfg.url as string) ?? '');
                        setTokenValue('');
                        break;
                    case 'api_basic_auth':
                        setBasicUrl((cfg.url as string) ?? '');
                        setBasicUsername((cfg.username as string) ?? '');
                        setBasicPassword('');
                        break;
                }
            } else {
                setType('ssh_password');
                setName('');
                setDescription('');
                setSshHost('');
                setSshPort('');
                setSshUsername('');
                setSshPassword('');
                setSshKeyHost('');
                setSshKeyPort('');
                setSshKeyUsername('');
                setSshKeyPrivateKey('');
                setSshKeyPassphrase('');
                setTokenUrl('');
                setTokenValue('');
                setBasicUrl('');
                setBasicUsername('');
                setBasicPassword('');
            }
        }
    }, [isOpen, credential]);

    const buildConfigJson = (): Record<string, unknown> => {
        switch (type) {
            case 'ssh_password': {
                const cfg: Record<string, unknown> = { username: sshUsername, password: sshPassword };
                if (sshHost) cfg.host = sshHost;
                if (sshPort) cfg.port = sshPort;
                return cfg;
            }
            case 'ssh_key': {
                const cfg: Record<string, unknown> = { username: sshKeyUsername, privateKey: sshKeyPrivateKey };
                if (sshKeyHost) cfg.host = sshKeyHost;
                if (sshKeyPort) cfg.port = sshKeyPort;
                if (sshKeyPassphrase) cfg.passphrase = sshKeyPassphrase;
                return cfg;
            }
            case 'api_token':
                return { url: tokenUrl, token: tokenValue };
            case 'api_basic_auth':
                return { url: basicUrl, username: basicUsername, password: basicPassword };
        }
    };

    const hasRequiredFields = (): boolean => {
        if (!name.trim()) return false;
        switch (type) {
            case 'ssh_password':
                return !!(sshUsername && (isEditing || sshPassword));
            case 'ssh_key':
                return !!(sshKeyUsername && (isEditing || sshKeyPrivateKey));
            case 'api_token':
                return !!(tokenUrl && (isEditing || tokenValue));
            case 'api_basic_auth':
                return !!(basicUrl && basicUsername && (isEditing || basicPassword));
        }
    };

    const handleSave = async () => {
        if (saving) return;
        setSaving(true);
        setError('');
        try {
            if (isEditing) {
                const updates: { name?: string; description?: string; configJson?: Record<string, unknown> } = {
                    name,
                    description: description || undefined,
                };
                // Only send configJson if user provided new secret values
                const cfg = buildConfigJson();
                const hasNewSecrets = type === 'ssh_password' ? !!sshPassword
                    : type === 'ssh_key' ? !!sshKeyPrivateKey
                    : type === 'api_token' ? !!tokenValue
                    : !!basicPassword;
                if (hasNewSecrets) {
                    updates.configJson = cfg;
                }
                await onUpdate(credential!.id, updates);
            } else {
                await onSave({
                    name,
                    type,
                    description: description || undefined,
                    configJson: buildConfigJson(),
                });
            }
            onClose();
        } catch (err: any) {
            setError(err?.message || 'Failed to save');
        } finally {
            setSaving(false);
        }
    };

    const title = isEditing ? 'Edit Credential' : 'New Credential';
    const subtitle = isEditing ? credential.name : 'Add a new credential';

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40"
                    />
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed right-0 top-0 bottom-0 w-[480px] bg-white shadow-2xl z-50 flex flex-col border-l border-gray-100"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-white">
                            <div>
                                <h2 className="text-lg font-bold text-gray-900">{title}</h2>
                                <p className="text-xs text-gray-400">{subtitle}</p>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6">
                            {/* Type selector */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">
                                    Type <span className="text-red-500">*</span>
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    {CREDENTIAL_TYPE_OPTIONS.map((opt) => {
                                        const Icon = TYPE_ICONS[opt.value];
                                        const selected = type === opt.value;
                                        return (
                                            <button
                                                key={opt.value}
                                                type="button"
                                                disabled={isEditing}
                                                onClick={() => setType(opt.value)}
                                                className={cn(
                                                    "flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors text-left",
                                                    selected
                                                        ? "border-primary-500 bg-primary-50 text-primary-700"
                                                        : "border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50",
                                                    isEditing && "opacity-60 cursor-not-allowed"
                                                )}
                                            >
                                                <Icon className="w-4 h-4" />
                                                {opt.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Name */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">
                                    Name <span className="text-red-500">*</span>
                                </label>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="e.g. Production SSH, Staging API"
                                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                />
                            </div>

                            {/* Description */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">Description</label>
                                <input
                                    type="text"
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    placeholder="Optional description"
                                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                />
                            </div>

                            {/* Dynamic fields per type */}
                            {type === 'ssh_password' && (
                                <div className="space-y-4">
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1.5">
                                            <label className="text-sm font-medium text-gray-700">Host</label>
                                            <input
                                                type="text"
                                                value={sshHost}
                                                onChange={(e) => setSshHost(e.target.value)}
                                                placeholder="10.0.0.1"
                                                className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-sm font-medium text-gray-700">Port</label>
                                            <input
                                                type="text"
                                                value={sshPort}
                                                onChange={(e) => setSshPort(e.target.value)}
                                                placeholder="22"
                                                className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            Username <span className="text-red-500">*</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={sshUsername}
                                            onChange={(e) => setSshUsername(e.target.value)}
                                            placeholder="root"
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            Password <span className="text-red-500">*</span>
                                        </label>
                                        <input
                                            type="password"
                                            value={sshPassword}
                                            onChange={(e) => setSshPassword(e.target.value)}
                                            placeholder={isEditing ? '(unchanged)' : 'Password'}
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                </div>
                            )}

                            {type === 'ssh_key' && (
                                <div className="space-y-4">
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1.5">
                                            <label className="text-sm font-medium text-gray-700">Host</label>
                                            <input
                                                type="text"
                                                value={sshKeyHost}
                                                onChange={(e) => setSshKeyHost(e.target.value)}
                                                placeholder="10.0.0.1"
                                                className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-sm font-medium text-gray-700">Port</label>
                                            <input
                                                type="text"
                                                value={sshKeyPort}
                                                onChange={(e) => setSshKeyPort(e.target.value)}
                                                placeholder="22"
                                                className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            Username <span className="text-red-500">*</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={sshKeyUsername}
                                            onChange={(e) => setSshKeyUsername(e.target.value)}
                                            placeholder="root"
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            Private Key <span className="text-red-500">*</span>
                                        </label>
                                        <textarea
                                            value={sshKeyPrivateKey}
                                            onChange={(e) => setSshKeyPrivateKey(e.target.value)}
                                            placeholder={isEditing ? '(unchanged) Paste new key to replace...' : 'Paste private key (PEM format)...'}
                                            rows={8}
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">Passphrase</label>
                                        <input
                                            type="password"
                                            value={sshKeyPassphrase}
                                            onChange={(e) => setSshKeyPassphrase(e.target.value)}
                                            placeholder={isEditing ? '(unchanged)' : 'Optional passphrase'}
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                </div>
                            )}

                            {type === 'api_token' && (
                                <div className="space-y-4">
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            URL <span className="text-red-500">*</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={tokenUrl}
                                            onChange={(e) => setTokenUrl(e.target.value)}
                                            placeholder="https://api.example.com"
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            Token <span className="text-red-500">*</span>
                                        </label>
                                        <input
                                            type="password"
                                            value={tokenValue}
                                            onChange={(e) => setTokenValue(e.target.value)}
                                            placeholder={isEditing ? '(unchanged)' : 'Bearer token value'}
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                </div>
                            )}

                            {type === 'api_basic_auth' && (
                                <div className="space-y-4">
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            URL <span className="text-red-500">*</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={basicUrl}
                                            onChange={(e) => setBasicUrl(e.target.value)}
                                            placeholder="https://api.example.com"
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            Username <span className="text-red-500">*</span>
                                        </label>
                                        <input
                                            type="text"
                                            value={basicUsername}
                                            onChange={(e) => setBasicUsername(e.target.value)}
                                            placeholder="Username"
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-gray-700">
                                            Password <span className="text-red-500">*</span>
                                        </label>
                                        <input
                                            type="password"
                                            value={basicPassword}
                                            onChange={(e) => setBasicPassword(e.target.value)}
                                            placeholder={isEditing ? '(unchanged)' : 'Password'}
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                        />
                                    </div>
                                </div>
                            )}

                            {error && (
                                <p className="text-xs text-red-500">{error}</p>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="p-6 border-t border-gray-100 bg-white flex items-center justify-end gap-3">
                            <button
                                onClick={onClose}
                                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-50 rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={!hasRequiredFields() || saving}
                                className="px-4 py-2 text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 rounded-lg shadow-sm flex items-center gap-2 disabled:opacity-50"
                            >
                                <Save className="w-4 h-4" />
                                {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Credential'}
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
