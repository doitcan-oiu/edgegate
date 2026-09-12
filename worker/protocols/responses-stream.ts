import { badResponse, type ObjectValue } from './convert';
import { UpstreamStreamError } from './error-stream';

const data = (value: ObjectValue) => `data: ${JSON.stringify(value)}\n\n`;
const text = (value: unknown): string => { if (typeof value !== 'string') throw badResponse(); return value; };
const identifier = (value: unknown): string => { const result = text(value); if (!result || result.length > 512) throw badResponse(); return result; };
const position = (value: unknown): number => { if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 4096) throw badResponse(); return Number(value); };
const parse = (payload: string): ObjectValue => { const result = JSON.parse(payload); if (!result || typeof result !== 'object' || Array.isArray(result)) throw badResponse(); return result; };
function chatUsage(usage: ObjectValue | null | undefined) {
  if (!usage) return undefined;
  if (!Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) throw badResponse();
  return { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
    ...(usage.input_tokens_details ? { prompt_tokens_details: usage.input_tokens_details } : {}), ...(usage.output_tokens_details ? { completion_tokens_details: usage.output_tokens_details } : {}) };
}
function responsesUsage(usage: ObjectValue | undefined) {
  if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)) throw badResponse();
  return { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
    input_tokens_details: usage.prompt_tokens_details || { cached_tokens: 0 }, output_tokens_details: usage.completion_tokens_details || { reasoning_tokens: 0 } };
}

type Part = { type: 'output_text' | 'refusal'; length: number; done: boolean };
type ResponseItem = { id: string; type: 'message' | 'function_call' | 'reasoning'; done: boolean; parts: Map<number, Part>; toolIndex?: number; callId?: string; name?: string; length: number; argumentsDone?: boolean };
const emptyReasoning = (item: ObjectValue) => !item.encrypted_content && (!item.summary || (Array.isArray(item.summary) && item.summary.length === 0)) && (!item.content || (Array.isArray(item.content) && item.content.length === 0));

