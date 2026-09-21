import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Badge,
  Button,
  Field,
  FluentProvider,
  Input,
  Spinner,
  Textarea,
  createDarkTheme,
  createLightTheme,
  makeStyles,
  shorthands,
  tokens,
  type BrandVariants,
} from '@fluentui/react-components'
import {
  Add20Regular,
  Bot20Regular,
  BrainCircuit20Regular,
  DesktopPulse20Regular,
  DocumentData20Regular,
  Home20Regular,
  Settings20Regular,
  ArrowClockwise20Regular,
  WeatherSunny20Regular,
  WeatherMoon20Regular,
} from '@fluentui/react-icons'
import type { IcepakEnvironmentProbe, IcepakProjectOperationResult, PeerIdentity, PeerRecord, RemoteJobRecord, SkillDetail, SkillRecord, TaskRecord } from '@thermal-agent/contracts'

const brand: BrandVariants = {
  10: '#130903', 20: '#281006', 30: '#421706', 40: '#5c2009', 50: '#742b10',
  60: '#8d3718', 70: '#a54420', 80: '#bd522a', 90: '#d1643b', 100: '#df7954',
  110: '#e78f70', 120: '#eda58d', 130: '#f2bba8', 140: '#f6d0c4', 150: '#fae5df', 160: '#fff8f6',
}

const lightTheme = createLightTheme(brand)
const darkTheme = createDarkTheme(brand)

type Page = 'overview' | 'agent' | 'tasks' | 'skills' | 'nodes' | 'settings'

interface DshStatus {
  phase: 'unconfigured' | 'starting' | 'ready' | 'stopped' | 'failed'
  url?: string
  detail?: string
  workspacePath?: string
}

interface LanStatus {
  enabled: boolean
  port?: number
  addresses: string[]
  pairingCode?: string
  pairingExpiresAt?: string
  sessionCount: number
}

interface DiscoveryStatus {
  enabled: boolean
  udpPort: number
  group: string
  lastError: string | null
  discovered: Array<{
    identity: PeerIdentity
    address: string
    servicePort: number
    heartbeat: { pluginStatus: string; aedtVersions: string[]; maxConcurrent: number; activeAttempts: number }
    lastSeenAt: string
    trusted: boolean
  }>
}

const isLanClient = !['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname)

const useStyles = makeStyles({
  app: { minHeight: '100dvh', backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground1 },
  shell: { display: 'grid', gridTemplateColumns: '232px minmax(0, 1fr)', minHeight: '100dvh', '@media (max-width: 900px)': { gridTemplateColumns: '1fr' } },
  sidebar: {
    position: 'sticky', top: 0, height: '100dvh', display: 'flex', flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1, borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    '@media (max-width: 900px)': { display: 'none' },
  },
  brand: { display: 'flex', alignItems: 'center', gap: '12px', minHeight: '72px', ...shorthands.padding('0', '20px'), fontWeight: 700 },
  brandMark: {
    display: 'grid', placeItems: 'center', width: '32px', height: '32px', borderRadius: '10px',
    color: tokens.colorNeutralForegroundOnBrand, backgroundColor: tokens.colorBrandBackground,
  },
  nav: { display: 'grid', gap: '4px', ...shorthands.padding('12px') },
  navButton: { justifyContent: 'flex-start', width: '100%' },
  sidebarFooter: { marginTop: 'auto', ...shorthands.padding('16px'), color: tokens.colorNeutralForeground3, fontSize: '12px' },
  main: { minWidth: 0 },
  header: {
    minHeight: '72px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
    ...shorthands.padding('0', '28px'), backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    '@media (max-width: 900px)': { paddingLeft: '16px', paddingRight: '16px' },
  },
  headerTitle: { fontSize: '16px', fontWeight: 650 },
  headerActions: { display: 'flex', alignItems: 'center', gap: '10px' },
  content: { maxWidth: '1480px', margin: '0 auto', ...shorthands.padding('28px'), '@media (max-width: 900px)': { paddingTop: '18px', paddingRight: '16px', paddingBottom: '84px', paddingLeft: '16px' } },
  intro: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '24px', marginBottom: '24px', '@media (max-width: 900px)': { alignItems: 'flex-start', flexDirection: 'column' } },
  title: { margin: 0, fontSize: '28px', lineHeight: 1.15, letterSpacing: '-0.02em' },
  subtitle: { margin: '8px 0 0', color: tokens.colorNeutralForeground3, maxWidth: '680px', lineHeight: 1.6 },
  summaryGrid: { display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', gap: '16px', marginBottom: '16px', '@media (max-width: 900px)': { gridTemplateColumns: '1fr' } },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '12px', ...shorthands.padding('20px'), boxShadow: tokens.shadow2,
  },
  panelTitle: { display: 'flex', alignItems: 'center', gap: '8px', margin: 0, fontSize: '14px', fontWeight: 650 },
  metric: { marginTop: '18px', fontSize: '34px', fontWeight: 700, letterSpacing: '-0.04em' },
  metricLabel: { marginTop: '4px', color: tokens.colorNeutralForeground3, fontSize: '12px' },
  statusRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginTop: '18px' },
  details: { color: tokens.colorNeutralForeground3, fontSize: '12px', lineHeight: 1.5 },
  workGrid: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(320px, 0.8fr)', gap: '16px', '@media (max-width: 900px)': { gridTemplateColumns: '1fr' } },
  table: { width: '100%', borderCollapse: 'collapse', marginTop: '14px' },
  tableHead: { textAlign: 'left', color: tokens.colorNeutralForeground3, fontSize: '12px', fontWeight: 500 },
  tableCell: { ...shorthands.padding('12px', '8px'), borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  empty: { display: 'grid', placeItems: 'center', minHeight: '220px', color: tokens.colorNeutralForeground3, textAlign: 'center' },
  form: { display: 'grid', gap: '16px', marginTop: '16px' },
  error: { color: tokens.colorPaletteRedForeground1, fontSize: '13px', marginTop: '12px' },
  placeholder: { color: tokens.colorNeutralForeground3, lineHeight: 1.6 },
  settingsGrid: { display: 'grid', gridTemplateColumns: 'minmax(320px, 0.8fr) minmax(0, 1.2fr)', gap: '16px', '@media (max-width: 900px)': { gridTemplateColumns: '1fr' } },
  resultGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px', marginTop: '18px' },
  resultItem: { ...shorthands.padding('12px'), borderRadius: '8px', backgroundColor: tokens.colorNeutralBackground2 },
  resultValue: { marginTop: '5px', fontWeight: 650, overflowWrap: 'anywhere' },
  skillGrid: { display: 'grid', gridTemplateColumns: 'minmax(280px, 0.7fr) minmax(0, 1.3fr)', gap: '16px', '@media (max-width: 900px)': { gridTemplateColumns: '1fr' } },
  skillList: { display: 'grid', gap: '8px', marginTop: '14px' },
  skillButton: { width: '100%', justifyContent: 'space-between', textAlign: 'left' },
  section: { marginTop: '20px' },
  agentPanel: { height: 'calc(100dvh - 128px)', minHeight: '560px', overflow: 'hidden', ...shorthands.padding('0') },
  agentFrame: { width: '100%', height: '100%', border: 0, backgroundColor: tokens.colorNeutralBackground1 },
  mobileNav: {
    display: 'none',
    '@media (max-width: 900px)': {
      position: 'fixed', display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', left: 0, right: 0, bottom: 0,
      zIndex: 10, backgroundColor: tokens.colorNeutralBackground1, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
      paddingTop: '6px', paddingRight: '6px', paddingBottom: '6px', paddingLeft: '6px',
    },
  },
})

