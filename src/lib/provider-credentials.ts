import { env } from './env.ts';
import type { ProviderId } from './search.ts';

export interface EncryptedProviderCredential {
  encrypted_key: string;
  iv: string;
}

const encoder = new TextEncoder();
const MIN_SECRET_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret = env('XWEB_PROVIDER_KEY_ENCRYPTION_KEY')): Promise<CryptoKey> {
  if (!secret || encoder.encode(secret).byteLength < MIN_SECRET_BYTES) {
    throw new Error('Provider credential encryption is not configured.');
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptProviderKey(value: string, secret?: string): Promise<EncryptedProviderCredential> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(value));
  return { encrypted_key: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}

export async function decryptProviderKey(
  credential: EncryptedProviderCredential,
  secret?: string,
): Promise<string> {
  const key = await encryptionKey(secret);
  const iv = fromBase64(credential.iv).buffer as ArrayBuffer;
  const encrypted = fromBase64(credential.encrypted_key).buffer as ArrayBuffer;
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encrypted,
  );
  return new TextDecoder().decode(plaintext);
}

export interface StoredProviderCredential extends EncryptedProviderCredential {
  provider: ProviderId;
}

/** Decrypt the current user's saved provider keys for server-side search use. */
export async function decryptProviderKeyMap(
  credentials: StoredProviderCredential[],
): Promise<Partial<Record<ProviderId, string>>> {
  const entries = await Promise.all(credentials.map(async ({ provider, encrypted_key, iv }) => [
    provider,
    await decryptProviderKey({ encrypted_key, iv }),
  ] as const));
  return Object.fromEntries(entries) as Partial<Record<ProviderId, string>>;
}
