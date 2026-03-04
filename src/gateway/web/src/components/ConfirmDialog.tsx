import { X, AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    description: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'primary' | 'danger' | 'warning';
}

export function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    description,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    variant = 'primary'
}: ConfirmDialogProps) {
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

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm transition-opacity"
                onClick={onClose}
            />

            {/* Dialog Panel */}
            <div className="relative w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden text-left transform transition-all animate-in fade-in zoom-in-95 duration-200">
                <div className="p-6">
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
                            className="p-1 text-gray-400 hover:text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="mt-8 flex items-center justify-end gap-3">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-100 transition-colors"
                        >
                            {cancelText}
                        </button>
                        <button
                            onClick={() => {
                                onConfirm();
                                onClose();
                            }}
                            className={cn(
                                "px-4 py-2 text-sm font-medium text-white rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 transition-all",
                                style.button
                            )}
                        >
                            {confirmText}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
