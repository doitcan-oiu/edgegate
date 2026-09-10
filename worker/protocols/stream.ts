import type { Protocol } from '../types';
import { anthropicStop, anthropicUsage, badResponse, openaiStop, openaiUsage, type ObjectValue } from './convert';

const encoder = new TextEncoder();
const maxEvent = 1024 * 1024;
const event = (type: string, value: ObjectValue) => `event: ${type}\ndata: ${JSON.stringify({ ...value, type })}\n\n`;
const data = (value: ObjectValue) => `data: ${JSON.stringify(value)}\n\n`;
async function* frames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        if (boundary > maxEvent) throw badResponse();
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (payload) yield payload;
      }
      if (buffer.length > maxEvent) throw badResponse();
      if (done) { if (buffer.trim()) throw badResponse(); return; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function* anthropicToOpenAI(body: ReadableStream<Uint8Array>, includeUsage: boolean) {
  let id = '', model = '', reason: string | undefined, usage: ObjectValue = {}, started = false;
  const blocks = new Map<number, { type: string; toolIndex?: number; hasArguments?: boolean; closed?: boolean }>();
  let tools = 0;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: ObjectValue, finish: string | null = null) => data({ id, model, created, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] });
  for await (const payload of frames(body)) {
    const value = JSON.parse(payload) as ObjectValue;
    if (value.type === 'error') throw badResponse();
    if (value.type === 'ping') continue;
    if (value.type === 'message_start') {
      if (started || !value.message?.id) throw badResponse();
      started = true; id = `chatcmpl-${value.message.id}`; model = value.message.model; usage = { ...value.message.usage };
      yield chunk({ role: 'assistant', content: '' }); continue;
    }
    if (!started) throw badResponse();
    if (value.type === 'content_block_start') {
      const block = value.content_block;
      if (!Number.isInteger(value.index) || blocks.has(value.index) || blocks.size >= 256) throw badResponse();
      if (block.type === 'text') {
        blocks.set(value.index, { type: 'text' });
        if (block.text) yield chunk({ content: block.text });
      } else if (block.type === 'tool_use') {
        const index = tools++; blocks.set(value.index, { type: 'tool_use', toolIndex: index, hasArguments: !!Object.keys(block.input || {}).length });
        if (!block.id || !block.name) throw badResponse();
        yield chunk({ tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name, arguments: Object.keys(block.input || {}).length ? JSON.stringify(block.input) : '' } }] });
      } else throw badResponse();
    } else if (value.type === 'content_block_delta') {
      const block = blocks.get(value.index), delta = value.delta;
      if (block?.closed) throw badResponse();
      if (block?.type === 'text' && delta.type === 'text_delta') yield chunk({ content: delta.text });
      else if (block?.type === 'tool_use' && delta.type === 'input_json_delta') { block.hasArguments ||= !!delta.partial_json; yield chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: delta.partial_json } }] }); }
      else throw badResponse();
    } else if (value.type === 'content_block_stop') {
      const block = blocks.get(value.index);
      if (!block || block.closed) throw badResponse();
      if (block.type === 'tool_use' && !block.hasArguments) yield chunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: '{}' } }] });
      block.closed = true;
    } else if (value.type === 'message_delta') {
      usage = { ...usage, ...value.usage };
      if (value.delta?.stop_reason) reason = openaiStop(value.delta.stop_reason);
    } else if (value.type === 'message_stop') {
      if (!reason || [...blocks.values()].some(block => !block.closed)) throw badResponse();
      yield chunk({}, reason);
      if (includeUsage && openaiUsage(usage)) yield data({ id, model, created, object: 'chat.completion.chunk', choices: [], usage: openaiUsage(usage) });
      yield 'data: [DONE]\n\n'; return;
    } else throw badResponse();
  }
  throw badResponse();
}
async function* openaiToAnthropic(body: ReadableStream<Uint8Array>) {
  let started = false, nextIndex = 0, textIndex: number | undefined, reason: string | undefined, usage: ObjectValue | undefined;
  const open = new Set<number>();
  const tools = new Map<number, { index: number; id: string; name: string; pending: string; started: boolean }>();
  const stopBlocks = function* () { for (const index of [...open].sort((a, b) => a - b)) yield event('content_block_stop', { index }); open.clear(); };
  for await (const payload of frames(body)) {
    if (payload === '[DONE]') {
      if (!started || !reason || !usage) throw badResponse();
      for (const tool of tools.values()) if (!tool.started) {
        if (!tool.id || !tool.name) throw badResponse();
        tool.index = nextIndex++;
        yield event('content_block_start', { index: tool.index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }); open.add(tool.index);
        if (tool.pending) yield event('content_block_delta', { index: tool.index, delta: { type: 'input_json_delta', partial_json: tool.pending } });
      }
      yield* stopBlocks();
      yield event('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: anthropicUsage(usage) });
      yield event('message_stop', {}); return;
    }
    const value = JSON.parse(payload) as ObjectValue;
    if (value.error || !Array.isArray(value.choices)) throw badResponse();
    if (!started) {
      if (!value.id || !value.model) throw badResponse();
      started = true;
      // Streaming usage arrives later. Zero here is the protocol's initial counter;
      // the final message_delta replaces it with the reported upstream usage.
      yield event('message_start', { message: { id: `msg_${value.id}`, type: 'message', role: 'assistant', model: value.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    }
    if (value.usage) usage = value.usage;
    for (const choice of value.choices) {
      if (choice.index !== 0) throw badResponse();
      const delta = choice.delta || {};
      if (delta.function_call || delta.audio || delta.reasoning_content) throw badResponse();
      const text = delta.content ?? delta.refusal;
      if (text) {
        if (typeof text !== 'string') throw badResponse();
        if (textIndex === undefined) { textIndex = nextIndex++; open.add(textIndex); yield event('content_block_start', { index: textIndex, content_block: { type: 'text', text: '' } }); }
        yield event('content_block_delta', { index: textIndex, delta: { type: 'text_delta', text } });
      }
      for (const call of delta.tool_calls || []) {
        if (!Number.isInteger(call.index) || call.index < 0 || (call.type && call.type !== 'function')) throw badResponse();
        let tool = tools.get(call.index);
        if (!tool) {
          if (tools.size >= 64) throw badResponse();
          tool = { index: -1, id: '', name: '', pending: '', started: false }; tools.set(call.index, tool);
        }
        if (call.id) tool.id = call.id;
        if (call.function?.name) { if (tool.started) { if (tool.name !== call.function.name) throw badResponse(); } else tool.name += call.function.name; }
        const argument = call.function?.arguments || '';
        if (typeof argument !== 'string') throw badResponse();
        if (!tool.started) {
          tool.pending += argument;
          if (tool.pending.length > maxEvent) throw badResponse();
          if (tool.id && tool.name && tool.pending) {
            tool.started = true; tool.index = nextIndex++; open.add(tool.index);
            yield event('content_block_start', { index: tool.index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
            yield event('content_block_delta', { index: tool.index, delta: { type: 'input_json_delta', partial_json: tool.pending } }); tool.pending = '';
          }
        } else if (argument) yield event('content_block_delta', { index: tool.index, delta: { type: 'input_json_delta', partial_json: argument } });
      }
      if (choice.finish_reason) reason = anthropicStop(choice.finish_reason);
    }
  }
  throw badResponse();
}
export function convertStream(body: ReadableStream<Uint8Array>, from: Protocol, to: Protocol, includeUsage: boolean, finish: () => void) {
  const iterator = (from === 'anthropic' ? anthropicToOpenAI(body, includeUsage) : openaiToAnthropic(body))[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) { finish(); controller.close(); } else controller.enqueue(encoder.encode(next.value));
      } catch {
        finish(); await iterator.return?.();
        const error = { type: 'api_error', message: '上游流中断或包含无法转换的事件，请通过请求 ID 查看 Cloudflare 日志' };
        controller.enqueue(encoder.encode(to === 'anthropic' ? event('error', { error }) : data({ error })));
        controller.close();
      }
    },
    async cancel() { finish(); await iterator.return?.(); },
  });
}