const navItems: Array<{ page: Page; label: string; icon: JSX.Element }> = [
  { page: 'overview', label: '概览', icon: <Home20Regular /> },
  { page: 'agent', label: 'Agent', icon: <Bot20Regular /> },
  { page: 'tasks', label: '任务', icon: <DocumentData20Regular /> },
  { page: 'skills', label: '技能', icon: <BrainCircuit20Regular /> },
  { page: 'nodes', label: '节点', icon: <DesktopPulse20Regular /> },
  { page: 'settings', label: '设置', icon: <Settings20Regular /> },
]

export function App() {
  const styles = useStyles()
  const [page, setPage] = useState<Page>('overview')
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [probe, setProbe] = useState<IcepakEnvironmentProbe | null>(null)
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [authorized, setAuthorized] = useState(!isLanClient)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!authorized) return
    setLoading(true)
    setError('')
    try {
      const [tasksResponse, probeResponse, skillsResponse] = await Promise.all([fetch('/api/tasks'), fetch('/api/plugins/icepak/probe'), fetch('/api/skills')])
      if (!tasksResponse.ok || !probeResponse.ok || !skillsResponse.ok) throw new Error('本地 Core 暂时无法返回完整状态')
      const tasksBody = await tasksResponse.json() as { tasks: TaskRecord[] }
      const probeBody = await probeResponse.json() as { probe: IcepakEnvironmentProbe }
      const skillsBody = await skillsResponse.json() as { skills: SkillRecord[] }
      setTasks(tasksBody.tasks)
      setProbe(probeBody.probe)
      setSkills(skillsBody.skills)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '状态读取失败')
    } finally {
      setLoading(false)
    }
  }, [authorized])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!isLanClient) return
    void fetch('/api/health').then(response => setAuthorized(response.ok)).catch(() => setAuthorized(false))
  }, [])

  useEffect(() => {
    if (!authorized) return
    const events = new EventSource('/api/events')
    const snapshot = (event: MessageEvent<string>) => {
      try {
        const value = JSON.parse(event.data) as { tasks?: TaskRecord[] }
        if (Array.isArray(value.tasks)) setTasks(value.tasks)
      } catch { /* a later valid snapshot will repair transient data */ }
    }
    events.addEventListener('snapshot', snapshot as EventListener)
    return () => events.close()
  }, [authorized])

  const activeTasks = useMemo(() => tasks.filter(task => !['COMPLETED', 'FAILED', 'CANCELLED', 'ESCALATED'].includes(task.executionStatus)), [tasks])
  const completedTasks = useMemo(() => tasks.filter(task => task.executionStatus === 'COMPLETED'), [tasks])

  if (!authorized) return <FluentProvider theme={dark ? darkTheme : lightTheme} className={styles.app}><LanPairGate styles={styles} onPaired={() => setAuthorized(true)} /></FluentProvider>

  return (
    <FluentProvider theme={dark ? darkTheme : lightTheme} className={styles.app}>
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}><span className={styles.brandMark}><Bot20Regular /></span>Thermal Agent</div>
          <nav className={styles.nav} aria-label="主导航">
            {navItems.map(item => <Button key={item.page} className={styles.navButton} appearance={page === item.page ? 'primary' : 'subtle'} icon={item.icon} onClick={() => setPage(item.page)}>{item.label}</Button>)}
          </nav>
          <div className={styles.sidebarFooter}>数据保存在本机。局域网发布默认关闭。</div>
        </aside>
        <main className={styles.main}>
          <header className={styles.header}>
            <div className={styles.headerTitle}>{navItems.find(item => item.page === page)?.label}</div>
            <div className={styles.headerActions}>
              <Badge appearance="outline" color={probe?.status === 'READY' ? 'success' : 'informative'}>{probe ? `Icepak ${probe.status}` : '正在探测'}</Badge>
              <Button appearance="subtle" icon={<ArrowClockwise20Regular />} aria-label="刷新" onClick={() => void refresh()} />
              <Button appearance="subtle" icon={dark ? <WeatherSunny20Regular /> : <WeatherMoon20Regular />} aria-label="切换主题" onClick={() => setDark(value => !value)} />
            </div>
          </header>
          <div className={styles.content}>
            {page === 'overview' && <Overview styles={styles} tasks={tasks} activeCount={activeTasks.length} completedCount={completedTasks.length} probe={probe} loading={loading} error={error} onCreated={refresh} />}
            {page === 'agent' && <AgentWorkspace styles={styles} />}
            {page === 'tasks' && <TaskList styles={styles} tasks={tasks} loading={loading} onChanged={refresh} />}
            {page === 'skills' && <SkillLibrary styles={styles} skills={skills} onChanged={refresh} />}
            {page === 'nodes' && <NodeWorkspace styles={styles} />}
            {page === 'settings' && <><LanSettings styles={styles} /><IcepakSettings styles={styles} probe={probe} onProbeUpdated={setProbe} /></>}
          </div>
        </main>
      </div>
      <nav className={styles.mobileNav} aria-label="移动端导航">
        {navItems.map(item => <Button key={item.page} appearance={page === item.page ? 'primary' : 'subtle'} icon={item.icon} aria-label={item.label} onClick={() => setPage(item.page)} />)}
      </nav>
    </FluentProvider>
  )
}

