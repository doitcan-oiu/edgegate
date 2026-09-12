import { describe, expect, it, vi } from 'vitest';
import { convertStream } from '../worker/protocols/stream';
import { forwardStream } from '../worker/protocols/error-stream';
import type { Protocol } from '../worker/types';

const encoder = new TextEncoder();
const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } };
const responseUsage = { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } };
const event = (type: string, fields: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const chat = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c1', model: 'model', created: 123, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const chatEnd = (reason = 'stop') => chat({}, reason) + `data: ${JSON.stringify({ id: 'c1', model: 'model', choices: [], usage })}\n\n` + 'data: [DONE]\n\n';
function bytes(value: string, size = 23) {
  const data = encoder.encode(value); let position = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) { if (position >= data.length) controller.close(); else { controller.enqueue(data.slice(position, position + size)); position += size; } } });
}
function parse(value: string): any[] { return value.split(/\r?\n/).filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6))); }
async function converted(value: string, from: Protocol, to: Protocol, includeUsage = true, size = 23) {
  return new Response(convertStream(bytes(value, size), from, to, includeUsage, () => {})).text();
}
const response = (status = 'in_progress', output: any[] = []) => ({ id: 'r1', object: 'response', model: 'model', created_at: 123, status, output, usage: status === 'in_progress' ? null : responseUsage });
const message = { id: 'm1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好🌍', annotations: [] }] };
const call = { id: 'f1', type: 'function_call', call_id: 'tool1', name: 'weather', arguments: '{"city":"北京"}', status: 'completed' };
function responseStream() {
  return event('response.created', { response: response() }) + event('response.in_progress', { response: response() }) +
    event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } }) +
    event('response.content_part.added', { output_index: 0, item_id: 'm1', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }) +
    event('response.output_text.delta', { output_index: 0, item_id: 'm1', content_index: 0, delta: '你好' }) +
    event('response.output_text.delta', { output_index: 0, item_id: 'm1', content_index: 0, delta: '🌍' }) +
    event('response.output_item.added', { output_index: 1, item: { ...call, status: 'in_progress', arguments: '' } }) +
    event('response.function_call_arguments.delta', { output_index: 1, item_id: 'f1', delta: '{"city":' }) +
    event('response.function_call_arguments.delta', { output_index: 1, item_id: 'f1', delta: '"北京"}' }) +
    event('response.function_call_arguments.done', { output_index: 1, item_id: 'f1', arguments: call.arguments }) +
    event('response.output_text.done', { output_index: 0, item_id: 'm1', content_index: 0, text: '你好🌍' }) +
    event('response.content_part.done', { output_index: 0, item_id: 'm1', content_index: 0, part: message.content[0] }) +
    event('response.output_item.done', { output_index: 0, item: message }) + event('response.output_item.done', { output_index: 1, item: call }) +
    event('response.completed', { response: response('completed', [message, call]) });
}

