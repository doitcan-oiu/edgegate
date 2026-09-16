export type RouteGroupStrategy = 'random' | 'weighted' | 'round_robin';

export interface RouteGroup {
  id: string;
  model_id: string;
  name: string;
  priority: number;
  weight: number;
  strategy: RouteGroupStrategy;
  enabled: number;
  created_at: string;
  route_count?: number;
}