/** Convert semantic Responses events to incremental Chat Completion chunks. */
export async function* responsesToChat(source: AsyncIterable<string>, includeUsage: boolean) {
  let id = '', model = '', created = 0, toolCount = 0;
  const items = new Map<number, ResponseItem>();
  const chunk = (delta: ObjectValue, reason: string | null = null) => data({ id: `chatcmpl-${id}`, model, created, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reason, logprobs: null }] });
  const itemAt = (value: ObjectValue, type?: ResponseItem['type']) => {
    const item = items.get(position(value.output_index));
    if (!item || item.done || (type && item.type !== type) || (value.item_id != null && value.item_id !== item.id)) throw badResponse();
    return item;
  };
  for await (const payload of source) {
    const value = parse(payload);
    if (value.error || value.response?.error || ['error', 'response.error', 'response.failed'].includes(value.type)) throw new UpstreamStreamError(payload);
    if (value.type === 'response.created' || value.type === 'response.in_progress') {
      const response = value.response;
      if (!response || !['queued', 'in_progress'].includes(response.status)) throw badResponse();
      if (id) { if (response.id !== id || response.model !== model) throw badResponse(); continue; }
      id = identifier(response.id); model = identifier(response.model); created = response.created_at ?? Math.floor(Date.now() / 1000);
      yield chunk({ role: 'assistant', content: '' }); continue;
    }
    if (!id) throw badResponse();
    if (value.type === 'response.output_item.added') {
      const index = position(value.output_index), raw = value.item;
      if (items.has(index) || items.size >= 256 || !raw) throw badResponse();
      const item: ResponseItem = { id: identifier(raw.id), type: raw.type, done: false, parts: new Map(), length: 0 };
      if (item.type === 'message') {
        if (raw.role !== 'assistant' || !Array.isArray(raw.content) || raw.content.length) throw badResponse();
      } else if (item.type === 'function_call') {
        if (toolCount >= 64) throw badResponse();
        item.toolIndex = toolCount++; item.callId = identifier(raw.call_id); item.name = identifier(raw.name);
        const args = text(raw.arguments ?? ''); item.length = args.length;
        yield chunk({ tool_calls: [{ index: item.toolIndex, id: item.callId, type: 'function', function: { name: item.name, arguments: args } }] });
      } else if (item.type !== 'reasoning' || !emptyReasoning(raw)) throw badResponse();
      items.set(index, item);
    } else if (value.type === 'response.content_part.added') {
      const item = itemAt(value, 'message'), index = position(value.content_index), part = value.part;
      if (item.parts.has(index) || item.parts.size >= 256 || !part || !['output_text', 'refusal'].includes(part.type) || part.annotations?.length) throw badResponse();
      const initial = text(part.type === 'refusal' ? part.refusal : part.text);
      item.parts.set(index, { type: part.type, length: initial.length, done: false });
      if (initial) yield chunk({ [part.type === 'refusal' ? 'refusal' : 'content']: initial });
    } else if (['response.output_text.delta', 'response.refusal.delta', 'response.output_text.done', 'response.refusal.done', 'response.content_part.done'].includes(value.type)) {
      const item = itemAt(value, 'message'), part = item.parts.get(position(value.content_index));
      if (!part) throw badResponse();
      const field = part.type === 'refusal' ? 'refusal' : 'content';
      if (value.type.endsWith('.delta')) {
        if (part.done || value.type !== `response.${part.type}.delta`) throw badResponse();
        const delta = text(value.delta); part.length += delta.length;
        if (delta) yield chunk({ [field]: delta });
      } else {
        if (value.type === 'response.content_part.done' && (value.part?.type !== part.type || value.part?.annotations?.length)) throw badResponse();
        if (value.type !== 'response.content_part.done' && value.type !== `response.${part.type}.done`) throw badResponse();
        const final = text(value.type === 'response.content_part.done' ? value.part[part.type === 'refusal' ? 'refusal' : 'text'] : value[part.type === 'refusal' ? 'refusal' : 'text']);
        if (!part.length && final) { part.length = final.length; yield chunk({ [field]: final }); }
        if (part.length !== final.length) throw badResponse();
        part.done = true;
      }
    } else if (value.type === 'response.function_call_arguments.delta' || value.type === 'response.function_call_arguments.done') {
      const item = itemAt(value, 'function_call');
      if (item.argumentsDone) throw badResponse();
      const delta = value.type.endsWith('.delta') ? text(value.delta) : text(value.arguments);
      if (value.type.endsWith('.delta')) {
        item.length += delta.length;
        if (delta) yield chunk({ tool_calls: [{ index: item.toolIndex, function: { arguments: delta } }] });
      } else {
        if (!item.length && delta) { item.length = delta.length; yield chunk({ tool_calls: [{ index: item.toolIndex, function: { arguments: delta } }] }); }
        if (item.length !== delta.length) throw badResponse();
        item.argumentsDone = true;
      }
    } else if (value.type === 'response.output_item.done') {
      const item = itemAt(value), raw = value.item;
      if (!raw || raw.id !== item.id || raw.type !== item.type) throw badResponse();
      if (item.type === 'message') {
        if ([...item.parts.values()].some(part => !part.done) || !Array.isArray(raw.content) || raw.content.length !== item.parts.size) throw badResponse();
      } else if (item.type === 'function_call') {
        if (raw.call_id !== item.callId || raw.name !== item.name) throw badResponse();
        const args = text(raw.arguments);
        if (!item.length && args) { item.length = args.length; yield chunk({ tool_calls: [{ index: item.toolIndex, function: { arguments: args } }] }); }
        if (item.length !== args.length) throw badResponse();
      } else if (!emptyReasoning(raw)) throw badResponse();
      item.done = true;
    } else if (value.type === 'response.completed' || value.type === 'response.incomplete') {
      const response = value.response, incomplete = value.type === 'response.incomplete';
      if (!response || response.id !== id || response.status !== (incomplete ? 'incomplete' : 'completed') || [...items.values()].some(item => !item.done) || !Array.isArray(response.output) || response.output.length !== items.size) throw badResponse();
      for (const [index, item] of items) if (response.output[index]?.id !== item.id) throw badResponse();
      let reason = toolCount ? 'tool_calls' : 'stop';
      if (incomplete) {
        if (['max_output_tokens', 'max_tokens'].includes(response.incomplete_details?.reason)) reason = 'length';
        else if (response.incomplete_details?.reason === 'content_filter') reason = 'content_filter';
        else throw badResponse();
      }
      const usage = chatUsage(response.usage);
      yield chunk({}, reason);
      if (includeUsage && usage) yield data({ id: `chatcmpl-${id}`, model, created, object: 'chat.completion.chunk', choices: [], usage });
      yield 'data: [DONE]\n\n'; return;
    } else throw badResponse();
  }
  throw badResponse();
}