function Overview({ styles, tasks, activeCount, completedCount, probe, loading, error, onCreated }: {
  styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; activeCount: number; completedCount: number
  probe: IcepakEnvironmentProbe | null; loading: boolean; error: string; onCreated(): Promise<void>
}) {
  return <>
    <div className={styles.intro}><div><h1 className={styles.title}>散热仿真工作台</h1><p className={styles.subtitle}>在本机收集需求、验证 Icepak 环境并管理可恢复的仿真任务。</p></div></div>
    <section className={styles.summaryGrid} aria-label="运行摘要">
      <div className={styles.panel}><h2 className={styles.panelTitle}><DocumentData20Regular />任务队列</h2><div className={styles.metric}>{activeCount}</div><div className={styles.metricLabel}>个任务正在准备或执行</div></div>
      <div className={styles.panel}><h2 className={styles.panelTitle}><DesktopPulse20Regular />Icepak 能力</h2><div className={styles.statusRow}><Badge color={probe?.status === 'READY' ? 'success' : 'warning'}>{probe?.status ?? 'CHECKING'}</Badge></div><p className={styles.details}>{probe?.diagnostics[0] ?? '正在读取插件证据'}</p></div>
      <div className={styles.panel}><h2 className={styles.panelTitle}><DocumentData20Regular />已完成</h2><div className={styles.metric}>{completedCount}</div><div className={styles.metricLabel}>个任务已形成完整结果</div></div>
    </section>
    <section className={styles.workGrid}>
      <TaskPanel styles={styles} tasks={tasks} loading={loading} error={error} onChanged={onCreated} />
      <CreateTaskPanel styles={styles} onCreated={onCreated} />
    </section>
  </>
}

function LanPairGate({ styles, onPaired }: { styles: ReturnType<typeof useStyles>; onPaired(): void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function pair(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch('/api/lan/pair', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim() }),
      })
      const body = await response.json() as { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message ?? '配对失败')
      onPaired()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '配对失败') }
    finally { setBusy(false) }
  }
  return <main className={styles.content} style={{ maxWidth: 520, paddingTop: 96 }}><div className={styles.panel}><h1 className={styles.title}>连接 Thermal Agent</h1><p className={styles.subtitle}>请在运行 App 的 Windows 电脑上打开“设置 → 局域网发布”，输入当前短时配对码。</p><form className={styles.form} onSubmit={pair}><Field label="8 位配对码" required><Input value={code} maxLength={8} inputMode="numeric" onChange={(_, data) => setCode(data.value.replace(/\D/gu, ''))} /></Field>{error && <p className={styles.error}>{error}</p>}<Button type="submit" appearance="primary" disabled={busy || code.length !== 8}>{busy ? '配对中' : '配对并进入'}</Button></form></div></main>
}

function LanSettings({ styles }: { styles: ReturnType<typeof useStyles> }) {
  const [status, setStatus] = useState<LanStatus | null>(null)
  const [port, setPort] = useState('43111')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/lan/status')
      const body = await response.json() as { lan?: LanStatus; error?: { message?: string } }
      if (!response.ok || !body.lan) throw new Error(body.error?.message ?? 'LAN 状态读取失败')
      setStatus(body.lan); setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'LAN 状态读取失败') }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  async function toggle() {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/lan/${status?.enabled ? 'stop' : 'start'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: status?.enabled ? '{}' : JSON.stringify({ port: Number(port) }),
      })
      const body = await response.json() as { lan?: LanStatus; error?: { message?: string } }
      if (!response.ok || !body.lan) throw new Error(body.error?.message ?? 'LAN 操作失败')
      setStatus(body.lan)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'LAN 操作失败') }
    finally { setBusy(false) }
  }
  return <><div className={styles.intro}><div><h1 className={styles.title}>局域网发布</h1><p className={styles.subtitle}>默认关闭。开启后，静态登录页可访问；API、SSE 和业务操作必须先用短时配对码换取 HttpOnly 会话。节点签名发现也会同时开启，需要局域网允许 UDP 43112 组播。</p></div></div><div className={styles.panel} style={{ marginBottom: 16 }}><div className={styles.statusRow}><div><h2 className={styles.panelTitle}><DesktopPulse20Regular />LAN Web</h2><p className={styles.details}>{status?.enabled ? status.addresses.join(' · ') || `端口 ${status.port}` : '仅本机可访问'}</p></div><Badge color={status?.enabled ? 'success' : 'informative'}>{status?.enabled ? 'ENABLED' : 'DISABLED'}</Badge></div>{!isLanClient && <div className={styles.form}><Field label="监听端口"><Input type="number" disabled={status?.enabled} value={port} onChange={(_, data) => setPort(data.value)} /></Field>{status?.enabled && status.pairingCode && <div className={styles.resultItem}><div className={styles.details}>短时配对码（10 分钟）</div><div className={styles.metric}>{status.pairingCode}</div><div className={styles.details}>已配对会话：{status.sessionCount}</div></div>}<Button appearance={status?.enabled ? 'secondary' : 'primary'} disabled={busy} onClick={() => void toggle()}>{busy ? '处理中' : status?.enabled ? '停止局域网发布' : '显式开启局域网发布'}</Button></div>}{error && <p className={styles.error}>{error}</p>}</div></>
}

