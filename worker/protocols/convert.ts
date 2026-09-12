import type { Protocol } from '../types';
import { ApiError } from '../lib/errors';
import { chatRequestToResponses, chatResponseToResponses, responsesRequestToChat, responsesResponseToChat, validateResponsesResponse } from './responses';

// Native requests retain provider extensions. Cross-protocol requests explicitly
// map supported options and omit the rest, while validating message/tool content.
export type ObjectValue = Record<string, any>;
export type InferenceInput = ObjectValue & { model: string; stream: boolean };
type MessageInput = InferenceInput & { messages: ObjectValue[] };
export const incompatible = (field: string) => new ApiError(400, 'unsupported_conversion', `跨协议转换不支持 ${field}，请使用同协议服务商或移除此参数`);
export const badResponse = () => new ApiError(502, 'invalid_upstream_response', '上游响应不符合目标协议或包含无法转换的内容');
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
    if (part.type === 'text') return { type: 'text', text: text(part.text) };
    if (images && part.type === 'image_url') return imageToAnthropic(part);
    throw incompatible(`content.${part.type}`);
  });
}
function anthropicContent(part: ObjectValue, images = true): ObjectValue {
  if (part.type === 'text') return { type: 'text', text: text(part.text) };
  if (images && part.type === 'image') {
    const source = object(part.source);
    if (source.type === 'base64') return { type: 'image_url', image_url: { url: `data:${text(source.media_type)};base64,${text(source.data)}` } };
    if (source.type === 'url') return { type: 'image_url', image_url: { url: text(source.url) } };
  }
  throw incompatible(`content.${part.type}`);
}
function toAnthropic(input: InferenceInput): MessageInput {
  const messages: ObjectValue[] = [], system: ObjectValue[] = [];
  const add = (role: string, content: ObjectValue[]) => {
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of list(input.messages)) {
    // These fields contain actual conversation content, unlike optional names,
    // cache hints or sampling options. Do not silently erase that content.
    if (message.audio || message.reasoning_content || message.function_call) throw incompatible('message.audio / reasoning_content / function_call');
    if (['system', 'developer'].includes(message.role)) { system.push(...openaiContent(message.content, false)); continue; }
    if (message.role === 'tool') { add('user', [{ type: 'tool_result', tool_use_id: text(message.tool_call_id), content: openaiContent(message.content) }]); continue; }
    if (!['user', 'assistant'].includes(message.role)) throw incompatible(`role.${message.role}`);
    const content = openaiContent(message.content, message.role === 'user');
    if (message.refusal != null) {
      if (message.role !== 'assistant') throw incompatible('message.refusal');
      content.push({ type: 'text', text: text(message.refusal) });
    }
    for (const call of message.tool_calls ? list(message.tool_calls) : []) {
      if (message.role !== 'assistant' || call.type !== 'function') throw incompatible('tool_calls');
      content.push({ type: 'tool_use', id: text(call.id), name: text(call.function?.name), input: argumentsObject(call.function?.arguments) });
    }
    add(message.role, content);
  }
  if (!messages.length) throw incompatible('缺少 user / assistant 消息');
  const result: MessageInput = { model: input.model, messages, stream: input.stream, max_tokens: input.max_completion_tokens ?? input.max_tokens ?? 4096 };
  if (system.length) result.system = system;
  if (input.user != null) result.metadata = { user_id: text(input.user) };
  if (typeof input.temperature === 'number' && input.temperature >= 0 && input.temperature <= 1) result.temperature = input.temperature;
  if (input.top_p != null) result.top_p = input.top_p;
  if (input.stop != null) result.stop_sequences = typeof input.stop === 'string' ? [input.stop] : input.stop;
  if (input.tools) {
    const tools = list(input.tools).filter(tool => tool.type === 'function').map(tool => {
      const fn = object(tool.function);
      return { name: text(fn.name), ...(fn.description ? { description: text(fn.description) } : {}), input_schema: fn.parameters || { type: 'object', properties: {} } };
    });
    if (tools.length) result.tools = tools;
  }
  const choice = input.tool_choice;
  if (result.tools?.length) {
    if (typeof choice === 'string' && ['auto', 'none', 'required'].includes(choice)) {
      result.tool_choice = { type: choice === 'required' ? 'any' : choice };
    } else if (choice?.type === 'function' && result.tools.some((tool: ObjectValue) => tool.name === choice.function?.name)) {
      result.tool_choice = { type: 'tool', name: text(choice.function.name) };
    }
    if (typeof input.parallel_tool_calls === 'boolean') result.tool_choice = { ...(result.tool_choice || { type: 'auto' }), disable_parallel_tool_use: !input.parallel_tool_calls };
  }
  return result;
}
function toOpenAI(input: InferenceInput): MessageInput {
  const messages: ObjectValue[] = [];
  if (input.system) messages.push({ role: 'system', content: typeof input.system === 'string' ? input.system : list(input.system).map(p => anthropicContent(p, false)) });
  for (const message of list(input.messages)) {
    if (!['user', 'assistant'].includes(message.role)) throw incompatible('message.role');
    if (typeof message.content === 'string') { messages.push({ role: message.role, content: message.content }); continue; }
    const blocks = list(message.content);
    if (message.role === 'assistant') {
      const content: ObjectValue[] = [], calls: ObjectValue[] = [];
      for (const block of blocks) {
        if (block.type === 'tool_use') { calls.push({ type: 'function', id: text(block.id), function: { name: text(block.name), arguments: JSON.stringify(object(block.input)) } }); }
        else content.push(anthropicContent(block, false));
      }
      messages.push({ role: 'assistant', content: content.length ? content.map(p => p.text).join('') : null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      let content: ObjectValue[] = [];
      const flush = () => { if (content.length) { messages.push({ role: 'user', content }); content = []; } };
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          flush();
          const result = typeof block.content === 'string' ? block.content : list(block.content || []).map(p => anthropicContent(p, false));
          messages.push({ role: 'tool', tool_call_id: text(block.tool_use_id), content: block.is_error ? JSON.stringify({ is_error: true, content: result }) : result });
        } else content.push(anthropicContent(block));
      }
      flush();
    }
  }
  const result: MessageInput = { model: input.model, messages, stream: input.stream, max_tokens: input.max_tokens };
  if (input.metadata) { const metadata = object(input.metadata); if (metadata.user_id != null) result.user = text(metadata.user_id); }
  for (const key of ['temperature', 'top_p']) if (input[key] != null) result[key] = input[key];
  if (input.stop_sequences) result.stop = input.stop_sequences;
  if (input.tools) {
    const tools = list(input.tools).filter(tool => tool.type == null || tool.type === 'custom').map(tool => ({
      type: 'function', function: { name: text(tool.name), ...(tool.description ? { description: text(tool.description) } : {}), parameters: object(tool.input_schema) },
    }));
    if (tools.length) result.tools = tools;
  }
  if (input.tool_choice && result.tools?.length) {
    const choice = object(input.tool_choice);
    if (choice.type === 'tool' && result.tools.some((tool: ObjectValue) => tool.function.name === choice.name)) result.tool_choice = { type: 'function', function: { name: text(choice.name) } };
    else if (['auto', 'none', 'any'].includes(choice.type)) result.tool_choice = choice.type === 'any' ? 'required' : choice.type;
    if (typeof choice.disable_parallel_tool_use === 'boolean') result.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  if (input.stream) result.stream_options = { include_usage: true };
  return result;
}
export function convertRequest(input: InferenceInput, from: Protocol, to: 'openai' | 'anthropic'): MessageInput;
export function convertRequest(input: InferenceInput, from: Protocol, to: Protocol): InferenceInput;
export function convertRequest(input: InferenceInput, from: Protocol, to: Protocol): InferenceInput {
  if (from === to) return { ...input };
  if (to === 'responses') return chatRequestToResponses(from === 'anthropic' ? toOpenAI(input) : input);
  if (from === 'responses') {
    const chat = responsesRequestToChat(input);
    if (to === 'openai') return chat;
    return toAnthropic(chat);
  }
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
  if (protocol === 'responses') { validateResponsesResponse(value); return; }
  if (!value || value.error || (protocol === 'openai' ? !Array.isArray(value.choices) : value.type !== 'message' || !Array.isArray(value.content))) throw badResponse();
}
export function convertResponse(value: ObjectValue, from: Protocol, to: Protocol): ObjectValue {
  validateResponse(value, from);
  if (from === to) return value;
  try {
    if (from === 'responses') {
      const chat = responsesResponseToChat(value);
      return to === 'openai' ? chat : convertResponse(chat, 'openai', 'anthropic');
    }
    if (to === 'responses') return chatResponseToResponses(from === 'anthropic' ? convertResponse(value, 'anthropic', 'openai') : value);
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
