import { Hono } from 'hono';
import type { AppEnv, Channel, Env } from './types';
import { ApiError, invalid } from './lib/errors';
import { encryptionConfigured, encryptSecret, randomToken } from './lib/crypto';
import { channelSchema, providerSchema, safeBaseUrl } from './lib/validation';
import { channelConfigured } from './upstream';
import { profile, profiles, saveProfile, syncCatalog } from './providers';
import { cfApi, providerPath, publicProvider, type CustomProvider } from './cloudflare';

export const channels = new Hono<AppEnv>();
channels.get('/providers', async c => {
  const page = Math.max(1, Math.floor(Number(c.req.query('page')) || 1));
  const query = new URLSearchParams({ page: String(page), per_page: '50' });
  if (c.req.query('search')) query.set('search', c.req.query('search')!.slice(0, 100));
  const result = await cfApi<CustomProvider[]>(c.env, `${providerPath(c.env)}?${query}`);
  const local = await profiles(c.env);
  return c.json({ data: result.result.map(provider => ({ ...publicProvider(provider), ...(local.get(provider.id) || { protocol: 'openai', tags: [], models: [] }) })), page, total: result.result_info?.total_count ?? null,
    has_more: result.result_info?.total_pages != null ? page < result.result_info.total_pages : result.result.length === 50,
  });
});
channels.post('/providers', async c => {
  const data = providerSchema.parse(await c.req.json());
  const result = await cfApi<CustomProvider>(c.env, providerPath(c.env), { method: 'POST', body: JSON.stringify({ name: data.name, slug: data.slug, description: data.description, enable: data.enable, base_url: safeBaseUrl(data.base_url) }) });
  await saveProfile(c.env, result.result.id, data);
  return c.json({ ...publicProvider(result.result), ...await profile(c.env, result.result.id) }, 201);
});
channels.patch('/providers/:id', async c => {
  const id = c.req.param('id');
  const data = providerSchema.parse({ ...await profile(c.env, id), ...await c.req.json() });
  // A slug/endpoint change could redirect existing credentials in other gateways.
  // Expose name/description/enable edits here; use a new provider for a new destination.
  const previous = (await cfApi<CustomProvider>(c.env, `${providerPath(c.env)}/${encodeURIComponent(id)}`)).result;
  if (data.slug !== previous.slug || safeBaseUrl(data.base_url) !== safeBaseUrl(previous.base_url)) throw invalid('已有服务商的 slug 和地址不可在此修改，请新建服务商以保护现有凭据');
  const result = await cfApi<CustomProvider>(c.env, `${providerPath(c.env)}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name: data.name, description: data.description, enable: data.enable }) });
  await saveProfile(c.env, id, data);
  return c.json({ ...publicProvider(result.result), ...await profile(c.env, id) });
});
channels.delete('/providers/:id', async c => {
  const id = c.req.param('id');
  if (await c.env.DB.prepare('SELECT id FROM channels WHERE provider_id = ? LIMIT 1').bind(id).first()) throw new ApiError(409, 'provider_in_use', '请先解除本程序中关联此服务商的渠道');
  await cfApi(c.env, `${providerPath(c.env)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await c.env.DB.prepare('DELETE FROM provider_profiles WHERE provider_id = ?').bind(id).run();
  return c.json({ ok: true });
});

type ChannelData = ReturnType<typeof channelSchema.parse>;
async function encryptChannelSecret(env: Env, secret: string, id: string) {
  if (!encryptionConfigured(env.ENCRYPTION_KEY)) throw new ApiError(503, 'encryption_setup_required', '请配置有效的 ENCRYPTION_KEY：32 字节随机数据的 Base64 编码');
  return encryptSecret(secret, env.ENCRYPTION_KEY, id);
}
async function resolveCustom(env: Env, data: ChannelData, id: string, previous?: Channel) {
  const previousCustom = previous?.kind === 'openai' ? previous : undefined;
  // Requests from older clients infer the credential mode; new forms choose it explicitly.
  const mode = data.credential_mode || (data.secret ? 'local' : data.byok_alias ? 'byok' : previousCustom?.secret_encrypted ? 'local' : previousCustom?.byok_alias ? 'byok' : 'local');
  if (mode === 'byok' && data.secret) throw invalid('使用已有 BYOK 别名时无需填写 API Key；请切换为程序加密存储后保存新密钥');
  if (!data.secret && !data.byok_alias && !previousCustom?.byok_alias && !previousCustom?.secret_encrypted) {
    throw invalid('请提供供应商 API Key 或已存在的 Cloudflare BYOK 别名');
  }
  // Validate encryption before creating any account-level provider resources.
  const newEncrypted = data.secret ? await encryptChannelSecret(env, data.secret, id) : null;
  let provider: CustomProvider;
  if (data.provider_id) {
    provider = (await cfApi<CustomProvider>(env, `${providerPath(env)}/${encodeURIComponent(data.provider_id)}`)).result;
  } else if (previous?.provider_id && previous.kind === 'openai') {
    provider = (await cfApi<CustomProvider>(env, `${providerPath(env)}/${encodeURIComponent(previous.provider_id)}`)).result;
  } else {
    if (!data.provider_slug) throw invalid('请选择已有 Cloudflare 服务商，或填写 slug 创建服务商');
    provider = (await cfApi<CustomProvider>(env, providerPath(env), { method: 'POST', body: JSON.stringify({ name: data.name, slug: data.provider_slug, base_url: safeBaseUrl(data.base_url), enable: true }) })).result;
  }
  const exists = await env.DB.prepare('SELECT provider_id FROM provider_profiles WHERE provider_id = ?').bind(provider.id).first();
  if (!exists) await saveProfile(env, provider.id, data);
  const existingProfile = await profile(env, provider.id);
  const defaultPath = `${new URL(provider.base_url).pathname.replace(/\/+$/, '').endsWith('/v1') ? '' : 'v1/'}${existingProfile.protocol === 'anthropic' ? 'messages' : 'chat/completions'}`;
  const path = (data.gateway_path || (previousCustom?.provider_id === provider.id ? previousCustom.gateway_path : '') || defaultPath).replace(/^\/+|\/+$/g, '');
  if (!path) throw invalid('上游请求路径不能为空');
  const previousEndpoint = previousCustom?.base_url ? `${safeBaseUrl(previousCustom.base_url)}/${previousCustom.provider_id ? previousCustom.gateway_path : 'chat/completions'}` : '';
  const sameProvider = !!previousCustom && (!previousCustom.provider_id || (previousCustom.provider_id === provider.id && previousCustom.provider_slug === provider.slug));
  const sameDestination = sameProvider && previousEndpoint === `${safeBaseUrl(provider.base_url)}/${path}`;
  // Never silently carry a saved credential across a provider or endpoint change.
  const encrypted = mode === 'local' ? newEncrypted || (sameDestination ? previousCustom?.secret_encrypted : null) : null;
  const alias = mode === 'byok' ? data.byok_alias || (sameDestination ? previousCustom?.byok_alias : '') || '' : '';
  if (!encrypted && !alias) throw invalid(mode === 'local'
    ? '请填写供应商 API Key；更换服务商或请求地址时需重新输入密钥'
    : '请填写此服务商在当前 AI Gateway 中已存在的 BYOK 别名');
  return { provider, path, alias, encrypted };
}
channels.get('/channels', async c => {
  const { results } = await c.env.DB.prepare('SELECT * FROM channels ORDER BY created_at DESC').all<Channel>();
  const local = await profiles(c.env);
  return c.json(results.map(({ secret_encrypted, ...channel }) => ({ ...channel, ...(local.get(channel.provider_id || '') || { protocol: 'openai', tags: [], models: [] }), has_secret: !!secret_encrypted,
    configured: channelConfigured({ ...channel, secret_encrypted }, c.env),
  })));
});
channels.post('/channels', async c => {
  const data = channelSchema.parse(await c.req.json()), id = `ch_${randomToken(12)}`;
  const custom = data.kind === 'openai' ? await resolveCustom(c.env, data, id) : null;
  const encrypted = custom ? custom.encrypted : data.secret ? await encryptChannelSecret(c.env, data.secret, id) : null;
  try {
    await c.env.DB.prepare('INSERT INTO channels (id, name, kind, base_url, secret_encrypted, enabled, timeout_ms, provider_id, provider_slug, gateway_path, byok_alias) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, data.name, data.kind, custom?.provider.base_url || '', encrypted, +data.enabled, data.timeout_ms, custom?.provider.id || null, custom?.provider.slug || null, custom?.path || data.gateway_path || 'chat/completions', custom?.alias || '').run();
  } catch (error) {
    if (custom) throw new ApiError(503, 'local_save_failed', `Cloudflare 服务商 ${custom.provider.slug} 已准备好，但本地保存失败；请从已有服务商关联并重新填写凭据`);
    throw error;
  }
  if (custom) await syncCatalog(c.env, custom.provider.id);
  return c.json({ id }, 201);
});
channels.put('/channels/:id', async c => {
  const id = c.req.param('id');
  const previous = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<Channel>();
  if (!previous) throw new ApiError(404, 'not_found', '渠道不存在');
  const data = channelSchema.parse(await c.req.json());
  const custom = data.kind === 'openai' ? await resolveCustom(c.env, data, id, previous) : null;
  const encrypted = custom ? custom.encrypted : data.secret ? await encryptChannelSecret(c.env, data.secret, id) : data.kind === previous.kind ? previous.secret_encrypted : null;
  try {
    await c.env.DB.prepare('UPDATE channels SET name = ?, kind = ?, base_url = ?, secret_encrypted = ?, enabled = ?, timeout_ms = ?, provider_id = ?, provider_slug = ?, gateway_path = ?, byok_alias = ? WHERE id = ?')
      .bind(data.name, data.kind, custom?.provider.base_url || '', encrypted, +data.enabled, data.timeout_ms, custom?.provider.id || null, custom?.provider.slug || null, custom?.path || data.gateway_path || 'chat/completions', custom?.alias || '', id).run();
  } catch (error) {
    if (custom) throw new ApiError(503, 'local_save_failed', `Cloudflare 服务商 ${custom.provider.slug} 已准备好，但本地保存失败；请重新保存渠道并确认凭据`);
    throw error;
  }
  if (custom) await syncCatalog(c.env, custom.provider.id);
  return c.json({ ok: true });
});
channels.delete('/channels/:id', async c => {
  // Provider resources are account-wide and may be shared by other gateways.
  await c.env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});
