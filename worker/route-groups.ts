import { Hono } from 'hono';
import type { AppEnv } from './types';
import { ApiError, invalid } from './lib/errors';
import { randomToken } from './lib/crypto';
import { routeGroupCreateSchema, routeGroupSchema } from './lib/validation';
import { requireGlobalModelScope } from './route-scope';

export const routeGroups = new Hono<AppEnv>();

routeGroups.post('/route-groups', async c => {
  requireGlobalModelScope(c);
  const data = routeGroupCreateSchema.parse(await c.req.json());
  if (!data.create_model && !await c.env.DB.prepare('SELECT id FROM models WHERE id = ?').bind(data.model_id).first()) throw invalid('请选择有效的模型');
  const id = `rg_${randomToken(12)}`;
  const results = await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO models (id) SELECT ? WHERE ? ON CONFLICT(id) DO NOTHING').bind(data.model_id, +data.create_model),
    c.env.DB.prepare('INSERT INTO route_groups (id, model_id, name, priority, weight, strategy, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, data.model_id, data.name, data.priority, data.weight, data.strategy, +data.enabled),
  ]);
  return c.json({ id, model_id: data.model_id, model_created: !!results[0].meta.changes }, 201);
});

routeGroups.put('/route-groups/:id', async c => {
  requireGlobalModelScope(c);
  const data = routeGroupSchema.parse(await c.req.json()), id = c.req.param('id');
  const group = await c.env.DB.prepare('SELECT model_id FROM route_groups WHERE id = ?').bind(id).first<{ model_id: string }>();
  if (!group) throw new ApiError(404, 'not_found', '路由组不存在');
  if (group.model_id !== data.model_id) throw invalid('路由组不能移到其他模型，请创建新组');
  const result = await c.env.DB.prepare('UPDATE route_groups SET name = ?, priority = ?, weight = ?, strategy = ?, enabled = ? WHERE id = ? AND model_id = ?')
    .bind(data.name, data.priority, data.weight, data.strategy, +data.enabled, id, data.model_id).run();
  if (!result.meta.changes) throw new ApiError(404, 'not_found', '路由组不存在');
  return c.json({ ok: true });
});

routeGroups.delete('/route-groups/:id', async c => {
  requireGlobalModelScope(c);
  const id = c.req.param('id');
  // Check emptiness in the same statement: deleting a populated group must never
  // move its routes to the active default group through ON DELETE SET NULL.
  const result = await c.env.DB.prepare('DELETE FROM route_groups WHERE id = ? AND NOT EXISTS (SELECT 1 FROM routes WHERE group_id = route_groups.id)').bind(id).run();
  if (!result.meta.changes) {
    if (await c.env.DB.prepare('SELECT id FROM route_groups WHERE id = ?').bind(id).first()) throw new ApiError(409, 'group_not_empty', '请先移出或删除组内所有标签的路由，再删除路由组');
    throw new ApiError(404, 'not_found', '路由组不存在');
  }
  return c.json({ ok: true });
});
