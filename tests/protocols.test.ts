import { describe, expect, it } from 'vitest';
import { convertRequest, convertResponse, type InferenceInput } from '../worker/protocols/convert';
import { convertStream } from '../worker/protocols/stream';

const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
const oa: InferenceInput = { model: 'm', stream: false, messages: [{ role: 'user', content: '你好' }] };
const ant: InferenceInput = { model: 'm', stream: false, max_tokens: 100, messages: [{ role: 'user', content: '你好' }] };
const anthropic = { id: 'a1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: '你好' }, { type: 'tool_use', id: 't1', name: 'weather', input: { city: '北京' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } };
const openai = { id: 'o1', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '你好', tool_calls: [{ id: 't1', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_tokens_details: { cached_tokens: 3 } } };
const event = (type: string, value: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
const oaChunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: 'o1', model: 'm', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
function bytes(value: string, chunk = 7) {
  const data = new TextEncoder().encode(value); let position = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) { if (position >= data.length) controller.close(); else { controller.enqueue(data.slice(position, position + chunk)); position += chunk; } } });
}
async function stream(value: string, from: 'openai' | 'anthropic', chunk = 7, includeUsage = true) {
  const body = convertStream(bytes(value, chunk), from, from === 'openai' ? 'anthropic' : 'openai', includeUsage, () => {});
  return new Response(body).text();
}
const parse = (s: string) => s.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));

