import { useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Bot, Code2, Copy, Eraser, SlidersHorizontal, Square, Terminal, User } from 'lucide-react';
import { copy, RefreshContext, ToastContext, useApi } from '../lib';
import type { Model } from '../types';
import { Badge, Button, ErrorBox, Field, PageTitle, Toggle, Input, TextArea, Select } from '../components';

type Message = { role: 'user' | 'assistant'; content: string };
export function Playground() {
  const models = useApi<Model[]>('/models');
  const [model, setModel] = useState(''), [system, setSystem] = useState('你是一个有帮助的 AI 助手。'), [temperature, setTemperature] = useState(0.7), [maxTokens, setMaxTokens] = useState(1024), [stream, setStream] = useState(true);
  const [draft, setDraft] = useState(''), [messages, setMessages] = useState<Message[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [requestId, setRequestId] = useState(''), [elapsed, setElapsed] = useState(0), [showCode, setShowCode] = useState(false);
  const controller = useRef<AbortController | null>(null), bottom = useRef<HTMLDivElement>(null);
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  useEffect(() => { if (!model && models.data?.length) setModel(models.data.find(m => m.enabled)?.id || ''); }, [models.data, model]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (messages.length) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages]);
  async function send(e: FormEvent) {
    e.preventDefault(); if (!draft.trim() || busy || !model) return;
    const conversation: Message[] = [...messages.filter(m => m.content), { role: 'user', content: draft.trim() }];
    setMessages([...conversation, { role: 'assistant', content: '' }]); setDraft(''); setBusy(true); setError(''); setRequestId(''); setElapsed(0);
    const abort = new AbortController(); controller.current = abort; const started = performance.now();
    const output = (content: string) => setMessages([...conversation, { role: 'assistant', content }]);
    try {
      const response = await fetch('/api/playground', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal: abort.signal,
        body: JSON.stringify({ model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...conversation], temperature, max_tokens: maxTokens, stream }),
      });
      setRequestId(response.headers.get('X-Request-ID') || '');
      if (!response.ok) { const data = await response.json() as { error?: { message?: string } }; if (response.status === 401) window.dispatchEvent(new Event('session-expired')); throw new Error(data.error?.message || `请求失败 (${response.status})`); }
      if (stream) {
        const reader = response.body!.getReader(), decoder = new TextDecoder(); let pending = '', answer = '', doneEvent = false;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          pending += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim(); if (data === '[DONE]') { doneEvent = true; continue; }
            let event; try { event = JSON.parse(data); } catch { continue; }
            if (event.error) throw new Error('上游在流式响应中返回错误');
            const text = event.choices?.[0]?.delta?.content;
            if (typeof text === 'string') { answer += text; if (answer.length > 2 * 1024 * 1024) throw new Error('响应超出 Playground 显示上限'); output(answer); }
          }
        }
        if (!doneEvent) throw new Error('流式响应未完成，请查看请求日志');
        if (!answer) output('模型已完成响应，但没有返回文本内容。');
      } else { const data = await response.json() as { choices?: { message?: { content?: string } }[] }; output(data.choices?.[0]?.message?.content || '模型未返回文本内容。'); }
    } catch (err) {
      if (abort.signal.aborted) setError('已停止生成，已收到的内容保留在下方。');
      else { abort.abort(); setError((err as Error).message); }
    } finally { setBusy(false); setElapsed(Math.round(performance.now() - started)); refresh(); controller.current = null; }
  }
  const snippet = `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${location.origin}/v1",\n  apiKey: process.env.EDGEGATE_API_KEY,\n});\n\nconst response = await client.chat.completions.create({\n  model: "${model || 'gpt-4.1'}",\n  messages: [{ role: "user", content: "你好" }],\n  stream: true,\n});\n\nfor await (const chunk of response) {\n  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");\n}`;
  return <><PageTitle eyebrow="06 / MODEL LAB" title="Playground" description="调试对话、调整参数，验证模型的实际响应。" action={<Button variant="secondary" onClick={() => setShowCode(!showCode)}><Code2 size={17} />{showCode ? '返回对话' : '查看接入代码'}</Button>} />
    <div className="playground-workspace">
      <section className="surface chat-panel">
        <div className="chat-toolbar"><div className="inline-heading"><span className="signal-dot" /><span className="model-readout">{model || '选择模型开始'}</span><Badge>{stream ? 'STREAM' : 'JSON'}</Badge></div><Button variant="ghost" aria-label="清空对话" disabled={busy || !messages.length} onClick={() => { setMessages([]); setError(''); setRequestId(''); }}><Eraser size={16} />清空</Button></div>
        {showCode ? <div className="code-preview"><div><span>JavaScript · OpenAI SDK</span><Button variant="ghost" aria-label="复制代码" onClick={() => copy(snippet, notify)}><Copy size={16} /></Button></div><pre>{snippet}</pre></div> : <>
          <div className="chat-messages">{!messages.length ? <div className="chat-welcome"><span className="chat-welcome-mark"><Terminal size={29} /></span><h2>验证下一次调用</h2><p>从一条消息开始，检查模型输出与路由。<br />在参数面板中选择模型、调整生成方式。</p><div className="prompt-suggestions">{[{ label: '探索能力', text: '用三句话介绍 Cloudflare Workers' }, { label: '测试代码', text: '写一个 TypeScript 快速排序函数' }].map(prompt => <button type="button" key={prompt.text} onClick={() => setDraft(prompt.text)}><span>{prompt.label}<ArrowUp size={14} /></span>{prompt.text}</button>)}</div></div> : messages.map((message, index) => <article className={`chat-message ${message.role}`} key={index}><span className="message-avatar">{message.role === 'user' ? <User size={17} /> : <Bot size={19} />}</span><div><strong>{message.role === 'user' ? '你' : model}</strong><div className="message-text">{message.content || (busy ? <span className="typing-dots">思考中<span>…</span></span> : '未收到回复')}</div></div></article>)}<div ref={bottom} /></div>
          <div className="chat-compose"><ErrorBox message={error || models.error} /><form onSubmit={send}><TextArea aria-label="输入消息" placeholder="输入消息，测试你的模型…" value={draft} onChange={e => setDraft(e.target.value)} rows={2} maxLength={16000} disabled={busy} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} /><div className="compose-actions"><span>Enter 发送 · Shift + Enter 换行</span>{busy ? <Button type="button" onClick={() => controller.current?.abort()} aria-label="停止生成"><Square size={14} fill="currentColor" />停止</Button> : <Button disabled={!draft.trim() || !model} aria-label="发送消息">发送<ArrowUp size={16} /></Button>}</div></form><div className="request-meta">{requestId ? <><span className="mono">{requestId.slice(0, 18)}…</span><span>{busy ? '响应中…' : `${elapsed} ms`}</span></> : <span>对话仅保存在当前页面，离开后不会保留。</span>}</div></div>
        </>}
      </section>
      <aside className="playground-controls"><div className="surface-heading"><h2><SlidersHorizontal size={17} />请求参数</h2><span className="surface-caption">CONFIG</span></div><div className="form-stack">
        <Field label="模型"><Select disabled={busy} value={model} onChange={value => { setModel(value); setMessages([]); setError(''); }}><option value="" disabled>选择模型</option>{models.data?.filter(m => m.enabled).map(m => <option key={m.id}>{m.id}</option>)}</Select></Field>
        <Field label="系统提示词"><TextArea disabled={busy} rows={5} value={system} maxLength={8000} onChange={e => setSystem(e.target.value)} /></Field>
        <Field label={`Temperature · ${temperature}`} hint="越低越稳定，越高越有创造性。"><Input type="range" min={0} max={2} step={0.1} disabled={busy} value={temperature} onChange={e => setTemperature(Number(e.target.value))} /></Field>
        <Field label="最大输出 Tokens"><Input type="number" min={1} max={32768} disabled={busy} value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))} /></Field>
        <Toggle checked={stream} onChange={value => { if (!busy) setStream(value); }} label="流式响应" /><div className="info-note">使用管理员会话调用，产生真实上游用量。每分钟 30 次，每日 1,000 次。</div>
      </div></aside>
    </div></>;
}
