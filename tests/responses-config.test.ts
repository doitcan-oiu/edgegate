import { describe, expect, it } from 'vitest';
import { channelSchema, profileSchema, responsesSchema } from '../worker/lib/validation';

describe('Responses request and provider configuration', () => {
  it('preserves native input items and optional request state without translating their fields', () => {
    const request = {
      model: 'gpt-4.1',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '描述图片' }, { type: 'input_image', image_url: 'https://example.com/image.png' }] },
        { type: 'function_call_output', call_id: 'call_fixture', output: '{"ok":true}' },
      ],
      previous_response_id: 'resp_fixture',
      tools: [{ type: 'web_search' }],
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_object' } },
      max_output_tokens: 4096,
    };
    expect(responsesSchema.parse(request)).toEqual({ ...request, stream: false });
    expect(responsesSchema.parse({ model: 'gpt-4.1', input: '你好', stream: true })).toMatchObject({ input: '你好', stream: true });
    expect(responsesSchema.parse({ model: 'gpt-4.1', previous_response_id: 'resp_fixture' })).toEqual({ model: 'gpt-4.1', previous_response_id: 'resp_fixture', stream: false });
    expect(responsesSchema.parse({ model: 'gpt-4.1', conversation: 'conv_fixture', instructions: null, previous_response_id: null })).toMatchObject({ conversation: 'conv_fixture', instructions: null, previous_response_id: null });
  });

  it.each([
    {}, { model: '' }, { model: 'gpt-4.1', input: 42 }, { model: 'gpt-4.1', input: ['text'] },
    { model: 'gpt-4.1', input: [null] }, { model: 'gpt-4.1', input: [['nested']] },
    { model: 'gpt-4.1', stream: 'true' }, { model: 'gpt-4.1', max_output_tokens: 0 },
    { model: 'gpt-4.1', max_output_tokens: 1.5 }, { model: 'gpt-4.1', instructions: {} },
  ])('rejects malformed Responses request fields: %j', input => {
    expect(responsesSchema.safeParse(input).success).toBe(false);
  });

  it('allows Responses for custom channels while retaining the built-in OpenAI protocol', () => {
    expect(profileSchema.parse({ protocol: 'responses', tags: ['AA'], models: ['gpt-4.1'] })).toEqual({ protocol: 'responses', tags: ['AA'], models: ['gpt-4.1'] });
    expect(channelSchema.parse({ name: 'Responses supplier', kind: 'openai', protocol: 'responses' })).toMatchObject({ protocol: 'responses' });
    for (const kind of ['cloudflare', 'ai-gateway']) {
      expect(channelSchema.parse({ name: 'Built-in', kind }).protocol).toBe('openai');
      expect(channelSchema.safeParse({ name: 'Built-in', kind, protocol: 'responses' }).success).toBe(false);
    }
  });
});