function AgentWorkspace({ styles }: { styles: ReturnType<typeof useStyles> }) {
  const [status, setStatus] = useState<DshStatus>({ phase: 'starting' })
  const [error, setError] = useState('')
  const [restarting, setRestarting] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/agent/status')
      const body = await response.json() as { agent?: DshStatus; error?: { message?: string } }
      if (!response.ok || !body.agent) throw new Error(body.error?.message ?? 'DSH 状态读取失败')
      setStatus(body.agent); setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'DSH 状态读取失败')
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    const timer = window.setInterval(() => void refreshStatus(), 2_000)
    return () => window.clearInterval(timer)
  }, [refreshStatus])

  async function restart() {
    setRestarting(true); setError('')
    try {
      const response = await fetch('/api/agent/restart', { method: 'POST' })
      if (!response.ok) throw new Error('DSH Host 重启失败')
      await refreshStatus()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'DSH Host 重启失败')
    } finally { setRestarting(false) }
  }

  if (isLanClient) return <div className={styles.panel}><div className={styles.empty}><div><Bot20Regular fontSize={28} /><p>DSH 对话仅在安装 App 的本机桌面开放。局域网浏览器可查看和管理结构化 Task、Skill 与仿真结果。</p></div></div></div>
  return <>
    <div className={styles.intro}>
      <div><h1 className={styles.title}>散热 Agent</h1><p className={styles.subtitle}>DSH 负责自然语言理解、任务整理和工具选择；昂贵求解与 Skill 发布仍由人工确认。</p></div>
      <div className={styles.headerActions}><Badge color={status.phase === 'ready' ? 'success' : status.phase === 'failed' ? 'danger' : 'informative'}>{status.phase.toUpperCase()}</Badge><Button disabled={restarting} onClick={() => void restart()}>{restarting ? '重启中' : '重启运行时'}</Button></div>
    </div>
    {error && <p className={styles.error}>{error}</p>}
    <div className={`${styles.panel} ${styles.agentPanel}`}>
      {status.phase === 'ready' && status.url
        ? <iframe className={styles.agentFrame} src={status.url} title="Thermal Agent DSH 对话" />
        : <div className={styles.empty}><div><Spinner label={status.detail ?? '正在启动 DSH Host'} /><p className={styles.details}>{status.workspacePath ?? '正在准备本地工作目录'}</p></div></div>}
    </div>
  </>
}

function TaskPanel({ styles, tasks, loading, error, onChanged }: { styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; loading: boolean; error: string; onChanged(): Promise<void> }) {
  return <div className={styles.panel}><h2 className={styles.panelTitle}>最近任务</h2>{loading ? <div className={styles.empty}><Spinner label="正在读取本地任务" /></div> : error ? <p className={styles.error}>{error}</p> : tasks.length === 0 ? <div className={styles.empty}><div><DocumentData20Regular fontSize={28} /><p>还没有任务。可以先创建一个需求草稿。</p></div></div> : <TaskTable styles={styles} tasks={tasks.slice(0, 8)} onChanged={onChanged} />}</div>
}

function TaskList({ styles, tasks, loading, onChanged }: { styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; loading: boolean; onChanged(): Promise<void> }) {
  return <><div className={styles.intro}><div><h1 className={styles.title}>任务</h1><p className={styles.subtitle}>执行状态、热判定和审批状态分别记录，避免把求解完成误认为热设计达标。</p></div></div><div className={styles.panel}>{loading ? <Spinner label="正在加载任务" /> : tasks.length ? <TaskTable styles={styles} tasks={tasks} onChanged={onChanged} /> : <div className={styles.empty}>当前没有任务。</div>}</div></>
}

function TaskTable({ styles, tasks, onChanged }: { styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; onChanged(): Promise<void> }) {
  return <div style={{ overflowX: 'auto' }}><table className={styles.table}><thead className={styles.tableHead}><tr><th className={styles.tableCell}>任务</th><th className={styles.tableCell}>执行状态</th><th className={styles.tableCell}>热判定</th><th className={styles.tableCell}>审批</th><th className={styles.tableCell}>操作</th></tr></thead><tbody>{tasks.map(task => <tr key={task.id}><td className={styles.tableCell}><strong>{task.title}</strong><div className={styles.details}>{task.description || '尚未填写补充说明'}</div></td><td className={styles.tableCell}><Badge appearance="outline">{task.executionStatus}</Badge></td><td className={styles.tableCell}>{task.thermalVerdict}</td><td className={styles.tableCell}>{task.approvalStatus}</td><td className={styles.tableCell}><TaskAction styles={styles} task={task} onChanged={onChanged} /></td></tr>)}</tbody></table></div>
}

