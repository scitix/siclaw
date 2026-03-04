import { useState, useCallback } from 'react';
import type { McpServer, McpTransport } from '../pages/McpServers/mcpServerData';

export function useMcpServers(
  sendRpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>,
) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);

  const loadServers = useCallback(async () => {
    try {
      const result = await sendRpc<{ servers: McpServer[] }>('mcp.list');
      setServers(result.servers ?? []);
    } catch (err) {
      console.error('[useMcpServers] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  const createServer = useCallback(async (data: {
    name: string;
    transport: McpTransport;
    url?: string;
    command?: string;
    argsJson?: string[];
    envJson?: Record<string, string>;
    headersJson?: Record<string, string>;
    description?: string;
  }) => {
    const result = await sendRpc<{ id: string }>('mcp.create', data);
    await loadServers();
    return result;
  }, [sendRpc, loadServers]);

  const updateServer = useCallback(async (id: string, data: {
    name?: string;
    transport?: string;
    url?: string;
    command?: string;
    argsJson?: string[];
    envJson?: Record<string, string>;
    headersJson?: Record<string, string>;
    description?: string;
    enabled?: boolean;
  }) => {
    await sendRpc('mcp.update', { id, ...data });
    await loadServers();
  }, [sendRpc, loadServers]);

  const toggleServer = useCallback(async (id: string) => {
    await sendRpc('mcp.toggle', { id });
    await loadServers();
  }, [sendRpc, loadServers]);

  const deleteServer = useCallback(async (id: string) => {
    await sendRpc('mcp.delete', { id });
    await loadServers();
  }, [sendRpc, loadServers]);

  return { servers, loading, loadServers, createServer, updateServer, toggleServer, deleteServer };
}
