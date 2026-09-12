import { describe, expect, it } from 'vitest';
import { availablePlaygroundModels, inferenceBody, conversationForRetry, playgroundSnippet, readPlaygroundStream, type PlaygroundMessage } from '../src/playground';

const parameters = { model: 'test-model', system: 'answer briefly', temperature: .4, maxTokens: 512, stream: false };
const conversation: PlaygroundMessage[] = [
  { id: '1', role: 'user', content: 'first question' },
  { id: '2', role: 'assistant', content: 'first answer', model: 'original-model', requestId: 'private-trace', scopeLabel: 'private-tag' },
  { id: '3', role: 'user', content: 'second question' },
  { id: '4', role: 'assistant', content: 'partial answer', state: 'error', error: 'provider failure' },
];

describe('Playground request preparation', () => {
  it('regenerates the last user turn without duplicating it or including the failed answer', () => {
    expect(conversationForRetry(conversation)).toEqual(conversation.slice(0, 3));
    expect(conversation).toHaveLength(4);
    expect(conversationForRetry([])).toEqual([]);
  });
  it('preserves context across model changes and strips presentation metadata from requests', () => {
    const body = inferenceBody({ ...parameters, model: 'another-model' }, [...conversation, { role: 'assistant', content: '' }]);
    expect(body).toEqual({ model: 'another-model', messages: [{ role: 'system', content: 'answer briefly' }, ...conversation.map(({ role, content }) => ({ role, content }))], temperature: .4, max_tokens: 512, stream: false });
    expect(JSON.stringify(body)).not.toContain('private-trace');
    expect(JSON.stringify(body)).not.toContain('private-tag');
    expect(JSON.stringify(body)).not.toContain('provider failure');
    expect(conversation[1].model).toBe('original-model');
  });
  it.each([true, false])('generates copyable code using current parameters with stream=%s', stream => {
    const params = { ...parameters, stream, system: 'quotes " and \\ paths\nnew line', model: 'model"name' };
    const snippet = playgroundSnippet('https://gateway.example/v1', params, conversationForRetry(conversation));
    const request = snippet.split('client.chat.completions.create(')[1].split(');\n\n')[0];
    expect(JSON.parse(request)).toEqual(inferenceBody(params, conversation.slice(0, 3)));
    expect(snippet.includes('for await')).toBe(stream);
    expect(snippet.includes('console.log(response.choices')).toBe(!stream);
    expect(snippet).toContain('process.env.EDGEGATE_API_KEY');
  });
  it('explains API key tag authorization in copied code without inventing public routing parameters', () => {
    const snippet = playgroundSnippet('https://gateway.example/v1', parameters, conversation, { kind: 'tag', tag: 'AA' });
    expect(snippet).toContain('仅授权标签 "AA"'); expect(snippet).not.toContain('?tag=');
    expect(playgroundSnippet('https://gateway.example/v1', parameters, conversation, { kind: 'untagged' })).toContain('暂不支持仅授权未打标签渠道');
  });
  it('lists only callable models in the selected tag and never broadens an empty scope', () => {
    const channels = [
      { id: 'a', tags: ['AA'], enabled: 1, configured: true }, { id: 'b', tags: ['BB'], enabled: 1, configured: true },
      { id: 'both', tags: ['AA', 'BB'], enabled: 1, configured: true }, { id: 'u', tags: [], enabled: 1, configured: true },
      { id: 'off', tags: ['AA'], enabled: 0, configured: true }, { id: 'pending', tags: ['AA'], enabled: 1, configured: false },
    ];
    const models = channels.map(channel => ({ id: channel.id, enabled: 1, routes: [{ channel_id: channel.id, enabled: 1 }] }));
    models.push({ id: 'off-model', enabled: 0, routes: [{ channel_id: 'a', enabled: 1 }] }, { id: 'off-route', enabled: 1, routes: [{ channel_id: 'a', enabled: 0 }] });
    expect(availablePlaygroundModels(models, channels, { kind: 'tag', tag: 'AA' }).map(model => model.id)).toEqual(['a', 'both']);
    expect(availablePlaygroundModels(models, channels, { kind: 'tag', tag: 'BB' }).map(model => model.id)).toEqual(['b', 'both']);
    expect(availablePlaygroundModels(models, channels, { kind: 'untagged' }).map(model => model.id)).toEqual(['u']);
    expect(availablePlaygroundModels(models, channels, { kind: 'tag', tag: 'removed' })).toEqual([]);
    expect(availablePlaygroundModels(models, channels, null)).toEqual([]);
  });
});

function source(text: string, chunkSize = 7, close = true) {
  const bytes = new TextEncoder().encode(text); let offset = 0, cancelled = false;
  return { stream: new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { if (close) controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize;
    }, cancel() { cancelled = true; },
  }), cancelled: () => cancelled };
}
describe('Playground streaming responses', () => {
  it('handles split UTF-8, CRLF and multiline data, then stops at DONE without waiting for disconnect', async () => {
    const input = source(': keepalive\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"你好🌏"}}]}\r\n\r\ndata: [DONE]\r\n\r\n', 1, false);
    const updates: string[] = [];
    expect(await readPlaygroundStream(input.stream, text => updates.push(text))).toBe('你好🌏');
    expect(updates).toEqual(['你好🌏']); expect(input.cancelled()).toBe(true);
  });
  it('shows the gateway-provided error and retains previously received content', async () => {
    const input = source('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"message":"管理员自定义提示"}}\n\n', 9, false);
    const updates: string[] = [];
    await expect(readPlaygroundStream(input.stream, text => updates.push(text))).rejects.toThrow('管理员自定义提示');
    expect(updates).toEqual(['partial']); expect(input.cancelled()).toBe(true);
  });
  it('reports truncated streams instead of marking partial output complete', async () => {
    const input = source('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    await expect(readPlaygroundStream(input.stream, () => {})).rejects.toThrow('流式响应未完成');
  });
  it('propagates cancellation so the caller can distinguish stopped generation from an upstream error', async () => {
    const input = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new DOMException('Stopped', 'AbortError')); } });
    await expect(readPlaygroundStream(input, () => {})).rejects.toMatchObject({ name: 'AbortError' });
  });
});
