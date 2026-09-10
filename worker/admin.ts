import { Hono } from 'hono';
import type { AppEnv, Model, Route } from './types';
import { ApiError, invalid } from './lib/errors';
import { encryptionConfigured, randomToken, sha256 } from './lib/crypto';
import { modelSchema, routeSchema, keySchema } from './lib/validation';
import { channels } from './channels';
import { logs, logDetail, stats } from './observability';

export const admin = new Hono<AppEnv>();
admin.get('/config', c => c.json({
  account_id: c.env.CLOUDFLARE_ACCOUNT_ID || '', gateway_id: c.env.AI_GATEWAY_ID || 'default',
  ai_token_configured: !!c.env.CF_AI_TOKEN, aig_token_configured: !!c.env.CF_AIG_TOKEN,
  encryption_configured: encryptionConfigured(c.env.ENCRYPTION_KEY),
  control_token_configured: !!c.env.CF_API_TOKEN,
  observability_source: 'cloudflare',
  dashboard_url: `https://dash.cloudflare.com/${c.env.CLOUDFLARE_ACCOUNT_ID || ''}/ai/ai-gateway`,
}));
admin.route('/', channels);
admin.get('/models', async c => {
  const [models, routes] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM models ORDER BY created_at, id').all<Model>(),
    c.env.DB.prepare('SELECT * FROM routes ORDER BY priority, id').all<Route>(),
  ]);
  return c.json(models.results.map(model => ({ ...model, routes: routes.results.filter(route => route.model_id === model.id) })));
});
admin.post('/models', async c => {
  const data = modelSchema.parse(await c.req.json());
  if (await c.env.DB.prepare('SELECT id FROM models WHERE id = ?').bind(data.id).first()) throw new ApiError(409, 'conflict', '模型 ID 已存在');
  await c.env.DB.prepare('INSERT INTO models (id, description, enabled) VALUES (?, ?, ?)').bind(data.id, data.description, +data.enabled).run();
  return c.json({ id: data.id }, 201);
});
admin.put('/models/:id', async c => {
  const data = modelSchema.omit({ id: true }).parse(await c.req.json());
  const result = await c.env.DB.prepare('UPDATE models SET description = ?, enabled = ? WHERE id = ?').bind(data.description, +data.enabled, c.req.param('id')).run();
  if (!result.meta.changes) throw new ApiError(404, 'not_found', '模型不存在');
  return c.json({ ok: true });
});
admin.delete('/models/:id', async c => {
  await c.env.DB.prepare('DELETE FROM models WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
async function validateRoute(data: ReturnType<typeof routeSchema.parse>, db: D1Database, excludeId = '') {
  const [model, channel, duplicate] = await Promise.all([
    db.prepare('SELECT id FROM models WHERE id = ?').bind(data.model_id).first(),
    db.prepare('SELECT id FROM channels WHERE id = ?').bind(data.channel_id).first(),
    db.prepare('SELECT id FROM routes WHERE model_id = ? AND channel_id = ? AND upstream_model = ? AND id != ?').bind(data.model_id, data.channel_id, data.upstream_model, excludeId).first(),
  ]);
  if (!model || !channel) throw invalid('请选择有效的模型和渠道');
  if (duplicate) throw new ApiError(409, 'conflict', '该路由已存在');
}
admin.post('/routes', async c => {
  const data = routeSchema.parse(await c.req.json());
  await validateRoute(data, c.env.DB);
  const id = `rt_${randomToken(12)}`;
  await c.env.DB.prepare('INSERT INTO routes (id, model_id, channel_id, upstream_model, priority, weight, input_price, output_price, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, data.model_id, data.channel_id, data.upstream_model, data.priority, data.weight, data.input_price, data.output_price, +data.enabled).run();
  return c.json({ id }, 201);
});
admin.put('/routes/:id', async c => {
  const data = routeSchema.parse(await c.req.json()), id = c.req.param('id');
  await validateRoute(data, c.env.DB, id);
  const result = await c.env.DB.prepare('UPDATE routes SET managed_by_provider = 0, model_id = ?, channel_id = ?, upstream_model = ?, priority = ?, weight = ?, input_price = ?, output_price = ?, enabled = ? WHERE id = ?')
    .bind(data.model_id, data.channel_id, data.upstream_model, data.priority, data.weight, data.input_price, data.output_price, +data.enabled, id).run();
  if (!result.meta.changes) throw new ApiError(404, 'not_found', '路由不存在');
  return c.json({ ok: true });
});
admin.delete('/routes/:id', async c => {
  await c.env.DB.prepare('DELETE FROM routes WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
admin.get('/tags', async c => {
  const { results } = await c.env.DB.prepare('SELECT DISTINCT value AS tag FROM provider_profiles, json_each(provider_profiles.tags) ORDER BY value').all<{ tag: string }>();
  return c.json(results.map(row => row.tag));
});
admin.get('/keys', async c => {
  const { results } = await c.env.DB.prepare(`SELECT k.id, k.name, k.prefix, k.allowed_tags, k.allowed_models, k.rpm, k.daily_limit, k.expires_at, k.revoked_at, k.created_at,
    CASE WHEN c.day = ? THEN c.day_count ELSE 0 END AS requests_today
    FROM api_keys k LEFT JOIN key_counters c ON c.key_id = k.id ORDER BY k.created_at DESC`).bind(Math.floor(Date.now() / 86400000)).all();
  return c.json(results.map(row => ({ ...row, allowed_models: JSON.parse(row.allowed_models as string), allowed_tags: JSON.parse(row.allowed_tags as string) })));
});
admin.post('/keys', async c => {
  const data = keySchema.parse(await c.req.json());
  if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) throw invalid('过期时间必须晚于当前时间');
  const available = await c.env.DB.prepare('SELECT id FROM models').all<{ id: string }>();
  if (data.allowed_models.some(id => !available.results.some(m => m.id === id))) throw invalid('授权模型不存在');
  const known = await c.env.DB.prepare('SELECT DISTINCT value AS tag FROM provider_profiles, json_each(provider_profiles.tags)').all<{ tag: string }>();
  if (data.allowed_tags.some(tag => !known.results.some(row => row.tag === tag))) throw invalid('所选服务商标签不存在');
  const key = `eg_${randomToken()}`, id = `key_${randomToken(12)}`;
  await c.env.DB.prepare('INSERT INTO api_keys (id, name, key_hash, prefix, allowed_models, rpm, daily_limit, expires_at, allowed_tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, data.name, await sha256(key), key.slice(0, 11), JSON.stringify(data.allowed_models), data.rpm, data.daily_limit, data.expires_at ? new Date(data.expires_at).toISOString() : null, JSON.stringify(data.allowed_tags)).run();
  return c.json({ id, key }, 201);
});
admin.delete('/keys/:id', async c => {
  await c.env.DB.prepare("UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND revoked_at IS NULL").bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
admin.get('/logs', logs);
admin.get('/logs/:id', logDetail);
admin.get('/stats', stats);
