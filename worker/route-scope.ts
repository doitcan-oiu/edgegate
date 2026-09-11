import type { Context } from 'hono';
import type { AppEnv } from './types';
import { invalid, ApiError } from './lib/errors';
import type { RouteScope } from '../shared/route-scope';

export function readRouteScope(c: Context<AppEnv>): RouteScope {
  const tag = c.req.query('tag'), untagged = c.req.query('untagged');
  if (tag !== undefined && untagged !== undefined) throw invalid('只能选择一个标签范围');
  if (tag !== undefined) {
    if (!tag || tag.length > 40) throw invalid('请输入有效的服务商标签');
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

export async function checkRouteScope(c: Context<AppEnv>, channelId: string, routeId?: string) {
  const scope = readRouteScope(c);
  if (scope.kind === 'all') return;
  if (routeId) {
    const condition = scopeCondition(scope, 'channel_id');
    if (!await c.env.DB.prepare(`SELECT id FROM routes WHERE id = ? AND ${condition.sql}`).bind(routeId, ...condition.values).first()) {
      throw new ApiError(409, 'route_scope_changed', '路由已不属于当前标签，请刷新后重试');
    }
  }
  const condition = scopeCondition(scope, 'id');
  if (!await c.env.DB.prepare(`SELECT id FROM channels WHERE id = ? AND ${condition.sql}`).bind(channelId, ...condition.values).first()) {
    throw invalid('目标渠道不属于当前标签，请重新选择');
  }
}

export function requireGlobalModelScope(c: Context<AppEnv>) {
  if (readRouteScope(c).kind !== 'all') throw invalid('模型设置对所有标签生效，不能通过标签范围修改');
}
