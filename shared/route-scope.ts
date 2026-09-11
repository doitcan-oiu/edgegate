export type RouteScope = { kind: 'all' } | { kind: 'untagged' } | { kind: 'tag'; tag: string };

export function matchesRouteScope(tags: string[], scope: RouteScope) {
  return scope.kind === 'all' || (scope.kind === 'untagged' ? tags.length === 0 : tags.includes(scope.tag));
}

export function routeScopeQuery(scope: RouteScope) {
  return scope.kind === 'all' ? '' : `?${new URLSearchParams(scope.kind === 'tag' ? { tag: scope.tag } : { untagged: '1' })}`;
}

export function scopeModels<T extends { routes: R[] }, R extends { channel_id: string }>(models: T[], channelIds: Set<string>, scope: RouteScope): T[] {
  if (scope.kind === 'all') return models;
  return models.map(model => ({ ...model, routes: model.routes.filter(route => channelIds.has(route.channel_id)) })).filter(model => model.routes.length > 0);
}
