export type ConversationMessage = { role: 'user' | 'assistant'; content: string };
export type PlaygroundMessage = ConversationMessage & {
  id: string; model?: string; state?: 'pending' | 'complete' | 'stopped' | 'error'; error?: string;
  requestId?: string; elapsed?: number; attempts?: number;
};
export interface PlaygroundParameters { model: string; system: string; temperature: number; maxTokens: number; stream: boolean }

export function inferenceBody(parameters: PlaygroundParameters, messages: ConversationMessage[]) {
  return {
    model: parameters.model,
    messages: [...(parameters.system.trim() ? [{ role: 'system', content: parameters.system }] : []), ...messages.filter(message => message.content).map(({ role, content }) => ({ role, content }))],
    temperature: parameters.temperature, max_tokens: parameters.maxTokens, stream: parameters.stream,
  };
}

export function conversationForRetry<T extends ConversationMessage>(messages: T[]) {
  const lastUser = messages.map(message => message.role).lastIndexOf('user');
  return lastUser < 0 ? [] : messages.slice(0, lastUser + 1);
}

export function playgroundSnippet(baseURL: string, parameters: PlaygroundParameters, messages: ConversationMessage[]) {
  return `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: ${JSON.stringify(baseURL)},\n  apiKey: process.env.EDGEGATE_API_KEY,\n});\n\nconst response = await client.chat.completions.create(${JSON.stringify(inferenceBody(parameters, messages), null, 2)});\n\n${parameters.stream
    ? 'for await (const chunk of response) {\n  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");\n}'
    : 'console.log(response.choices[0]?.message?.content ?? "");'}`;
}

export async function readPlaygroundStream(body: ReadableStream<Uint8Array>, onText: (text: string) => void) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let pending = '', answer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        if (data.trim() === '[DONE]') return answer;
        let event;
        try { event = JSON.parse(data); } catch { throw new Error('上游返回了无效的流式数据'); }
        if (event?.error) throw new Error(typeof event.error === 'string' ? event.error : event.error.message || '上游在流式响应中返回错误');
        const text = event?.choices?.[0]?.delta?.content;
        if (typeof text === 'string') {
          answer += text;
          if (answer.length > 2 * 1024 * 1024) throw new Error('响应超出 Playground 显示上限');
          onText(answer);
        }
      }
      if (pending.length > 2 * 1024 * 1024) throw new Error('响应超出 Playground 显示上限');
      if (done) throw new Error('流式响应未完成，可重新生成或通过请求 ID 查看日志');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
