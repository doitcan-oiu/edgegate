export type RouteScope = { kind: 'all' } | { kind: 'untagged' } | { kind: 'tag'; tag: string };

export function matchesRouteScope(tags: string[], scope: RouteScope) {
  return scope.kind === 'all' || (scope.kind === 'untagged' ? tags.length === 0 : tags.includes(scope.tag));
}

export function routeScopeQuery(scope: RouteScope) {
  return scope.kind === 'all' ? '' : `?${new URLSearchParams(scope.kind === 'tag' ? { tag: scope.tag } : { untagged: '1' })}`;
}

export function matchesScopedRoute(route: { scope_tag?: string }, channelTags: string[], scope: RouteScope) {
  return matchesRouteScope(route.scope_tag ? [route.scope_tag] : channelTags, scope);
}

export function routeScopeTags(models: { routes: { scope_tag?: string }[] }[], channels: { tags: string[] }[]) {
  return [...new Set([...channels.flatMap(channel => channel.tags), ...models.flatMap(model => model.routes.flatMap(route => route.scope_tag ? [route.scope_tag] : []))])].sort();
}

export function scopeModels<T extends { routes: R[] }, R extends { channel_id: string; scope_tag?: string }>(models: T[], channels: { id: string; tags: string[] }[], scope: RouteScope): T[] {
  if (scope.kind === 'all') return models;
  const byId = new Map(channels.map(channel => [channel.id, channel]));
  return models.map(model => ({ ...model, routes: model.routes.filter(route => {
    const channel = byId.get(route.channel_id);
    return channel && matchesScopedRoute(route, channel.tags, scope);
  }) })).filter(model => model.routes.length > 0);
}
