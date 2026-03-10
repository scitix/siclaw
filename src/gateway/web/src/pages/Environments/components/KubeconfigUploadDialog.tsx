import { useState } from 'react';

interface EnvOption {
    id: string;
    name: string;
    apiServer: string;
    hasUserKubeconfig: boolean;
}

interface KubeconfigUploadDialogProps {
    environments: EnvOption[];
    initialEnvId?: string;
    onClose: () => void;
    onUploaded: () => void;
    sendRpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

export function KubeconfigUploadDialog({ environments, initialEnvId, onClose, onUploaded, sendRpc }: KubeconfigUploadDialogProps) {
    const [envId, setEnvId] = useState(initialEnvId ?? '');
    const [kubeContent, setKubeContent] = useState('');
    const [saving, setSaving] = useState(false);

    const selectedEnv = environments.find(e => e.id === envId);

    const handleUpload = async () => {
        if (!envId || !kubeContent.trim()) return;
        setSaving(true);
        try {
            await sendRpc('userEnvConfig.set', { envId, kubeconfig: kubeContent });
            onUploaded();
        } catch (err: any) {
            alert(err?.message || 'Failed to upload kubeconfig');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Upload Kubeconfig</h3>

                {/* Environment selector */}
                <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Environment</label>
                    <select
                        value={envId}
                        onChange={e => setEnvId(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
                    >
                        <option value="">Select an environment...</option>
                        {environments.map(env => (
                            <option key={env.id} value={env.id}>
                                {env.name} ({env.apiServer}) {env.hasUserKubeconfig ? '— replace' : ''}
                            </option>
                        ))}
                    </select>
                </div>

                {selectedEnv && (
                    <p className="text-xs text-gray-400 mb-3">
                        API Server: <span className="font-mono">{selectedEnv.apiServer}</span>
                        {selectedEnv.hasUserKubeconfig && ' — existing kubeconfig will be replaced'}
                    </p>
                )}

                <textarea
                    value={kubeContent}
                    onChange={e => setKubeContent(e.target.value)}
                    placeholder="Paste kubeconfig YAML content..."
                    rows={12}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none mb-4"
                />
                <div className="flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">Cancel</button>
                    <button
                        onClick={handleUpload}
                        disabled={!envId || !kubeContent.trim() || saving}
                        className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
                    >
                        {saving ? 'Uploading...' : 'Upload'}
                    </button>
                </div>
            </div>
        </div>
    );
}
