import type { Protocol } from '../types';
import type { PublicUpstreamError } from '../upstream-errors';

export class UpstreamStreamError extends Error {
  constructor(public raw: string) { super('Upstream stream error'); }
}
export type StreamErrorHandler = (raw: string) => Promise<PublicUpstreamError>;
export function streamErrorEvent(error: PublicUpstreamError, protocol: Protocol, requestId: string, sequenceNumber = 0) {
  if (protocol === 'responses') return `event: error\ndata: ${JSON.stringify({ type: 'error', code: error.code, message: error.message, param: null, request_id: requestId, sequence_number: sequenceNumber })}\n\n`;
  return protocol === 'anthropic'
    ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: error.message }, request_id: requestId })}\n\n`
    : `data: ${JSON.stringify({ error: { type: error.code, ...error, request_id: requestId } })}\n\n`;
}

// Inspect complete events before sending any error payload. Healthy SSE frames retain their bytes.
async function* inspectedFrames(body: ReadableStream<Uint8Array>, protocol: Protocol, state: { sequence: number }) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', terminal = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        if (boundary.index > 1024 * 1024) throw new Error('Oversized stream event');
        const end = boundary.index + boundary[0].length;
        const raw = buffer.slice(0, end); buffer = buffer.slice(end);
        const lines = raw.split(/\r?\n/);
        const payload = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        const errorEvent = lines.some(line => /^event:\s*(?:error|response\.error|response\.failed)\s*$/.test(line));
        if (payload && payload !== '[DONE]') {
          let parsed;
          try { parsed = JSON.parse(payload); } catch { if (errorEvent) throw new UpstreamStreamError(payload); throw new Error('Invalid stream event'); }
          if (parsed?.error || parsed?.response?.error || ['error', 'response.error', 'response.failed'].includes(parsed?.type) || errorEvent) throw new UpstreamStreamError(payload);
          if (protocol === 'responses') {
            if (Number.isInteger(parsed?.sequence_number)) state.sequence = parsed.sequence_number + 1;
            if (['response.completed', 'response.incomplete'].includes(parsed?.type)) {
              if (parsed?.response?.status !== parsed.type.slice('response.'.length)) throw new Error('Invalid terminal response');
              terminal = true;
            }
          }
        } else if (errorEvent) throw new UpstreamStreamError(payload);
        yield raw;
        if (terminal) return;
      }
      if (buffer.length > 1024 * 1024) throw new Error('Oversized stream event');
      if (done) { if (buffer.trim() || (protocol === 'responses' && !terminal)) throw new Error('Incomplete stream event'); return; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function forwardStream(body: ReadableStream<Uint8Array>, protocol: Protocol, requestId: string, finish: () => void, onError: StreamErrorHandler) {
  const state = { sequence: 0 };
  const iterator = inspectedFrames(body, protocol, state)[Symbol.asyncIterator](), encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) { finish(); controller.close(); } else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        finish(); await iterator.return?.();
        controller.enqueue(encoder.encode(streamErrorEvent(await onError(error instanceof UpstreamStreamError ? error.raw : ''), protocol, requestId, state.sequence)));
        controller.close();
      }
    },
    async cancel() { finish(); await iterator.return?.(); },
  });
}
