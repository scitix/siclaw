import { X, Save, Upload, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface KnowledgeUploadDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (data: { name: string; content: string }) => Promise<unknown>;
}

type InputMode = 'file' | 'paste';

export function KnowledgeUploadDrawer({ isOpen, onClose, onSave }: KnowledgeUploadDrawerProps) {
    const [mode, setMode] = useState<InputMode>('file');
    const [name, setName] = useState('');
    const [content, setContent] = useState('');
    const [fileName, setFileName] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setMode('file');
            setName('');
            setContent('');
            setFileName('');
            setError('');
            setSaving(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    }, [isOpen]);

    const switchMode = (next: InputMode) => {
        if (next === mode) return;
        setMode(next);
        setContent('');
        setFileName('');
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        setContent(text);
        setFileName(file.name);
        if (!name) {
            setName(file.name.replace(/\.md$/, ''));
        }
    };

    const handleSave = async () => {
        if (saving) return;
        if (!name.trim()) { setError('Name is required'); return; }
        if (!content.trim()) { setError('Content is required'); return; }
        setSaving(true);
        setError('');
        try {
            await onSave({
                name: name.trim(),
                content,
            });
            onClose();
        } catch (err: any) {
            setError(err?.message || 'Failed to upload');
        } finally {
            setSaving(false);
        }
    };

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
                        className="fixed right-0 top-0 bottom-0 w-[560px] bg-white shadow-2xl z-50 flex flex-col border-l border-gray-100"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-white">
                            <div>
                                <h2 className="text-lg font-bold text-gray-900">Upload Document</h2>
                                <p className="text-xs text-gray-400">Add a Markdown document to the knowledge base</p>
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
                            {/* Name */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-gray-700">
                                    Name <span className="text-red-500">*</span>
                                </label>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="e.g. RoCE Networking Guide"
                                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                />
                            </div>

                            {/* Mode tabs */}
                            <div className="space-y-3">
                                <label className="text-sm font-medium text-gray-700">
                                    Content <span className="text-red-500">*</span>
                                </label>
                                <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
                                    <button
                                        type="button"
                                        onClick={() => switchMode('file')}
                                        className={cn(
                                            "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                                            mode === 'file'
                                                ? "bg-white text-gray-900 shadow-sm"
                                                : "text-gray-500 hover:text-gray-700"
                                        )}
                                    >
                                        <Upload className="w-3.5 h-3.5" />
                                        Upload File
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => switchMode('paste')}
                                        className={cn(
                                            "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                                            mode === 'paste'
                                                ? "bg-white text-gray-900 shadow-sm"
                                                : "text-gray-500 hover:text-gray-700"
                                        )}
                                    >
                                        <FileText className="w-3.5 h-3.5" />
                                        Paste Content
                                    </button>
                                </div>

                                {mode === 'file' ? (
                                    <div className="space-y-2">
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept=".md,.markdown,.txt"
                                            onChange={handleFileChange}
                                            className="hidden"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => fileInputRef.current?.click()}
                                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-50 text-primary-600 hover:bg-primary-100 transition-colors"
                                        >
                                            <Upload className="w-3.5 h-3.5" />
                                            Choose File
                                        </button>
                                        {fileName && content && (
                                            <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
                                                <p className="text-xs text-gray-500">
                                                    <span className="font-medium text-gray-700">{fileName}</span>
                                                    {' — '}{content.length.toLocaleString()} characters
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="space-y-1.5">
                                        <textarea
                                            value={content}
                                            onChange={(e) => setContent(e.target.value)}
                                            placeholder="Paste Markdown content here..."
                                            rows={16}
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none"
                                        />
                                        {content && (
                                            <p className="text-xs text-gray-400">
                                                {content.length.toLocaleString()} characters
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>

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
                                disabled={!name.trim() || !content.trim() || saving}
                                className="px-4 py-2 text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 rounded-lg shadow-sm flex items-center gap-2 disabled:opacity-50"
                            >
                                <Save className="w-4 h-4" />
                                {saving ? 'Uploading...' : 'Upload'}
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
