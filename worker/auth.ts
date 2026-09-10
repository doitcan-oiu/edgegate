import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv, ApiKey, Env } from './types';
import { ApiError } from './lib/errors';
import { constantTimeEqual, randomToken, sha256 } from './lib/crypto';
import { consumeLimit } from './lib/rate-limit';

const cookieName = 'edgegate_session';
const ttl = 60 * 60 * 24;
export async function checkOrigin(c: Context<AppEnv>, next: Next) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('Sec-Fetch-Site') === 'cross-site') {
      throw new ApiError(403, 'origin_denied', '不允许跨站管理请求');
    }
  }
  await next();
}
export async function login(c: Context<AppEnv>) {
  if (!c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length < 32) throw new ApiError(503, 'setup_required', '请先配置至少 32 位的 ADMIN_TOKEN Secret');
  const rate = await consumeLimit(c.env, `login:${await sha256(c.req.header('CF-Connecting-IP') || 'local')}`, 10, 0);
  if (!rate.allowed) { c.header('Retry-After', String(rate.retryAfter)); throw new ApiError(429, 'rate_limited', '登录尝试过于频繁，请稍后重试'); }
  const { token } = z.object({ token: z.string().min(1).max(1024) }).parse(await c.req.json());
  if (!await constantTimeEqual(token, c.env.ADMIN_TOKEN)) throw new ApiError(401, 'invalid_credentials', '管理员令牌不正确');
  const tokenValue = randomToken();
  await c.env.KV.put(`session:${await sha256(tokenValue)}`, JSON.stringify({ expires: Date.now() + ttl * 1000, version: await sha256(c.env.ADMIN_TOKEN) }), { expirationTtl: ttl });
  setCookie(c, cookieName, tokenValue, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', path: '/', maxAge: ttl });
  return c.json({ ok: true });
}
export async function requireAdmin(c: Context<AppEnv>, next: Next) {
  const token = getCookie(c, cookieName);
  if (!token || !c.env.ADMIN_TOKEN) throw new ApiError(401, 'unauthorized', '请先登录管理控制台');
  const id = await sha256(token);
  const session = await c.env.KV.get<{ expires: number; version: string }>(`session:${id}`, 'json');
  if (!session || session.expires < Date.now() || session.version !== await sha256(c.env.ADMIN_TOKEN)) throw new ApiError(401, 'unauthorized', '会话已失效，请重新登录');
  c.set('sessionId', id);
  await next();
}
export async function logout(c: Context<AppEnv>) {
  await c.env.KV.delete(`session:${c.get('sessionId')}`);
  deleteCookie(c, cookieName, { path: '/' });
  return c.json({ ok: true });
}
export async function authenticateKey(request: Request, env: Env): Promise<ApiKey> {
  const token = request.headers.get('Authorization')?.match(/^Bearer\s+(eg_[A-Za-z0-9_-]{43})$/i)?.[1] || request.headers.get('x-api-key')?.match(/^(eg_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new ApiError(401, 'invalid_api_key', '请使用 Bearer API Key 或 x-api-key');
  const key = await env.DB.prepare('SELECT * FROM api_keys WHERE key_hash = ?').bind(await sha256(token)).first<ApiKey>();
  if (!key || key.revoked_at || (key.expires_at && Date.parse(key.expires_at) <= Date.now())) throw new ApiError(401, 'invalid_api_key', 'API Key 无效、已过期或已撤销');
  return key;
}
export function canUseModel(key: Pick<ApiKey, 'allowed_models'>, model: string) {
  const allowed = JSON.parse(key.allowed_models) as string[];
  return allowed.length === 0 || allowed.includes(model);
}
