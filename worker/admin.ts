import { Hono } from 'hono';
import type { AppEnv, Model, Route, RouteGroup } from './types';
import { ApiError, invalid } from './lib/errors';
import { decryptSecret, encryptSecret, encryptionConfigured, randomToken, sha256 } from './lib/crypto';
import { modelSchema, routeSchema, routeCreateSchema, keySchema } from './lib/validation';
import { channels } from './channels';
import { routeGroups } from './route-groups';
import { logs, logDetail, stats } from './observability';
import { channelAvailability } from './channel-availability';
import { getGatewaySettings, saveGatewaySettings } from './settings';
import { getErrorTraces } from './upstream-errors';
import { checkRouteScope, knownTagsSql, readRouteScope, requireGlobalModelScope, routeScopeCondition } from './route-scope';

export const admin = new Hono<AppEnv>();
admin.get('/config', async c => c.json({
  runtime: await getGatewaySettings(c.env),
  account_id: c.env.CLOUDFLARE_ACCOUNT_ID || '', gateway_id: c.env.AI_GATEWAY_ID || 'default',
  ai_token_configured: !!c.env.CF_AI_TOKEN, aig_token_configured: !!c.env.CF_AIG_TOKEN,
  encryption_configured: encryptionConfigured(c.env.ENCRYPTION_KEY),
  control_token_configured: !!c.env.CF_API_TOKEN,
  observability_source: 'cloudflare',
  dashboard_url: `https://dash.cloudflare.com/${c.env.CLOUDFLARE_ACCOUNT_ID || ''}/ai/ai-gateway`,
}));
admin.put('/config/runtime', async c => c.json(await saveGatewaySettings(c.env, await c.req.json())));
admin.get('/traces/:requestId', async c => {
  const requestId = c.req.param('requestId');
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw invalid('请输入有效的 EdgeGate 请求 ID');
  return c.json(await getErrorTraces(c.env, requestId));
});
admin.get('/channels/availability', channelAvailability);
admin.route('/', channels);
admin.route('/', routeGroups);
admin.get('/models', async c => {
  const scope = readRouteScope(c), condition = routeScopeCondition(scope);
  const [models, routes, groups] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM models ORDER BY created_at, id').all<Model>(),
    c.env.DB.prepare(`SELECT * FROM routes WHERE ${condition.sql} ORDER BY priority, id`).bind(...condition.values).all<Route>(),
    c.env.DB.prepare('SELECT g.*, (SELECT COUNT(*) FROM routes r WHERE r.group_id = g.id) AS route_count FROM route_groups g ORDER BY priority, created_at, id').all<RouteGroup>(),
  ]);
  return c.json(models.results.map(model => {
    const modelRoutes = routes.results.filter(route => route.model_id === model.id);
    const modelGroups = groups.results.filter(group => group.model_id === model.id && (scope.kind === 'all' || group.route_count === 0 || modelRoutes.some(route => route.group_id === group.id)));
    return { ...model, routes: modelRoutes, groups: modelGroups };
  }).filter(model => scope.kind === 'all' || model.routes.length || model.groups.length));
});
admin.post('/models', async c => {
  requireGlobalModelScope(c);
  const data = modelSchema.parse(await c.req.json());
  if (await c.env.DB.prepare('SELECT id FROM models WHERE id = ?').bind(data.id).first()) throw new ApiError(409, 'conflict', '模型 ID 已存在');
  await c.env.DB.prepare('INSERT INTO models (id, description, enabled) VALUES (?, ?, ?)').bind(data.id, data.description, +data.enabled).run();
  return c.json({ id: data.id }, 201);
});
admin.put('/models/:id', async c => {
  requireGlobalModelScope(c);
  const data = modelSchema.omit({ id: true }).parse(await c.req.json());
  const result = await c.env.DB.prepare('UPDATE models SET description = ?, enabled = ? WHERE id = ?').bind(data.description, +data.enabled, c.req.param('id')).run();
  if (!result.meta.changes) throw new ApiError(404, 'not_found', '模型不存在');
  return c.json({ ok: true });
});
admin.delete('/models/:id', async c => {
  requireGlobalModelScope(c);
  await c.env.DB.prepare('DELETE FROM models WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
async function validateRoute(data: ReturnType<typeof routeSchema.parse>, db: D1Database, scopeTag: string, excludeId = '', allowNewModel = false) {
  // Older clients omit group_id when editing. Preserve membership until they
  // explicitly choose another group (or null for the default group).
  const groupId = data.group_id !== undefined ? data.group_id
    : excludeId ? (await db.prepare('SELECT group_id FROM routes WHERE id = ?').bind(excludeId).first<{ group_id: string | null }>())?.group_id ?? null : null;
  const [model, channel, duplicate] = await Promise.all([
    db.prepare('SELECT id FROM models WHERE id = ?').bind(data.model_id).first(),
    db.prepare('SELECT id FROM channels WHERE id = ?').bind(data.channel_id).first(),
    db.prepare('SELECT id FROM routes WHERE model_id = ? AND channel_id = ? AND upstream_model = ? AND scope_tag = ? AND id != ?').bind(data.model_id, data.channel_id, data.upstream_model, scopeTag, excludeId).first(),
  ]);
  if ((!model && !allowNewModel) || !channel) throw invalid('请选择有效的模型和渠道');
  if (duplicate) throw new ApiError(409, 'conflict', '该路由已存在');
  if (groupId && !await db.prepare('SELECT id FROM route_groups WHERE id = ? AND model_id = ?').bind(groupId, data.model_id).first()) throw invalid('所选路由组不存在或不属于当前模型');
  return groupId;
}
admin.post('/routes', async c => {
  const data = routeCreateSchema.parse(await c.req.json());
  const { scopeTag, target } = await checkRouteScope(c, data.channel_id);
  const groupId = await validateRoute(data, c.env.DB, scopeTag, '', data.create_model);
  const id = `rt_${randomToken(12)}`;
  // One transaction creates the optional model and its scoped route together.
  // Reusing an ID must preserve its global description and enabled state.
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO models (id) SELECT ? WHERE ? AND EXISTS (SELECT 1 FROM channels WHERE id = ? AND ${target.sql})
        AND (? IS NULL OR EXISTS (SELECT 1 FROM route_groups WHERE id = ? AND model_id = ?))
        ON CONFLICT(id) DO NOTHING`).bind(data.model_id, +data.create_model, data.channel_id, ...target.values, groupId, groupId, data.model_id),
      c.env.DB.prepare(`INSERT INTO routes (id, model_id, channel_id, upstream_model, priority, weight, input_price, output_price, enabled, scope_tag, group_id)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM channels WHERE id = ? AND ${target.sql})
        AND (? IS NULL OR EXISTS (SELECT 1 FROM route_groups WHERE id = ? AND model_id = ?))`)
        .bind(id, data.model_id, data.channel_id, data.upstream_model, data.priority, data.weight, data.input_price, data.output_price, +data.enabled, scopeTag, groupId, data.channel_id, ...target.values, groupId, groupId, data.model_id),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed: routes.model_id, routes.channel_id, routes.upstream_model')) {
      throw new ApiError(409, 'conflict', '该路由已存在');
    }
    throw error;
  }
  if (!results[1].meta.changes) throw new ApiError(409, 'route_scope_changed', '渠道范围已变化，请刷新后重试');
  return c.json({ id, model_id: data.model_id, model_created: !!results[0].meta.changes }, 201);
});
admin.put('/routes/:id', async c => {
  const data = routeSchema.parse(await c.req.json()), id = c.req.param('id');
  const { scopeTag, source, target } = await checkRouteScope(c, data.channel_id, id);
  const groupId = await validateRoute(data, c.env.DB, scopeTag, id);
  const scope = readRouteScope(c);
  const result = await c.env.DB.prepare(`UPDATE routes SET managed_by_provider = 0, model_id = ?, channel_id = ?, upstream_model = ?, priority = ?, weight = ?, input_price = ?, output_price = ?, enabled = ?, scope_tag = ?, group_id = ?
    WHERE id = ? AND ${source.sql} AND EXISTS (SELECT 1 FROM channels WHERE id = ? AND ${target.sql})
    AND (? IS NULL OR EXISTS (SELECT 1 FROM route_groups WHERE id = ? AND model_id = ?))
    AND (? OR group_id IS ?)`)
    .bind(data.model_id, data.channel_id, data.upstream_model, data.priority, data.weight, data.input_price, data.output_price, +data.enabled, scopeTag, groupId, id, ...source.values, data.channel_id, ...target.values, groupId, groupId, data.model_id, +(data.group_id !== undefined), groupId).run();
  if (!result.meta.changes) {
    const exists = await c.env.DB.prepare('SELECT id FROM routes WHERE id = ?').bind(id).first();
    throw new ApiError(scope.kind === 'all' && !exists ? 404 : 409, 'route_scope_changed', '路由不存在或标签、分组已变化，请刷新后重试');
  }
  return c.json({ ok: true });
});
admin.delete('/routes/:id', async c => {
  const scope = readRouteScope(c), condition = routeScopeCondition(scope);
  const result = await c.env.DB.prepare(`DELETE FROM routes WHERE id = ? AND ${condition.sql}`).bind(c.req.param('id'), ...condition.values).run();
  if (scope.kind !== 'all' && !result.meta.changes) throw new ApiError(409, 'route_scope_changed', '路由已不属于当前标签，请刷新后重试');
  return c.json({ ok: true });
});
admin.get('/tags', async c => {
  const { results } = await c.env.DB.prepare(`${knownTagsSql} ORDER BY tag`).all<{ tag: string }>();
  return c.json(results.map(row => row.tag));
});
admin.get('/keys', async c => {
  const { results } = await c.env.DB.prepare(`SELECT k.id, k.name, k.prefix, k.allowed_tags, k.allowed_models, k.rpm, k.daily_limit, k.expires_at, k.revoked_at, k.created_at,
    CASE WHEN k.token_encrypted IS NOT NULL THEN 1 ELSE 0 END AS can_reveal,
    CASE WHEN c.day = ? THEN c.day_count ELSE 0 END AS requests_today
    FROM api_keys k LEFT JOIN key_counters c ON c.key_id = k.id ORDER BY k.created_at DESC`).bind(Math.floor(Date.now() / 86400000)).all();
  return c.json(results.map(row => ({ ...row, can_reveal: !!row.can_reveal, allowed_models: JSON.parse(row.allowed_models as string), allowed_tags: JSON.parse(row.allowed_tags as string) })));
});
admin.get('/keys/:id/token', async c => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT token_encrypted FROM api_keys WHERE id = ?').bind(id).first<{ token_encrypted: string | null }>();
  if (!row) throw new ApiError(404, 'not_found', '应用密钥不存在');
  if (!row.token_encrypted) throw new ApiError(409, 'key_not_recoverable', '此旧密钥仅保存哈希，无法恢复原文；如需可查看的令牌，请创建新密钥');
  if (!encryptionConfigured(c.env.ENCRYPTION_KEY)) throw new ApiError(503, 'encryption_setup_required', '请配置有效的 ENCRYPTION_KEY：32 字节随机数据的 Base64 编码');
  let key: string;
  try { key = await decryptSecret(row.token_encrypted, c.env.ENCRYPTION_KEY, `api-key:${id}`); }
  catch { throw new ApiError(500, 'key_decryption_failed', '无法解密此令牌，请确认 ENCRYPTION_KEY 与创建时一致'); }
  return c.json({ key });
});
admin.post('/keys', async c => {
  const data = keySchema.parse(await c.req.json());
  if (!encryptionConfigured(c.env.ENCRYPTION_KEY)) throw new ApiError(503, 'encryption_setup_required', '请配置有效的 ENCRYPTION_KEY：32 字节随机数据的 Base64 编码');
  if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) throw invalid('过期时间必须晚于当前时间');
  const available = await c.env.DB.prepare('SELECT id FROM models').all<{ id: string }>();
  if (data.allowed_models.some(id => !available.results.some(m => m.id === id))) throw invalid('授权模型不存在');
  const known = await c.env.DB.prepare(knownTagsSql).all<{ tag: string }>();
  if (data.allowed_tags.some(tag => !known.results.some(row => row.tag === tag))) throw invalid('所选服务商标签不存在');
  const key = `eg_${randomToken()}`, id = `key_${randomToken(12)}`;
  const [hash, encrypted] = await Promise.all([sha256(key), encryptSecret(key, c.env.ENCRYPTION_KEY, `api-key:${id}`)]);
  await c.env.DB.prepare('INSERT INTO api_keys (id, name, key_hash, prefix, allowed_models, rpm, daily_limit, expires_at, allowed_tags, token_encrypted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, data.name, hash, key.slice(0, 11), JSON.stringify(data.allowed_models), data.rpm, data.daily_limit, data.expires_at ? new Date(data.expires_at).toISOString() : null, JSON.stringify(data.allowed_tags), encrypted).run();
  return c.json({ id, key }, 201);
});
admin.delete('/keys/:id', async c => {
  await c.env.DB.prepare("UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND revoked_at IS NULL").bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
admin.get('/logs', logs);
admin.get('/logs/:id', logDetail);
admin.get('/stats', stats);
