import { describe, expect, it } from 'vitest';
import { mergeModelInput } from '../src/model-input';
import { profileSchema } from '../worker/lib/validation';

describe('model tag input', () => {
  it('merges pasted lists without changing existing IDs, order or case', () => {
    const result = mergeModelInput(['existing', 'Claude-Opus'], 'claude-sonnet-4-6\r\nexisting, @cf/meta/llama-3.1，claude-sonnet-4-6\tclaude-opus');
    expect(result).toEqual({ models: ['existing', 'Claude-Opus', 'claude-sonnet-4-6', '@cf/meta/llama-3.1', 'claude-opus'], added: 3 });
    expect(profileSchema.safeParse({ models: result.models }).success).toBe(true);
  });

  it('rejects an invalid batch without losing or partly modifying the current list', () => {
    const current = ['existing'];
    for (const model of ['invalid?id', 'claude@opus', '-leading', 'x'.repeat(161)]) {
      expect(mergeModelInput(current, `valid-model\n${model}`)).toHaveProperty('error');
      expect(profileSchema.safeParse({ models: [model] }).success).toBe(false);
      expect(current).toEqual(['existing']);
    }
  });

  it('checks the limit after deduplication and rejects overflow', () => {
    const current = Array.from({ length: 1000 }, (_, i) => `model-${i}`);
    expect(mergeModelInput(current, 'model-0\nmodel-999')).toMatchObject({ added: 0, models: current });
    expect(mergeModelInput(current, 'new-model')).toHaveProperty('error');
    expect(mergeModelInput(current.slice(1), 'new-model').models).toHaveLength(1000);
  });

  it('preserves an empty list and accepts IDs at the length boundary', () => {
    expect(mergeModelInput([], ' ,，\n ')).toEqual({ models: [], added: 0 });
    const model = `@${'x'.repeat(159)}`;
    expect(mergeModelInput([], model)).toEqual({ models: [model], added: 1 });
    expect(profileSchema.safeParse({ models: [model] }).success).toBe(true);
  });
});
