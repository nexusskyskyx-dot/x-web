import { decryptProviderKey, encryptProviderKey, type EncryptedProviderCredential } from './provider-credentials.ts';

export const AI_PROVIDERS = ['openai', 'anthropic', 'groq'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiCredential extends EncryptedProviderCredential {
  provider: AiProvider;
  model: string;
}

export interface AiRuntimeConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
  source: 'byok' | 'xweb';
  baseUrl?: string;
}

export const AI_DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  groq: 'llama-3.3-70b-versatile',
};

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

export async function encryptAiKey(apiKey: string) {
  return encryptProviderKey(apiKey);
}

export async function decryptAiCredential(credential: AiCredential): Promise<AiRuntimeConfig> {
  return {
    provider: credential.provider,
    model: credential.model,
    apiKey: await decryptProviderKey(credential),
    source: 'byok',
  };
}
