import type { Candidate, Env } from './types';
import type { GatewaySettings, UpstreamErrorTrace } from '../shared/gateway-settings';

export const MAX_ERROR_BYTES = 16 * 1024;
export const ERROR_RETENTION_DAYS = 7;
const encoder = new TextEncoder();
export interface UpstreamFailure { status: number | null; code: string; providerCode?: string; message: string; body: string; truncated: boolean }
export interface PublicUpstreamError { code: string; message: string }

export function upstreamFailure(status: number | null, body: string, code = status ? `upstream_${status}` : 'upstream_connection_error', truncated = false): UpstreamFailure {
  const bytes = encoder.encode(body);
  if (bytes.length > MAX_ERROR_BYTES) { body = new TextDecoder().decode(bytes.slice(0, MAX_ERROR_BYTES), { stream: true }); truncated = true; }
  let message = body, providerCode: string | undefined;
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error ?? parsed?.errors?.[0] ?? parsed;
    message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : body;
    const candidateCode = error?.code ?? error?.type ?? parsed?.code;
    if (typeof candidateCode === 'string' || typeof candidateCode === 'number') providerCode = String(candidateCode).slice(0, 100);
  } catch { /* Providers also return plain text or HTML errors. */ }
  return { status, code, providerCode, message, body, truncated };
}

export async function readUpstreamFailure(response: Response) {
  if (!response.body) return upstreamFailure(response.status, '');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BYTES - size;
      chunks.push(value.slice(0, remaining)); size += Math.min(value.length, remaining);
      if (value.length > remaining) { truncated = true; break; }
    }
  } catch { truncated = true; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return upstreamFailure(response.status, new TextDecoder().decode(bytes), undefined, truncated);
}

export function publicUpstreamError(settings: GatewaySettings, failure: UpstreamFailure): PublicUpstreamError {
  if (settings.upstream_error_mode === 'show' && failure.message) return { code: failure.providerCode || failure.code, message: failure.message };
  if (settings.upstream_error_mode === 'custom') {
    const rules = settings.upstream_error_rules;
    const match = rules.find(rule => rule.code === failure.providerCode)
      || rules.find(rule => rule.code === String(failure.status)) || rules.find(rule => rule.code === failure.code);
    if (match) return { code: failure.code, message: match.message };
  }
  return { code: failure.code, message: '上游服务暂时无法完成请求，请稍后重试或联系管理员，并提供请求 ID。' };
}

export async function recordUpstreamFailure(env: Env, requestId: string, attempt: number, candidate: Candidate, failure: UpstreamFailure, cfLogId?: string | null) {
  await env.DB.prepare(`INSERT INTO upstream_error_traces
    (request_id, attempt, channel_id, channel_name, upstream_model, cf_log_id, status, error_code, error_body, truncated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id, attempt) DO UPDATE SET status = excluded.status, error_code = excluded.error_code,
      error_body = excluded.error_body, truncated = excluded.truncated`)
    .bind(requestId, attempt, candidate.channel_id, candidate.channel.name, candidate.upstream_model, cfLogId || null,
      failure.status, failure.providerCode || failure.code, failure.body, +failure.truncated).run();
}

export async function getErrorTraces(env: Env, requestId: string) {
  const { results } = await env.DB.prepare(`SELECT * FROM upstream_error_traces
    WHERE request_id = ? AND created_at >= ? ORDER BY attempt`).bind(requestId, new Date(Date.now() - ERROR_RETENTION_DAYS * 86400000).toISOString()).all<UpstreamErrorTrace>();
  return results;
}