describe('bidirectional protocol requests', () => {
  it('maps OpenAI system, images, function calls and tool results into Anthropic blocks', () => {
    const input = { ...oa, max_completion_tokens: 500, stop: ['END'], tools: [{ type: 'function', function: { name: 'weather', parameters: schema } }], tool_choice: 'required', parallel_tool_calls: false,
      messages: [{ role: 'system', content: 'System' }, { role: 'developer', content: 'Developer' }, { role: 'user', content: [{ type: 'text', text: '图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }, { role: 'assistant', content: null, tool_calls: openai.choices[0].message.tool_calls }, { role: 'tool', tool_call_id: 't1', content: 'Sunny' }] };
    const result = convertRequest(input, 'openai', 'anthropic');
    expect(result.system).toEqual([{ type: 'text', text: 'System' }, { type: 'text', text: 'Developer' }]);
    expect(result.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } });
    expect(result.messages[1].content[0]).toEqual(anthropic.content[1]);
    expect(result.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Sunny' }] });
    expect(result).toMatchObject({ max_tokens: 500, stop_sequences: ['END'], tools: [{ input_schema: schema }], tool_choice: { type: 'any', disable_parallel_tool_use: true } });
    expect(input.messages[2].role).toBe('user');
  });
  it('maps Anthropic history, URL images, tool schema and forced calls into OpenAI', () => {
    const result = convertRequest({ ...ant, stream: true, system: '规则', stop_sequences: ['END'], tools: [{ name: 'weather', input_schema: schema }], tool_choice: { type: 'tool', name: 'weather', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }, { role: 'assistant', content: anthropic.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Sunny' }, { type: 'text', text: '继续' }] }] }, 'anthropic', 'openai');
    expect(result.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(result.messages[1].content[0]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/a.png' } });
    expect(result.messages[2].tool_calls).toEqual(openai.choices[0].message.tool_calls);
    expect(result).toMatchObject({ stop: ['END'], tools: [{ function: { parameters: schema } }], tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: false, stream_options: { include_usage: true } });
  });
  it('preserves tool errors and user identifiers in their target representations', () => {
    const result = convertRequest({ ...ant, metadata: { user_id: 'app-user' }, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'timeout' }] }] }, 'anthropic', 'openai');
    expect(result.user).toBe('app-user'); expect(JSON.parse(result.messages[0].content)).toEqual({ is_error: true, content: 'timeout' });
    expect(convertRequest({ ...oa, user: 'app-user' }, 'openai', 'anthropic').metadata).toEqual({ user_id: 'app-user' });
  });
  it('preserves provider extensions when no conversion is needed', () => {
    const input = { ...ant, thinking: { type: 'enabled', budget_tokens: 1024 } };
    expect(convertRequest(input, 'anthropic', 'anthropic')).toEqual(input);
    expect(convertRequest({ ...oa, response_format: { type: 'json_object' } }, 'openai', 'openai')).toHaveProperty('response_format');
  });
  it.each([{ n: 2 }, { temperature: 1.5 }, { response_format: { type: 'json_object' } }, { audio: { voice: 'alloy' } }, { messages: [{ role: 'assistant', tool_calls: [{ type: 'function', id: 't', function: { name: 'f', arguments: 'not-json' } }] }] }])('rejects unsupported OpenAI semantics explicitly: %j', input => {
    expect(() => convertRequest({ ...oa, ...input }, 'openai', 'anthropic')).toThrow(/跨协议/);
  });
  it.each([{ thinking: { type: 'enabled' } }, { top_k: 8 }, { tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'cache', cache_control: { type: 'ephemeral' } }] }] }])('does not silently lose Anthropic semantics: %j', input => {
    expect(() => convertRequest({ ...ant, ...input }, 'anthropic', 'openai')).toThrow(/跨协议/);
  });
});
describe('bidirectional JSON responses', () => {
  it('maps text, tools, stop reasons and cache-inclusive usage to OpenAI', () => {
    const result = convertResponse(anthropic, 'anthropic', 'openai');
    expect(result.choices).toMatchObject(openai.choices);
    expect(result.usage).toEqual(openai.usage);
  });
  it('maps OpenAI tools and usage back to Anthropic', () => {
    const result = convertResponse(openai, 'openai', 'anthropic');
    expect(result).toMatchObject({ type: 'message', content: anthropic.content, stop_reason: 'tool_use', usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3 } });
  });
  it('rejects unexpected choices or unsupported thinking blocks rather than truncating them', () => {
    expect(() => convertResponse({ ...openai, choices: [...openai.choices, ...openai.choices] }, 'openai', 'anthropic')).toThrow();
    expect(() => convertResponse({ ...anthropic, content: [{ type: 'thinking', thinking: 'private' }] }, 'anthropic', 'openai')).toThrow();
  });
});
describe('incremental SSE conversion', () => {
  const antStream = event('message_start', { message: { ...anthropic, content: [], usage: { input_tokens: 10, output_tokens: 0 } } }) + event('ping') +
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好🌍' } }) + event('content_block_stop', { index: 0 }) +
    event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 't1', name: 'weather', input: {} } }) + event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } }) + event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"北京"}' } }) + event('content_block_stop', { index: 1 }) +
    event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }) + event('message_stop');
  const oaStream = oaChunk({ role: 'assistant', content: '你好🌍' }) + oaChunk({ tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'weather', arguments: '{"city":' } }, { index: 1, id: 't2', type: 'function', function: { name: 'clock', arguments: '{' } }] }) + oaChunk({ tool_calls: [{ index: 1, function: { arguments: '}' } }, { index: 0, function: { arguments: '"北京"}' } }] }) + oaChunk({}, 'tool_calls') + `data: ${JSON.stringify({ id: 'o1', model: 'm', choices: [], usage: openai.usage })}\n\n` + 'data: [DONE]\n\n';
  it.each([1, 7, 8192])('preserves split UTF-8 and tool argument deltas, chunk size %i', async size => {
    const output = await stream(antStream.replace(/\n/g, '\r\n'), 'anthropic', size);
    const values = parse(output);
    expect(values.map(v => v.choices?.[0]?.delta?.content || '').join('')).toBe('你好🌍');
    const calls = values.flatMap(v => v.choices?.[0]?.delta?.tool_calls || []);
    expect(calls[0]).toMatchObject({ index: 0, id: 't1', function: { name: 'weather' } });
    expect(calls.map(c => c.function.arguments || '').join('')).toBe('{"city":"北京"}');
    expect(values.at(-1).usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
    expect(output).toMatch(/data: \[DONE\]\n\n$/);
  });
  it('converts interleaved OpenAI tools into indexed Anthropic blocks and final usage', async () => {
    const output = await stream(oaStream, 'openai'); const values = parse(output);
    expect(values[0].type).toBe('message_start'); expect(values.at(-1).type).toBe('message_stop');
    const starts = values.filter(v => v.type === 'content_block_start'); expect(starts.map(s => s.content_block.type)).toEqual(['text', 'tool_use', 'tool_use']);
    for (const start of starts.filter(s => s.content_block.type === 'tool_use')) {
      const args = values.filter(v => v.index === start.index && v.type === 'content_block_delta').map(v => v.delta.partial_json).join('');
      expect(JSON.parse(args)).toEqual(start.content_block.id === 't1' ? { city: '北京' } : {});
    }
    expect(values.at(-2)).toMatchObject({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3 } });
    expect(values.filter(v => v.type === 'content_block_stop').map(v => v.index)).toEqual([0, 1, 2]);
  });
  it('emits valid empty arguments for Anthropic tools without JSON deltas', async () => {
    const source = event('message_start', { message: { ...anthropic, content: [] } }) + event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'empty', name: 'clock', input: {} } }) + event('content_block_stop', { index: 0 }) + event('message_delta', { delta: { stop_reason: 'tool_use' } }) + event('message_stop');
    const calls = parse(await stream(source, 'anthropic')).flatMap(v => v.choices?.[0]?.delta?.tool_calls || []);
    expect(calls.map(c => c.function.arguments || '').join('')).toBe('{}');
  });
  it('keeps Anthropic block indexes dense when another tool starts sending arguments first', async () => {
    const source = oaChunk({ tool_calls: [{ index: 0, id: 'later', type: 'function', function: { name: 'cl', arguments: '' } }, { index: 1, id: 'first', type: 'function', function: { name: 'weather', arguments: '{}' } }] }) + oaChunk({ tool_calls: [{ index: 0, function: { name: 'ock', arguments: '{}' } }] }) + oaChunk({}, 'tool_calls') + `data: ${JSON.stringify({ id: 'o1', model: 'm', choices: [], usage: openai.usage })}\n\n` + 'data: [DONE]\n\n';
    const values = parse(await stream(source, 'openai'));
    const starts = values.filter(v => v.type === 'content_block_start');
    expect(starts.map(v => v.index)).toEqual([0, 1]);
    expect(starts.map(v => v.content_block.name)).toEqual(['weather', 'clock']);
    expect(values.at(-1).type).toBe('message_stop');
  });
  it('does not claim completion when the upstream stream ends early', async () => {
    const output = await stream(antStream.replace(event('message_stop'), ''), 'anthropic');
    expect(output).toContain('api_error'); expect(output).not.toContain('[DONE]');
    const reverse = await stream(oaStream.replace('data: [DONE]\n\n', ''), 'openai');
    expect(reverse).toContain('event: error'); expect(reverse).not.toContain('event: message_stop');
  });
  it('maps stream errors without leaking upstream error bodies', async () => {
    const output = await stream(event('error', { error: { message: 'sensitive-provider-secret' } }), 'anthropic');
    expect(output).toContain('api_error'); expect(output).not.toContain('sensitive-provider-secret');
  });
  it('does not emit usage unless the OpenAI caller requested it', async () => {
    expect(parse(await stream(antStream, 'anthropic', 7, false)).some(v => v.usage)).toBe(false);
  });
  it('yields a text delta before the upstream response finishes', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const input = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    const reader = convertStream(input, 'openai', 'anthropic', true, () => source.error(new Error('cancelled'))).getReader();
    source.enqueue(new TextEncoder().encode(oaChunk({ content: 'first' })));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('message_start');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('content_block_start');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first');
    await reader.cancel();
  });
  it('limits oversized SSE frames', async () => {
    const result = await stream('data: '+ 'x'.repeat(1024 * 1024 + 1), 'openai', 65536);
    expect(result).toContain('event: error'); expect(result).not.toContain('message_stop');
  });
});