describe('Responses streaming conversions', () => {
  it.each([1, 7, 127])('converts Responses text, tools, usage and completion across %s-byte CRLF chunks', async size => {
    const raw = await converted(responseStream().replace(/\n/g, '\r\n'), 'responses', 'openai', true, size), values = parse(raw);
    expect(values.flatMap(value => value.choices).map(choice => choice.delta.content || '').join('')).toBe('你好🌍');
    const calls = values.flatMap(value => value.choices).flatMap(choice => choice.delta.tool_calls || []);
    expect(calls[0]).toMatchObject({ id: 'tool1', index: 0, function: { name: 'weather' } });
    expect(calls.map(value => value.function.arguments || '').join('')).toBe(call.arguments);
    expect(values.at(-1).usage).toEqual(usage);
    expect(values.at(-2).choices[0].finish_reason).toBe('tool_calls');
    expect(raw.endsWith('data: [DONE]\n\n')).toBe(true);
  });
  it('converts Chat deltas into Responses lifecycle, complete output and monotonically ordered events', async () => {
    const raw = await converted(chat({ role: 'assistant', content: '你好' }) + chat({ content: '🌍' }) + chat({ tool_calls: [{ index: 0, id: 'tool1', type: 'function', function: { name: 'weather', arguments: '{"city":' } }] }) + chat({ tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] }) + chatEnd('tool_calls'), 'openai', 'responses');
    const values = parse(raw);
    expect(values.map(value => value.sequence_number)).toEqual(values.map((_, index) => index));
    expect(values.slice(0, 2).map(value => value.type)).toEqual(['response.created', 'response.in_progress']);
    expect(values.filter(value => value.type === 'response.output_text.delta').map(value => value.delta).join('')).toBe('你好🌍');
    expect(values.at(-1)).toMatchObject({ type: 'response.completed', response: { status: 'completed', usage: responseUsage, output: [{ type: 'message', content: [{ text: '你好🌍' }] }, { type: 'function_call', call_id: 'tool1', name: 'weather', arguments: call.arguments }] } });
    expect(raw).not.toContain('[DONE]');
  });
  it('bridges Responses to Anthropic with tools and cached usage', async () => {
    const values = parse(await converted(responseStream(), 'responses', 'anthropic'));
    expect(values.find(value => value.type === 'message_start').message.model).toBe('model');
    expect(values.find(value => value.content_block?.type === 'tool_use').content_block).toMatchObject({ id: 'tool1', name: 'weather' });
    expect(values.at(-2)).toMatchObject({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 8, output_tokens: 8, cache_read_input_tokens: 4 } });
    expect(values.at(-1).type).toBe('message_stop');
  });
  it('bridges Anthropic to Responses without dropping final usage', async () => {
    const source = event('message_start', { message: { id: 'a1', model: 'model', usage: { input_tokens: 10, output_tokens: 0 } } }) +
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) + event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } }) + event('content_block_stop', { index: 0 }) +
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) + event('message_stop');
    expect(parse(await converted(source, 'anthropic', 'responses')).at(-1)).toMatchObject({ type: 'response.completed', response: { output: [{ content: [{ text: 'hello' }] }], usage: { input_tokens: 10, output_tokens: 2 } } });
  });
  it.each(['length', 'content_filter'])('maps Chat %s to an incomplete Responses terminal', async reason => {
    const values = parse(await converted(chat({ content: 'partial' }) + chatEnd(reason), 'openai', 'responses'));
    expect(values.at(-1)).toMatchObject({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: reason === 'length' ? 'max_output_tokens' : 'content_filter' } } });
    expect(values.some(value => value.type === 'response.completed')).toBe(false);
  });
  it('converts Responses incomplete to a length finish reason', async () => {
    const source = event('response.created', { response: response() }) + event('response.incomplete', { response: { ...response('incomplete'), incomplete_details: { reason: 'max_output_tokens' } } });
    expect(parse(await converted(source, 'responses', 'openai')).at(-2).choices[0].finish_reason).toBe('length');
  });
  it('honors a Chat caller that does not request usage', async () => {
    expect(parse(await converted(responseStream(), 'responses', 'openai', false)).some(value => value.usage)).toBe(false);
  });
  it('supports split function names and interleaved function arguments', async () => {
    const source = chat({ tool_calls: [{ index: 0, id: 'first', function: { name: 'wea', arguments: '' } }, { index: 1, id: 'second', function: { name: 'clock', arguments: '{' } }] }) + chat({ tool_calls: [{ index: 0, function: { name: 'ther', arguments: '{}' } }, { index: 1, function: { arguments: '}' } }] }) + chatEnd('tool_calls');
    const values = parse(await converted(source, 'openai', 'responses'));
    expect(values.at(-1).response.output.map((item: any) => [item.call_id, item.name, item.arguments])).toEqual([['first', 'weather', '{}'], ['second', 'clock', '{}']]);
  });
  it.each(['responses', 'openai'] as const)('does not complete a truncated %s source', async from => {
    const source = from === 'responses' ? responseStream().replace(/event: response.completed[\s\S]*$/, '') : chat({ content: 'partial' });
    const result = await converted(source, from, from === 'responses' ? 'openai' : 'responses');
    expect(result).toContain('api_error'); expect(result).not.toContain('[DONE]'); expect(result).not.toContain('event: response.completed');
  });
  it('allows an empty reasoning marker before ordinary output', async () => {
    const item = { id: 'reasoning1', type: 'reasoning', summary: [] };
    const source = event('response.created', { response: response() }) + event('response.output_item.added', { output_index: 0, item }) + event('response.output_item.done', { output_index: 0, item }) + event('response.completed', { response: response('completed', [item]) });
    expect(await converted(source, 'responses', 'openai')).toContain('[DONE]');
  });
  it('rejects substantive reasoning instead of silently dropping it', async () => {
    const source = event('response.created', { response: response() }) + event('response.output_item.added', { output_index: 0, item: { id: 'reasoning1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] } });
    expect(await converted(source, 'responses', 'openai')).toContain('api_error');
  });
  it('limits accumulated Chat output while continuing to emit deltas', async () => {
    const source = Array.from({ length: 34 }, () => chat({ content: 'x'.repeat(65536) })).join('') + chatEnd();
    const output = await converted(source, 'openai', 'responses', true, 131072);
    expect(output).toContain('response.output_text.delta'); expect(output).toContain('event: error'); expect(output).not.toContain('event: response.completed');
  });
  it('emits Responses deltas before upstream completion and cancels the source', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn(), finish = vi.fn(() => controller.error(new Error('cancelled')));
    const source = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel: cancelled });
    const reader = convertStream(source, 'openai', 'responses', true, finish).getReader();
    controller.enqueue(encoder.encode(chat({ content: 'first' })));
    let result = '';
    while (!result.includes('response.output_text.delta')) result += new TextDecoder().decode((await reader.read()).value);
    expect(result).toContain('first'); expect(result).not.toContain('response.completed');
    await reader.cancel(); expect(finish).toHaveBeenCalled();
  });
});

