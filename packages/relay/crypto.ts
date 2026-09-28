import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Authenticate and encrypt private records with a context-specific AAD. */
export function encrypt(value: unknown, key: Buffer, context: string): string {
  if (key.length !== 32) throw new Error('A 32-byte encryption key is required');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** Decrypt only the record bound to the supplied context; tampering fails closed. */
export function decrypt<T>(value: string, key: Buffer, context: string): T {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  decipher.setAAD(Buffer.from(context));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as T;
}

/** Persist token digests, never public bearer-token values. */
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Constant-time bearer comparison, including different-length inputs. */
export function tokenMatches(value: string, expectedDigest: string): boolean {
  return timingSafeEqual(Buffer.from(digest(value)), Buffer.from(expectedDigest));
}
