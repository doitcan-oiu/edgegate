import { Children, createContext, isValidElement, useContext, useId, type ReactNode, type ComponentProps, type InputHTMLAttributes, type TextareaHTMLAttributes, type OptionHTMLAttributes } from 'react';
import { Button as HeroButton, Checkbox as HeroCheckbox, Chip, Input as HeroInput, Label, ListBox, Modal as HeroModal, Select as HeroSelect, Spinner, Switch, TextArea as HeroTextArea } from '@heroui/react';
import { AlertCircle, Check, CheckCircle2, ChevronRight, Copy, Inbox, ArrowUpRight, SlidersHorizontal, Zap } from 'lucide-react';
import type { Log } from './types';
import { compact, money, time, useApi } from './lib';

export function Logo({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-mark"><Zap size={small ? 17 : 21} fill="currentColor" strokeWidth={1.5} /></span>{!small && <><span>edgegate</span><code> / </code></>}</div>;
}
/** Preserve native form submission while sharing HeroUI interaction states. */
export function Button({ variant = 'primary', className = '', children, disabled, isDisabled, type = 'submit', ...props }: Omit<ComponentProps<typeof HeroButton>, 'variant' | 'children' | 'className'> & { disabled?: boolean; children?: ReactNode; className?: string; variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <HeroButton {...props} type={type} isDisabled={disabled ?? isDisabled} variant={variant === 'secondary' ? 'outline' : variant} isIconOnly={className.includes('icon-btn')} className={`btn ${className}`}>{children}</HeroButton>;
}
const FieldContext = createContext<{ id?: string; labelId?: string; hintId?: string }>({});
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const field = useContext(FieldContext);
  const attributes = { id: field.id, 'aria-describedby': field.hintId, ...props };
  return props.type === 'range' ? <input {...attributes} className="range-input" /> : <HeroInput {...attributes} className={`eg-input ${props.className || ''}`} />;
}
export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useContext(FieldContext);
  return <HeroTextArea id={field.id} aria-describedby={field.hintId} {...props} className={`eg-textarea ${props.className || ''}`} />;
}
function optionText(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<{ children?: ReactNode }>(child) ? optionText(child.props.children) : String(child)).join('');
}
/** Accept option data without rendering a second visible, native select. */
export function Select({ children, value, onChange, disabled, required, 'aria-label': ariaLabel }: { children: ReactNode; value: string; onChange: (value: string) => void; disabled?: boolean; required?: boolean; 'aria-label'?: string }) {
  const field = useContext(FieldContext);
  const options = Children.toArray(children).filter(isValidElement<OptionHTMLAttributes<HTMLOptionElement>>).map(child => ({ id: String(child.props.value ?? optionText(child.props.children)), label: optionText(child.props.children), disabled: child.props.disabled }));
  const placeholder = options.find(option => option.id === '')?.label || '请选择';
  return <HeroSelect className="eg-select" value={value || null} onChange={key => onChange(key === null ? '' : String(key))} isDisabled={disabled} isRequired={required} aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : field.labelId} aria-describedby={field.hintId} placeholder={placeholder} disabledKeys={options.filter(option => option.disabled).map(option => option.id)}>
    <HeroSelect.Trigger id={field.id}><HeroSelect.Value /><HeroSelect.Indicator /></HeroSelect.Trigger>
    <HeroSelect.Popover><ListBox>{options.filter(option => option.id !== '').map(option => <ListBox.Item key={option.id} id={option.id} textValue={option.label}>{option.label}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></HeroSelect.Popover>
  </HeroSelect>;
}
export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return <HeroCheckbox isSelected={checked} onChange={onChange} className="permission-check"><HeroCheckbox.Content><HeroCheckbox.Control><HeroCheckbox.Indicator /></HeroCheckbox.Control><Label>{children}</Label></HeroCheckbox.Content></HeroCheckbox>;
}
export function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="page-heading"><div className="page-title-block"><div className="eyebrow"><span />{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="page-actions">{action}</div>}</header>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'green' | 'amber' | 'red' | 'neutral' }) {
  return <Chip size="sm" variant="soft" color={({ green: 'success', amber: 'warning', red: 'danger', neutral: 'default' } as const)[tone]} className="badge"><span className="status-dot" /><Chip.Label>{children}</Chip.Label></Chip>;
}
export function ErrorBox({ message }: { message?: string }) {
  return message ? <div className="error-box" role="alert"><AlertCircle size={17} /><span>{message}</span></div> : null;
}
export function Loading() { return <div className="loading-state"><Spinner size="sm" /><span>正在读取数据…</span></div>; }
export function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Inbox size={25} /></span><div className="empty-copy"><h3>{title}</h3><p>{description}</p>{action}</div></div>;
}
export function Modal({ title, description, children, onClose, wide = false, presentation = 'drawer' }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean; presentation?: 'drawer' | 'dialog' }) {
  return <HeroModal.Backdrop isOpen onOpenChange={open => { if (!open) onClose(); }} variant="opaque" className={`eg-overlay ${presentation}`}>
    <HeroModal.Container size={wide ? 'lg' : 'md'} placement="center" scroll="inside">
      <HeroModal.Dialog className={`eg-dialog ${wide ? 'eg-dialog-wide' : ''}`}><HeroModal.CloseTrigger aria-label="关闭" />
        <HeroModal.Header className="modal-head"><span className="eyebrow"><SlidersHorizontal size={14} />{presentation === 'drawer' ? 'WORKSPACE CONFIGURATION' : 'CONFIRM ACTION'}</span><HeroModal.Heading>{title}</HeroModal.Heading>{description && <p>{description}</p>}</HeroModal.Header>
        <HeroModal.Body>{children}</HeroModal.Body>
      </HeroModal.Dialog>
    </HeroModal.Container>
  </HeroModal.Backdrop>;
}
export function FormSection({ title, description, number, children }: { title: string; description?: string; number: string; children: ReactNode }) {
  return <fieldset className="form-section"><legend><span>{number}</span>{title}</legend>{description && <p className="section-description">{description}</p>}<div className="form-section-fields">{children}</div></fieldset>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId(), labelId = `${id}-label`, hintId = hint ? `${id}-hint` : undefined;
  return <FieldContext.Provider value={{ id, labelId, hintId }}><div className="field"><Label htmlFor={id} id={labelId} className="field-label">{label}</Label>{children}{hint && <span id={hintId} className="field-hint">{hint}</span>}</div></FieldContext.Provider>;
}
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <Switch isSelected={checked} onChange={onChange} size="sm"><Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control><Label>{label}</Label></Switch.Content></Switch>;
}
export function Confirm({ title, description, onConfirm, onClose, busy, error }: { title: string; description: string; onConfirm: () => void; onClose: () => void; busy: boolean; error: string }) {
  return <Modal title={title} onClose={onClose} presentation="dialog"><p className="confirm-copy">{description}</p><ErrorBox message={error} /><div className="modal-actions"><Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button><Button variant="danger" onClick={onConfirm} disabled={busy}>{busy ? '处理中…' : '确认操作'}</Button></div></Modal>;
}
export function CopyButton({ value, onCopy }: { value: string; onCopy: (value: string) => void }) {
  return <Button variant="ghost" className="icon-btn" aria-label="复制" onClick={() => onCopy(value)}><Copy size={16} /></Button>;
}
export function LogTable({ logs, onSelect }: { logs: Log[]; onSelect?: (log: Log) => void }) {
  return <div className="table-scroll"><table className="request-table"><thead><tr><th>请求 / 模型</th><th>结果</th><th>上游渠道</th><th>响应耗时</th><th>Token 用量</th><th>请求时间</th>{onSelect && <th><span className="sr-only">详情</span></th>}</tr></thead>
    <tbody>{logs.map(log => <tr key={log.id}>
      <td><span className="request-identity"><span className="request-icon"><ArrowUpRight size={17} /></span><span><strong className="table-primary mono">{log.model}</strong><span className="table-secondary mono">{log.id.slice(0, 12)}{log.stream ? ' · SSE' : ' · JSON'}</span></span></span></td>
      <td><Badge tone={log.success ? 'green' : 'red'}>{log.status ?? ''} {log.success ? '成功' : '失败'}</Badge></td><td>{log.channel_name}</td>
      <td><span className="mono">{log.latency_ms < 1000 ? `${log.latency_ms} ms` : `${(log.latency_ms / 1000).toFixed(2)} s`}</span><span className="latency-track" aria-hidden="true"><i style={{ width: `${Math.min(100, log.latency_ms / 50)}%` }} /></span></td>
      <td className="mono">{log.input_tokens === null || log.output_tokens === null ? '—' : compact(log.input_tokens + log.output_tokens)}</td><td className="muted nowrap">{time(log.created_at)}</td>
      {onSelect && <td><Button variant="ghost" className="icon-btn" aria-label={`查看请求 ${log.id}`} onClick={() => onSelect(log)}><ChevronRight size={18} /></Button></td>}
    </tr>)}</tbody></table></div>;
}
export function LogDetail({ log, onClose }: { log: Log; onClose: () => void }) {
  const detail = useApi<Log>(`/logs/${encodeURIComponent(log.id)}`), current = detail.data || log;
  return <Modal title="Cloudflare 请求详情" onClose={onClose}><ErrorBox message={detail.error} /><div className="log-detail-hero"><Badge tone={current.success ? 'green' : 'red'}>{current.success ? '请求成功' : '请求失败'}</Badge><h3>{current.model}</h3><div><strong>{(current.latency_ms / 1000).toFixed(2)}<small>秒</small></strong><strong>{current.input_tokens === null || current.output_tokens === null ? '—' : compact(current.input_tokens + current.output_tokens)}<small>Tokens</small></strong></div></div><div className="detail-grid">{Object.entries({ 'Cloudflare 日志 ID': current.id, 'EdgeGate 请求 ID': current.request_id || '外部调用', '模型别名': current.model, '上游模型': current.upstream_model || '—', '服务商': current.provider, '渠道': current.channel_name, '密钥': current.key_name, 'HTTP 状态': current.status ?? '未报告', '调用结果': current.success ? '成功' : '失败', '当前尝试序号': current.attempts ?? '—', '耗时': `${current.latency_ms} ms`, '输入 Tokens': current.input_tokens ?? '未报告', '输出 Tokens': current.output_tokens ?? '未报告', 'Cloudflare 费用': money(current.cost_usd), '缓存命中': current.cached ? '是' : '否', '请求时间': time(current.created_at) }).map(([key, value]) => <div key={key}><span>{key}</span><strong className="mono">{value}</strong></div>)}</div><div className="info-note">实时读取 Cloudflare Logs API，D1 不存储此日志。正文是否采集及保留多久，取决于 AI Gateway 的日志设置；可在 Cloudflare 控制台查看完整请求与响应。</div></Modal>;
}
export function SuccessIcon() { return <CheckCircle2 size={17} />; }
export function CheckIcon() { return <Check size={16} />; }
