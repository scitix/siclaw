import { useState, useMemo } from 'react';
import { CheckCircle2, FileText } from 'lucide-react';

interface KubeconfigUploadDialogProps {
    clusterId: string;
    clusterName: string;
    apiServer: string;
    replacing: boolean;
    onClose: () => void;
    onUploaded: () => void;
    sendRpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

interface KubeconfigSummary {
    contexts: string[];
    clusters: { name: string; server: string }[];
    currentContext: string;
}

function parseKubeconfigSummary(content: string): KubeconfigSummary | null {
    try {
        // Simple YAML key extraction without importing yaml parser
        const lines = content.split('\n');
        const contexts: string[] = [];
        const clusters: { name: string; server: string }[] = [];
        let currentContext = '';
        let inClusters = false;
        let inContexts = false;
        let currentClusterName = '';
        let currentClusterServer = '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('current-context:')) {
                currentContext = trimmed.replace('current-context:', '').trim().replace(/^['"]|['"]$/g, '');
            }
            if (trimmed === 'clusters:') { inClusters = true; inContexts = false; }
            if (trimmed === 'contexts:') { inContexts = true; inClusters = false; }
            if (trimmed === 'users:') { inClusters = false; inContexts = false; }

            if (inClusters) {
                if (trimmed.startsWith('name:') && line.startsWith('- ')) {
                    if (currentClusterName) clusters.push({ name: currentClusterName, server: currentClusterServer });
                    currentClusterName = trimmed.replace('name:', '').trim().replace(/^['"]|['"]$/g, '');
                    currentClusterServer = '';
                } else if (trimmed.startsWith('server:')) {
                    currentClusterServer = trimmed.replace('server:', '').trim().replace(/^['"]|['"]$/g, '');
                }
            }
            if (inContexts && trimmed.startsWith('name:') && line.startsWith('- ')) {
                contexts.push(trimmed.replace('name:', '').trim().replace(/^['"]|['"]$/g, ''));
            }
        }
        if (currentClusterName) clusters.push({ name: currentClusterName, server: currentClusterServer });

        if (clusters.length === 0 && contexts.length === 0) return null;
        return { contexts, clusters, currentContext };
    } catch {
        return null;
    }
}

export function KubeconfigUploadDialog({ clusterId, clusterName, apiServer, replacing, onClose, onUploaded, sendRpc }: KubeconfigUploadDialogProps) {
    const [kubeContent, setKubeContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const summary = useMemo(() => kubeContent.trim() ? parseKubeconfigSummary(kubeContent) : null, [kubeContent]);
    const hasParsed = summary !== null;

    const handleUpload = async () => {
        if (!kubeContent.trim()) return;
        setSaving(true);
        setError('');
        try {
            await sendRpc('userClusterConfig.set', { clusterId, kubeconfig: kubeContent });
            onUploaded();
        } catch (err: any) {
            setError(err?.message || 'Failed to upload kubeconfig');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Upload Kubeconfig</h3>

                {/* Cluster info */}
                <div className="mb-4 px-3 py-2.5 bg-gray-50 rounded-lg">
                    <p className="text-sm font-medium text-gray-900">{clusterName}</p>
                    <p className="text-xs text-gray-500 font-mono mt-0.5">{apiServer}</p>
                    {replacing && (
                        <p className="text-xs text-amber-600 mt-1">Existing kubeconfig will be replaced</p>
                    )}
                </div>

                {/* Kubeconfig input or parsed summary */}
                {hasParsed ? (
                    <div className="border border-green-200 bg-green-50 rounded-lg p-3 mb-4">
                        <div className="flex items-center gap-2 mb-2">
                            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                            <span className="text-sm font-medium text-green-700">Kubeconfig parsed</span>
                            <button
                                onClick={() => setKubeContent('')}
                                className="ml-auto text-xs text-gray-400 hover:text-gray-600"
                            >
                                Clear
                            </button>
                        </div>
                        <div className="space-y-1">
                            {summary.clusters.map(c => (
                                <div key={c.name} className="flex items-center gap-2 text-xs text-gray-600">
                                    <FileText className="w-3 h-3 text-gray-400 shrink-0" />
                                    <span className="font-medium">{c.name}</span>
                                    <span className="text-gray-400 font-mono truncate">{c.server}</span>
                                </div>
                            ))}
                            {summary.currentContext && (
                                <p className="text-xs text-gray-400 mt-1">
                                    Context: <span className="font-mono">{summary.currentContext}</span>
                                </p>
                            )}
                        </div>
                    </div>
                ) : (
                    <textarea
                        value={kubeContent}
                        onChange={e => { setKubeContent(e.target.value); setError(''); }}
                        placeholder="Paste kubeconfig YAML content..."
                        rows={8}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none mb-4"
                    />
                )}

                {error && (
                    <p className="text-xs text-red-500 mb-3">{error}</p>
                )}

                <div className="flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">Cancel</button>
                    <button
                        onClick={handleUpload}
                        disabled={!kubeContent.trim() || saving}
                        className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
                    >
                        {saving ? 'Uploading...' : 'Upload'}
                    </button>
                </div>
            </div>
        </div>
    );
}