function TaskAction({ styles, task, onChanged }: { styles: ReturnType<typeof useStyles>; task: TaskRecord; onChanged(): Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const projectPath = typeof task.requirementSnapshot.projectPath === 'string' ? task.requirementSnapshot.projectPath : ''
  async function act(kind: 'confirm' | 'baseline' | 'candidate' | 'retry' | 'skill' | 'report' | 'approve' | 'reject') {
    setBusy(true); setError('')
    try {
      const response = kind === 'confirm'
        ? await fetch(`/api/tasks/${task.id}/transitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'READY', expectedVersion: task.version, reason: '用户确认需求与工程路径' }) })
        : kind === 'baseline'
          ? await fetch(`/api/tasks/${task.id}/runs/baseline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath, version: task.requirementSnapshot.aedtVersion ?? '2024.2', cores: task.requirementSnapshot.cores ?? 4 }) })
          : kind === 'candidate'
            ? await fetch(`/api/tasks/${task.id}/runs/candidate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: task.version, fanSpeedRatio: 1.1, version: task.requirementSnapshot.aedtVersion ?? '2024.2', cores: task.requirementSnapshot.cores ?? 4, minImprovementC: 0.5 }) })
          : kind === 'retry'
            ? await fetch(`/api/tasks/${task.id}/runs/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: task.version }) })
          : kind === 'report'
            ? await fetch(`/api/tasks/${task.id}/report`, { method: 'POST' })
          : kind === 'skill'
            ? await fetch(`/api/tasks/${task.id}/skill-draft`, { method: 'POST' })
            : await fetch(`/api/tasks/${task.id}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: kind === 'approve' ? 'APPROVED' : 'REJECTED', expectedVersion: task.version, reason: kind === 'approve' ? '用户复核并接受求解证据' : '用户拒绝当前结果并升级人工处理' }) })
      const body = await response.json() as { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message ?? '操作未完成')
      if (kind === 'report') window.open(`/api/tasks/${task.id}/report`, '_blank', 'noopener,noreferrer')
      await onChanged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作未完成') }
    finally { setBusy(false) }
  }
  if (task.executionStatus === 'DRAFT') return <div><Button size="small" disabled={!projectPath || busy} onClick={() => void act('confirm')}>确认需求</Button>{!projectPath && <div className={styles.error}>缺少工程路径</div>}{error && <div className={styles.error}>{error}</div>}</div>
  if (task.executionStatus === 'READY') return <div><Button size="small" appearance="primary" disabled={!projectPath || busy} onClick={() => void act('baseline')}>{busy ? '启动中' : '启动 Baseline'}</Button>{error && <div className={styles.error}>{error}</div>}</div>
  if (task.executionStatus === 'WAITING_FOR_APPROVAL') return <div><div className={styles.headerActions}><Button size="small" appearance="primary" disabled={busy} onClick={() => void act('approve')}>接受结果</Button>{task.thermalVerdict === 'FAIL' && <Button size="small" disabled={busy} onClick={() => void act('candidate')}>批准风扇 +10%</Button>}<Button size="small" disabled={busy} onClick={() => void act('reject')}>拒绝并升级</Button></div>{error && <div className={styles.error}>{error}</div>}</div>
  if (task.executionStatus === 'COMPLETED') return <div><div className={styles.headerActions}><Button size="small" disabled={busy} onClick={() => void act('report')}>{busy ? '生成中' : '查看 PDF 报告'}</Button><Button size="small" disabled={busy} onClick={() => void act('skill')}>沉淀 Skill 草稿</Button></div>{error && <div className={styles.error}>{error}</div>}</div>
  if (task.executionStatus === 'FAILED' || task.executionStatus === 'CANCELLED') return <div><Button size="small" disabled={busy} onClick={() => void act('retry')}>{busy ? '重试中' : '重试最近 Run'}</Button>{error && <div className={styles.error}>{error}</div>}</div>
  return <span className={styles.details}>{task.executionStatus === 'RUNNING' ? '后台求解中' : '无可用操作'}</span>
}

function SkillLibrary({ styles, skills, onChanged }: { styles: ReturnType<typeof useStyles>; skills: SkillRecord[]; onChanged(): Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string | null>(skills[0]?.id ?? null)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [runTitle, setRunTitle] = useState('')
  const [runProjectPath, setRunProjectPath] = useState('')
  const [runTarget, setRunTarget] = useState('')
  const [runMessage, setRunMessage] = useState('')

  useEffect(() => {
    if (!skills.length) { setSelectedId(null); setDetail(null); return }
    if (!selectedId || !skills.some(skill => skill.id === selectedId)) setSelectedId(skills[0].id)
  }, [skills, selectedId])

  useEffect(() => {
    if (!selectedId) return
    let active = true
    void fetch(`/api/skills/${selectedId}`).then(async response => {
      const body = await response.json() as { skill?: SkillDetail; error?: { message?: string } }
      if (!response.ok || !body.skill) throw new Error(body.error?.message ?? 'Skill 详情读取失败')
      if (active) { setDetail(body.skill); setError('') }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Skill 详情读取失败') })
    return () => { active = false }
  }, [selectedId, skills])

  async function review(action: 'enable' | 'disable') {
    if (!detail) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/skills/${detail.id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewer: 'local-user', expectedUpdatedAt: detail.updatedAt }),
      })
      const body = await response.json() as { skill?: SkillDetail; error?: { message?: string } }
      if (!response.ok || !body.skill) throw new Error(body.error?.message ?? 'Skill 审核操作失败')
      setDetail(body.skill)
      await onChanged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Skill 审核操作失败') }
    finally { setBusy(false) }
  }

  async function startRun() {
    if (!detail) return
    setBusy(true); setError(''); setRunMessage('')
    try {
      const target = runTarget.trim() ? Number(runTarget) : undefined
      if (target !== undefined && !Number.isFinite(target)) throw new Error('最高温度目标必须是数字')
      const response = await fetch(`/api/skills/${detail.id}/runs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: runTitle, description: `由 Skill「${detail.name}」创建`, projectPath: runProjectPath, targetTmaxC: target, version: '2024.2', cores: 4 }),
      })
      const body = await response.json() as { task?: TaskRecord; error?: { message?: string } }
      if (!response.ok || !body.task) throw new Error(body.error?.message ?? 'Skill Run 创建失败')
      setRunMessage(`已创建任务草稿：${body.task.title}`); setRunTitle(''); setRunProjectPath(''); setRunTarget('')
      await onChanged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Skill Run 创建失败') }
    finally { setBusy(false) }
  }

  return <>
    <div className={styles.intro}><div><h1 className={styles.title}>散热技能库</h1><p className={styles.subtitle}>草稿只保存在业务库；人工审核启用后才导出到 DSH。停用会撤回发布文件。</p></div></div>
    {skills.length === 0 ? <div className={styles.panel}><div className={styles.empty}><div><BrainCircuit20Regular fontSize={28} /><p>暂无 Skill。请先从具备完整证据的已完成任务沉淀草稿。</p></div></div></div> :
      <section className={styles.skillGrid}>
        <div className={styles.panel}><h2 className={styles.panelTitle}>技能</h2><div className={styles.skillList}>{skills.map(skill => <Button key={skill.id} className={styles.skillButton} appearance={selectedId === skill.id ? 'primary' : 'subtle'} onClick={() => setSelectedId(skill.id)}><span>{skill.name}</span><Badge appearance="outline">{skill.status}</Badge></Button>)}</div></div>
        <div className={styles.panel}>{detail ? <>
          <div className={styles.statusRow}><div><h2 className={styles.panelTitle}>{detail.name}</h2><p className={styles.details}>{detail.description}</p></div><Badge color={detail.status === 'ENABLED' ? 'success' : detail.status === 'DRAFT' ? 'warning' : 'informative'}>{detail.status}</Badge></div>
          <div className={styles.section}><strong>步骤与验收</strong><ol>{detail.version.definition.steps.map(step => <li key={step.id}><strong>{step.title}</strong><div className={styles.details}>{step.description}<br />验证：{step.verification}</div></li>)}</ol></div>
          <div className={styles.section}><strong>权限边界</strong><ul>{detail.version.definition.permissions.map(item => <li key={item}>{item}</li>)}</ul></div>
          <p className={styles.details}>来源任务：{detail.sources.length} · 版本：v{detail.activeVersion} · 运行：{detail.runCount} · 成功：{detail.successCount} · 连续失败：{detail.consecutiveFailures}{detail.publishedPath ? ` · 已发布到 ${detail.publishedPath}` : ''}</p>
          {error && <p className={styles.error}>{error}</p>}
          {detail.status === 'DRAFT' || detail.status === 'DISABLED'
            ? <Button appearance="primary" disabled={busy} onClick={() => void review('enable')}>{busy ? '处理中' : '审核并启用'}</Button>
            : detail.status === 'ENABLED' ? <Button disabled={busy} onClick={() => void review('disable')}>{busy ? '处理中' : '停用并撤回'}</Button> : null}
          {detail.status === 'ENABLED' && <div className={styles.section}><strong>从此 Skill 创建任务</strong><div className={styles.form}><Field label="任务名称" required><Input value={runTitle} onChange={(_, data) => setRunTitle(data.value)} /></Field><Field label="Windows 工程路径" required><Input value={runProjectPath} onChange={(_, data) => setRunProjectPath(data.value)} placeholder="C:\\ThermalModels\\Project1.aedt" /></Field><Field label="最高温度目标（°C）"><Input type="number" value={runTarget} onChange={(_, data) => setRunTarget(data.value)} /></Field><Button appearance="primary" disabled={busy || !runTitle.trim() || !runProjectPath.trim()} onClick={() => void startRun()}>{busy ? '环境检查中' : '检查环境并创建 Skill Run'}</Button>{runMessage && <p className={styles.details}>{runMessage}</p>}</div></div>}
        </> : <Spinner label="正在读取 Skill 详情" />}</div>
      </section>}
  </>
}

