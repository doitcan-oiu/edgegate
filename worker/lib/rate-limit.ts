import type { Env } from '../types';

// A single conditional UPSERT checks and advances both windows atomically.
// KV is deliberately not used for counters or API key authorization.
export async function consumeLimit(env: Env, id: string, rpm: number, dailyLimit: number) {
  const now = Date.now();
  const minute = Math.floor(now / 60000), day = Math.floor(now / 86400000);
  const row = await env.DB.prepare(`
    INSERT INTO key_counters (key_id, minute, minute_count, day, day_count) VALUES (?, ?, 1, ?, 1)
    ON CONFLICT(key_id) DO UPDATE SET
      minute = excluded.minute,
      minute_count = CASE WHEN key_counters.minute = excluded.minute THEN key_counters.minute_count + 1 ELSE 1 END,
      day = excluded.day,
      day_count = CASE WHEN key_counters.day = excluded.day THEN key_counters.day_count + 1 ELSE 1 END
    WHERE (key_counters.minute != excluded.minute OR key_counters.minute_count < ?)
      AND (? = 0 OR key_counters.day != excluded.day OR key_counters.day_count < ?)
    RETURNING minute_count, day_count
  `).bind(id, minute, day, rpm, dailyLimit, dailyLimit).first();
  if (row) return { allowed: true, retryAfter: 0 };
  const counter = await env.DB.prepare('SELECT day, day_count FROM key_counters WHERE key_id = ?').bind(id).first<{ day: number; day_count: number }>();
  const daily = dailyLimit > 0 && counter?.day === day && counter.day_count >= dailyLimit;
  return { allowed: false, retryAfter: Math.ceil(((daily ? (day + 1) * 86400000 : (minute + 1) * 60000) - now) / 1000) };
}
