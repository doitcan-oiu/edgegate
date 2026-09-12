import { describe, expect, it } from 'vitest';
import { convertRequest, convertResponse, validateResponse, type InferenceInput, type ObjectValue } from '../worker/protocols/convert';

const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
const request: InferenceInput = { model: 'm', stream: false, input: '你好' };
const chat: InferenceInput = { model: 'm', stream: false, messages: [{ role: 'user', content: '你好' }] };
const tool = { type: 'function', name: 'weather', parameters: schema, strict: false };
const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'weather', arguments: '{"city":"北京"}', status: 'completed' };
const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好', annotations: [] }] };
const response: ObjectValue = { id: 'resp_1', object: 'response', created_at: 1700000000, model: 'm', status: 'completed', error: null, incomplete_details: null,
  output: [message], usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } };
const completion: ObjectValue = { id: 'chatcmpl_1', object: 'chat.completion', created: 1700000000, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop', logprobs: null }],
  usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } };

describe('Responses nonstream request conversion', () => {
  it('preserves native state, built-in tools and provider extensions verbatim', () => {
    const input = { ...request, previous_response_id: 'resp_old', conversation: 'conv_old', background: true, store: true, tools: [{ type: 'web_search' }], vendor_option: { enabled: true } };
    expect(convertRequest(input, 'responses', 'responses')).toEqual(input);
  });
  it('converts instructions, images and a full tool round trip without mutating the source', () => {
    const input = { ...request, instructions: '请简洁回答', max_output_tokens: 500, tools: [tool], tool_choice: { type: 'function', name: 'weather' }, parallel_tool_calls: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '查天气' }, { type: 'input_image', image_url: 'data:image/png;base64,YQ==', detail: 'high' }] },
        message, call, { type: 'function_call_output', call_id: 'call_1', output: '晴天' }, { role: 'user', content: '继续' }] };
    const original = structuredClone(input);
    const result = convertRequest(input, 'responses', 'openai');
    expect(result.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(result.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==', detail: 'high' } });
    expect(result.messages[2].tool_calls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: call.arguments } }]);
    expect(result.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '晴天' });
    expect(result).toMatchObject({ max_completion_tokens: 500, tools: [{ type: 'function', function: { name: 'weather', strict: false, parameters: schema } }], tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: false });
    expect(input).toEqual(original);
  });
  it('builds Responses input items from Chat multi-turn text, images, calls and results', () => {
    const input = { ...chat, max_completion_tokens: 800, tools: [{ type: 'function', function: { name: 'weather', parameters: schema } }], tool_choice: 'required',
      messages: [{ role: 'developer', content: '规则' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
        { role: 'assistant', content: '正在查询', tool_calls: [{ type: 'function', id: 'call_1', function: { name: 'weather', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: '晴天' }] }] };
    const original = structuredClone(input);
    const result = convertRequest(input, 'openai', 'responses');
    expect(result).toMatchObject({ store: false, max_output_tokens: 800, tools: [{ ...tool, strict: false }], tool_choice: 'required' });
    expect(result.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '规则' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: '正在查询' }] },
      { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: '晴天' }] },
    ]);
    expect(input).toEqual(original);
  });
  it('preserves assistant refusal history with a valid complete output-message item', () => {
    const result = convertRequest({ ...chat, messages: [{ role: 'assistant', content: '抱歉', refusal: '无法完成' }] }, 'openai', 'responses');
    expect(result.input[0]).toMatchObject({ id: expect.stringMatching(/^msg_/), status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '抱歉', annotations: [] }, { type: 'refusal', refusal: '无法完成' }] });
    expect(convertRequest(result, 'responses', 'openai').messages[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '抱歉' }], refusal: '无法完成' });
  });
  it('bridges Responses to Anthropic including benign defaults, instructions, tools and images', () => {
    const result = convertRequest({ ...request, store: false, metadata: {}, text: { format: { type: 'text' } }, instructions: '规则', max_output_tokens: 300, tools: [tool], tool_choice: 'required',
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }, call, { type: 'function_call_output', call_id: 'call_1', output: '晴天' }] }, 'responses', 'anthropic');
    expect(result).toMatchObject({ max_tokens: 300, system: [{ type: 'text', text: '规则' }], tools: [{ name: 'weather', input_schema: schema }], tool_choice: { type: 'any' } });
    expect(result.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } });
    expect(result.messages[1].content[0]).toEqual({ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: '北京' } });
    expect(result.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
    expect(result).not.toHaveProperty('store');
  });
  it('bridges Anthropic to Responses with system and tool-use history', () => {
    const result = convertRequest({ model: 'm', stream: false, system: '规则', max_tokens: 400, tools: [{ name: 'weather', input_schema: schema }],
      messages: [{ role: 'user', content: '天气' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: '北京' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴天' }] }] }, 'anthropic', 'responses');
    expect(result).toMatchObject({ max_output_tokens: 400, store: false, tools: [{ ...tool, strict: false }] });
    expect(result.input.map((item: ObjectValue) => item.type)).toEqual(['message', 'message', 'function_call', 'function_call_output']);
    expect(result.input[2]).toMatchObject({ call_id: 'call_1', arguments: '{"city":"北京"}' });
  });
  it.each(['text', 'json_object'])('maps %s text formats both directions', type => {
    const converted = convertRequest({ ...chat, response_format: { type } }, 'openai', 'responses');
    expect(converted.text).toEqual({ format: { type } });
    expect(convertRequest(converted, 'responses', 'openai').response_format).toEqual({ type });
  });
  it('maps named JSON schemas and reasoning effort without dropping schema strictness', () => {
    const jsonSchema = { name: 'weather', description: '天气', schema, strict: true };
    const result = convertRequest({ ...chat, response_format: { type: 'json_schema', json_schema: jsonSchema }, reasoning_effort: 'low' }, 'openai', 'responses');
    expect(result.text).toEqual({ format: { type: 'json_schema', ...jsonSchema } });
    expect(result.reasoning).toEqual({ effort: 'low' });
    const reversed = convertRequest(result, 'responses', 'openai');
    expect(reversed.response_format).toEqual({ type: 'json_schema', json_schema: jsonSchema });
    expect(reversed.reasoning_effort).toBe('low');
  });
  it('preserves explicit tool strictness and infers a safe default without rewriting the schema', () => {
    expect(convertRequest({ ...request, tools: [{ ...tool, strict: true }] }, 'responses', 'openai').tools[0].function.strict).toBe(true);
    expect(convertRequest({ ...request, tools: [tool] }, 'responses', 'openai').tools[0].function.strict).toBe(false);
    const { strict: _, ...implicit } = tool;
    expect(convertRequest({ ...request, tools: [implicit] }, 'responses', 'openai').tools[0].function.strict).toBe(true);
    expect(convertRequest({ ...request, tools: [{ ...implicit, parameters: {} }] }, 'responses', 'openai').tools[0].function.strict).toBe(false);
    expect(convertRequest({ ...request, tools: [{ type: 'function', name: 'weather' }] }, 'responses', 'openai').tools[0].function.strict).toBe(false);
    const optionalSchema = { type: 'object', properties: { city: { type: 'string', default: '北京', 'x-vendor': 'keep' } } };
    const input = { ...request, tools: [{ ...implicit, parameters: optionalSchema, cache_control: { type: 'ephemeral' } }] };
    const before = structuredClone(input);
    expect(convertRequest(input, 'responses', 'openai').tools).toEqual([{ type: 'function', function: { name: 'weather', parameters: optionalSchema, strict: false } }]);
    expect(input).toEqual(before);
  });
  it('allows stateless replay of empty reasoning markers with complete message output', () => {
    const input = { ...request, input: [{ type: 'reasoning', id: 'rs_1', summary: [] }, message, { role: 'user', content: '继续' }] };
    expect(convertRequest(input, 'responses', 'openai').messages.map(m => m.role)).toEqual(['assistant', 'user']);
  });
  it('omits unsupported Responses tuning and nested metadata without mutating the source', () => {
    const input = { ...request, stream: true, store: true, background: true, truncation: 'auto', include: ['reasoning.encrypted_content'],
      vendor_option: { enabled: true }, frequency_penalty: 0.7, stream_options: { include_obfuscation: true, vendor: 'extra' },
      reasoning: { effort: 'low', summary: 'auto', vendor: 'extra' }, text: { verbosity: 'high', format: { type: 'text', vendor: true } },
      input: [{ ...message, phase: 'commentary', cache_control: { type: 'ephemeral' }, content: [{ type: 'output_text', text: '你好', annotations: [{ type: 'url_citation', url: 'https://example.com' }], logprobs: [{}], vendor: true }] },
        { role: 'user', content: [{ type: 'input_text', text: '继续', prompt_cache_breakpoint: { mode: 'explicit' } }] }] };
    const before = structuredClone(input);
    expect(convertRequest(input, 'responses', 'openai')).toEqual({ model: 'm', stream: true,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '你好' }] }, { role: 'user', content: [{ type: 'text', text: '继续' }] }],
      reasoning_effort: 'low', response_format: { type: 'text' }, stream_options: { include_usage: true } });
    expect(input).toEqual(before);
    expect(convertRequest(input, 'responses', 'responses')).toEqual(before);
    expect(convertRequest({ ...request, store: false }, 'responses', 'openai').store).toBe(false);
  });
  it('omits unsupported Chat tuning and favors max_completion_tokens over max_tokens', () => {
    const input = { ...chat, n: 3, frequency_penalty: 0.8, presence_penalty: 0.4, stop: ['END'], audio: { voice: 'alloy' },
      store: true, logprobs: true, max_tokens: 10, max_completion_tokens: 20, vendor_option: { enabled: true }, stream_options: { include_usage: true, vendor: true },
      messages: [{ role: 'user', name: 'speaker', cache_control: { type: 'ephemeral' }, content: [{ type: 'text', text: '你好', vendor: true }] }] };
    const before = structuredClone(input);
    expect(convertRequest(input, 'openai', 'responses')).toEqual({ model: 'm', stream: false, store: false, max_output_tokens: 20,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }] });
    expect(input).toEqual(before);
    expect(convertRequest(input, 'openai', 'openai')).toEqual(before);
  });
  it('maps supported schema fields while preserving the entire schema body', () => {
    const extended = { ...schema, 'x-vendor': { arbitrary: ['keep', { nested: true }] } };
    const input = { ...chat, tools: [{ type: 'function', vendor: true, function: { name: 'weather', parameters: extended, strict: false, cache_control: { type: 'ephemeral' } } }],
      response_format: { type: 'json_schema', vendor: true, json_schema: { name: 'weather', schema: extended, strict: false, vendor: true } } };
    const before = structuredClone(input);
    const converted = convertRequest(input, 'openai', 'responses');
    expect(converted.tools).toEqual([{ type: 'function', name: 'weather', parameters: extended, strict: false }]);
    expect(converted.text).toEqual({ format: { type: 'json_schema', name: 'weather', schema: extended, strict: false } });
    const reversed = convertRequest({ ...converted, tools: converted.tools.map((entry: ObjectValue) => ({ ...entry, vendor: true })),
      text: { format: { ...converted.text.format, vendor: true }, verbosity: 'high' } }, 'responses', 'openai');
    expect(reversed.tools).toEqual([{ type: 'function', function: { name: 'weather', parameters: extended, strict: false } }]);
    expect(reversed.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'weather', schema: extended, strict: false } });
    expect(input).toEqual(before);
  });
  it.each(['responses', 'openai'] as const)('keeps function tools and drops choices referencing removed %s tools', from => {
    const to = from === 'responses' ? 'openai' : 'responses';
    const base = from === 'responses' ? request : chat;
    const supportedTool = from === 'responses' ? tool : { type: 'function', function: { name: 'weather', parameters: schema, strict: false } };
    const removedTool = { type: 'web_search', name: 'search', vendor: true };
    const choice = (name: string) => from === 'responses' ? { type: 'function', name, vendor: true } : { type: 'function', function: { name, vendor: true }, vendor: true };
    const mixed = { ...base, tools: [removedTool, supportedTool], tool_choice: choice('weather') };
    const before = structuredClone(mixed);
    const result = convertRequest(mixed, from, to);
    expect(result.tools).toHaveLength(1);
    expect(result.tool_choice).toEqual(to === 'responses' ? { type: 'function', name: 'weather' } : { type: 'function', function: { name: 'weather' } });
    expect(mixed).toEqual(before);
    for (const tool_choice of [choice('search'), { type: 'web_search' }, { type: 'allowed_tools', tools: [removedTool] }, 'vendor_mode']) {
      expect(convertRequest({ ...mixed, tool_choice }, from, to)).not.toHaveProperty('tool_choice');
    }
    for (const tools of [[], [removedTool]]) {
      const empty = convertRequest({ ...base, tools, tool_choice: 'required' }, from, to);
      expect(empty).not.toHaveProperty('tools');
      expect(empty).not.toHaveProperty('tool_choice');
    }
    expect(convertRequest({ ...base, tool_choice: 'required' }, from, to)).not.toHaveProperty('tool_choice');
    for (const tool_choice of ['auto', 'none', 'required']) expect(convertRequest({ ...mixed, tool_choice }, from, to).tool_choice).toBe(tool_choice);
  });
  it('omits unknown format modes and uses the default for unknown image detail', () => {
    const image = 'https://example.com/a.png';
    const converted = convertRequest({ ...chat, response_format: { type: 'vendor_format', options: {} },
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image, detail: 'original', vendor: true }, cache_control: { type: 'ephemeral' } }] }] }, 'openai', 'responses');
    expect(converted).not.toHaveProperty('text');
    expect(converted.input[0].content).toEqual([{ type: 'input_image', image_url: image, detail: 'auto' }]);
    const reversed = convertRequest({ ...request, text: { verbosity: 'high', format: { type: 'vendor_format' } }, reasoning: { summary: 'auto' },
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: image, detail: 'original', vendor: true }] }] }, 'responses', 'openai');
    expect(reversed).not.toHaveProperty('response_format');
    expect(reversed).not.toHaveProperty('reasoning_effort');
    expect(reversed.messages[0].content).toEqual([{ type: 'image_url', image_url: { url: image } }]);
  });
  it.each([{ previous_response_id: 'resp_old' }, { conversation: 'conv_old' }, { prompt: { id: 'pmpt_saved', variables: { location: '北京' } } }])('does not silently drop referenced context: %j', patch => {
    expect(() => convertRequest({ ...request, ...patch }, 'responses', 'openai')).toThrow(expect.objectContaining({ code: 'unsupported_conversion', status: 400 }));
    expect(() => convertRequest({ ...chat, ...patch }, 'openai', 'responses')).toThrow(expect.objectContaining({ code: 'unsupported_conversion', status: 400 }));
  });
  it.each([
    { input: [{ type: 'item_reference', id: 'msg_old' }] }, { input: [{ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'summary' }] }] },
    { input: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'private-state' }] },
    { input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }] },
    { input: [{ ...call, status: 'in_progress' }] }, { input: [{ ...call, arguments: {} }] }, { input: [{ ...call, call_id: undefined }] },
    { input: [{ type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }] },
    { input: [{ role: 'user', content: [{ type: 'input_text' }] }] }, { input: [{ role: 'user', content: [{ type: 'input_audio' }] }] },
    { tools: [{ type: 'function', name: 'weather', parameters: [] }] }, { tools: [{ type: 'function', parameters: schema }] },
    { tools: [{ ...tool, strict: 'yes' }] }, { text: { format: { type: 'json_schema', name: 'weather' } } },
  ])('still rejects unsupported or malformed Responses content: %j', patch => {
    expect(() => convertRequest({ ...request, ...patch }, 'responses', 'openai')).toThrow(expect.objectContaining({ code: 'unsupported_conversion', status: 400 }));
  });
  it.each([
    { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'abc', format: 'wav' } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'text' }] }] }, { messages: [{ role: 'user' }] },
    { messages: [{ role: 'assistant', content: 'answer', audio: { id: 'audio_1' } }] },
    { messages: [{ role: 'assistant', content: 'answer', reasoning_content: 'private reasoning' }] },
    { messages: [{ role: 'assistant', content: 'answer', function_call: { name: 'weather', arguments: '{}' } }] },
    { messages: [{ role: 'tool', tool_call_id: 'call_1' }] },
    { messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'custom', custom: { name: 'weather', input: '{}' } }] }] },
    { messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather' } }] }] },
    { tools: [{ type: 'function', function: { name: 'weather', parameters: [] } }] },
    { response_format: { type: 'json_schema', json_schema: { name: 'weather' } } },
  ])('still rejects unsupported or malformed Chat content: %j', patch => {
    expect(() => convertRequest({ ...chat, ...patch }, 'openai', 'responses')).toThrow(expect.objectContaining({ code: 'unsupported_conversion', status: 400 }));
  });
});

