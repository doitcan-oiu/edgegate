import type { Context } from 'hono';
import type { AppEnv, ApiKey, Protocol } from './types';
import { ApiError } from './lib/errors';
import { chatSchema, messagesSchema } from './lib/validation';
import { authenticateKey, canUseModel } from './auth';
import { consumeLimit } from './lib/rate-limit';
import { getCandidates, orderCandidates, requestUpstream } from './upstream';
import { readLimited } from './lib/stream';
import { convertRequest, convertResponse, validateResponse, type InferenceInput } from './protocols/convert';
import { convertStream } from './protocols/stream';

export async function listModels(c: Context<AppEnv>) {
  const key = await authenticateKey(c.req.raw, c.env);
  const accessible = new Set((await getCandidates(c.env, undefined, JSON.parse(key.allowed_tags))).map(r => r.model_id));
  const { results } = await c.env.DB.prepare('SELECT id, created_at FROM models WHERE enabled = 1 ORDER BY id').all<{ id: string; created_at: string }>();
  return c.json({ object: 'list', data: results.filter(m => accessible.has(m.id) && canUseModel(key, m.id)).map(m => ({ id: m.id, object: 'model', created: Math.floor(Date.parse(m.created_at) / 1000), owned_by: 'edgegate' })) });
}
export async function chat(c: Context<AppEnv>, playground = false, protocol: Protocol = 'openai'): Promise<Response> {
  const key: Pick<ApiKey, 'id' | 'name' | 'rpm' | 'daily_limit' | 'allowed_models' | 'allowed_tags'> = playground
    ? { id: 'playground', name: 'Playground', rpm: 30, daily_limit: 1000, allowed_models: '[]', allowed_tags: '[]' }
    : await authenticateKey(c.req.raw, c.env);
  const input = (protocol === 'anthropic' ? messagesSchema : chatSchema).parse(await c.req.json()) as InferenceInput;
  if (!canUseModel(key, input.model)) throw new ApiError(403, 'model_not_allowed', '该密钥没有此模型的访问权限');
  const allowedTags = JSON.parse(key.allowed_tags) as string[];
  const available = await getCandidates(c.env, input.model, allowedTags);
  if (allowedTags.length && !available.length) throw new ApiError(403, 'model_not_allowed', '该密钥的标签范围内没有此模型的可用服务商');
  const limit = await consumeLimit(c.env, key.id, key.rpm, key.daily_limit);
  if (!limit.allowed) { c.header('Retry-After', String(limit.retryAfter)); throw new ApiError(429, 'rate_limited', '已达到请求频率或每日请求上限'); }
  const requestId = c.get('requestId'), start = Date.now();
  let attempts = 0;
  const candidates = orderCandidates(available).slice(0, 5);
  if (!candidates.length) { throw new ApiError(503, 'no_available_route', '此模型没有已配置且启用的渠道，请检查渠道凭据和模型路由'); }
  let lastCode = 'upstream_unavailable';
  let conversionError: ApiError | undefined;
  for (const candidate of candidates) {
    if (c.req.raw.signal.aborted) { throw new ApiError(499, 'client_disconnected', '客户端已断开连接'); }
    if (Date.now() - start > 180000) break;
    const upstreamProtocol = candidate.channel.protocol || 'openai';
    let converted: InferenceInput;
    try { converted = convertRequest(input, protocol, upstreamProtocol); }
    catch (error) { if (error instanceof ApiError && error.code === 'unsupported_conversion') { conversionError = error; continue; } throw error; }
    attempts++;
    const controller = new AbortController();
    const remaining = Math.min(candidate.channel.timeout_ms, 180000 - (Date.now() - start));
    const timer = setTimeout(() => controller.abort('upstream_timeout'), remaining);
    const signal = AbortSignal.any([controller.signal, c.req.raw.signal]);
    let response: Response | undefined;
    let streaming = false;
    try {
      response = await requestUpstream(c.env, candidate, converted, { request_id: requestId, key_id: key.id, key_name: key.name, model_alias: input.model, channel_id: candidate.channel_id, channel_name: candidate.channel.name, attempt: String(attempts), client_protocol: protocol, upstream_protocol: upstreamProtocol }, signal, protocol === 'anthropic' ? c.req.raw.headers : undefined);
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel();
        lastCode = `upstream_${status}`;
        // Provider auth, throttling, unavailable models and server errors can fail over.
        if ([401, 403, 404, 408, 409, 429].includes(status) || status >= 500) continue;
        throw new ApiError(status >= 400 && status < 500 ? status : 502, lastCode, '上游服务拒绝了请求，请检查模型参数');
      }
      const headers = new Headers({ 'X-Request-ID': requestId, 'X-Gateway-Attempts': String(attempts), 'Cache-Control': 'no-store' });
      for (const name of ['cf-aig-log-id', 'cf-aig-cache-status', 'cf-aig-model', 'cf-aig-provider']) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (input.stream) {
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); lastCode = 'invalid_upstream_stream'; continue; }
        headers.set('Content-Type', 'text/event-stream; charset=utf-8');
        headers.set('X-Accel-Buffering', 'no');
        if (protocol !== upstreamProtocol) {
          const body = convertStream(response.body, upstreamProtocol, protocol, !!input.stream_options?.include_usage, () => { clearTimeout(timer); controller.abort(); });
          streaming = true;
          return new Response(body, { headers });
        }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(output) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                clearTimeout(timer);
                output.close();
                return;
              }
              output.enqueue(value);
            } catch {
              clearTimeout(timer); controller.abort(); await reader.cancel().catch(() => {});
              output.error(new Error('Upstream stream interrupted'));
            }
          },
          async cancel() {
            clearTimeout(timer); controller.abort();
            await reader.cancel().catch(() => {});
          },
        });
        streaming = true;
        return new Response(body, { headers });
      }
      const raw = await readLimited(response);
      const result = JSON.parse(raw);
      try { validateResponse(result, upstreamProtocol); } catch { lastCode = 'invalid_upstream_response'; continue; }
      headers.set('Content-Type', 'application/json');
      return new Response(protocol === upstreamProtocol ? raw : JSON.stringify(convertResponse(result, upstreamProtocol, protocol)), { headers });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      lastCode = controller.signal.aborted ? 'upstream_timeout' : 'upstream_connection_error';
      controller.abort();
      await response?.body?.cancel().catch(() => {});
    } finally { if (!streaming) clearTimeout(timer); }
  }
  if (!attempts && conversionError) throw conversionError;
  throw new ApiError(502, lastCode, '所有可用上游均请求失败，请检查渠道配置或稍后重试');
}
