import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decryptProviderKey, encryptProviderKey } from './provider-credentials.ts';

const secret = 'x-web-provider-key-encryption-test-secret-32-bytes';

describe('provider credential encryption', () => {
  it('encrypts and decrypts a provider key', async () => {
    const encrypted = await encryptProviderKey('test-provider-secret-123', secret);
    assert.notEqual(encrypted.encrypted_key, 'test-provider-secret-123');
    assert.equal(await decryptProviderKey(encrypted, secret), 'test-provider-secret-123');
  });

  it('uses a fresh nonce for each encryption', async () => {
    const first = await encryptProviderKey('same-key', secret);
    const second = await encryptProviderKey('same-key', secret);
    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.encrypted_key, second.encrypted_key);
  });

  it('rejects tampering and incorrect secrets', async () => {
    const encrypted = await encryptProviderKey('test-provider-secret-123', secret);
    await assert.rejects(() => decryptProviderKey(encrypted, `${secret}-wrong`));
    await assert.rejects(() => decryptProviderKey({ ...encrypted, encrypted_key: `${encrypted.encrypted_key.slice(0, -2)}AA` }, secret));
  });

  it('rejects a missing or weak encryption secret', async () => {
    await assert.rejects(() => encryptProviderKey('secret', 'too-short'), /not configured/);
  });
});