type ChatTool = { index: number; item: ObjectValue; started: boolean };
/** Emit deltas immediately; retain only bounded output needed by Responses done events. */
export async function* chatToResponses(source: AsyncIterable<string>, onSequence?: (next: number) => void) {
  let id = '', model = '', created = 0, sequence = 0, finishReason = '', retained = 0;
  let usage: ObjectValue | undefined, message: ObjectValue | undefined, messageIndex = -1;
  const output: ObjectValue[] = [], tools = new Map<number, ChatTool>();
  const event = (type: string, value: ObjectValue) => { const result = `event: ${type}\ndata: ${JSON.stringify({ type, ...value, sequence_number: sequence++ })}\n\n`; onSequence?.(sequence); return result; };
  const response = (status: string) => ({ id, object: 'response', created_at: created, status, error: null, incomplete_details: status === 'incomplete' ? { reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } : null, model, output: status === 'in_progress' ? [] : output, usage: status === 'in_progress' ? null : responsesUsage(usage) });
  const retain = (value: string) => { retained += value.length; if (retained > 2 * 1024 * 1024) throw badResponse(); return value; };
  const startTool = function* (tool: ChatTool) {
    if (!tool.item.call_id || !tool.item.name) throw badResponse();
    tool.started = true;
    yield event('response.output_item.added', { output_index: tool.index, item: { ...tool.item, arguments: '' } });
    if (tool.item.arguments) yield event('response.function_call_arguments.delta', { item_id: tool.item.id, output_index: tool.index, delta: tool.item.arguments });
  };
  for await (const payload of source) {
    if (payload === '[DONE]') {
      if (!id || !finishReason) throw badResponse();
      responsesUsage(usage);
      for (const tool of tools.values()) if (!tool.started) yield* startTool(tool);
      const status = ['length', 'content_filter'].includes(finishReason) ? 'incomplete' : 'completed';
      for (let index = 0; index < output.length; index++) {
        const item = output[index]; item.status = status;
        if (item.type === 'message') {
          for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
            const part = item.content[contentIndex], common = { item_id: item.id, output_index: index, content_index: contentIndex };
            yield event(`response.${part.type}.done`, { ...common, [part.type === 'refusal' ? 'refusal' : 'text']: part.type === 'refusal' ? part.refusal : part.text, ...(part.type === 'output_text' ? { logprobs: [] } : {}) });
            yield event('response.content_part.done', { ...common, part });
          }
        } else yield event('response.function_call_arguments.done', { item_id: item.id, output_index: index, name: item.name, arguments: item.arguments });
        yield event('response.output_item.done', { output_index: index, item });
      }
      yield event(`response.${status}`, { response: response(status) }); return;
    }
    const value = parse(payload);
    if (value.error) throw new UpstreamStreamError(payload);
    if (!Array.isArray(value.choices)) throw badResponse();
    if (!id) {
      id = `resp_${identifier(value.id)}`; model = identifier(value.model); created = value.created ?? Math.floor(Date.now() / 1000);
      yield event('response.created', { response: response('in_progress') });
      yield event('response.in_progress', { response: response('in_progress') });
    }
    if (value.usage) usage = value.usage;
    for (const choice of value.choices) {
      if (choice.index !== 0 || finishReason) throw badResponse();
      const delta = choice.delta || {};
      if (delta.function_call || delta.audio || delta.reasoning_content || (delta.role && delta.role !== 'assistant') || choice.logprobs) throw badResponse();
      for (const field of ['content', 'refusal'] as const) {
        if (delta[field] == null || delta[field] === '') continue;
        const addition = retain(text(delta[field])), type = field === 'content' ? 'output_text' : 'refusal';
        if (!message) {
          messageIndex = output.length; message = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'in_progress', content: [] }; output.push(message);
          yield event('response.output_item.added', { output_index: messageIndex, item: { ...message, content: [] } });
        }
        let part = message.content.find((part: ObjectValue) => part.type === type), contentIndex = message.content.indexOf(part);
        if (!part) {
          part = type === 'output_text' ? { type, text: '', annotations: [], logprobs: [] } : { type, refusal: '' };
          contentIndex = message.content.length; message.content.push(part);
          yield event('response.content_part.added', { item_id: message.id, output_index: messageIndex, content_index: contentIndex, part });
        }
        part[field === 'content' ? 'text' : 'refusal'] += addition;
        yield event(`response.${type}.delta`, { item_id: message.id, output_index: messageIndex, content_index: contentIndex, delta: addition, ...(type === 'output_text' ? { logprobs: [] } : {}) });
      }
      if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) throw badResponse();
      for (const call of delta.tool_calls || []) {
        const index = position(call.index);
        if (call.type && call.type !== 'function') throw badResponse();
        let tool = tools.get(index);
        if (!tool) {
          if (tools.size >= 64) throw badResponse();
          tool = { index: output.length, item: { type: 'function_call', id: `fc_${id}_${index}`, call_id: '', name: '', arguments: '', status: 'in_progress' }, started: false };
          tools.set(index, tool); output.push(tool.item);
        }
        if (call.id) { const callId = identifier(call.id); if (tool.item.call_id && tool.item.call_id !== callId) throw badResponse(); tool.item.call_id = callId; }
        if (call.function?.name) {
          const name = identifier(call.function.name);
          if (tool.started) { if (tool.item.name !== name) throw badResponse(); } else tool.item.name += name;
          if (tool.item.name.length > 512) throw badResponse();
        }
        const args = call.function?.arguments == null ? '' : retain(text(call.function.arguments));
        tool.item.arguments += args;
        if (!tool.started && tool.item.call_id && tool.item.name && args) yield* startTool(tool);
        else if (tool.started && args) yield event('response.function_call_arguments.delta', { item_id: tool.item.id, output_index: tool.index, delta: args });
      }
      if (choice.finish_reason != null) {
        if (!['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason)) throw badResponse();
        finishReason = choice.finish_reason;
      }
    }
  }
  throw badResponse();
}
