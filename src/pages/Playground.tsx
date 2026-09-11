import '../playground.css';
import { ComboBox, ListBox } from '@heroui/react';
import { memo, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Code2, Copy, Eraser, RotateCcw, SlidersHorizontal, Square } from 'lucide-react';
import { copy, RefreshContext, ToastContext, useApi } from '../lib';
import type { Model } from '../types';
import { Button, ErrorBox, Field, Toggle, Input, TextArea, Modal } from '../components';
import { conversationForRetry, inferenceBody, playgroundSnippet, readPlaygroundStream, type PlaygroundMessage } from '../playground';

const defaultSystem = '你是一个有帮助的 AI 助手。';
const duration = (ms: number) => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  const notify = useContext(ToastContext), parts = content.split(/```([^\n`]*)\n([\s\S]*?)(?:```|$)/g);
  return <div className="message-text">{parts.map((part, index) => {
    if (index % 3 === 1) return null;
    if (index % 3 === 2) return <div className="message-code" key={index}><div><span>{parts[index - 1].trim() || '代码'}</span><Button type="button" variant="ghost" aria-label="复制代码块" onClick={() => copy(part.replace(/\n$/, ''), notify)}><Copy size={13} />复制</Button></div><pre><code>{part}</code></pre></div>;
    return part ? <span key={index}>{part}</span> : null;
  })}</div>;
});

export function Playground() {
  const models = useApi<Model[]>('/models');
  const [model, setModel] = useState(''), [system, setSystem] = useState(defaultSystem), [temperature, setTemperature] = useState('0.7'), [maxTokens, setMaxTokens] = useState('1024'), [stream, setStream] = useState(true);
  const [draft, setDraft] = useState(''), [messages, setMessages] = useState<PlaygroundMessage[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0), [showCode, setShowCode] = useState(false), [showParams, setShowParams] = useState(() => window.innerWidth >= 1000), [awayFromBottom, setAwayFromBottom] = useState(false);
  const controller = useRef<AbortController | null>(null), chatScroll = useRef<HTMLDivElement>(null), composer = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true), started = useRef(0), mounted = useRef(true);
  const { refresh } = useContext(RefreshContext), notify = useContext(ToastContext);
  const enabledModels = models.data?.filter(item => item.enabled) || [];
  const selectedModel = enabledModels.find(item => item.id === model);
  const parameters = { model, system, temperature: Number(temperature), maxTokens: Number(maxTokens), stream };
  const parameterError = !temperature.trim() || !Number.isFinite(parameters.temperature) || parameters.temperature < 0 || parameters.temperature > 2
    ? 'Temperature 需在 0–2 之间。' : !maxTokens.trim() || !Number.isInteger(parameters.maxTokens) || parameters.maxTokens < 1 || parameters.maxTokens > 32768 ? '最大输出需为 1–32768 的整数。' : '';
  const canRequest = !!selectedModel && selectedModel.routes.some(route => route.enabled) && !parameterError;
  const lastResponse = [...messages].reverse().find(message => message.role === 'assistant');

  useEffect(() => {
    if (!models.data || busy) return;
    setModel(previous => models.data!.some(item => item.id === previous && item.enabled) ? previous : models.data!.find(item => item.enabled && item.routes.some(route => route.enabled))?.id || models.data!.find(item => item.enabled)?.id || '');
  }, [models.data, busy]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setElapsed(Math.round(performance.now() - started.current)), 250);
    return () => clearInterval(timer);
  }, [busy]);
  useLayoutEffect(() => {
    const textarea = composer.current?.querySelector('textarea');
    if (textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(144, textarea.scrollHeight)}px`; }
    const node = chatScroll.current;
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [draft, messages, showParams]);
  const focusDraft = () => composer.current?.querySelector('textarea')?.focus();
  function toBottom() {
    stickToBottom.current = true; setAwayFromBottom(false);
    if (chatScroll.current) chatScroll.current.scrollTop = chatScroll.current.scrollHeight;
  }
  function resetConversation() { setMessages([]); setError(''); setElapsed(0); toBottom(); focusDraft(); }

  async function generate(conversation: PlaygroundMessage[]) {
    if (controller.current || !canRequest) { if (parameterError) setError(parameterError); return; }
    const abort = new AbortController(); controller.current = abort;
    const assistant: PlaygroundMessage = { id: crypto.randomUUID(), role: 'assistant', model, content: '', state: 'pending' };
    const update = (patch: Partial<PlaygroundMessage>) => {
      Object.assign(assistant, patch);
      if (mounted.current) setMessages([...conversation, { ...assistant }]);
    };
    stickToBottom.current = true; setAwayFromBottom(false);
    setBusy(true); setError(''); setElapsed(0); started.current = performance.now(); update({});
    try {
      const response = await fetch('/api/playground', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal: abort.signal,
        body: JSON.stringify(inferenceBody(parameters, conversation)),
      });
      update({ requestId: response.headers.get('X-Request-ID') || '', attempts: Number(response.headers.get('X-Gateway-Attempts')) || undefined });
      if (!response.ok) {
        const data = await response.json() as { error?: { message?: string } };
        if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
        throw new Error(data.error?.message || `请求失败 (${response.status})`);
      }
      if (stream) {
        if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) throw new Error('上游未返回有效的流式响应');
        await readPlaygroundStream(response.body, content => update({ content }));
      } else {
        const data = await response.json() as { choices?: { message?: { content?: unknown } }[] };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content === 'string') update({ content });
      }
      update({ state: 'complete' });
    } catch (err) {
      if (abort.signal.aborted) update({ state: 'stopped' });
      else { abort.abort(); update({ state: 'error', error: (err as Error).message }); }
    } finally {
      const ms = Math.round(performance.now() - started.current);
      update({ elapsed: ms }); controller.current = null;
      if (mounted.current) { setBusy(false); setElapsed(ms); refresh(); }
    }
  }
  function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || controller.current || !canRequest) return;
    const conversation: PlaygroundMessage[] = [...messages.filter(message => message.content), { id: crypto.randomUUID(), role: 'user', content: draft.trim() }];
    setDraft(''); void generate(conversation);
  }
  function regenerate() {
    const conversation = conversationForRetry(messages);
    if (conversation.length) void generate(conversation);
  }
  const codeMessages = draft.trim() ? [...messages, { role: 'user' as const, content: draft.trim() }] : conversationForRetry(messages);
  const snippet = playgroundSnippet(`${location.origin}/v1`, parameters, codeMessages.length ? codeMessages : [{ role: 'user', content: '你好' }]);

  return <div className="playground-page">
    <header className="playground-heading"><div><h1>Playground</h1><span>模型调试</span></div><div className="playground-heading-actions"><Button type="button" variant="secondary" disabled={!!parameterError || !model} onClick={() => setShowCode(true)}><Code2 size={15} />调用代码</Button><Button type="button" variant="secondary" aria-expanded={showParams} aria-controls="playground-parameters" onClick={() => setShowParams(!showParams)}><SlidersHorizontal size={15} />{showParams ? '收起参数' : '请求参数'}</Button></div></header>
    <div className={`playground-workspace ${showParams ? '' : 'parameters-collapsed'}`}>
      <section className="chat-panel" aria-label="模型对话">
        <div className="chat-toolbar">
          <ComboBox className="playground-model" aria-label="选择或搜索模型" value={model || null} onChange={value => { if (value) { setModel(String(value)); setError(''); } }} defaultItems={enabledModels} isDisabled={busy || models.loading && !models.data} allowsEmptyCollection>
            <ComboBox.InputGroup><Input placeholder={models.loading ? '加载模型…' : '搜索并选择模型'} /><ComboBox.Trigger aria-label="展开模型列表" /></ComboBox.InputGroup>
            <ComboBox.Popover className="playground-model-options"><ListBox renderEmptyState={() => <span className="model-search-empty">没有匹配的模型</span>}>{(item: Model) => <ListBox.Item id={item.id} textValue={item.id}><span>{item.id}</span><ListBox.ItemIndicator /></ListBox.Item>}</ListBox></ComboBox.Popover>
          </ComboBox>
          <span className="playground-mode">{stream ? '流式' : 'JSON'}</span>
          <Button type="button" variant="ghost" className="chat-clear" disabled={busy || !messages.length} onClick={resetConversation}><Eraser size={14} />清空</Button>
        </div>
        <div className="chat-transcript">
          <div className="chat-messages" ref={chatScroll} onScroll={event => { const node = event.currentTarget; const away = node.scrollHeight - node.clientHeight - node.scrollTop > 64; stickToBottom.current = !away; setAwayFromBottom(away); }}>
            {!messages.length ? <div className="chat-welcome"><h2>发送消息，开始调试</h2><p>选择模型后直接输入，切换模型会保留对话上下文。</p><div className="prompt-suggestions">{[{ label: '测试文本', text: '用三句话介绍 Cloudflare Workers' }, { label: '测试代码', text: '写一个 TypeScript 快速排序函数' }].map(prompt => <button type="button" key={prompt.label} onClick={() => { setDraft(prompt.text); focusDraft(); }}>{prompt.label}<ArrowUp size={13} /></button>)}</div></div>
              : messages.map((message, index) => <article className={`chat-message ${message.role}`} key={message.id}><header><strong title={message.model}>{message.role === 'user' ? '你' : message.model}</strong><div className="message-actions">{message.content && <Button type="button" variant="ghost" className="icon-btn" aria-label={`复制第 ${index + 1} 条消息`} onClick={() => copy(message.content, notify)}><Copy size={14} /></Button>}{message.role === 'assistant' && index === messages.length - 1 && !busy && <Button type="button" variant="ghost" disabled={!canRequest} onClick={regenerate}><RotateCcw size={13} />{message.state === 'error' ? '重试' : '重新生成'}</Button>}</div></header>
                {message.content ? <MessageContent content={message.content} /> : message.state === 'pending' ? <p className="message-placeholder" role="status">正在等待模型响应…</p> : message.state === 'complete' ? <p className="message-placeholder">响应已完成，未返回文本内容。</p> : null}
                {message.error && <ErrorBox message={message.error} />}{message.state === 'stopped' && <p className="message-placeholder">已停止生成{message.content ? '，已保留收到的内容。' : '。'}</p>}
                {message.role === 'assistant' && message.state !== 'pending' && <div className="message-meta"><span>{duration(message.elapsed || 0)}</span>{message.attempts && <span>{message.attempts} 次上游请求</span>}{message.requestId && <Button type="button" variant="ghost" aria-label={`复制第 ${index + 1} 条消息的请求 ID`} onClick={() => copy(message.requestId!, notify)}>请求 ID<Copy size={12} /></Button>}</div>}
              </article>)}
          </div>
          {awayFromBottom && <Button type="button" variant="secondary" className="chat-to-bottom" onClick={toBottom}><ArrowDown size={13} />回到最新</Button>}
        </div>
        <div className="chat-compose" ref={composer}><ErrorBox message={error || models.error || parameterError} />
          {!models.loading && !canRequest && !parameterError && !models.error && <p className="playground-unavailable">{selectedModel ? '此模型尚无已启用的路由。' : '暂无可用模型。'}<a href="#models">管理模型与路由</a></p>}
          <form onSubmit={send}><TextArea aria-label="输入消息" placeholder={busy ? '可以先输入下一条消息…' : '输入消息…'} value={draft} onChange={event => setDraft(event.target.value)} rows={2} maxLength={16000} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault(); if (!busy) event.currentTarget.form?.requestSubmit();
            }
          }} /><div className="compose-actions"><span>Enter 发送 · Shift + Enter 换行</span><span className="compose-length">{draft.length.toLocaleString()} / 16,000</span>{busy ? <Button type="button" onClick={() => controller.current?.abort()} aria-label="停止生成"><Square size={12} fill="currentColor" />停止</Button> : <Button type="submit" disabled={!draft.trim() || !canRequest} aria-label="发送消息">发送<ArrowUp size={14} /></Button>}</div></form>
          <div className="request-meta"><span>{busy ? `生成中 · ${duration(elapsed)}` : lastResponse?.requestId ? <button type="button" title="复制完整请求 ID" onClick={() => copy(lastResponse.requestId!, notify)}><code>{lastResponse.requestId}</code><Copy size={12} /></button> : '对话仅在当前页面保留'}</span><span>{busy ? '可随时停止' : lastResponse?.elapsed ? duration(lastResponse.elapsed) : ''}</span></div>
        </div>
      </section>
      {showParams && <aside className="playground-controls" id="playground-parameters" aria-label="请求参数"><header><h2>请求参数</h2><Button type="button" variant="ghost" disabled={busy} onClick={() => { setSystem(defaultSystem); setTemperature('0.7'); setMaxTokens('1024'); setStream(true); setError(''); }}>重置</Button></header>
        <div className="playground-parameter-fields"><Field label="系统提示词"><TextArea disabled={busy} rows={4} value={system} maxLength={8000} placeholder="设置角色、语气或约束，可留空" onChange={event => setSystem(event.target.value)} /></Field>
          <Field label="Temperature" hint="越低越稳定，越高越随机。"><div className="playground-temperature"><Input id="playground-temperature-slider" type="range" aria-label="调整 Temperature" min={0} max={2} step={0.1} disabled={busy} value={temperature || '0'} onChange={event => setTemperature(event.target.value)} /><Input type="number" aria-label="Temperature 数值" min={0} max={2} step={0.1} disabled={busy} required value={temperature} onChange={event => setTemperature(event.target.value)} /></div></Field>
          <Field label="最大输出 Tokens" hint="1–32768，实际范围取决于模型。"><Input type="number" min={1} max={32768} step={1} required disabled={busy} value={maxTokens} onChange={event => setMaxTokens(event.target.value)} /></Field>
          <div className={`playground-stream-setting ${busy ? 'is-disabled' : ''}`}><Toggle disabled={busy} checked={stream} onChange={value => { if (!busy) setStream(value); }} label="流式响应" /><p>关闭后一次性返回完整回复。</p></div>
        </div><p className="playground-usage-note">使用管理员会话，计入真实上游用量。<br />每分钟 30 次，每日 1,000 次。</p>
      </aside>}
    </div>
    {showCode && <Modal title="调用代码" description="代码使用当前模型、系统提示词、参数和待发送消息；没有草稿时使用最近一轮请求。" onClose={() => setShowCode(false)} wide><div className="playground-code-heading"><span>JavaScript · OpenAI SDK</span><Button type="button" variant="secondary" onClick={() => copy(snippet, notify)}><Copy size={14} />复制代码</Button></div><pre className="playground-code"><code>{snippet}</code></pre></Modal>}
  </div>;
}