function CreateTaskPanel({ styles, onCreated }: { styles: ReturnType<typeof useStyles>; onCreated(): Promise<void> }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [targetTmaxC, setTargetTmaxC] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setSaving(true)
    try {
      const parsedTarget = targetTmaxC.trim() ? Number(targetTmaxC) : undefined
      if (parsedTarget !== undefined && !Number.isFinite(parsedTarget)) throw new Error('最高温度目标必须是数字')
      const response = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description, requirementSnapshot: { projectPath, aedtVersion: '2024.2', cores: 4, ...(parsedTarget === undefined ? {} : { targetTmaxC: parsedTarget }) } }) })
      if (!response.ok) { const body = await response.json() as { error?: { message?: string } }; throw new Error(body.error?.message ?? '任务未创建') }
      setTitle(''); setDescription(''); setProjectPath(''); setTargetTmaxC(''); await onCreated()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '任务未创建') }
    finally { setSaving(false) }
  }
  return <div className={styles.panel}><h2 className={styles.panelTitle}><Add20Regular />新建需求草稿</h2><form className={styles.form} onSubmit={submit}><Field label="任务名称" required><Input value={title} onChange={(_, data) => setTitle(data.value)} /></Field><Field label="Windows 工程路径" hint="保存后仍需人工确认，Core 会在求解前创建内容快照。"><Input value={projectPath} onChange={(_, data) => setProjectPath(data.value)} placeholder="C:\\ThermalModels\\Project1.aedt" /></Field><Field label="最高温度目标（°C）" hint="留空时热判定保持 PENDING，系统不会猜测目标。"><Input type="number" value={targetTmaxC} onChange={(_, data) => setTargetTmaxC(data.value)} /></Field><Field label="需求描述"><Textarea resize="vertical" value={description} onChange={(_, data) => setDescription(data.value)} /></Field>{error && <div className={styles.error}>{error}</div>}<Button type="submit" appearance="primary" disabled={!title.trim() || saving}>{saving ? '正在保存' : '保存草稿'}</Button></form></div>
}

