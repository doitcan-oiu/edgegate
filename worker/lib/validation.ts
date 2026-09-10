import { z } from 'zod';
import { invalid } from './errors';

export const nameSchema = z.string().trim().min(1).max(80);
export const modelId = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9@][a-zA-Z0-9._:/-]*$/, '模型 ID 只能包含字母、数字、点、下划线、斜线和短横线');
export const tagsSchema = z.array(z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}_.\/-]+$/u, '标签可包含中英文、数字、点、下划线、斜线和短横线')).max(32).transform(tags => [...new Set(tags)].sort());
export const profileSchema = z.object({ protocol: z.enum(['openai', 'anthropic']).default('openai'), tags: tagsSchema.default([]), models: z.array(modelId).max(100).default([]).transform(models => [...new Set(models)]) });

export function safeBaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid('请输入有效的 HTTPS Base URL'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    (url.port && url.port !== '443') || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') ||
    /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) || host.endsWith('.localhost')) {
    throw invalid('Base URL 必须是公共 HTTPS 域名，且不能包含账号、查询参数或非标准端口');
  }
  return url.toString().replace(/\/+$/, '');
}
export const channelSchema = z.object({
  ...profileSchema.shape,
  name: nameSchema,
  kind: z.enum(['cloudflare', 'ai-gateway', 'openai']),
  base_url: z.string().max(500).default(''),
  secret: z.string().trim().max(4096).optional(),
  credential_mode: z.enum(['local', 'byok']).optional(),
  enabled: z.boolean().default(true),
  timeout_ms: z.number().int().min(1000).max(120000).default(60000),
  provider_id: z.string().max(100).optional(),
  provider_slug: z.string().trim().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  gateway_path: z.string().trim().min(1).max(300).regex(/^[a-zA-Z0-9_/-]+$/, '请求路径只能包含字母、数字、下划线、短横线和斜线').optional(),
  byok_alias: z.string().trim().max(100).regex(/^[a-zA-Z0-9_-]*$/).default(''),
});
export const providerSchema = z.object({
  ...profileSchema.shape,
  name: nameSchema,
  slug: z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  base_url: z.string().max(500),
  description: z.string().max(500).default(''),
  enable: z.boolean().default(true),
});
export const modelSchema = z.object({ id: modelId, description: z.string().trim().max(300).default(''), enabled: z.boolean().default(true) });
export const routeSchema = z.object({
  model_id: modelId, channel_id: z.string().min(1).max(100), upstream_model: modelId,
  priority: z.number().int().min(0).max(1000).default(0), weight: z.number().int().min(1).max(1000).default(1),
  input_price: z.number().min(0).max(100000).nullable().default(null),
  output_price: z.number().min(0).max(100000).nullable().default(null), enabled: z.boolean().default(true),
});
export const keySchema = z.object({
  allowed_tags: tagsSchema.default([]),
  name: nameSchema, allowed_models: z.array(modelId).max(100).default([]),
  rpm: z.number().int().min(1).max(10000).default(60),
  daily_limit: z.number().int().min(0).max(100000000).default(0),
  expires_at: z.iso.datetime({ offset: true }).nullable().default(null),
});
export const chatSchema = z.object({
  model: modelId,
  messages: z.array(z.object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown())), z.null()]).optional(),
  }).passthrough()).min(1).max(256),
  stream: z.boolean().default(false),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  n: z.number().int().min(1).max(8).optional(),
}).passthrough();
export type ChatInput = z.infer<typeof chatSchema>;
export const messagesSchema = z.object({
  model: modelId,
  max_tokens: z.number().int().positive(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]) }).passthrough()).min(1).max(256),
  system: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).optional(),
  stream: z.boolean().default(false),
}).passthrough();
