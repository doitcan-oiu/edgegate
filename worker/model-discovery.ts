import { z } from 'zod';
import type { Channel, Env } from './types';
import { decryptSecret } from './lib/crypto';
import { ApiError, invalid } from './lib/errors';
import { readLimited } from './lib/stream';
import { MAX_PROVIDER_MODELS, modelId, safeBaseUrl } from './lib/validation';

const discoverySchema = z.object({
  base_url: z.string().trim().min(1).max(500),
  protocol: z.enum(['openai', 'anthropic']).default('openai'),
  secret: z.string().trim().max(4096).optional(),
  channel_id: z.string().min(1).max(100).optional(),
  provider_id: z.string().min(1).max(100).optional(),
});
const pageSchema = z.object({
  data: z.array(z.object({ id: modelId })),
  has_more: z.boolean().optional(),
  last_id: z.string().min(1).max(160).nullable().optional(),
});

export async function discoverModels(env: Env, input: unknown) {
  const data = discoverySchema.parse(input), baseUrl = safeBaseUrl(data.base_url);
  let secret = data.secret;
  if (!secret && data.channel_id) {
    const channel = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(data.channel_id).first<Channel>();
    if (!channel) throw new ApiError(404, 'not_found', '用于获取模型的渠道不存在');
    // Saved credentials may only be used with their original upstream destination.
    if (channel.kind !== 'openai' || safeBaseUrl(channel.base_url) !== baseUrl ||
      (data.provider_id && data.provider_id !== channel.provider_id)) {
      throw invalid('上游地址或服务商已变更，请重新填写供应商 API Key 后获取模型');
    }
    if (channel.secret_encrypted) secret = await decryptSecret(channel.secret_encrypted, env.ENCRYPTION_KEY, channel.id);
  }
  if (!secret) throw invalid('请先填写供应商 API Key；仅有 BYOK 别名时，需提供一个用于获取模型的 API Key');
  const url = new URL(`${baseUrl}${new URL(baseUrl).pathname.endsWith('/v1') ? '' : '/v1'}/models`);
  const headers = new Headers({ Accept: 'application/json' });
  if (data.protocol === 'anthropic') {
    headers.set('x-api-key', secret);
    headers.set('anthropic-version', '2023-06-01');
    url.searchParams.set('limit', '1000');
  } else headers.set('Authorization', `Bearer ${secret}`);
  const signal = AbortSignal.timeout(20000), models = new Set<string>(), cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    let response: Response;
    try {
      // Discovery is a read-only supplier request, including before a provider exists.
      response = await fetch(url, { method: 'GET', headers, signal, redirect: 'manual' });
    } catch { throw new ApiError(502, 'models_connection_error', '无法连接上游模型接口或请求超时，请检查 Base URL 后重试'); }
    if (!response.ok) {
      await response.body?.cancel();
      const message = [401, 403].includes(response.status) ? '上游拒绝访问，请检查供应商 API Key 及模型读取权限'
        : response.status === 404 ? '上游未提供 /v1/models 接口，请检查 Base URL 或手动填写模型清单'
        : response.status === 429 ? '上游模型接口已限流，请稍后重试'
        : response.status >= 300 && response.status < 400 ? '上游模型接口返回重定向，请填写最终的 Base URL 后重试'
        : `获取模型失败，上游返回 HTTP ${response.status}`;
      // Do not expose upstream error bodies, which may echo credentials.
      throw new ApiError(502, 'models_upstream_error', message);
    }
    let result: z.infer<typeof pageSchema>;
    try { result = pageSchema.parse(JSON.parse(await readLimited(response, 4 * 1024 * 1024))); }
    catch { throw new ApiError(502, 'models_invalid_response', '上游模型清单格式无效，应返回包含模型 id 的 data 数组'); }
    for (const model of result.data) models.add(model.id);
    if (models.size > MAX_PROVIDER_MODELS) throw new ApiError(502, 'models_limit_exceeded', `上游返回超过 ${MAX_PROVIDER_MODELS} 个模型，请手动选择需要的模型`);
    if (!result.has_more) {
      if (!models.size) throw new ApiError(502, 'models_empty', '上游未返回可用模型，请检查此 API Key 的权限或手动填写');
      return { models: [...models] };
    }
    if (data.protocol !== 'anthropic' || !result.data.length || !result.last_id || cursors.has(result.last_id)) {
      throw new ApiError(502, 'models_pagination_error', '无法读取上游的完整模型清单，请检查分页格式或手动填写');
    }
    cursors.add(result.last_id);
    url.searchParams.set('after_id', result.last_id);
  }
  throw new ApiError(502, 'models_pagination_error', '上游模型分页过多，请手动选择需要的模型');
}
