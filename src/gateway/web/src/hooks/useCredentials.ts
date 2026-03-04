import { useState, useCallback } from 'react';
import type { Credential, CredentialType } from '../pages/Credentials/credentialData';

export function useCredentials(
  sendRpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>,
) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);

  const loadCredentials = useCallback(async () => {
    try {
      const result = await sendRpc<{ credentials: Credential[] }>('credential.list');
      setCredentials(result.credentials ?? []);
    } catch (err) {
      console.error('[useCredentials] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  const createCredential = useCallback(async (data: {
    name: string;
    type: CredentialType;
    description?: string;
    configJson: Record<string, unknown>;
  }) => {
    const result = await sendRpc<{ id: string }>('credential.create', data);
    await loadCredentials();
    return result;
  }, [sendRpc, loadCredentials]);

  const updateCredential = useCallback(async (id: string, data: {
    name?: string;
    description?: string;
    configJson?: Record<string, unknown>;
  }) => {
    await sendRpc('credential.update', { id, ...data });
    await loadCredentials();
  }, [sendRpc, loadCredentials]);

  const deleteCredential = useCallback(async (id: string) => {
    await sendRpc('credential.delete', { id });
    await loadCredentials();
  }, [sendRpc, loadCredentials]);

  return { credentials, loading, loadCredentials, createCredential, updateCredential, deleteCredential };
}
