export type CredentialType = 'ssh_password' | 'ssh_key' | 'api_token' | 'api_basic_auth';

export interface Credential {
  id: string;
  name: string;
  type: CredentialType;
  description: string | null;
  configSummary: string;
  configJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const CREDENTIAL_TYPE_LABELS: Record<CredentialType, string> = {
  ssh_password: 'SSH Password',
  ssh_key: 'SSH Key',
  api_token: 'API Token',
  api_basic_auth: 'API Basic Auth',
};

export const CREDENTIAL_TYPE_OPTIONS: { value: CredentialType; label: string }[] = [
  { value: 'ssh_password', label: 'SSH Password' },
  { value: 'ssh_key', label: 'SSH Key' },
  { value: 'api_token', label: 'API Token' },
  { value: 'api_basic_auth', label: 'API Basic Auth' },
];
