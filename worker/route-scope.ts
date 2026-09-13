import type { Context } from 'hono';
import type { AppEnv } from './types';
import { invalid, ApiError } from './lib/errors';
import type { RouteScope } from '../shared/route-scope';
import { tagsSchema } from './lib/validation';

export const knownTagsSql = `SELECT value AS tag FROM provider_profiles, json_each(provider_profiles.tags)
  UNION SELECT scope_tag AS tag FROM routes WHERE scope_tag != ''`;

export function readRouteScope(c: Context<AppEnv>): RouteScope {
  const tag = c.req.query('tag'), untagged = c.req.query('untagged');
  if (tag !== undefined && untagged !== undefined) throw invalid('只能选择一个标签范围');
  if (tag !== undefined) {
    if (!tagsSchema.safeParse([tag]).success || tag.trim() !== tag) throw invalid('请输入有效的标签');
    return { kind: 'tag', tag };
  }
  if (untagged !== undefined && untagged !== '1') throw invalid('未打标签筛选值无效');
  return untagged === '1' ? { kind: 'untagged' } : { kind: 'all' };
}

export function scopeCondition(scope: RouteScope, channelColumn: string) {
  if (scope.kind === 'all') return { sql: '1 = 1', values: [] as string[] };
  const match = scope.kind === 'tag' ? 'EXISTS (SELECT 1 FROM json_each(p.tags) t WHERE t.value = ?)' : "json_array_length(COALESCE(p.tags, '[]')) = 0";
  return { sql: `${channelColumn} IN (SELECT c.id FROM channels c LEFT JOIN provider_profiles p ON p.provider_id = c.provider_id WHERE ${match})`, values: scope.kind === 'tag' ? [scope.tag] : [] };
}

export function routeScopeCondition(scope: RouteScope, channelColumn = 'channel_id', tagColumn = 'scope_tag') {
  if (scope.kind === 'all') return { sql: '1 = 1', values: [] as string[] };
  const inherited = scopeCondition(scope, channelColumn);
  return scope.kind === 'tag'
    ? { sql: `(${tagColumn} = ? OR (${tagColumn} = '' AND ${inherited.sql}))`, values: [scope.tag, ...inherited.values] }
    : { sql: `(${tagColumn} = '' AND ${inherited.sql})`, values: inherited.values };
}

export async function checkRouteScope(c: Context<AppEnv>, channelId: string, routeId?: string) {
  const scope = readRouteScope(c);
  let scopeTag = '';
  if (routeId) {
    const condition = routeScopeCondition(scope);
    const route = await c.env.DB.prepare(`SELECT scope_tag FROM routes WHERE id = ? AND ${condition.sql}`).bind(routeId, ...condition.values).first<{ scope_tag: string }>();
    if (!route) {
      throw new ApiError(scope.kind === 'all' ? 404 : 409, 'route_scope_changed', '路由不存在或已不属于当前标签，请刷新后重试');
    }
    scopeTag = route.scope_tag;
  }
  if (scope.kind === 'tag') {
    if (!await c.env.DB.prepare(`SELECT tag FROM (${knownTagsSql}) WHERE tag = ?`).bind(scope.tag).first()) throw invalid('所选标签不存在，请刷新后重试');
    const inherited = scopeCondition(scope, 'id');
    if (!await c.env.DB.prepare(`SELECT id FROM channels WHERE id = ? AND ${inherited.sql}`).bind(channelId, ...inherited.values).first()) scopeTag = scope.tag;
  }
  // Explicit routes may target any channel. Inherited writes still check channel
  // membership inside the transaction, so stale tags cannot broaden access.
  const target = scopeTag ? { sql: '1 = 1', values: [] as string[] } : scopeCondition(scope, 'id');
  if (!await c.env.DB.prepare(`SELECT id FROM channels WHERE id = ? AND ${target.sql}`).bind(channelId, ...target.values).first()) throw invalid('请选择有效的目标渠道；未打标签范围只能使用未打标签渠道');
  return { scopeTag, target, source: routeScopeCondition(scope) };
}

export function requireGlobalModelScope(c: Context<AppEnv>) {
  if (readRouteScope(c).kind !== 'all') throw invalid('模型设置对所有标签生效，不能通过标签范围修改');
}
