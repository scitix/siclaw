import { X, AlertTriangle, CheckCircle2, HelpCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useEffect, useRef } from 'react';

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => unknown;
    title: string;
    description: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'primary' | 'danger' | 'warning';
    /** Message shown on successful async confirm. If set, dialog stays open briefly to show it. */
    successMessage?: string;
}

export function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    description,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    variant = 'primary',
    successMessage,
}: ConfirmDialogProps) {
    const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [errorMsg, setErrorMsg] = useState('');
    const timerRef = useRef<ReturnType<typeof setTimeout>>();

    // Clean up timer on unmount
    useEffect(() => () => clearTimeout(timerRef.current), []);

    // Reset state when dialog opens/closes
    useEffect(() => {
        if (isOpen) {
            setStatus('idle');
            setErrorMsg('');
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const variantStyles = {
        primary: {
            icon: HelpCircle,
            iconColor: "text-primary-600",
            iconBg: "bg-primary-50",
            button: "bg-primary-600 hover:bg-primary-700 focus:ring-primary-100"
        },
        danger: {
            icon: AlertTriangle,
            iconColor: "text-red-600",
            iconBg: "bg-red-50",
            button: "bg-red-600 hover:bg-red-700 focus:ring-red-100"
        },
        warning: {
            icon: CheckCircle2,
            iconColor: "text-orange-600",
            iconBg: "bg-orange-50",
            button: "bg-orange-600 hover:bg-orange-700 focus:ring-orange-100"
        }
    };

    const style = variantStyles[variant];
    const Icon = style.icon;
    const isWorking = status === 'loading' || status === 'success';

    const handleConfirm = async () => {
        setStatus('loading');
        setErrorMsg('');
        try {
            await onConfirm();
            if (successMessage) {
                setStatus('success');
                timerRef.current = setTimeout(() => onClose(), 1200);
            } else {
                onClose();
            }
        } catch (err: any) {
            setStatus('error');
            setErrorMsg(err instanceof Error ? err.message : String(err));
        }
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm transition-opacity"
                onClick={isWorking ? undefined : onClose}
            />

            {/* Dialog Panel */}
            <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden text-left transform transition-all animate-in fade-in zoom-in-95 duration-200">
                <div className="p-6">
                    {status === 'success' ? (
                        <div className="flex flex-col items-center py-4 gap-3">
                            <div className="p-3 rounded-xl bg-green-50">
                                <CheckCircle2 className="w-6 h-6 text-green-600" />
                            </div>
                            <p className="text-sm font-medium text-green-700">{successMessage}</p>
                        </div>
                    ) : (
                        <>
                            <div className="flex items-start gap-4">
                                <div className={cn("p-3 rounded-xl flex-shrink-0", style.iconBg)}>
                                    <Icon className={cn("w-6 h-6", style.iconColor)} />
                                </div>
                                <div className="flex-1 pt-1">
                                    <h3 className="text-lg font-semibold text-gray-900 leading-none mb-2">
                                        {title}
                                    </h3>
                                    <p className="text-sm text-gray-500 leading-relaxed">
                                        {description}
                                    </p>
                                </div>
                                <button
                                    onClick={onClose}
                                    disabled={isWorking}
                                    className="p-1 text-gray-400 hover:text-gray-500 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            {status === 'error' && (
                                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                                    <p className="text-sm text-red-700">{errorMsg}</p>
                                </div>
                            )}

                            <div className="mt-8 flex items-center justify-end gap-3">
                                <button
                                    onClick={onClose}
                                    disabled={isWorking}
                                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-100 transition-colors disabled:opacity-50"
                                >
                                    {cancelText}
                                </button>
                                <button
                                    onClick={handleConfirm}
                                    disabled={isWorking}
                                    className={cn(
                                        "px-4 py-2 text-sm font-medium text-white rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 transition-all disabled:opacity-70",
                                        style.button
                                    )}
                                >
                                    {isWorking ? (
                                        <span className="flex items-center gap-2">
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            Processing...
                                        </span>
                                    ) : (
                                        confirmText
                                    )}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
