import { X, Upload, FileText, Trash2, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';

interface KnowledgeUploadDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (data: { content: string; fileName: string }) => Promise<unknown>;
    onBatchSave: (docs: Array<{ content: string; fileName: string }>) => Promise<{
        results: Array<{ id: string; name: string; error?: string }>;
    }>;
}

interface PendingFile {
    key: string;
    fileName: string;
    content: string;
    sizeBytes: number;
}

let keyCounter = 0;

export function KnowledgeUploadDrawer({ isOpen, onClose, onSave, onBatchSave }: KnowledgeUploadDrawerProps) {
    const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setPendingFiles([]);
            setError('');
            setSaving(false);
            setUploadProgress(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    }, [isOpen]);

    const handleFilesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const fileList = e.target.files;
        if (!fileList || fileList.length === 0) return;

        const newFiles: PendingFile[] = [];
        for (const file of Array.from(fileList)) {
            const text = await file.text();
            newFiles.push({
                key: `file-${++keyCounter}`,
                fileName: file.name,
                content: text,
                sizeBytes: new Blob([text]).size,
            });
        }
        setPendingFiles(prev => [...prev, ...newFiles]);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const removePendingFile = (key: string) => {
        setPendingFiles(prev => prev.filter(f => f.key !== key));
    };

    const handleSave = async () => {
        if (saving) return;
        setError('');

        if (pendingFiles.length === 0) { setError('No files selected'); return; }

        setSaving(true);
        if (pendingFiles.length === 1) {
            try {
                await onSave({ content: pendingFiles[0].content, fileName: pendingFiles[0].fileName });
                onClose();
            } catch (err: any) {
                setError(err?.message || 'Failed to upload');
            } finally {
                setSaving(false);
            }
            return;
        }

        // Batch upload
        setUploadProgress({ done: 0, total: pendingFiles.length });
        try {
            const result = await onBatchSave(
                pendingFiles.map(f => ({ content: f.content, fileName: f.fileName })),
            );
            const errors = result.results.filter(r => r.error);
            if (errors.length > 0) {
                setError(`${errors.length} failed: ${errors.map(e => `${e.name}: ${e.error}`).join('; ')}`);
                const failedNames = new Set(errors.map(e => e.name));
                setPendingFiles(prev => prev.filter(f => failedNames.has(f.fileName)));
            } else {
                onClose();
            }
        } catch (err: any) {
            setError(err?.message || 'Batch upload failed');
        } finally {
            setSaving(false);
            setUploadProgress(null);
        }
    };

    const totalSize = pendingFiles.reduce((sum, f) => sum + f.sizeBytes, 0);

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
                                <h2 className="text-lg font-bold text-gray-900">Upload Documents</h2>
                                <p className="text-xs text-gray-400">Add Markdown documents to the knowledge base</p>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-4">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".md,.markdown,.txt"
                                multiple
                                onChange={handleFilesChange}
                                className="hidden"
                            />
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-50 text-primary-600 hover:bg-primary-100 transition-colors"
                            >
                                <Upload className="w-3.5 h-3.5" />
                                Choose Files
                            </button>

                            {pendingFiles.length > 0 && (
                                <div className="space-y-2">
                                    <p className="text-xs text-gray-500">
                                        {pendingFiles.length} file{pendingFiles.length > 1 ? 's' : ''} selected
                                        {' \u2014 '}
                                        {(totalSize / 1024).toFixed(1)} KB total
                                    </p>
                                    <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                                        {pendingFiles.map((f) => (
                                            <div key={f.key} className="flex items-center gap-3 px-3 py-2 group">
                                                <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium text-gray-900 truncate">{f.fileName}</p>
                                                    <p className="text-[11px] text-gray-400">{(f.sizeBytes / 1024).toFixed(1)} KB</p>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => removePendingFile(f.key)}
                                                    className="p-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                                                    title="Remove"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        ))}
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
                                disabled={pendingFiles.length === 0 || saving}
                                className="px-4 py-2 text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 rounded-lg shadow-sm flex items-center gap-2 disabled:opacity-50"
                            >
                                {saving ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        {uploadProgress
                                            ? `Uploading ${uploadProgress.total} files...`
                                            : 'Uploading...'}
                                    </>
                                ) : (
                                    <>
                                        <Upload className="w-4 h-4" />
                                        {pendingFiles.length > 1
                                            ? `Upload ${pendingFiles.length} Files`
                                            : 'Upload'}
                                    </>
                                )}
                            </button>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