describe('Responses error inspection', () => {
  it.each(['response.failed', 'response.error', 'error'])('hides %s provider detail and sends the original to tracing', async type => {
    const raw = event(type, type === 'response.failed' ? { response: { status: 'failed', error: { message: 'provider-secret', code: 'rate_limit_exceeded' } } } : { message: 'provider-secret', code: 'rate_limit_exceeded' });
    const onError = vi.fn(async (_raw: string) => ({ code: 'custom_error', message: '请稍后重试' })), finish = vi.fn();
    const output = await new Response(forwardStream(bytes(raw), 'responses', 'req1', finish, onError)).text();
    expect(output).not.toContain('provider-secret'); expect(onError.mock.calls[0]?.[0]).toContain('provider-secret');
    expect(parse(output)[0]).toMatchObject({ type: 'error', code: 'custom_error', message: '请稍后重试', request_id: 'req1' }); expect(finish).toHaveBeenCalled();
  });
  it('preserves native frames and requires a completed or incomplete terminal', async () => {
    const valid = responseStream().replace(/\n/g, '\r\n'), onError = vi.fn(async () => ({ code: 'upstream_stream_error', message: '中断' }));
    expect(await new Response(forwardStream(bytes(valid), 'responses', 'r', () => {}, onError)).text()).toBe(valid);
    expect(onError).not.toHaveBeenCalled();
    const truncated = event('response.created', { response: response() });
    expect(await new Response(forwardStream(bytes(truncated), 'responses', 'r', () => {}, onError)).text()).toContain('中断');
    expect(onError).toHaveBeenCalledWith('');
  });
  it('accepts a native incomplete terminal and numbers sanitized errors after prior events', async () => {
    const start = event('response.created', { response: response(), sequence_number: 12 });
    const incomplete = event('response.incomplete', { response: { ...response('incomplete'), incomplete_details: { reason: 'max_output_tokens' } }, sequence_number: 13 });
    const onError = vi.fn(async () => ({ code: 'mapped', message: '中断' }));
    expect(await new Response(forwardStream(bytes(start + incomplete), 'responses', 'r', () => {}, onError)).text()).toBe(start + incomplete);
    expect(onError).not.toHaveBeenCalled();
    const values = parse(await new Response(forwardStream(bytes(start), 'responses', 'r', () => {}, onError)).text());
    expect(values.at(-1)).toMatchObject({ type: 'error', sequence_number: 13 });
  });
  it('retains errors through the Responses to Anthropic bridge', async () => {
    const onError = vi.fn(async () => ({ code: 'mapped', message: '安全提示' }));
    const result = await new Response(convertStream(bytes(event('response.failed', { response: { error: { message: 'raw-failure' } } })), 'responses', 'anthropic', true, () => {}, onError, 'r1')).text();
    expect(result).toContain('安全提示'); expect(result).not.toContain('raw-failure'); expect(onError).toHaveBeenCalledWith(expect.stringContaining('raw-failure'));
  });
});
