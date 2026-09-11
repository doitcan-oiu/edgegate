import { z } from 'zod';
import type { Env } from './types';
import { DEFAULT_GATEWAY_SETTINGS, type GatewaySettings } from '../shared/gateway-settings';

export const gatewaySettingsSchema = z.object({
  load_balancing: z.enum(['random', 'weighted']),
  same_channel_retries: z.number().int().min(0).max(5),
  cross_channel_retries: z.number().int().min(0).max(10),
  upstream_error_mode: z.enum(['show', 'hide', 'custom']),
  upstream_error_rules: z.array(z.object({
    code: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/, '填写 HTTP 状态码或供应商错误码'),
    message: z.string().trim().min(1).max(1000),
  }).strict()).max(50),
}).strict().superRefine((value, ctx) => {
  const codes = new Set<string>();
  value.upstream_error_rules.forEach((rule, index) => {
    if (codes.has(rule.code)) ctx.addIssue({ code: 'custom', path: ['upstream_error_rules', index, 'code'], message: '错误码不能重复' });
    codes.add(rule.code);
  });
});

export async function getGatewaySettings(env: Env): Promise<GatewaySettings> {
  const row = await env.DB.prepare('SELECT value FROM gateway_settings WHERE id = 1').first<{ value: string }>();
  return row ? gatewaySettingsSchema.parse(JSON.parse(row.value)) : { ...DEFAULT_GATEWAY_SETTINGS, upstream_error_rules: [] };
}

export async function saveGatewaySettings(env: Env, input: unknown) {
  const settings = gatewaySettingsSchema.parse(input);
  await env.DB.prepare(`INSERT INTO gateway_settings (id, value) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).bind(JSON.stringify(settings)).run();
  return settings;
}
