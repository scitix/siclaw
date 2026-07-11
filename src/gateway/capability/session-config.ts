import type { CapabilityLlmConfig } from "./contract.js";

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

/**
 * Resolve the LLM block sent to a capability box's /session endpoint.
 *
 * Consumer ownership is whole-block: even an empty consumer object is
 * authoritative. Runtime's Helm credentials are consulted only when the
 * consumer omitted the object entirely, which prevents a tenant-selected URL
 * from accidentally receiving a Runtime-owned token.
 */
export function resolveCapabilitySessionLlm(
  consumer: CapabilityLlmConfig | undefined,
  env: RuntimeEnv = process.env,
): CapabilityLlmConfig | undefined {
  if (consumer !== undefined) return consumer;

  const authToken = nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
  const apiKey = authToken ? undefined : nonEmpty(env.ANTHROPIC_API_KEY);
  const fallback: CapabilityLlmConfig = {
    base_url: nonEmpty(env.ANTHROPIC_BASE_URL),
    auth_token: authToken,
    api_key: apiKey,
    model: nonEmpty(env.ANTHROPIC_MODEL),
  };

  return Object.values(fallback).some((value) => value !== undefined) ? fallback : undefined;
}
