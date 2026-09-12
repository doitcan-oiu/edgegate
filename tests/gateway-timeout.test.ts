import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { chat } from '../worker/gateway';
import { getCandidates, requestUpstream } from '../worker/upstream';
import { getGatewaySettings } from '../worker/settings';
import { recordUpstreamFailure } from '../worker/upstream-errors';
import { ApiError } from '../worker/lib/errors';
import { DEFAULT_GATEWAY_SETTINGS } from '../shared/gateway-settings';
import type { AppEnv, Candidate, Env, Protocol } from '../worker/types';

vi.mock('../worker/upstream', async original => ({ ...await original<typeof import('../worker/upstream')>(), getCandidates: vi.fn(), requestUpstream: vi.fn() }));
vi.mock('../worker/settings', () => ({ getGatewaySettings: vi.fn() }));
vi.mock('../worker/lib/rate-limit', () => ({ consumeLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock('../worker/upstream-errors', async original => ({ ...await original<typeof import('../worker/upstream-errors')>(), recordUpstreamFailure: vi.fn(async () => {}) }));

const encoder = new TextEncoder();
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => { c.set('requestId', 'timeout-test'); await next(); });
app.post('/:protocol', c => chat(c, true, c.req.param('protocol') as Protocol));
app.onError(error => new Response(JSON.stringify({ error: error.message }), { status: error instanceof ApiError ? error.status : 500 }));

function candidate(timeout: number, protocol: Protocol = 'openai', id = 'primary', priority = 0): Candidate {
  return { id: `route-${id}`, model_id: 'model', channel_id: id, upstream_model: 'upstream', priority, weight: 1, enabled: 1, input_price: null, output_price: null,
    channel: { id, name: id, kind: 'openai', base_url: 'https://example.com', secret_encrypted: null, enabled: 1, timeout_ms: timeout, auto_create_routes: 1, created_at: '', provider_id: 'provider', provider_slug: 'provider', gateway_path: 'v1/chat/completions', byok_alias: 'default', protocol } };
}
function request(protocol: Protocol = 'openai', stream = true, signal?: AbortSignal) {
  return app.request(`/${protocol}`, { method: 'POST', body: JSON.stringify(protocol === 'responses' ? { model: 'model', input: 'Hello', max_output_tokens: 1024, stream } : { model: 'model', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 1024, stream }), signal }, {} as Env);
}
function frames(protocol: Protocol) {
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  if (protocol === 'openai') return {
    start: data({ id: 'completion', model: 'upstream', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] }),
    end: data({ id: 'completion', model: 'upstream', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + 'data: [DONE]\n\n',
  };
  const event = (type: string, value: object) => `event: ${type}\n${data({ type, ...value })}`;
  if (protocol === 'responses') {
    const part = { type: 'output_text', text: 'hello', annotations: [] };
    const item = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [part] };
    const response = { id: 'resp_test', object: 'response', created_at: 1, model: 'upstream', status: 'completed', output: [item], error: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    return {
      start: event('response.created', { sequence_number: 0, response: { ...response, status: 'in_progress', output: [], usage: null } })
        + event('response.output_item.added', { sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
        + event('response.content_part.added', { sequence_number: 2, output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text: '' } })
        + event('response.output_text.delta', { sequence_number: 3, output_index: 0, item_id: item.id, content_index: 0, delta: 'hello' }),
      end: event('response.output_text.done', { sequence_number: 4, output_index: 0, item_id: item.id, content_index: 0, text: 'hello' })
        + event('response.content_part.done', { sequence_number: 5, output_index: 0, item_id: item.id, content_index: 0, part })
        + event('response.output_item.done', { sequence_number: 6, output_index: 0, item })
        + event('response.completed', { sequence_number: 7, response }),
    };
  }
  return {
    start: event('message_start', { message: { id: 'message', model: 'upstream', usage: { input_tokens: 1, output_tokens: 0 } } })
      + event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } }),
    end: event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) + event('message_stop', {}),
  };
}
function streamingUpstream() {
  let source: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal;
  vi.mocked(requestUpstream).mockImplementation(async (_env, upstream, _input, _metadata, abortSignal) => {
    signal = abortSignal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      source = controller;
      signal.addEventListener('abort', () => controller.error(new Error(String(signal.reason))), { once: true });
      controller.enqueue(encoder.encode(frames(upstream.channel.protocol || 'openai').start));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return { get source() { return source; }, get signal() { return signal; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getGatewaySettings).mockResolvedValue({ ...DEFAULT_GATEWAY_SETTINGS });
  vi.mocked(getCandidates).mockResolvedValue([candidate(1200000)]);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); });

describe('long upstream request deadlines', () => {
  it.each<[Protocol, Protocol]>([['openai', 'openai'], ['anthropic', 'anthropic'], ['openai', 'anthropic'], ['anthropic', 'openai'], ['responses', 'responses'], ['responses', 'openai'], ['responses', 'anthropic'], ['openai', 'responses'], ['anthropic', 'responses']])('streams past 10 minutes from %s to %s without the old 180-second cap', async (upstreamProtocol, clientProtocol) => {
    vi.mocked(getCandidates).mockResolvedValue([candidate(1200000, upstreamProtocol)]);
    const upstream = streamingUpstream();
    const response = await request(clientProtocol), reading = response.text();
    expect(response.status).toBe(200);
    await vi.advanceTimersByTimeAsync(660000);
    expect(upstream.signal.aborted).toBe(false);
    upstream.source.enqueue(encoder.encode(frames(upstreamProtocol).end)); upstream.source.close();
    const text = await reading;
    expect(text).toContain('hello'); expect(text).not.toContain('event: error'); expect(text).not.toContain('"error":{');
    expect(requestUpstream).toHaveBeenCalledTimes(1);
    expect(recordUpstreamFailure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each<Protocol>(['openai', 'anthropic', 'responses'])('enforces the full SSE deadline and records a timeout without replaying %s output', async protocol => {
    vi.mocked(getCandidates).mockResolvedValue([candidate(1200000, protocol), candidate(1200000, protocol, 'fallback', 1)]);
    const upstream = streamingUpstream();
    const response = await request(protocol), reading = response.text();
    await vi.advanceTimersByTimeAsync(1200000);
    expect(upstream.signal.reason).toBe('upstream_timeout');
    const text = await reading;
    expect(text).toContain('hello'); expect(text).toContain('error');
    expect(recordUpstreamFailure).toHaveBeenCalledWith(expect.anything(), 'timeout-test', 1, expect.anything(), expect.objectContaining({ code: 'upstream_timeout' }), null);
    expect(requestUpstream).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('gives a fallback its full deadline after a slow first attempt', async () => {
    vi.mocked(getCandidates).mockResolvedValue([candidate(300000), candidate(1200000, 'openai', 'fallback', 1)]);
    const upstream = streamingUpstream();
    vi.mocked(requestUpstream).mockImplementationOnce((_env, _candidate, _input, _metadata, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
    }));
    const pending = request();
    await vi.advanceTimersByTimeAsync(300000);
    const response = await pending, reading = response.text();
    expect(response.status).toBe(200); expect(response.headers.get('X-Gateway-Attempts')).toBe('2');
    await vi.advanceTimersByTimeAsync(1199999);
    expect(upstream.signal.aborted).toBe(false);
    upstream.source.enqueue(encoder.encode(frames('openai').end)); upstream.source.close();
    expect(await reading).toContain('[DONE]');
    expect(requestUpstream).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels the upstream and clears its long timer when the client cancels the stream', async () => {
    const upstream = streamingUpstream(), response = await request();
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
    expect(upstream.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(requestUpstream).toHaveBeenCalledTimes(1);
  });
  it('applies the same total deadline to a non-streaming response body', async () => {
    vi.mocked(getCandidates).mockResolvedValue([candidate(1200000)]);
    const upstream = streamingUpstream();
    const pending = request('openai', false);
    await vi.advanceTimersByTimeAsync(1200000);
    expect((await pending).status).toBe(502);
    expect(upstream.signal.aborted).toBe(true);
    expect(recordUpstreamFailure).toHaveBeenCalledWith(expect.anything(), 'timeout-test', 1, expect.anything(), expect.objectContaining({ code: 'upstream_timeout' }), null);
  });
});
