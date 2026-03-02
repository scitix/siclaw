import { X, Copy, Check } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

interface BindChannelDialogProps {
    isOpen: boolean;
    onClose: () => void;
    channel: string;
    sendRpc: (method: string, params?: Record<string, unknown>) => Promise<any>;
}

const CHANNEL_LABELS: Record<string, string> = {
    feishu: 'Feishu',
    dingtalk: 'DingTalk',
};

export function BindChannelDialog({ isOpen, onClose, channel, sendRpc }: BindChannelDialogProps) {
    const [code, setCode] = useState('');
    const [remaining, setRemaining] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [copied, setCopied] = useState(false);

    const generateCode = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const result = await sendRpc('binding.generate') as { code: string; expiresIn: number };
            setCode(result.code);
            setRemaining(result.expiresIn);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to generate code');
        } finally {
            setLoading(false);
        }
    }, [sendRpc]);

    useEffect(() => {
        if (isOpen) {
            generateCode();
            setCopied(false);
        } else {
            setCode('');
            setRemaining(0);
            setError('');
        }
    }, [isOpen, generateCode]);

    useEffect(() => {
        if (remaining <= 0) return;
        const timer = setInterval(() => {
            setRemaining((r) => {
                if (r <= 1) {
                    clearInterval(timer);
                    return 0;
                }
                return r - 1;
            });
        }, 1000);
        return () => clearInterval(timer);
    }, [remaining]);

    const handleCopy = () => {
        const command = `/bind ${code}`;
        navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    if (!isOpen) return null;

    const label = CHANNEL_LABELS[channel] || channel;
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const expired = code && remaining <= 0;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
                className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm transition-opacity"
                onClick={onClose}
            />
            <div className="relative w-full max-w-sm bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden text-center transform transition-all animate-in fade-in zoom-in-95 duration-200">
                <div className="p-6">
                    <div className="flex items-center justify-between mb-6">
                        <h3 className="text-lg font-semibold text-gray-900">
                            Bind {label}
                        </h3>
                        <button
                            onClick={onClose}
                            className="p-1 text-gray-400 hover:text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {loading ? (
                        <div className="py-8 text-sm text-gray-500">Generating code...</div>
                    ) : error ? (
                        <div className="py-8">
                            <p className="text-sm text-red-500 mb-4">{error}</p>
                            <button
                                onClick={generateCode}
                                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
                            >
                                Retry
                            </button>
                        </div>
                    ) : (
                        <>
                            <div className="py-4">
                                <div className={`text-4xl font-mono font-bold tracking-[0.3em] ${expired ? 'text-gray-300' : 'text-gray-900'}`}>
                                    {code}
                                </div>
                                {expired ? (
                                    <p className="text-sm text-red-500 mt-3">
                                        Code expired.{' '}
                                        <button onClick={generateCode} className="underline hover:text-red-600">
                                            Generate new code
                                        </button>
                                    </p>
                                ) : (
                                    <p className="text-sm text-gray-400 mt-3">
                                        Expires in {minutes}:{String(seconds).padStart(2, '0')}
                                    </p>
                                )}
                            </div>

                            <div className="bg-gray-50 rounded-lg p-4 mt-2">
                                <p className="text-sm text-gray-600">
                                    Send the following command to Siclaw in {label}:
                                </p>
                                <div className="flex items-center justify-center gap-2 mt-2">
                                    <code className="text-sm font-mono font-semibold text-primary-700 bg-primary-50 px-3 py-1 rounded">
                                        /bind {code}
                                    </code>
                                    <button
                                        onClick={handleCopy}
                                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded transition-colors"
                                        title="Copy command"
                                    >
                                        {copied ? (
                                            <Check className="w-4 h-4 text-green-500" />
                                        ) : (
                                            <Copy className="w-4 h-4" />
                                        )}
                                    </button>
                                </div>
                            </div>
                        </>
                    )}

                    <div className="mt-6">
                        <button
                            onClick={onClose}
                            className="w-full px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                        >
                            Close
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
