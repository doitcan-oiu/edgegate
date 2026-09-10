import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { Activity, ArrowRight, Blocks, Box, Check, ChevronRight, Cloud, KeyRound, LayoutDashboard, LogOut, Menu, RefreshCw, Settings2, ShieldCheck, Terminal, X } from 'lucide-react';
import { api, RefreshContext, ToastContext } from './lib';
import { Button, ErrorBox, Loading, Logo, Field, Input } from './components';
const Dashboard = lazy(() => import('./pages/Dashboard').then(module => ({ default: module.Dashboard })));
const Channels = lazy(() => import('./pages/Channels').then(module => ({ default: module.Channels })));
const Models = lazy(() => import('./pages/Models').then(module => ({ default: module.Models })));
const Keys = lazy(() => import('./pages/Keys').then(module => ({ default: module.Keys })));
const Logs = lazy(() => import('./pages/Logs').then(module => ({ default: module.Logs })));
const Playground = lazy(() => import('./pages/Playground').then(module => ({ default: module.Playground })));
const Settings = lazy(() => import('./pages/Settings').then(module => ({ default: module.Settings })));
const navigation = [
  { id: 'overview', label: '运行总览', icon: LayoutDashboard, component: Dashboard },
  { id: 'channels', label: '渠道管理', icon: Blocks, component: Channels },
  { id: 'models', label: '模型与路由', icon: Box, component: Models },
  { id: 'keys', label: 'API 密钥', icon: KeyRound, component: Keys },
  { id: 'logs', label: '请求日志', icon: Activity, component: Logs },
  { id: 'playground', label: 'Playground', icon: Terminal, component: Playground },
  { id: 'settings', label: '网关设置', icon: Settings2, component: Settings },
];
function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/auth/login', { method: 'POST', body: JSON.stringify({ token }) }); setToken(''); onLogin(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <div className="access-page">
    <header className="access-header"><Logo /><span className="platform-label"><Cloud size={17} /> BUILT ON CLOUDFLARE</span></header>
    <main className="access-main">
      <div className="access-intro"><span className="eyebrow"><span className="signal-dot" /> YOUR AI INFRASTRUCTURE</span><h1>模型之间，<br />连接一切<span>可能。</span></h1><p>一个网关，统一模型接入、协议转换与应用权限。<br />让每一次请求，都有清晰的路径。</p></div>
      <div className="access-workbench">
        <section className="access-map" aria-label="网关请求链路">
          <div className="surface-caption"><Terminal size={16} /> REQUEST PIPELINE <span>01 → 03</span></div>
          <div className="pipeline-node"><span className="node-number">01</span><div><strong>你的应用</strong><span>OpenAI / Anthropic SDK</span></div><Box size={21} /></div>
          <div className="pipeline-connector"><span />协议转换 · 标签鉴权</div>
          <div className="pipeline-node node-focus"><span className="node-number">02</span><div><strong>EdgeGate</strong><span>Cloudflare Workers</span></div><Logo small /></div>
          <div className="pipeline-connector"><span />经过 AI Gateway</div>
          <div className="pipeline-node"><span className="node-number">03</span><div><strong>你的模型服务商</strong><span>OpenAI 兼容 · Anthropic</span></div><Cloud size={22} /></div>
          <div className="protocol-strip"><code>POST /v1/chat/completions</code><code>POST /v1/messages</code></div>
        </section>
        <section className="access-form">
          <div className="access-form-heading"><span className="square-icon"><ShieldCheck size={22} /></span><span className="eyebrow">CONSOLE ACCESS</span></div>
          <h2>进入工作空间</h2><p>使用管理员令牌登录你的网关。</p>
          <form onSubmit={submit}><Field label="管理员令牌" hint="令牌用于验证身份，不会保存在浏览器本地存储中。"><Input type="password" autoComplete="current-password" placeholder="输入 ADMIN_TOKEN" value={token} onChange={e => setToken(e.target.value)} required /></Field><ErrorBox message={error} /><Button type="submit" disabled={busy || !token} className="access-submit">{busy ? '正在验证…' : '连接控制台'}<ArrowRight size={18} /></Button></form>
          <details className="access-help"><summary>首次使用 · 获取管理员令牌<ChevronRight size={16} /></summary><p>本地运行 <code>npm run setup</code>，在 <code>.dev.vars</code> 中查看 <code>ADMIN_TOKEN</code>。部署后使用 Worker 中配置的同名 Secret。</p></details>
          <div className="security-caption"><ShieldCheck size={14} /> HttpOnly 会话保护</div>
        </section>
      </div>
    </main>
    <footer className="access-footer"><span>EDGEGATE / MODEL GATEWAY</span><span>Workers <i /> AI Gateway <i /> D1 <i /> KV</span></footer>
  </div>;
}
export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [route, setRoute] = useState(location.hash.slice(1) || 'overview');
  const [version, setVersion] = useState(0), [toast, setToast] = useState(''), [mobile, setMobile] = useState(false);
  useEffect(() => { api('/auth/me').then(() => setAuthenticated(true)).catch(() => setAuthenticated(false)); }, []);
  useEffect(() => {
    const changed = () => { setRoute(location.hash.slice(1) || 'overview'); setMobile(false); };
    const expired = () => setAuthenticated(false);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobile(false); };
    window.addEventListener('hashchange', changed); window.addEventListener('session-expired', expired); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('session-expired', expired); window.removeEventListener('keydown', escape); };
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [route]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3500); return () => clearTimeout(timer); }, [toast]);
  const current = navigation.find(item => item.id === route) || navigation[0], Page = current.component;
  const refresh = () => setVersion(v => v + 1);
  async function logout() { try { await api('/auth/logout', { method: 'POST' }); setAuthenticated(false); } catch (err) { setToast((err as Error).message); } }
  if (authenticated === null) return <div className="boot"><Logo /><Loading /></div>;
  if (!authenticated) return <Login onLogin={() => { setAuthenticated(true); refresh(); }} />;
  return <RefreshContext.Provider value={{ version, refresh }}><ToastContext.Provider value={setToast}>
    <div className="console-shell">
      <header className="console-header"><div className="header-inner">
        <a href="#overview" aria-label="EdgeGate 总览"><Logo /></a><div className="workspace-identity"><span className="signal-dot" /><span>默认工作空间</span><code>WORKSPACE</code></div>
        <div className="header-actions"><span className="session-label"><ShieldCheck size={15} />管理员会话</span><Button variant="ghost" className="icon-btn" aria-label="刷新数据" onClick={refresh}><RefreshCw size={18} /></Button><Button variant="secondary" className="logout-button" aria-label="退出登录" onClick={logout}><LogOut size={16} /><span>退出</span></Button><Button variant="ghost" className="mobile-menu icon-btn" onClick={() => setMobile(!mobile)} aria-label="展开导航" aria-expanded={mobile} aria-controls="gateway-navigation">{mobile ? <X size={21} /> : <Menu size={21} />}</Button></div>
      </div><div className={`navigation-bar ${mobile ? 'navigation-open' : ''}`}><nav id="gateway-navigation" aria-label="主导航">{navigation.map(({ id, icon: Icon, label }, index) => <a key={id} href={`#${id}`} className={`nav-item ${current.id === id ? 'active' : ''}`} aria-current={current.id === id ? 'page' : undefined}><Icon size={17} /><span>{label}</span><small>0{index + 1}</small></a>)}</nav></div></header>
      <main key={current.id} className={`main-content page-${current.id}`}><Suspense fallback={<Loading />}><Page /></Suspense></main>
      <footer className="console-footer"><span><span className="signal-dot" />EDGEGATE <i /> 管理控制台</span><span>Cloudflare Workers <i /> AI Gateway <i /> D1 <i /> KV</span></footer>
      {toast && <div className="toast" role="status"><Check size={19} /><span>{toast}</span><Button variant="ghost" className="icon-btn" aria-label="关闭提示" onClick={() => setToast('')}><X size={17} /></Button></div>}
    </div>
  </ToastContext.Provider></RefreshContext.Provider>;
}
