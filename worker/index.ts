import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ZodError } from 'zod';
import type { AppEnv, Env } from './types';
import { ApiError } from './lib/errors';
import { checkOrigin, login, logout, requireAdmin } from './auth';
import { admin } from './admin';
import { chat, listModels } from './gateway';

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  c.header('X-Request-ID', c.get('requestId'));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Cache-Control', 'no-store');
  await next();
});
app.use('/api/*', bodyLimit({ maxSize: 64 * 1024, onError: () => { throw new ApiError(413, 'payload_too_large', '管理请求不能超过 64 KiB'); } }));
app.use('/v1/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: () => { throw new ApiError(413, 'payload_too_large', '请求不能超过 2 MiB，请使用图片 URL 传递大型图片'); } }));
app.use('/api/*', checkOrigin);
app.get('/api/health', c => c.json({ status: 'ok', service: 'edgegate', setup_required: !c.env.ADMIN_TOKEN || c.env.ADMIN_TOKEN.length < 32 }));
app.post('/api/auth/login', login);
app.use('/api/*', requireAdmin);
app.get('/api/auth/me', c => c.json({ authenticated: true }));
app.post('/api/auth/logout', logout);
app.post('/api/playground', c => chat(c, true));
app.route('/api', admin);
app.get('/v1/models', listModels);
app.post('/v1/chat/completions', c => chat(c));
app.post('/v1/messages', c => chat(c, false, 'anthropic'));
app.notFound(c => c.json({ error: { message: '接口不存在', type: 'not_found', code: 'not_found' } }, 404));
app.onError((error, c) => {
  let status = 500, code = 'internal_error', message = '服务暂时不可用，请使用请求 ID 排查日志';
  if (error instanceof ApiError) ({ status, code, message } = error);
  else if (error instanceof ZodError) { status = 400; code = 'validation_error'; message = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '); }
  else if (error instanceof SyntaxError) { status = 400; code = 'invalid_json'; message = '请求体必须是有效的 JSON'; }
  else console.error(JSON.stringify({ event: 'request_failed', request_id: c.get('requestId'), error_type: error.name }));
  const anthropic = c.req.path === '/v1/messages';
  const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'api_error';
  return new Response(JSON.stringify(anthropic ? { type: 'error', error: { type, message }, request_id: c.get('requestId') } : { error: { message, type: code, code, request_id: c.get('requestId') } }), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Request-ID': c.get('requestId'),
      ...(c.res.headers.get('Retry-After') ? { 'Retry-After': c.res.headers.get('Retry-After')! } : {}),
    },
  });
});
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(env.DB.prepare('DELETE FROM key_counters WHERE day < ?').bind(Math.floor(Date.now() / 86400000) - 2).run());
  },
} satisfies ExportedHandler<Env>;
