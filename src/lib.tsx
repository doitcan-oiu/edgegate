import { createContext, useContext, useEffect, useState } from 'react';

export async function api<T = { ok: boolean }>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, credentials: 'same-origin', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') window.dispatchEvent(new Event('session-expired'));
    throw new Error(data.error?.message || `请求失败 (${response.status})`);
  }
  return data;
}
export const RefreshContext = createContext({ version: 0, refresh: () => {} });
export const ToastContext = createContext<(message: string) => void>(() => {});
export function useApi<T>(path: string) {
  const { version } = useContext(RefreshContext);
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api<T>(path, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, version]);
  return { data, error, loading };
}
export const number = (value: number) => new Intl.NumberFormat('zh-CN').format(Math.round(value));
export const compact = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const money = (value: number | null) => value === null ? '—' : `$${value.toFixed(value < 0.01 && value > 0 ? 6 : 4)}`;
export const time = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const channelLabel = { openai: '自定义服务商 · AI Gateway', 'ai-gateway': 'AI Gateway · 内置模型 / 动态路由', cloudflare: 'Cloudflare AI · 统一计费' };
export async function copy(text: string, notify: (s: string) => void) {
  try { await navigator.clipboard.writeText(text); notify('已复制到剪贴板'); } catch { notify('无法访问剪贴板，请手动选择并复制'); }
}