describe('Responses nonstream response conversion', () => {
  it('maps text, token details and timestamps to Chat and back', () => {
    const result = convertResponse(response, 'responses', 'openai');
    expect(result).toMatchObject({ object: 'chat.completion', created: response.created_at, choices: completion.choices, usage: completion.usage });
    const reverse = convertResponse(completion, 'openai', 'responses');
    expect(reverse).toMatchObject({ object: 'response', status: 'completed', error: null, incomplete_details: null, output: [{ ...message, id: 'msg_chatcmpl_1' }], usage: response.usage });
    validateResponse(reverse, 'responses');
  });
  it('preserves function call correlation and refusal contents', () => {
    const source = { ...response, output: [{ ...message, content: [{ type: 'refusal', refusal: '无法回答' }] }, call] };
    const result = convertResponse(source, 'responses', 'openai');
    expect(result.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { content: null, refusal: '无法回答', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: call.arguments } }] } });
    const reverse = convertResponse(result, 'openai', 'responses');
    expect(reverse.output[0].content).toEqual([{ type: 'refusal', refusal: '无法回答' }]);
    expect(reverse.output[1]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'weather', arguments: call.arguments });
  });
  it.each([['max_output_tokens', 'length'], ['content_filter', 'content_filter']])('maps incomplete %s bidirectionally', (reason, finish) => {
    const result = convertResponse({ ...response, status: 'incomplete', incomplete_details: { reason }, output: [{ ...message, status: 'incomplete' }] }, 'responses', 'openai');
    expect(result.choices[0].finish_reason).toBe(finish);
    expect(convertResponse(result, 'openai', 'responses')).toMatchObject({ status: 'incomplete', incomplete_details: { reason }, output: [{ status: 'incomplete' }] });
  });
  it('bridges Anthropic responses in both directions, including cached input and tool calls', () => {
    const result = convertResponse({ ...response, output: [message, call] }, 'responses', 'anthropic');
    expect(result).toMatchObject({ type: 'message', stop_reason: 'tool_use', content: [{ type: 'text', text: '你好' }, { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: '北京' } }], usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 3 } });
    const reverse = convertResponse(result, 'anthropic', 'responses');
    expect(reverse).toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }, { type: 'function_call', call_id: 'call_1' }], usage: { input_tokens: 15, output_tokens: 5 } });
  });
  it('allows empty reasoning output while retaining the following answer', () => {
    const source = { ...response, output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, message] };
    expect(convertResponse(source, 'responses', 'openai').choices[0].message.content).toBe('你好');
  });
  it('preserves native built-in output and asynchronous responses', () => {
    const source = { ...response, output: [{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'weather' } }, message] };
    expect(convertResponse(source, 'responses', 'responses')).toBe(source);
    const queued = { ...response, status: 'queued', output: [], usage: null };
    expect(convertResponse(queued, 'responses', 'responses')).toBe(queued);
    expect(() => convertResponse(queued, 'responses', 'openai')).toThrow();
  });
  it.each([
    { status: 'failed' }, { status: 'cancelled' }, { error: { message: 'failed' } }, { object: 'chat.completion' }, { created_at: 'today' },
    { output: [{}] }, { output: [{ ...message, content: [{ type: 'output_text', text: 3, annotations: [] }] }] },
    { output: [{ ...message, content: [{ type: 'output_text', text: 'missing annotations' }] }] },
    { output: [{ ...message, role: 'user' }] }, { output: [{ ...call, arguments: {} }] }, { output: [{ ...call, status: 'unknown' }] },
    { usage: { input_tokens: -1, output_tokens: 5 } },
  ])('rejects malformed and failed native responses: %j', patch => {
    expect(() => convertResponse({ ...response, ...patch }, 'responses', 'responses')).toThrow(expect.objectContaining({ code: 'invalid_upstream_response', status: 502 }));
  });
  it.each([
    { output: [{ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'reason' }] }, message] },
    { output: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'state' }, message] },
    { output: [{ ...message, phase: 'commentary' }] },
    { output: [{ ...message, content: [{ type: 'output_text', text: 'citation', annotations: [{ type: 'url_citation', url: 'https://example.com' }] }] }] },
    { output: [{ type: 'web_search_call', id: 'ws_1' }, message] },
    { status: 'incomplete', incomplete_details: { reason: 'max_messages' } },
  ])('does not silently discard unrepresentable output: %j', patch => {
    const source = { ...response, ...patch };
    expect(convertResponse(source, 'responses', 'responses')).toBe(source);
    expect(() => convertResponse(source, 'responses', 'openai')).toThrow(expect.objectContaining({ code: 'invalid_upstream_response' }));
  });
  it('rejects multiple Chat choices and provider-only reasoning output', () => {
    expect(() => convertResponse({ ...completion, choices: [...completion.choices, ...completion.choices] }, 'openai', 'responses')).toThrow();
    expect(() => convertResponse({ ...completion, choices: [{ ...completion.choices[0], message: { role: 'assistant', content: 'answer', reasoning_content: 'private' } }] }, 'openai', 'responses')).toThrow();
  });
});
