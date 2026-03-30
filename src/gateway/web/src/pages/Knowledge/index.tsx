import { useState, useEffect, useRef, useMemo } from 'react';
import { BookOpen, Loader2, Plus, Trash2, Search, FileText, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '../../hooks/useWebSocket';
import { usePermissions } from '../../hooks/usePermissions';
import { useKnowledge, type KnowledgeDoc } from '../../hooks/useKnowledge';
import { KnowledgeUploadDrawer } from './KnowledgeUploadDrawer';

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(iso?: string): string {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

export function KnowledgePage() {
    const { sendRpc, isConnected } = useWebSocket();
    const { isAdmin } = usePermissions(sendRpc, isConnected);
    const { docs, loading, loadDocs, uploadDoc, batchUploadDocs, getDoc, deleteDoc } = useKnowledge(sendRpc);

    const [search, setSearch] = useState('');
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [deleting, setDeleting] = useState<string | null>(null);
    const [previewDoc, setPreviewDoc] = useState<KnowledgeDoc | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (!isConnected) { hasLoadedRef.current = false; return; }
        if (hasLoadedRef.current) return;
        hasLoadedRef.current = true;
        loadDocs();
    }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

    const filtered = useMemo(() => {
        if (!search.trim()) return docs;
        const q = search.toLowerCase();
        return docs.filter(d =>
            d.name.toLowerCase().includes(q) ||
            d.filePath.toLowerCase().includes(q)
        );
    }, [docs, search]);

    const handleDelete = async (e: React.MouseEvent, id: string, name: string) => {
        e.stopPropagation();
        if (deleting) return;
        if (!window.confirm(`Delete knowledge document "${name}"?`)) return;
        setDeleting(id);
        try {
            await deleteDoc(id);
        } catch (err: any) {
            console.error('[Knowledge] Delete failed:', err);
            alert(`Delete failed: ${err?.message || 'Unknown error'}`);
        } finally {
            setDeleting(null);
        }
    };

    const handlePreview = async (doc: KnowledgeDoc) => {
        setPreviewLoading(true);
        try {
            const full = await getDoc(doc.id);
            setPreviewDoc(full);
        } catch (err) {
            console.error('[Knowledge] Preview failed:', err);
        } finally {
            setPreviewLoading(false);
        }
    };

    return (
        <div className="h-full bg-white flex flex-col">
            <header className="h-16 flex items-center justify-between px-6 bg-white sticky top-0 z-10 border-b border-gray-100">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary-50 rounded-lg">
                        <BookOpen className="w-5 h-5 text-primary-600" />
                    </div>
                    <div>
                        <h1 className="text-lg font-bold text-gray-900">Knowledge Base</h1>
                        <p className="text-xs text-gray-500">Team documentation for agent reference</p>
                    </div>
                </div>
                {isAdmin && (
                    <button
                        onClick={() => setDrawerOpen(true)}
                        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
                    >
                        <Plus className="w-4 h-4" />
                        Upload
                    </button>
                )}
            </header>

            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-5xl mx-auto">
                    {/* Search */}
                    <div className="flex items-center gap-3 mb-6">
                        <div className="relative flex-1 max-w-xs">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search documents..."
                                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                            />
                        </div>
                    </div>

                    {loading ? (
                        <div className="flex items-center justify-center py-20">
                            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="text-center py-20">
                            <BookOpen className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                            <h3 className="text-sm font-medium text-gray-900 mb-1">
                                {docs.length === 0 ? 'No documents yet' : 'No matching documents'}
                            </h3>
                            <p className="text-xs text-gray-500">
                                {docs.length === 0
                                    ? 'Upload your first knowledge document to get started.'
                                    : 'Try adjusting your search.'}
                            </p>
                        </div>
                    ) : (
                        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-gray-100 bg-gray-50/50">
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">File</th>
                                        <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Size</th>
                                        <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Chunks</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Uploaded</th>
                                        <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map((doc) => (
                                        <tr
                                            key={doc.id}
                                            className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors"
                                        >
                                            <td className="px-6 py-4">
                                                <span className="text-sm font-medium text-gray-900">{doc.name}</span>
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <span className="text-xs text-gray-500">{formatBytes(doc.sizeBytes)}</span>
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <span className={cn(
                                                    "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                                                    doc.chunkCount > 0
                                                        ? "bg-green-50 text-green-700"
                                                        : "bg-gray-100 text-gray-500"
                                                )}>
                                                    {doc.chunkCount}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="text-xs text-gray-500">{formatDate(doc.createdAt)}</span>
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                <div className="inline-flex items-center gap-1">
                                                    <button
                                                        onClick={() => handlePreview(doc)}
                                                        className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                                                        title="Preview"
                                                    >
                                                        <Eye className="w-3.5 h-3.5" />
                                                    </button>
                                                    {isAdmin && (
                                                        <button
                                                            onClick={(e) => handleDelete(e, doc.id, doc.name)}
                                                            disabled={deleting === doc.id}
                                                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                                                            title="Delete"
                                                        >
                                                            {deleting === doc.id ? (
                                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                            ) : (
                                                                <Trash2 className="w-3.5 h-3.5" />
                                                            )}
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {/* Preview Modal */}
            {previewDoc && (
                <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 flex items-center justify-center" onClick={() => setPreviewDoc(null)}>
                    <div className="bg-white rounded-xl shadow-2xl w-[720px] max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                            <div className="flex items-center gap-2">
                                <FileText className="w-4 h-4 text-primary-600" />
                                <h3 className="font-semibold text-gray-900">{previewDoc.name}</h3>
                            </div>
                            <button onClick={() => setPreviewDoc(null)} className="p-1 text-gray-400 hover:text-gray-600">
                                <span className="text-lg">&times;</span>
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-6">
                            {previewLoading ? (
                                <div className="flex items-center justify-center py-8">
                                    <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                                </div>
                            ) : (
                                <pre className="text-sm text-gray-700 whitespace-pre-wrap font-mono leading-relaxed">
                                    {previewDoc.content || '(empty)'}
                                </pre>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {isAdmin && (
                <KnowledgeUploadDrawer
                    isOpen={drawerOpen}
                    onClose={() => setDrawerOpen(false)}
                    onSave={uploadDoc}
                    onBatchSave={batchUploadDocs}
                />
            )}
        </div>
    );
}
