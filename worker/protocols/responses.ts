import { ApiError } from '../lib/errors';
import type { InferenceInput, ObjectValue } from './convert';

const unsupported = (field: string) => new ApiError(400, 'unsupported_conversion', `跨协议转换不支持 ${field}，请使用同协议服务商或移除此参数`);
const invalid = () => new ApiError(502, 'invalid_upstream_response', '上游 Responses 响应不符合协议或包含无法转换的内容');
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unsupported('JSON 对象');
  return value as ObjectValue;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw unsupported('文本内容');
  return value;
}
function list(value: unknown): ObjectValue[] {
  if (!Array.isArray(value)) throw unsupported('内容数组');
  return value.map(object);
}
function fields(value: ObjectValue, allowed: string[], context: string) {
  for (const key of Object.keys(value)) if (value[key] != null && !allowed.includes(key)) throw unsupported(`${context}.${key}`);
}
function finalItem(item: ObjectValue) {
  if (item.status != null && item.status !== 'completed') throw unsupported(`input.${item.type}.status`);
}
function noAnnotations(part: ObjectValue) {
  if (part.annotations?.length || part.logprobs?.length) throw unsupported('output_text.annotations / logprobs');
}
function emptyReasoning(item: ObjectValue): boolean {
  return item.type === 'reasoning' && Array.isArray(item.summary) && !item.summary.length && !item.content?.length && !item.encrypted_content;
}
function imageURL(value: unknown): string {
  const url = text(value);
  if (!/^https?:\/\//.test(url) && !/^data:image\/[\w.+-]+;base64,/.test(url)) throw unsupported('input_image.image_url');
  return url;
}
function responseContent(value: unknown, role: string): { content: string | ObjectValue[]; refusal?: string } {
  if (typeof value === 'string') return { content: value };
  const content: ObjectValue[] = [], refusals: string[] = [];
  for (const part of list(value)) {
    if (part.type === 'input_text' || part.type === 'output_text' && role === 'assistant') {
      fields(part, ['type', 'text', 'annotations', 'logprobs'], 'input.content'); noAnnotations(part);
      content.push({ type: 'text', text: text(part.text) });
    } else if (part.type === 'input_image' && role === 'user') {
      fields(part, ['type', 'image_url', 'detail'], 'input.content');
      if (part.detail != null && !['auto', 'low', 'high'].includes(part.detail)) throw unsupported('input_image.detail');
      content.push({ type: 'image_url', image_url: { url: imageURL(part.image_url), ...(part.detail != null ? { detail: part.detail } : {}) } });
    } else if (part.type === 'refusal' && role === 'assistant') {
      fields(part, ['type', 'refusal'], 'input.content'); refusals.push(text(part.refusal));
    } else throw unsupported(`input.content.${part.type}`);
  }
  return { content, ...(refusals.length ? { refusal: refusals.join('') } : {}) };
}
function chatContent(value: unknown, role: string): ObjectValue[] {
  if (value == null) return [];
  if (typeof value === 'string') return [{ type: 'input_text', text: value }];
  return list(value).map(part => {
    if (part.type === 'text') {
      fields(part, ['type', 'text'], 'message.content');
      return { type: 'input_text', text: text(part.text) };
    }
    if (part.type === 'image_url' && role === 'user') {
      fields(part, ['type', 'image_url'], 'message.content'); const image = object(part.image_url);
      fields(image, ['url', 'detail'], 'image_url');
      if (image.detail != null && !['auto', 'low', 'high'].includes(image.detail)) throw unsupported('image_url.detail');
      return { type: 'input_image', image_url: imageURL(image.url), detail: image.detail || 'auto' };
    }
    throw unsupported(`message.content.${part.type}`);
  });
}
function strictSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = value as ObjectValue;
  if (schema.type === 'object' || schema.properties) {
    const properties = schema.properties || {};
    if (schema.additionalProperties !== false || !Array.isArray(schema.required) || Object.keys(properties).some(key => !schema.required.includes(key))) return false;
    if (Object.values(properties).some(child => !strictSchema(child))) return false;
  }
  if (schema.items && !strictSchema(schema.items)) return false;
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key] && (!Array.isArray(schema[key]) || schema[key].some((child: unknown) => !strictSchema(child)))) return false;
  if (schema.$defs && Object.values(schema.$defs).some(child => !strictSchema(child))) return false;
  return true;
}
function responseTools(value: unknown) {
  return list(value).map(tool => {
    fields(tool, ['type', 'name', 'description', 'parameters', 'strict'], 'tools');
    if (tool.type !== 'function') throw unsupported('Responses 内建或自定义工具');
    if (tool.strict != null && typeof tool.strict !== 'boolean') throw unsupported('tools.strict');
    // Responses tries to normalize omitted strict mode; do not silently alter a
    // caller's schema when its effective strictness cannot be reproduced in Chat.
    if (tool.strict == null && !strictSchema(tool.parameters)) throw unsupported('tools.strict（跨协议请显式设置 true 或 false）');
    return { type: 'function', function: { name: text(tool.name), ...(tool.description != null ? { description: text(tool.description) } : {}),
      parameters: tool.parameters == null ? { type: 'object', properties: {} } : object(tool.parameters), strict: tool.strict ?? true } };
  });
}
function chatTools(value: unknown) {
  return list(value).map(tool => {
    fields(tool, ['type', 'function'], 'tools'); if (tool.type !== 'function') throw unsupported('非 function 工具');
    const fn = object(tool.function); fields(fn, ['name', 'description', 'parameters', 'strict'], 'tool.function');
    if (fn.strict != null && typeof fn.strict !== 'boolean') throw unsupported('tool.function.strict');
    return { type: 'function', name: text(fn.name), ...(fn.description != null ? { description: text(fn.description) } : {}),
      parameters: fn.parameters == null ? { type: 'object', properties: {} } : object(fn.parameters), strict: fn.strict ?? false };
  });
}
function toolChoice(value: unknown, toResponses: boolean) {
  if (typeof value === 'string') {
    if (!['auto', 'none', 'required'].includes(value)) throw unsupported('tool_choice');
    return value;
  }
  const choice = object(value); fields(choice, toResponses ? ['type', 'function'] : ['type', 'name'], 'tool_choice');
  if (choice.type !== 'function') throw unsupported('tool_choice');
  if (toResponses) { const fn = object(choice.function); fields(fn, ['name'], 'tool_choice.function'); return { type: 'function', name: text(fn.name) }; }
  return { type: 'function', function: { name: text(choice.name) } };
}
function responseFormat(value: unknown, toResponses: boolean): ObjectValue {
  const format = object(value);
  if (['text', 'json_object'].includes(format.type)) { fields(format, ['type'], 'text.format'); return { type: format.type }; }
  if (format.type !== 'json_schema') throw unsupported('text.format');
  if (toResponses) {
    fields(format, ['type', 'json_schema'], 'response_format');
    const schema = object(format.json_schema); fields(schema, ['name', 'description', 'schema', 'strict'], 'response_format.json_schema');
    return { type: 'json_schema', ...schema, name: text(schema.name), schema: object(schema.schema) };
  }
  fields(format, ['type', 'name', 'description', 'schema', 'strict'], 'text.format');
  const { type, ...schema } = format;
  return { type, json_schema: { ...schema, name: text(schema.name), schema: object(schema.schema) } };
}
const COMMON = ['temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'user', 'safety_identifier', 'prompt_cache_key', 'prompt_cache_retention', 'service_tier'];
export function responsesRequestToChat(input: InferenceInput): InferenceInput & { messages: ObjectValue[] } {
  fields(input, ['model', 'stream', 'input', 'instructions', 'max_output_tokens', 'tools', 'tool_choice', 'text', 'reasoning', 'store', 'background', 'truncation', 'include', 'stream_options', ...COMMON], 'request');
  if (input.store === true || input.background === true || input.truncation != null && input.truncation !== 'disabled') throw unsupported('store / background / truncation');
  if (input.include != null && (!Array.isArray(input.include) || input.include.length)) throw unsupported('include');
  if (input.stream_options) { fields(object(input.stream_options), ['include_obfuscation'], 'stream_options'); if (input.stream_options.include_obfuscation !== false) throw unsupported('stream_options.include_obfuscation'); }
  const messages: ObjectValue[] = [];
  if (input.instructions != null) messages.push({ role: 'system', content: text(input.instructions) });
  const items = typeof input.input === 'string' ? [{ role: 'user', content: input.input }] : list(input.input ?? []);
  for (const item of items) {
    if (item.type == null || item.type === 'message') {
      fields(item, ['type', 'role', 'content', 'id', 'status'], 'input.message'); finalItem(item);
      if (!['user', 'assistant', 'system', 'developer'].includes(item.role)) throw unsupported('input.message.role');
      messages.push({ role: item.role, ...responseContent(item.content, item.role) });
    } else if (item.type === 'function_call') {
      fields(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status'], 'input.function_call'); finalItem(item);
      const call = { id: text(item.call_id), type: 'function', function: { name: text(item.name), arguments: text(item.arguments) } };
      const last = messages.at(-1);
      if (last?.role === 'assistant') (last.tool_calls ||= []).push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output') {
      fields(item, ['type', 'id', 'call_id', 'output', 'status'], 'input.function_call_output'); finalItem(item);
      messages.push({ role: 'tool', tool_call_id: text(item.call_id), ...responseContent(item.output, 'tool') });
    } else if (emptyReasoning(item)) {
      fields(item, ['type', 'id', 'summary', 'content', 'encrypted_content', 'status'], 'input.reasoning'); finalItem(item);
    } else throw unsupported(`input.${item.type}`);
  }
  if (!messages.length) throw unsupported('缺少 input / instructions');
  const result: InferenceInput & { messages: ObjectValue[] } = { model: input.model, stream: input.stream, messages };
  if (input.store === false) result.store = false;
  for (const key of COMMON) if (input[key] != null) result[key] = input[key];
  if (input.max_output_tokens != null) result.max_completion_tokens = input.max_output_tokens;
  if (input.tools != null) result.tools = responseTools(input.tools);
  if (input.tool_choice != null) result.tool_choice = toolChoice(input.tool_choice, false);
  if (input.text != null) { const config = object(input.text); fields(config, ['format'], 'text'); if (config.format != null) result.response_format = responseFormat(config.format, false); }
  if (input.reasoning != null) { const config = object(input.reasoning); fields(config, ['effort'], 'reasoning'); if (config.effort != null) result.reasoning_effort = config.effort; }
  if (input.stream) result.stream_options = { include_usage: true };
  return result;
}
export function chatRequestToResponses(input: InferenceInput): InferenceInput {
  fields(input, ['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'tools', 'tool_choice', 'response_format', 'reasoning_effort', 'n', 'stream_options', 'store', ...COMMON], 'request');
  if (input.n != null && input.n !== 1) throw unsupported('n > 1');
  if (input.store === true) throw unsupported('store');
  if (input.max_tokens != null && input.max_completion_tokens != null && input.max_tokens !== input.max_completion_tokens) throw unsupported('同时设置不同的 max_tokens / max_completion_tokens');
  if (input.stream_options) fields(object(input.stream_options), ['include_usage'], 'stream_options');
  const items: ObjectValue[] = [];
  for (const message of list(input.messages)) {
    fields(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'refusal'], 'message');
    if (message.role === 'tool') {
      if (message.tool_calls || message.refusal) throw unsupported('tool message');
      items.push({ type: 'function_call_output', call_id: text(message.tool_call_id), output: typeof message.content === 'string' ? message.content : chatContent(message.content, 'tool') });
      continue;
    }
    if (!['user', 'assistant', 'system', 'developer'].includes(message.role)) throw unsupported('message.role');
    if (message.tool_call_id != null || message.role !== 'assistant' && (message.tool_calls != null || message.refusal != null)) throw unsupported('message.tool_calls / refusal');
    const content = chatContent(message.content, message.role);
    // EasyInputMessage accepts input_text for assistant history. Refusals require
    // the full output-message form, including an ID and completed status.
    if (message.refusal != null) {
      for (const part of content) { part.type = 'output_text'; part.annotations = []; }
      content.push({ type: 'refusal', refusal: text(message.refusal) });
    }
    if (content.length || !message.tool_calls?.length) items.push({ type: 'message', role: message.role, content,
      ...(message.refusal != null ? { id: `msg_edgegate_${items.length}`, status: 'completed' } : {}) });
    for (const call of message.tool_calls ? list(message.tool_calls) : []) {
      fields(call, ['id', 'type', 'function'], 'tool_call'); if (call.type !== 'function') throw unsupported('tool_call.type');
      const fn = object(call.function); fields(fn, ['name', 'arguments'], 'tool_call.function');
      items.push({ type: 'function_call', call_id: text(call.id), name: text(fn.name), arguments: text(fn.arguments) });
    }
  }
  if (!items.length) throw unsupported('缺少 messages');
  // This adapter exposes create only, so converted responses are deliberately stateless.
  const result: InferenceInput = { model: input.model, stream: input.stream, input: items, store: false };
  for (const key of COMMON) if (input[key] != null) result[key] = input[key];
  if (input.max_completion_tokens != null || input.max_tokens != null) result.max_output_tokens = input.max_completion_tokens ?? input.max_tokens;
  if (input.tools != null) result.tools = chatTools(input.tools);
  if (input.tool_choice != null) result.tool_choice = toolChoice(input.tool_choice, true);
  if (input.response_format != null) result.text = { format: responseFormat(input.response_format, true) };
  if (input.reasoning_effort != null) result.reasoning = { effort: input.reasoning_effort };
  return result;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw invalid();
  return value;
}
export function responsesUsageToChat(usage: ObjectValue | null | undefined): ObjectValue | undefined {
  if (usage == null) return undefined;
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: usage.total_tokens == null ? input + output : count(usage.total_tokens),
    ...(usage.input_tokens_details?.cached_tokens != null ? { prompt_tokens_details: { cached_tokens: count(usage.input_tokens_details.cached_tokens) } } : {}),
    ...(usage.output_tokens_details?.reasoning_tokens != null ? { completion_tokens_details: { reasoning_tokens: count(usage.output_tokens_details.reasoning_tokens) } } : {}) };
}
export function chatUsageToResponses(usage: ObjectValue | null | undefined): ObjectValue | undefined {
  if (usage == null) return undefined;
  const input = count(usage.prompt_tokens), output = count(usage.completion_tokens);
  return { input_tokens: input, output_tokens: output, total_tokens: usage.total_tokens == null ? input + output : count(usage.total_tokens),
    input_tokens_details: { cached_tokens: count(usage.prompt_tokens_details?.cached_tokens ?? 0) },
    output_tokens_details: { reasoning_tokens: count(usage.completion_tokens_details?.reasoning_tokens ?? 0) } };
}
export function validateResponsesResponse(value: ObjectValue) {
  if (!value || value.object !== 'response' || typeof value.id !== 'string' || !value.id || typeof value.model !== 'string'
    || typeof value.created_at !== 'number' || !Number.isFinite(value.created_at) || !Array.isArray(value.output)
    || value.error != null || !['completed', 'incomplete', 'queued', 'in_progress'].includes(value.status)) throw invalid();
  for (const item of value.output) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.type !== 'string' || !item.type) throw invalid();
    if (item.type === 'message') {
      if (typeof item.id !== 'string' || item.role !== 'assistant' || !Array.isArray(item.content) || !['completed', 'in_progress', 'incomplete'].includes(item.status)) throw invalid();
      for (const part of item.content) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) throw invalid();
        if (part.type === 'output_text') {
          if (typeof part.text !== 'string' || !Array.isArray(part.annotations)) throw invalid();
        } else if (part.type !== 'refusal' || typeof part.refusal !== 'string') throw invalid();
      }
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string'
        || item.status != null && !['completed', 'in_progress', 'incomplete'].includes(item.status)) throw invalid();
    } else if (typeof item.id !== 'string') throw invalid();
  }
  if (value.usage != null) responsesUsageToChat(value.usage);
}
export function responsesResponseToChat(value: ObjectValue): ObjectValue {
  try {
    validateResponsesResponse(value);
    if (!['completed', 'incomplete'].includes(value.status)) throw invalid();
    const texts: string[] = [], refusals: string[] = [], calls: ObjectValue[] = [];
    for (const item of value.output) {
      if (item.type === 'message') {
        fields(item, ['id', 'type', 'role', 'content', 'status'], 'output.message');
        if (item.status === 'in_progress') throw invalid();
        for (const part of item.content) {
          if (part.type === 'output_text') { fields(part, ['type', 'text', 'annotations', 'logprobs'], 'output_text'); noAnnotations(part); texts.push(text(part.text)); }
          else { fields(part, ['type', 'refusal'], 'refusal'); refusals.push(text(part.refusal)); }
        }
      } else if (item.type === 'function_call') {
        fields(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status'], 'function_call');
        if (item.status === 'in_progress') throw invalid();
        calls.push({ type: 'function', id: text(item.call_id), function: { name: text(item.name), arguments: text(item.arguments) } });
      } else if (emptyReasoning(item)) {
        fields(item, ['type', 'id', 'summary', 'content', 'encrypted_content', 'status'], 'reasoning');
      } else throw invalid();
    }
    let finish = calls.length ? 'tool_calls' : 'stop';
    if (value.status === 'incomplete') {
      const reasons: Record<string, string> = { max_output_tokens: 'length', content_filter: 'content_filter' };
      finish = reasons[value.incomplete_details?.reason]; if (!finish) throw invalid();
    }
    const usage = responsesUsageToChat(value.usage);
    return { id: `chatcmpl-${value.id}`, object: 'chat.completion', created: value.created_at, model: value.model,
      choices: [{ index: 0, message: { role: 'assistant', content: texts.length ? texts.join('') : null,
        ...(refusals.length ? { refusal: refusals.join('') } : {}), ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish, logprobs: null }],
      ...(usage ? { usage } : {}) };
  } catch { throw invalid(); }
}
export function chatResponseToResponses(value: ObjectValue): ObjectValue {
  try {
    if (value.error || !Array.isArray(value.choices) || value.choices.length !== 1 || typeof value.id !== 'string' || typeof value.model !== 'string') throw invalid();
    const choice = object(value.choices[0]), message = object(choice.message);
    fields(message, ['role', 'content', 'refusal', 'tool_calls', 'annotations'], 'message');
    if (message.role !== 'assistant' || message.annotations?.length || choice.logprobs != null) throw invalid();
    if (!['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason)) throw invalid();
    const incomplete = choice.finish_reason === 'length' || choice.finish_reason === 'content_filter';
    const content: ObjectValue[] = [];
    if (message.content != null) content.push({ type: 'output_text', text: text(message.content), annotations: [], logprobs: [] });
    if (message.refusal != null) content.push({ type: 'refusal', refusal: text(message.refusal) });
    const output: ObjectValue[] = content.length || !message.tool_calls?.length
      ? [{ id: `msg_${value.id}`, type: 'message', role: 'assistant', status: incomplete ? 'incomplete' : 'completed', content }] : [];
    for (const call of message.tool_calls ? list(message.tool_calls) : []) {
      fields(call, ['id', 'type', 'function'], 'tool_call'); if (call.type !== 'function') throw invalid();
      const fn = object(call.function); fields(fn, ['name', 'arguments'], 'tool_call.function');
      output.push({ id: `fc_${text(call.id)}`, type: 'function_call', call_id: call.id, name: text(fn.name), arguments: text(fn.arguments), status: incomplete ? 'incomplete' : 'completed' });
    }
    return { id: `resp_${value.id}`, object: 'response', created_at: typeof value.created === 'number' ? value.created : Math.floor(Date.now() / 1000),
      status: incomplete ? 'incomplete' : 'completed', error: null,
      incomplete_details: incomplete ? { reason: choice.finish_reason === 'length' ? 'max_output_tokens' : 'content_filter' } : null,
      model: value.model, output, usage: chatUsageToResponses(value.usage) ?? null, store: false };
  } catch { throw invalid(); }
}
