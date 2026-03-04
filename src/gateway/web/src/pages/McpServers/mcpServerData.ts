export type McpTransport = 'stdio' | 'sse' | 'streamable-http';

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  argsJson?: string[];
  envJson?: Record<string, string>;
  headersJson?: Record<string, string>;
  enabled: boolean;
  description?: string | null;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

export const MCP_TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'Stdio',
  sse: 'SSE',
  'streamable-http': 'Streamable HTTP',
};

export const MCP_TRANSPORT_OPTIONS: { value: McpTransport; label: string }[] = [
  { value: 'streamable-http', label: 'Streamable HTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'stdio', label: 'Stdio' },
];
