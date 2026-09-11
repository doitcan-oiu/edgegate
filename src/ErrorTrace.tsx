import type { UpstreamErrorTrace } from '../shared/gateway-settings';
import './runtime-settings.css';

export function ErrorTrace({ trace }: { trace: UpstreamErrorTrace }) {
  return <article className="error-trace"><header><strong>第 {trace.attempt} 次请求</strong><span>{trace.channel_name}</span><code>{trace.error_code}</code><span>{trace.status ? `HTTP ${trace.status}` : '连接错误'}</span></header><pre>{trace.error_body || '上游未返回错误正文'}</pre>{!!trace.truncated && <p>原始错误超过限制或未完整接收，仅保留前 16 KiB。</p>}</article>;
}
