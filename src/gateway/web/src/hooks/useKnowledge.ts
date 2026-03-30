import { useState, useCallback } from 'react';

export interface KnowledgeDoc {
  id: string;
  name: string;
  filePath: string;
  sizeBytes: number;
  chunkCount: number;
  uploadedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  content?: string;
}

export function useKnowledge(
  sendRpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>,
) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDocs = useCallback(async () => {
    try {
      const result = await sendRpc<{ docs: KnowledgeDoc[] }>('kb.list');
      setDocs(result.docs ?? []);
    } catch (err) {
      console.error('[useKnowledge] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  const uploadDoc = useCallback(async (data: {
    content: string;
    fileName?: string;
  }) => {
    const result = await sendRpc<{ id: string; name: string }>('kb.upload', data);
    await loadDocs();
    return result;
  }, [sendRpc, loadDocs]);

  const batchUploadDocs = useCallback(async (docs: Array<{
    content: string;
    fileName?: string;
  }>) => {
    const result = await sendRpc<{
      results: Array<{ id: string; name: string; error?: string }>;
    }>('kb.batchUpload', { docs });
    await loadDocs();
    return result;
  }, [sendRpc, loadDocs]);

  const getDoc = useCallback(async (id: string) => {
    return sendRpc<KnowledgeDoc>('kb.get', { id });
  }, [sendRpc]);

  const deleteDoc = useCallback(async (id: string) => {
    await sendRpc('kb.delete', { id });
    await loadDocs();
  }, [sendRpc, loadDocs]);

  return { docs, loading, loadDocs, uploadDoc, batchUploadDocs, getDoc, deleteDoc };
}
