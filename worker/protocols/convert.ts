import type { Protocol } from '../types';
import { ApiError } from '../lib/errors';

// Protocol boundaries accept provider extensions; cross-protocol conversion validates
// the fields it can represent and rejects the rest instead of losing instructions.
export type ObjectValue = Record<string, any>;
export type InferenceInput = ObjectValue & { model: string; messages: ObjectValue[]; stream: boolean };
export const incompatible = (field: string) => new ApiError(400, 'unsupported_conversion', `跨协议转换不支持 ${field}，请使用同协议服务商或移除此参数`);
export const badResponse = () => new ApiError(502, 'invalid_upstream_response', '上游响应不符合目标协议或包含无法转换的内容');
function fields(value: ObjectValue, allowed: string[], context: string) {
  for (const key of Object.keys(value)) if (value[key] != null && !allowed.includes(key)) throw incompatible(`${context}.${key}`);
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw incompatible('JSON 对象');
  return value as ObjectValue;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw incompatible('文本内容');
  return value;
}
function list(value: unknown): ObjectValue[] {
  if (!Array.isArray(value)) throw incompatible('内容数组');
  return value.map(object);
}
function argumentsObject(value: unknown) {
  try { return object(JSON.parse(text(value))); } catch { throw incompatible('工具 arguments（必须是 JSON 对象字符串）'); }
}
function imageToAnthropic(part: ObjectValue) {
  const url = text(part.image_url?.url);
  const data = url.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
  if (!/^https?:\/\//.test(url)) throw incompatible('image_url');
  return { type: 'image', source: { type: 'url', url } };
}
function openaiContent(value: unknown, images = true): ObjectValue[] {
  if (value == null) return [];
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  return list(value).map(part => {
    if (part.type === 'text') { fields(part, ['type', 'text'], 'content'); return { type: 'text', text: text(part.text) }; }
    if (images && part.type === 'image_url') return imageToAnthropic(part);
    throw incompatible(`content.${part.type}`);
  });
}
function anthropicContent(part: ObjectValue, images = true): ObjectValue {
  if (part.cache_control || part.citations?.length) throw incompatible('cache_control / citations');
  if (part.type === 'text') return { type: 'text', text: text(part.text) };
  if (images && part.type === 'image') {
    const source = object(part.source);
    if (source.type === 'base64') return { type: 'image_url', image_url: { url: `data:${text(source.media_type)};base64,${text(source.data)}` } };
    if (source.type === 'url') return { type: 'image_url', image_url: { url: text(source.url) } };
  }
  throw incompatible(`content.${part.type}`);
}
function toAnthropic(input: InferenceInput): InferenceInput {
  fields(input, ['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'tools', 'tool_choice', 'parallel_tool_calls', 'n', 'stream_options', 'user'], 'request');
  if (input.n != null && input.n !== 1) throw incompatible('n > 1');
  if (input.temperature != null && (input.temperature < 0 || input.temperature > 1)) throw incompatible('Anthropic temperature 范围为 0–1');
  const messages: ObjectValue[] = [], system: ObjectValue[] = [];
  const add = (role: string, content: ObjectValue[]) => {
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of input.messages) {
    fields(message, ['role', 'content', 'tool_calls', 'tool_call_id'], 'message');
    if (['system', 'developer'].includes(message.role)) { system.push(...openaiContent(message.content, false)); continue; }
    if (message.role === 'tool') { add('user', [{ type: 'tool_result', tool_use_id: text(message.tool_call_id), content: openaiContent(message.content) }]); continue; }
    if (!['user', 'assistant'].includes(message.role)) throw incompatible(`role.${message.role}`);
    const content = openaiContent(message.content, message.role === 'user');
    for (const call of message.tool_calls ? list(message.tool_calls) : []) {
      if (message.role !== 'assistant' || call.type !== 'function') throw incompatible('tool_calls');
      content.push({ type: 'tool_use', id: text(call.id), name: text(call.function?.name), input: argumentsObject(call.function?.arguments) });
    }
    add(message.role, content);
  }
  if (!messages.length) throw incompatible('缺少 user / assistant 消息');
  const result: InferenceInput = { model: input.model, messages, stream: input.stream, max_tokens: input.max_completion_tokens ?? input.max_tokens ?? 4096 };
  if (system.length) result.system = system;
  if (input.user != null) result.metadata = { user_id: text(input.user) };
  for (const key of ['temperature', 'top_p']) if (input[key] != null) result[key] = input[key];
  if (input.stop != null) result.stop_sequences = typeof input.stop === 'string' ? [input.stop] : input.stop;
  if (input.tools) result.tools = list(input.tools).map(tool => {
    if (tool.type !== 'function') throw incompatible('非 function 工具');
    const fn = object(tool.function); fields(fn, ['name', 'description', 'parameters', 'strict'], 'tool.function');
    if (fn.strict === true) throw incompatible('tool.strict');
    return { name: text(fn.name), ...(fn.description ? { description: text(fn.description) } : {}), input_schema: fn.parameters || { type: 'object', properties: {} } };
  });
  const choice = input.tool_choice;
  if (typeof choice === 'string') {
    if (!['auto', 'none', 'required'].includes(choice)) throw incompatible('tool_choice');
    result.tool_choice = { type: choice === 'required' ? 'any' : choice };
  } else if (choice) {
    if (choice.type !== 'function') throw incompatible('tool_choice');
    result.tool_choice = { type: 'tool', name: text(choice.function?.name) };
  }
  if (typeof input.parallel_tool_calls === 'boolean' && result.tools?.length) result.tool_choice = { ...(result.tool_choice || { type: 'auto' }), disable_parallel_tool_use: !input.parallel_tool_calls };
  return result;
}
function toOpenAI(input: InferenceInput): InferenceInput {
  fields(input, ['model', 'messages', 'stream', 'max_tokens', 'system', 'temperature', 'top_p', 'stop_sequences', 'tools', 'tool_choice', 'metadata'], 'request');
  const messages: ObjectValue[] = [];
  if (input.system) messages.push({ role: 'system', content: typeof input.system === 'string' ? input.system : list(input.system).map(p => anthropicContent(p, false)) });
  for (const message of input.messages) {
    fields(message, ['role', 'content'], 'message');
    if (typeof message.content === 'string') { messages.push({ role: message.role, content: message.content }); continue; }
    const blocks = list(message.content);
    if (message.role === 'assistant') {
      const content: ObjectValue[] = [], calls: ObjectValue[] = [];
      for (const block of blocks) {
        if (block.type === 'tool_use') { fields(block, ['type', 'id', 'name', 'input'], 'tool_use'); calls.push({ type: 'function', id: text(block.id), function: { name: text(block.name), arguments: JSON.stringify(object(block.input)) } }); }
        else content.push(anthropicContent(block, false));
      }
      messages.push({ role: 'assistant', content: content.length ? content.map(p => p.text).join('') : null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      let content: ObjectValue[] = [];
      const flush = () => { if (content.length) { messages.push({ role: 'user', content }); content = []; } };
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          fields(block, ['type', 'tool_use_id', 'content', 'is_error'], 'tool_result'); flush();
          const result = typeof block.content === 'string' ? block.content : list(block.content || []).map(p => anthropicContent(p, false));
          messages.push({ role: 'tool', tool_call_id: text(block.tool_use_id), content: block.is_error ? JSON.stringify({ is_error: true, content: result }) : result });
        } else content.push(anthropicContent(block));
      }
      flush();
    }
  }
  const result: InferenceInput = { model: input.model, messages, stream: input.stream, max_tokens: input.max_tokens };
  if (input.metadata) { fields(object(input.metadata), ['user_id'], 'metadata'); if (input.metadata.user_id != null) result.user = text(input.metadata.user_id); }
  for (const key of ['temperature', 'top_p']) if (input[key] != null) result[key] = input[key];
  if (input.stop_sequences) result.stop = input.stop_sequences;
  if (input.tools) result.tools = list(input.tools).map(tool => {
    fields(tool, ['name', 'description', 'input_schema'], 'tool');
    return { type: 'function', function: { name: text(tool.name), ...(tool.description ? { description: text(tool.description) } : {}), parameters: object(tool.input_schema) } };
  });
  if (input.tool_choice) {
    const choice = object(input.tool_choice); fields(choice, ['type', 'name', 'disable_parallel_tool_use'], 'tool_choice');
    if (choice.type === 'tool') result.tool_choice = { type: 'function', function: { name: text(choice.name) } };
    else if (['auto', 'none', 'any'].includes(choice.type)) result.tool_choice = choice.type === 'any' ? 'required' : choice.type;
    else throw incompatible('tool_choice');
    if (typeof choice.disable_parallel_tool_use === 'boolean') result.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  if (input.stream) result.stream_options = { include_usage: true };
  return result;
}
export function convertRequest(input: InferenceInput, from: Protocol, to: Protocol): InferenceInput {
  if (from === to) return { ...input };
  return to === 'anthropic' ? toAnthropic(input) : toOpenAI(input);
}
export function openaiStop(reason: unknown): string {
  const mapped: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'content_filter' };
  if (typeof reason !== 'string' || !mapped[reason]) throw badResponse();
  return mapped[reason];
}
export function anthropicStop(reason: unknown): string {
  const mapped: Record<string, string> = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };
  if (typeof reason !== 'string' || !mapped[reason]) throw badResponse();
  return mapped[reason];
}
export function openaiUsage(usage: ObjectValue | undefined) {
  if (usage?.input_tokens == null || usage.output_tokens == null) return undefined;
  const prompt = usage.input_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return { prompt_tokens: prompt, completion_tokens: usage.output_tokens, total_tokens: prompt + usage.output_tokens,
    ...(usage.cache_read_input_tokens != null ? { prompt_tokens_details: { cached_tokens: usage.cache_read_input_tokens } } : {}) };
}
export function anthropicUsage(usage: ObjectValue | undefined) {
  if (usage?.prompt_tokens == null || usage.completion_tokens == null) throw badResponse();
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  return { input_tokens: Math.max(0, usage.prompt_tokens - cached), output_tokens: usage.completion_tokens, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
}
export function validateResponse(value: ObjectValue, protocol: Protocol) {
  if (!value || value.error || (protocol === 'openai' ? !Array.isArray(value.choices) : value.type !== 'message' || !Array.isArray(value.content))) throw badResponse();
}
export function convertResponse(value: ObjectValue, from: Protocol, to: Protocol): ObjectValue {
  validateResponse(value, from);
  if (from === to) return value;
  try {
    if (from === 'anthropic') {
      const texts: string[] = [], calls: ObjectValue[] = [];
      for (const block of value.content) {
        if (block.type === 'text' && !block.citations?.length) texts.push(text(block.text));
        else if (block.type === 'tool_use') calls.push({ id: text(block.id), type: 'function', function: { name: text(block.name), arguments: JSON.stringify(object(block.input)) } });
        else throw badResponse();
      }
      return { id: `chatcmpl-${value.id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: value.model,
        choices: [{ index: 0, message: { role: 'assistant', content: texts.length ? texts.join('') : null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: openaiStop(value.stop_reason), logprobs: null }],
        ...(openaiUsage(value.usage) ? { usage: openaiUsage(value.usage) } : {}) };
    }
    if (value.choices.length !== 1) throw badResponse();
    const choice = value.choices[0], message = object(choice.message), content: ObjectValue[] = [];
    if (message.audio || message.reasoning_content || message.function_call) throw badResponse();
    if (message.content) content.push({ type: 'text', text: text(message.content) });
    if (message.refusal) content.push({ type: 'text', text: text(message.refusal) });
    for (const tool of message.tool_calls || []) {
      if (tool.type !== 'function') throw badResponse();
      content.push({ type: 'tool_use', id: text(tool.id), name: text(tool.function?.name), input: argumentsObject(tool.function?.arguments) });
    }
    return { id: `msg_${value.id}`, type: 'message', role: 'assistant', model: value.model, content, stop_reason: anthropicStop(choice.finish_reason), stop_sequence: null, usage: anthropicUsage(value.usage) };
  } catch { throw badResponse(); }
}
