const encoder = new TextEncoder();
export function randomToken(size = 32): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(size)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
export function encryptionConfigured(value: string | undefined) {
  try { return !!value && atob(value).length === 32; } catch { return false; }
}
async function encryptionKey(value: string | undefined) {
  if (!value) throw new Error('ENCRYPTION_KEY is not configured');
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptSecret(value: string, secret: string | undefined, channelId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(channelId) }, await encryptionKey(secret), encoder.encode(value));
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(result)))}`;
}
export async function decryptSecret(value: string, secret: string | undefined, channelId: string) {
  const [iv, data] = value.split('.').map(v => Uint8Array.from(atob(v), c => c.charCodeAt(0)));
  const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(channelId) }, await encryptionKey(secret), data);
  return new TextDecoder().decode(result);
}