function IcepakSettings({ styles, probe, onProbeUpdated }: { styles: ReturnType<typeof useStyles>; probe: IcepakEnvironmentProbe | null; onProbeUpdated(probe: IcepakEnvironmentProbe): void }) {
  const [projectPath, setProjectPath] = useState('')
  const [version, setVersion] = useState(probe?.selectedVersion ?? '2024.2')
  const [ratio, setRatio] = useState('1.1')
  const [running, setRunning] = useState<'inspect' | 'fan-check' | null>(null)
  const [result, setResult] = useState<IcepakProjectOperationResult | null>(null)
  const [error, setError] = useState('')
  const [probingLaunch, setProbingLaunch] = useState(false)
  useEffect(() => { if (probe?.selectedVersion) setVersion(probe.selectedVersion) }, [probe?.selectedVersion])

  async function probeLaunch() {
    setProbingLaunch(true); setError('')
    try {
      const response = await fetch('/api/plugins/icepak/probe-launchability', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }),
      })
      const body = await response.json() as { probe?: IcepakEnvironmentProbe; error?: { message?: string } }
      if (!response.ok || !body.probe) throw new Error(body.error?.message ?? 'Icepak 启动验证失败')
      onProbeUpdated(body.probe)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Icepak 启动验证失败') }
    finally { setProbingLaunch(false) }
  }

  async function run(operation: 'inspect' | 'fan-check') {
    setRunning(operation); setError(''); setResult(null)
    try {
      const response = await fetch(`/api/plugins/icepak/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          version,
          ...(operation === 'fan-check' ? { fanSpeedRatio: Number(ratio) } : {}),
        }),
      })
      const body = await response.json() as { result?: IcepakProjectOperationResult; error?: { message?: string } }
      if (!response.ok || !body.result) throw new Error(body.error?.message ?? 'Icepak 操作失败')
      setResult(body.result)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Icepak 操作失败')
    } finally {
      setRunning(null)
    }
  }

  return <>
    <div className={styles.intro}><div><h1 className={styles.title}>Icepak 插件</h1><p className={styles.subtitle}>检查本机 AEDT 工程并验证可执行动作。所有操作都在独立副本中完成，不修改源工程。</p></div></div>
    <section className={styles.settingsGrid}>
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}><DesktopPulse20Regular />环境与工程</h2>
        <div className={styles.statusRow}><Badge color={probe?.status === 'READY' ? 'success' : 'warning'}>{probe?.status ?? 'CHECKING'}</Badge><span className={styles.details}>{probe?.selectedVersion ?? '未选择 AEDT 版本'}</span></div>
        <div className={styles.form}>
          <Field label="Windows 主机上的 AEDT 工程路径" hint="例如 C:\\ThermalModels\\Project1.aedt"><Input value={projectPath} onChange={(_, data) => setProjectPath(data.value)} /></Field>
          <Field label="AEDT 版本"><Input value={version} onChange={(_, data) => setVersion(data.value)} /></Field>
          <Button disabled={probingLaunch || running !== null} onClick={() => void probeLaunch()}>{probingLaunch ? '正在启动并释放 Icepak' : '验证 Icepak 可启动'}</Button>
          <p className={styles.details}>启动验证会短暂开启独立 AEDT 会话；成功仅代表可启动，不代表已验证求解许可证。</p>
          <Field label="风扇转速比例" hint="仅用于动作验证，范围 (1.0, 1.5]"><Input type="number" min={1.01} max={1.5} step={0.01} value={ratio} onChange={(_, data) => setRatio(data.value)} /></Field>
          {error && <div className={styles.error}>{error}</div>}
          <Button appearance="primary" disabled={!projectPath.trim() || running !== null} onClick={() => void run('inspect')}>{running === 'inspect' ? '正在启动 AEDT' : '检查工程'}</Button>
          <Button disabled={!projectPath.trim() || running !== null} onClick={() => void run('fan-check')}>{running === 'fan-check' ? '正在验证动作' : '验证风扇动作'}</Button>
        </div>
      </div>
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>检查结果</h2>
        {running ? <div className={styles.empty}><Spinner label="AEDT 启动可能需要数分钟，请保持应用运行" /></div> : result ? <div className={styles.resultGrid}>
          <ResultItem styles={styles} label="工程" value={result.project.name || '未命名'} />
          <ResultItem styles={styles} label="活动设计" value={result.project.activeDesign || '未识别'} />
          <ResultItem styles={styles} label="AEDT 版本" value={result.project.aedtVersion || '未识别'} />
          <ResultItem styles={styles} label="Setup" value={result.project.setups.join(', ') || '未识别'} />
          <ResultItem styles={styles} label="温度 Monitor" value={result.project.monitors.join(', ') || '未识别'} />
          <ResultItem styles={styles} label="能力校验" value={result.validation.verified ? '通过' : '未通过'} />
          {result.fanAction && <ResultItem styles={styles} label="风扇动作" value="写入及回读验证通过" />}
          <ResultItem styles={styles} label="工作副本" value={result.workingProject} />
        </div> : <div className={styles.empty}><div><DesktopPulse20Regular fontSize={28} /><p>填写本机工程路径后开始检查。</p></div></div>}
      </div>
    </section>
  </>
}

function ResultItem({ styles, label, value }: { styles: ReturnType<typeof useStyles>; label: string; value: string }) {
  return <div className={styles.resultItem}><div className={styles.details}>{label}</div><div className={styles.resultValue}>{value}</div></div>
}

function NodeWorkspace({ styles }: { styles: ReturnType<typeof useStyles> }) {
  const [local, setLocal] = useState<PeerIdentity | null>(null)
  const [peers, setPeers] = useState<PeerRecord[]>([])
  const [discovery, setDiscovery] = useState<DiscoveryStatus | null>(null)
  const [remoteEnabled, setRemoteEnabled] = useState(false)
  const [remoteJobs, setRemoteJobs] = useState<RemoteJobRecord[]>([])
  const [displayName, setDisplayName] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [verifiedPeers, setVerifiedPeers] = useState<Record<string, string>>({})
  const [securePeers, setSecurePeers] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try {
      const identityResponse = await fetch('/api/nodes/local')
      const identityBody = await identityResponse.json() as { node?: PeerIdentity; error?: { message?: string } }
      if (!identityResponse.ok || !identityBody.node) throw new Error(identityBody.error?.message ?? '本机身份读取失败')
      setLocal(identityBody.node)
      if (!isLanClient) {
        const [peerResponse, discoveryResponse, remoteResponse] = await Promise.all([
          fetch('/api/nodes/peers'), fetch('/api/nodes/discovery'), fetch('/api/nodes/remote-execution'),
        ])
        const peerBody = await peerResponse.json() as { peers?: PeerRecord[]; error?: { message?: string } }
        if (!peerResponse.ok || !peerBody.peers) throw new Error(peerBody.error?.message ?? '可信节点读取失败')
        setPeers(peerBody.peers)
        const discoveryBody = await discoveryResponse.json() as { discovery?: DiscoveryStatus; error?: { message?: string } }
        if (!discoveryResponse.ok || !discoveryBody.discovery) throw new Error(discoveryBody.error?.message ?? '节点发现状态读取失败')
        setDiscovery(discoveryBody.discovery)
        const remoteBody = await remoteResponse.json() as { enabled?: boolean; jobs?: RemoteJobRecord[]; error?: { message?: string } }
        if (!remoteResponse.ok || typeof remoteBody.enabled !== 'boolean' || !remoteBody.jobs) {
          throw new Error(remoteBody.error?.message ?? '远程接单状态读取失败')
        }
        setRemoteEnabled(remoteBody.enabled)
        setRemoteJobs(remoteBody.jobs)
      }
      setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '节点读取失败') }
  }, [])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5_000)
    return () => clearInterval(timer)
  }, [refresh])

  async function pair(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch('/api/nodes/peers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, nodeId: nodeId.trim(), publicKey: publicKey.trim() }),
      })
      const body = await response.json() as { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message ?? '节点登记失败')
      setDisplayName(''); setNodeId(''); setPublicKey(''); await refresh()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '节点登记失败') }
    finally { setBusy(false) }
  }

  async function revoke(peer: PeerRecord) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/nodes/peers/${peer.nodeId}/revoke`, { method: 'POST' })
      const body = await response.json() as { error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message ?? '节点撤销失败')
      setVerifiedPeers(current => { const next = { ...current }; delete next[peer.nodeId]; return next })
      setSecurePeers(current => { const next = { ...current }; delete next[peer.nodeId]; return next })
      await refresh()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '节点撤销失败') }
    finally { setBusy(false) }
  }

  async function verifyPeer(peerId: string) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/nodes/peers/${peerId}/verify`, { method: 'POST' })
      const body = await response.json() as { verification?: { nodeId: string; verifiedAt: string }; error?: { message?: string } }
      if (!response.ok || !body.verification) throw new Error(body.error?.message ?? '节点身份验证失败')
      setVerifiedPeers(current => ({ ...current, [peerId]: body.verification!.verifiedAt }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '节点身份验证失败') }
    finally { setBusy(false) }
  }

  async function connectPeer(peerId: string) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/nodes/peers/${peerId}/connect`, { method: 'POST' })
      const body = await response.json() as { connection?: { nodeId: string; expiresAt: string }; error?: { message?: string } }
      if (!response.ok || !body.connection) throw new Error(body.error?.message ?? '加密通道测试失败')
      setSecurePeers(current => ({ ...current, [peerId]: body.connection!.expiresAt }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '加密通道测试失败') }
    finally { setBusy(false) }
  }

  async function toggleRemoteExecution() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/nodes/remote-execution', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !remoteEnabled }),
      })
      const body = await response.json() as { enabled?: boolean; error?: { message?: string } }
      if (!response.ok || typeof body.enabled !== 'boolean') throw new Error(body.error?.message ?? '远程接单设置失败')
      setRemoteEnabled(body.enabled)
      await refresh()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '远程接单设置失败') }
    finally { setBusy(false) }
  }

  return <>
    <div className={styles.intro}><div><h1 className={styles.title}>计算节点</h1><p className={styles.subtitle}>每台 App 有独立且持久的 Ed25519 身份。开启局域网发布后可签名发现附近节点；加密输入传输与任务收件协议已接入，跨机求解尚未完成。</p></div></div>
    <section className={styles.settingsGrid}>
      <div className={styles.panel}><h2 className={styles.panelTitle}><DesktopPulse20Regular />本机身份</h2>{local ? <div className={styles.resultGrid} style={{ gridTemplateColumns: '1fr' }}><ResultItem styles={styles} label="Node ID / 指纹" value={local.nodeId} /><ResultItem styles={styles} label="公钥（可在另一台 App 手动登记）" value={local.publicKey} /></div> : <Spinner label="正在读取本机身份" />}</div>
      <div className={styles.panel}><h2 className={styles.panelTitle}>可信节点登记</h2>{isLanClient ? <p className={styles.placeholder}>节点信任只能在运行 App 的本机电脑上管理。</p> : <><p className={styles.details}>请通过可信的线下方式核对对方 Node ID 与公钥。登记后可验证对方当前是否持有私钥，但不会自动分配任务；远程执行仍需加密传输。</p><form className={styles.form} onSubmit={pair}><Field label="设备名称" required><Input value={displayName} onChange={(_, data) => setDisplayName(data.value)} /></Field><Field label="对方 Node ID" required><Input value={nodeId} onChange={(_, data) => setNodeId(data.value)} /></Field><Field label="对方公钥" required><Input value={publicKey} onChange={(_, data) => setPublicKey(data.value)} /></Field><Button type="submit" appearance="primary" disabled={busy || !displayName.trim() || !nodeId.trim() || !publicKey.trim()}>登记可信节点</Button></form></>}</div>
    </section>
    {!isLanClient && <div className={styles.panel} style={{ marginTop: 16 }}>
      <div className={styles.statusRow} style={{ marginTop: 0 }}><div><h2 className={styles.panelTitle}>远程任务接单</h2><p className={styles.details}>默认关闭。开启后仅接收已登记可信节点的加密 Baseline Offer，并要求本机 Icepak 真正 READY；当前只保存待处理记录，不下载工程或启动求解。</p></div><Badge color={remoteEnabled ? 'warning' : 'informative'}>{remoteEnabled ? '已开启' : '已关闭'}</Badge></div>
      <Button appearance={remoteEnabled ? 'secondary' : 'primary'} disabled={busy} onClick={() => void toggleRemoteExecution()}>{remoteEnabled ? '停止远程接单' : '显式开启远程接单'}</Button>
      {remoteJobs.length > 0 && <div className={styles.skillList}>{remoteJobs.map(job => <div key={job.attemptId} className={styles.statusRow}><div><strong>{job.taskId}</strong><div className={styles.details}>Owner {job.ownerNodeId} · Attempt {job.attemptId} · 输入 {job.inputOriginalName}</div></div><Badge>{job.status}</Badge></div>)}</div>}
    </div>}
    {!isLanClient && <div className={styles.panel} style={{ marginTop: 16 }}><h2 className={styles.panelTitle}>局域网发现</h2><p className={styles.details}>{discovery?.enabled ? `已开启 · UDP ${discovery.group}:${discovery.udpPort}` : '未开启；请先在设置中开启局域网发布'}{discovery?.lastError ? ` · ${discovery.lastError}` : ''}</p>{discovery?.discovered.length ? <div className={styles.skillList}>{discovery.discovered.map(peer => <div key={peer.identity.nodeId} className={styles.statusRow}><div><strong>{peer.identity.nodeId}</strong><div className={styles.details}>{peer.address}:{peer.servicePort} · Icepak {peer.heartbeat.pluginStatus} · 负载 {peer.heartbeat.activeAttempts}/{peer.heartbeat.maxConcurrent} · {peer.heartbeat.aedtVersions.join(', ') || '未知 AEDT 版本'}</div>{peer.trusted && verifiedPeers[peer.identity.nodeId] && <div className={styles.details}>最近身份握手：{new Date(verifiedPeers[peer.identity.nodeId]).toLocaleString()}</div>}{peer.trusted && securePeers[peer.identity.nodeId] && Date.parse(securePeers[peer.identity.nodeId]) > Date.now() && <div className={styles.details}>临时加密会话至 {new Date(securePeers[peer.identity.nodeId]).toLocaleTimeString()}（可测试 ping；其他操作仍需任务租约）</div>}</div><div className={styles.headerActions}><Badge color={peer.trusted ? 'success' : 'warning'}>{peer.trusted ? '可信签名' : '未登记'}</Badge>{peer.trusted ? <><Button size="small" disabled={busy} onClick={() => void verifyPeer(peer.identity.nodeId)}>验证身份</Button><Button size="small" disabled={busy} onClick={() => void connectPeer(peer.identity.nodeId)}>测试加密通道</Button></> : <Button size="small" onClick={() => { setNodeId(peer.identity.nodeId); setPublicKey(peer.identity.publicKey); setDisplayName(peer.identity.nodeId) }}>填入登记</Button>}</div></div>)}</div> : <p className={styles.placeholder}>还没有发现其他 App。两台电脑需在同一局域网开启发布，且网络允许 UDP 组播。</p>}</div>}
    {!isLanClient && <div className={styles.panel} style={{ marginTop: 16 }}><h2 className={styles.panelTitle}>已登记节点</h2>{peers.length ? <div className={styles.skillList}>{peers.map(peer => <div key={peer.nodeId} className={styles.statusRow}><div><strong>{peer.displayName}</strong><div className={styles.details}>{peer.nodeId} · {peer.pluginStatus} · {peer.lastSeenAt ?? '尚无能力心跳'}</div></div><div className={styles.headerActions}><Badge color={peer.trustStatus === 'TRUSTED' ? 'success' : 'danger'}>{peer.trustStatus}</Badge>{peer.trustStatus === 'TRUSTED' && <Button size="small" disabled={busy} onClick={() => void revoke(peer)}>撤销信任</Button>}</div></div>)}</div> : <p className={styles.placeholder}>还没有登记其他计算节点。</p>}</div>}
    {error && <p className={styles.error}>{error}</p>}
  </>
}
