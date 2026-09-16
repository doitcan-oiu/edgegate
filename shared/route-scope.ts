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

export function scopeModels<T extends { routes: R[]; groups?: { id: string; route_count?: number }[] }, R extends { channel_id: string; scope_tag?: string; group_id?: string | null }>(models: T[], channels: { id: string; tags: string[] }[], scope: RouteScope): T[] {
  if (scope.kind === 'all') return models;
  const byId = new Map(channels.map(channel => [channel.id, channel]));
  return models.map(model => {
    const routes = model.routes.filter(route => {
      const channel = byId.get(route.channel_id);
      return channel && matchesScopedRoute(route, channel.tags, scope);
    });
    const groups = model.groups?.filter(group => routes.some(route => route.group_id === group.id)
      || (group.route_count ?? model.routes.filter(route => route.group_id === group.id).length) === 0);
    return { ...model, routes, ...(groups && { groups }) };
  }).filter(model => model.routes.length > 0 || !!model.groups?.length);
}
