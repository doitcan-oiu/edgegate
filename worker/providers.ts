import type { Env, ProviderProfile } from './types';

type Row = { provider_id: string; protocol: ProviderProfile['protocol']; tags: string; models: string };
const decode = (row?: Row): ProviderProfile => row ? { protocol: row.protocol, tags: JSON.parse(row.tags), models: JSON.parse(row.models) } : { protocol: 'openai', tags: [], models: [] };
export async function profiles(env: Env) {
  const { results } = await env.DB.prepare('SELECT * FROM provider_profiles').all<Row>();
  return new Map(results.map(row => [row.provider_id, decode(row)]));
}
export async function profile(env: Env, id: string): Promise<ProviderProfile> {
  return decode(await env.DB.prepare('SELECT * FROM provider_profiles WHERE provider_id = ?').bind(id).first<Row>() || undefined);
}
function catalogStatements(env: Env, id: string) {
  // Read the current catalog inside the D1 batch. Linking another channel must
  // never write a stale copy of provider tags over a concurrent permission edit.
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO models (id) SELECT value FROM json_each((SELECT models FROM provider_profiles WHERE provider_id = ?))`).bind(id),
    env.DB.prepare(`DELETE FROM routes WHERE managed_by_provider = 1 AND channel_id IN (SELECT id FROM channels WHERE provider_id = ?)
      AND model_id NOT IN (SELECT value FROM json_each((SELECT models FROM provider_profiles WHERE provider_id = ?)))`).bind(id, id),
    env.DB.prepare(`INSERT OR IGNORE INTO routes (id, model_id, channel_id, upstream_model, managed_by_provider)
      SELECT 'rt_' || lower(hex(randomblob(12))), model.value, channel.id, model.value, 1
      FROM channels AS channel, json_each((SELECT models FROM provider_profiles WHERE provider_id = ?)) AS model WHERE channel.provider_id = ?`).bind(id, id),
  ];
}
export async function syncCatalog(env: Env, id: string) {
  await env.DB.batch(catalogStatements(env, id));
}
export async function saveProfile(env: Env, id: string, data: ProviderProfile) {
  const previous = await profile(env, id);
  const statements = [env.DB.prepare(`INSERT INTO provider_profiles (provider_id, protocol, tags, models) VALUES (?, ?, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET protocol = excluded.protocol, tags = excluded.tags, models = excluded.models`)
    .bind(id, data.protocol, JSON.stringify(data.tags), JSON.stringify(data.models))];
  if (previous.protocol !== data.protocol) {
    const from = previous.protocol === 'openai' ? 'chat/completions' : 'messages';
    const to = data.protocol === 'openai' ? 'chat/completions' : 'messages';
    statements.push(env.DB.prepare(`UPDATE channels SET gateway_path = CASE gateway_path WHEN ? THEN ? WHEN ? THEN ? ELSE gateway_path END WHERE provider_id = ?`)
      .bind(from, to, `v1/${from}`, `v1/${to}`, id));
  }
  await env.DB.batch([...statements, ...catalogStatements(env, id)]);
}
