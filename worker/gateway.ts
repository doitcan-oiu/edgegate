import type { Context } from 'hono';
import type { AppEnv, ApiKey, Protocol } from './types';
import { ApiError } from './lib/errors';
import { chatSchema, messagesSchema, responsesSchema } from './lib/validation';
import { authenticateKey, canUseModel } from './auth';
import { consumeLimit } from './lib/rate-limit';
import { getCandidates, iterateCandidates, requestUpstream } from './upstream';
import { readLimited } from './lib/stream';
import { convertRequest, convertResponse, validateResponse, type InferenceInput } from './protocols/convert';
import { convertStream } from './protocols/stream';
import { forwardStream } from './protocols/error-stream';
import { getGatewaySettings } from './settings';
import { publicUpstreamError, readUpstreamFailure, recordUpstreamFailure, upstreamFailure } from './upstream-errors';
import { readRouteScope } from './route-scope';
import { matchesScopedRoute } from '../shared/route-scope';

async function retryPause(ms: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function listModels(c: Context<AppEnv>) {
  const key = await authenticateKey(c.req.raw, c.env);
  const accessible = new Set((await getCandidates(c.env, undefined, JSON.parse(key.allowed_tags))).map(r => r.model_id));
  const { results } = await c.env.DB.prepare('SELECT id, created_at FROM models WHERE enabled = 1 ORDER BY id').all<{ id: string; created_at: string }>();
  return c.json({ object: 'list', data: results.filter(m => accessible.has(m.id) && canUseModel(key, m.id)).map(m => ({ id: m.id, object: 'model', created: Math.floor(Date.parse(m.created_at) / 1000), owned_by: 'edgegate' })) });
}
export async function chat(c: Context<AppEnv>, playground = false, protocol: Protocol = 'openai'): Promise<Response> {
  const scope = playground ? readRouteScope(c) : null;
  const key: Pick<ApiKey, 'id' | 'name' | 'rpm' | 'daily_limit' | 'allowed_models' | 'allowed_tags'> = playground
    ? { id: 'playground', name: 'Playground', rpm: 30, daily_limit: 1000, allowed_models: '[]', allowed_tags: '[]' }
    : await authenticateKey(c.req.raw, c.env);
  const input = (protocol === 'anthropic' ? messagesSchema : protocol === 'responses' ? responsesSchema : chatSchema).parse(await c.req.json()) as InferenceInput;
  if (!canUseModel(key, input.model)) throw new ApiError(403, 'model_not_allowed', '该密钥没有此模型的访问权限');
  const allowedTags = JSON.parse(key.allowed_tags) as string[];
  const [accessible, settings] = await Promise.all([getCandidates(c.env, input.model, allowedTags), getGatewaySettings(c.env)]);
  let available = scope ? accessible.filter(candidate => matchesScopedRoute(candidate, candidate.channel.tags || [], scope)) : accessible;
  if (allowedTags.length && !available.length) throw new ApiError(403, 'model_not_allowed', '该密钥的标签范围内没有此模型的可用路由');
  // Provider-owned response/conversation IDs cannot move across upstream accounts.
  // Until affinity is persisted, state references require a single native channel.
  if (protocol === 'responses' && (input.previous_response_id || input.conversation)) {
    const native = available.filter(candidate => candidate.channel.protocol === 'responses');
    if (new Set(native.map(candidate => candidate.channel_id)).size > 1) {
      throw new ApiError(400, 'unsupported_response_state', '使用 previous_response_id 或 conversation 时，当前模型的授权范围内必须只有一个 Responses 渠道；请收窄渠道范围，或在 input 中传入完整对话');
    }
    if (native.length) available = native;
  }
  const limit = await consumeLimit(c.env, key.id, key.rpm, key.daily_limit);
  if (!limit.allowed) { c.header('Retry-After', String(limit.retryAfter)); throw new ApiError(429, 'rate_limited', '已达到请求频率或每日请求上限'); }
  const requestId = c.get('requestId');
  let attempts = 0, channelsTried = 0;
  if (!available.length) { throw new ApiError(503, 'no_available_route', scope && scope.kind !== 'all' ? '当前标签范围内没有此模型的可用路由，请检查渠道配置和启用状态' : '此模型没有已配置且启用的渠道，请检查渠道凭据和模型路由'); }
  let lastFailure = upstreamFailure(null, '', 'upstream_unavailable');
  let conversionError: ApiError | undefined;
  const convertedInputs = new Map<Protocol, InferenceInput>();
  const unsupportedProtocols = new Set<Protocol>();
  // Filter incompatible protocols before allocating a group cursor. Requests
  // with different compatible/authorized route sets rotate independently.
  const compatible = available.filter(candidate => {
    const upstreamProtocol = candidate.channel.protocol || 'openai';
    if (unsupportedProtocols.has(upstreamProtocol)) return false;
    if (!convertedInputs.has(upstreamProtocol)) {
      try { convertedInputs.set(upstreamProtocol, convertRequest(input, protocol, upstreamProtocol)); }
      catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'unsupported_conversion') throw error;
        conversionError = error; unsupportedProtocols.add(upstreamProtocol); return false;
      }
    }
    return true;
  });
  const candidates = iterateCandidates(c.env, compatible, Math.random, settings.load_balancing);
  for await (const candidate of candidates) {
    if (c.req.raw.signal.aborted) { throw new ApiError(499, 'client_disconnected', '客户端已断开连接'); }
    if (channelsTried >= settings.cross_channel_retries + 1) break;
    const upstreamProtocol = candidate.channel.protocol || 'openai';
    const converted = convertedInputs.get(upstreamProtocol)!;
    channelsTried++;
    for (let retry = 0; retry <= settings.same_channel_retries; retry++) {
      if (retry) await retryPause(Math.min(100 * 2 ** (retry - 1), 1000), c.req.raw.signal);
      if (c.req.raw.signal.aborted) throw new ApiError(499, 'client_disconnected', '客户端已断开连接');
      attempts++; c.header('X-Gateway-Attempts', String(attempts));
      const controller = new AbortController();
      // Each attempt gets its channel's full timeout, including the response body.
      // Keep it alive through SSE completion instead of truncating long streams.
      const timer = setTimeout(() => controller.abort('upstream_timeout'), candidate.channel.timeout_ms);
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal]);
      let response: Response | undefined;
      let streaming = false;
      const remember = async (failure: typeof lastFailure) => {
        lastFailure = failure;
        try { await recordUpstreamFailure(c.env, requestId, attempts, candidate, failure, response?.headers.get('cf-aig-log-id')); }
        catch { console.error(JSON.stringify({ event: 'error_trace_write_failed', request_id: requestId, attempt: attempts })); }
      };
      try {
        response = await requestUpstream(c.env, candidate, converted, { request_id: requestId, key_id: key.id, key_name: key.name, model_alias: input.model, channel_id: candidate.channel_id, channel_name: candidate.channel.name, attempt: String(attempts), channel_attempt: String(retry + 1), channel_index: String(channelsTried), client_protocol: protocol, upstream_protocol: upstreamProtocol }, signal, protocol === 'anthropic' ? c.req.raw.headers : undefined);
        if (!response.ok) {
          const status = response.status;
          await remember(await readUpstreamFailure(response));
          // Credential/model failures need a different channel, not the same failing credentials.
          if ([401, 403, 404].includes(status)) break;
          if ([408, 409, 429].includes(status) || status >= 500) continue;
          const exposed = publicUpstreamError(settings, lastFailure);
          throw new ApiError(status >= 400 && status < 500 ? status : 502, exposed.code, exposed.message);
        }
        const headers = new Headers({ 'X-Request-ID': requestId, 'X-Gateway-Attempts': String(attempts), 'Cache-Control': 'no-store' });
        for (const name of ['cf-aig-log-id', 'cf-aig-cache-status', 'cf-aig-model', 'cf-aig-provider']) {
          const value = response.headers.get(name);
          if (value) headers.set(name, value);
        }
        if (input.stream) {
          if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
            const failure = await readUpstreamFailure(response); failure.code = 'invalid_upstream_stream'; await remember(failure); continue;
          }
          headers.set('Content-Type', 'text/event-stream; charset=utf-8');
          headers.set('X-Accel-Buffering', 'no');
          const finish = () => { clearTimeout(timer); controller.abort(); };
          const onError = async (raw: string) => {
            const timedOut = controller.signal.reason === 'upstream_timeout';
            const failure = upstreamFailure(raw ? response!.status : null, raw || (timedOut ? '上游流式请求超过渠道配置的总时限' : '上游流中断或包含无法转换的事件'), timedOut ? 'upstream_timeout' : 'upstream_stream_error');
            await remember(failure); return publicUpstreamError(settings, failure);
          };
          const body = protocol !== upstreamProtocol
            ? convertStream(response.body, upstreamProtocol, protocol, protocol !== 'openai' || !!input.stream_options?.include_usage, finish, onError, requestId)
            : forwardStream(response.body, protocol, requestId, finish, onError);
          streaming = true;
          return new Response(body, { headers });
        }
        const raw = await readLimited(response);
        let result, output;
        try {
          result = JSON.parse(raw); validateResponse(result, upstreamProtocol);
          output = protocol === upstreamProtocol ? raw : JSON.stringify(convertResponse(result, upstreamProtocol, protocol));
        }
        catch { await remember(upstreamFailure(response.status, raw, 'invalid_upstream_response')); continue; }
        headers.set('Content-Type', 'application/json');
        return new Response(output, { headers });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (c.req.raw.signal.aborted) throw new ApiError(499, 'client_disconnected', '客户端已断开连接');
        await remember(upstreamFailure(null, error instanceof Error ? error.message : '上游连接失败', controller.signal.aborted ? 'upstream_timeout' : 'upstream_connection_error'));
        controller.abort();
        await response?.body?.cancel().catch(() => {});
      } finally { if (!streaming) clearTimeout(timer); }
    }
    // Stop before advancing the iterator, so unused fallback groups and tiers
    // do not consume a round-robin position after the retry budget is spent.
    if (channelsTried >= settings.cross_channel_retries + 1) break;
  }
  if (!attempts && conversionError) throw conversionError;
  const exposed = publicUpstreamError(settings, lastFailure);
  throw new ApiError(502, exposed.code, exposed.message);
}
