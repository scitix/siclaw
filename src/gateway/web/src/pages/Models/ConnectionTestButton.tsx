import { useState } from 'react';
import { Loader2, CheckCircle2, XCircle, Wifi } from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';

type TestState = 'idle' | 'testing' | 'success' | 'error';

interface ConnectionTestButtonProps {
    baseUrl: string;
    apiKey: string;
    api?: string;
    model?: string;
    disabled?: boolean;
}

export function ConnectionTestButton({ baseUrl, apiKey, api, model, disabled }: ConnectionTestButtonProps) {
    const { sendRpc } = useWebSocket();
    const [state, setState] = useState<TestState>('idle');
    const [message, setMessage] = useState('');

    const handleTest = async () => {
        if (!baseUrl || !apiKey) return;
        setState('testing');
        setMessage('');
        try {
            const result = await sendRpc<{ ok: boolean; message: string; models?: string[] }>(
                'provider.testConnection',
                { baseUrl, apiKey, api, model },
            );
            setState(result.ok ? 'success' : 'error');
            setMessage(result.message);
        } catch (err) {
            setState('error');
            setMessage(err instanceof Error ? err.message : 'Test failed');
        }
    };

    const icons: Record<TestState, React.ReactNode> = {
        idle: <Wifi className="w-4 h-4" />,
        testing: <Loader2 className="w-4 h-4 animate-spin" />,
        success: <CheckCircle2 className="w-4 h-4" />,
        error: <XCircle className="w-4 h-4" />,
    };

    const colors: Record<TestState, string> = {
        idle: 'text-gray-600 border-gray-200 hover:bg-gray-50',
        testing: 'text-indigo-600 border-indigo-200 bg-indigo-50',
        success: 'text-green-600 border-green-200 bg-green-50',
        error: 'text-red-600 border-red-200 bg-red-50',
    };

    const canTest = !disabled && !!baseUrl && !!apiKey && state !== 'testing';

    return (
        <div className="flex flex-col gap-1">
            <button
                type="button"
                onClick={handleTest}
                disabled={!canTest}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${colors[state]}`}
            >
                {icons[state]}
                {state === 'testing' ? 'Testing...' : 'Test Connection'}
            </button>
            {message && (
                <p className={`text-xs ${state === 'success' ? 'text-green-600' : 'text-red-500'}`}>
                    {message}
                </p>
            )}
        </div>
    );
}
