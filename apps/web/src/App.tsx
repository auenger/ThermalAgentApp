import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import {
  Badge,
  Button,
  Field,
  FluentProvider,
  Input,
  Select,
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
  Home20Filled,
  Settings20Regular,
  Settings20Filled,
  ArrowClockwise20Regular,
  ArrowLeft20Regular,
  ArrowDownload20Regular,
  ArrowUpload20Regular,
  Edit20Regular,
  Play20Regular,
  Send20Regular,
  Checkmark20Regular,
  Dismiss20Regular,
  DocumentPdf20Regular,
  Save20Regular,
  Stop20Regular,
  DocumentAdd20Regular,
  ChevronDown16Regular,
  ChevronRight16Regular,
  Chat20Regular,
  Archive16Regular,
  Bot20Filled,
  DocumentData20Filled,
  BrainCircuit20Filled,
  DesktopPulse20Filled,
  WeatherSunny20Regular,
  WeatherMoon20Regular,
} from '@fluentui/react-icons'
import type { AttemptArtifactRecord, AttemptRecord, AutoDispatchRecord, IcepakEnvironmentProbe, IcepakProjectOperationResult, ModelCapabilityAssessment, OptimizationRecommendation, OptimizationSkillGuidance, OptimizationSkillInput, PeerIdentity, PeerRecord, RemoteJobRecord, RunRecord, SkillDetail, SkillRecord, TaskEvent, TaskRecord } from '@thermal-agent/contracts'

const brand: BrandVariants = {
  10: '#260806', 20: '#3c0d09', 30: '#59130e', 40: '#771d15', 50: '#94291f',
  60: '#ab3529', 70: '#bb4032', 80: '#c84a39', 90: '#d45b49', 100: '#de705f',
  110: '#e8897c', 120: '#efa69c', 130: '#f4bfb8', 140: '#f8d6d1', 150: '#fbe9e6', 160: '#fff7f5',
}

const lightTheme = createLightTheme(brand)
const darkTheme = createDarkTheme(brand)

type Page = 'overview' | 'agent' | 'tasks' | 'task-create' | 'task-detail' | 'skills' | 'nodes' | 'settings'

interface DshStatus {
  phase: 'unconfigured' | 'starting' | 'ready' | 'stopped' | 'failed'
  url?: string
  detail?: string
  workspacePath?: string
}

interface DshSession { sessionId: string; title: string; updatedAt: number }
type AgentAction = { kind: 'session'; sessionId: string; key: number } | { kind: 'settings'; key: number }
type CheckStatus = 'waiting' | 'running' | 'passed' | 'failed' | 'skipped'
interface CheckStep { status: CheckStatus; detail: string }
interface IcepakSelfCheck {
  running: boolean
  version: string
  steps: [CheckStep, CheckStep, CheckStep]
  sampleResult: IcepakProjectOperationResult | null
  checkedAt?: string
}
const emptyIcepakCheck = (): IcepakSelfCheck => ({ running: false, version: '', steps: [
  { status: 'waiting', detail: '等待检测本机 AEDT 与 PyAEDT' },
  { status: 'waiting', detail: '等待确认可启动的 AEDT 版本' },
  { status: 'waiting', detail: '等待使用内置 Project1.aedt 检查工程' },
], sampleResult: null })

declare global {
  interface Window {
    thermalDesktop?: {
      platform: string
      setTitleBarTheme(dark: boolean): Promise<void>
      openDshSession(sessionId: string): Promise<void>
      openDshSettings(): Promise<void>
      styleDshFrame(): Promise<void>
    }
  }
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
  shell: { display: 'grid', gridTemplateColumns: '216px minmax(0, 1fr)', minHeight: '100dvh', '@media (max-width: 900px)': { gridTemplateColumns: '1fr' } },
  sidebar: {
    position: 'sticky', top: 0, height: '100dvh', display: 'flex', flexDirection: 'column',
    backgroundColor: '#eaeae5', borderRight: '1px solid #d7d8d2',
    '@media (max-width: 900px)': { display: 'none' },
  },
  brand: { display: 'flex', alignItems: 'center', gap: '9px', minHeight: '52px', ...shorthands.padding('0', '20px'), fontWeight: 700, fontSize: '15px', color: '#20211f' },
  brandMark: {
    display: 'grid', placeItems: 'center', width: '28px', height: '28px', borderRadius: '7px',
    color: '#c84a39', backgroundColor: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.08)',
  },
  nav: { display: 'block', overflowY: 'auto', minHeight: 0, ...shorthands.padding('15px', '12px') },
  navButton: { justifyContent: 'flex-start', width: '100%', height: '36px', marginBottom: '2px' },
  sidebarFooter: { marginTop: 'auto', ...shorthands.padding('12px', '20px'), color: '#676963', fontSize: '11px', borderTop: '1px solid #d6d7d1' },
  main: { minWidth: 0 },
  headerActions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px' },
  content: { maxWidth: '1480px', margin: '0 auto', ...shorthands.padding('24px'), '@media (max-width: 900px)': { paddingTop: '18px', paddingRight: '16px', paddingBottom: '84px', paddingLeft: '16px' } },
  intro: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '24px', marginBottom: '24px', '@media (max-width: 900px)': { alignItems: 'flex-start', flexDirection: 'column' } },
  title: { margin: 0, fontSize: '22px', lineHeight: 1.2, letterSpacing: '-0.02em' },
  subtitle: { margin: '8px 0 0', color: tokens.colorNeutralForeground3, maxWidth: '680px', lineHeight: 1.6 },
  summaryGrid: { display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr', gap: '14px', marginBottom: '14px', '@media (max-width: 900px)': { gridTemplateColumns: '1fr' } },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '9px', ...shorthands.padding('18px'), boxShadow: '0 1px 2px rgba(36,40,42,.035)',
  },
  panelTitle: { display: 'flex', alignItems: 'center', gap: '8px', margin: 0, fontSize: '14px', fontWeight: 650 },
  metric: { marginTop: '18px', fontSize: '34px', fontWeight: 700, letterSpacing: '-0.04em' },
  metricLabel: { marginTop: '4px', color: tokens.colorNeutralForeground3, fontSize: '12px' },
  statusRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginTop: '18px' },
  details: { color: tokens.colorNeutralForeground3, fontSize: '12px', lineHeight: 1.5 },
  workGrid: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(320px, 0.8fr)', gap: '14px', '@media (max-width: 900px)': { gridTemplateColumns: '1fr' } },
  table: { width: '100%', borderCollapse: 'collapse', marginTop: '14px' },
  tableHead: { textAlign: 'left', color: tokens.colorNeutralForeground3, fontSize: '12px', fontWeight: 500 },
  tableCell: { ...shorthands.padding('12px', '8px'), borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  empty: { display: 'grid', placeItems: 'center', minHeight: '220px', color: tokens.colorNeutralForeground3, textAlign: 'center' },
  form: { display: 'grid', gap: '22px', marginTop: '20px' },
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
  agentContent: { width: '100%', height: '100dvh', maxWidth: 'none', margin: 0, ...shorthands.padding('0'), overflow: 'hidden', position: 'relative' },
  agentFrame: { display: 'block', width: '100%', height: '100%', border: 0, backgroundColor: tokens.colorNeutralBackground1 },
  agentFallback: { width: '100%', height: '100%', display: 'grid', placeItems: 'center', textAlign: 'center', ...shorthands.padding('24px'), color: tokens.colorNeutralForeground3 },
  agentError: { position: 'absolute', top: '12px', left: '12px', right: '12px', zIndex: 1, ...shorthands.padding('10px', '12px'), backgroundColor: tokens.colorPaletteRedBackground1, color: tokens.colorPaletteRedForeground1, borderRadius: '6px' },
  mobileNav: {
    display: 'none',
    '@media (max-width: 900px)': {
      position: 'fixed', display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', left: 0, right: 0, bottom: 0,
      zIndex: 10, backgroundColor: tokens.colorNeutralBackground1, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
      paddingTop: '6px', paddingRight: '6px', paddingBottom: '6px', paddingLeft: '6px',
    },
  },
})

const navItems: Array<{ page: Page; label: string; icon: JSX.Element; activeIcon: JSX.Element }> = [
  { page: 'overview', label: '概览', icon: <Home20Regular />, activeIcon: <Home20Filled /> },
  { page: 'agent', label: 'Agent', icon: <Bot20Regular />, activeIcon: <Bot20Filled /> },
  { page: 'tasks', label: '任务', icon: <DocumentData20Regular />, activeIcon: <DocumentData20Filled /> },
  { page: 'skills', label: '技能', icon: <BrainCircuit20Regular />, activeIcon: <BrainCircuit20Filled /> },
  { page: 'nodes', label: '节点', icon: <DesktopPulse20Regular />, activeIcon: <DesktopPulse20Filled /> },
  { page: 'settings', label: '设置', icon: <Settings20Regular />, activeIcon: <Settings20Filled /> },
]

export function App() {
  const styles = useStyles()
  const [page, setPage] = useState<Page>('overview')
  const [dark, setDark] = useState(false)
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [autoDispatches, setAutoDispatches] = useState<AutoDispatchRecord[]>([])
  const [probe, setProbe] = useState<IcepakEnvironmentProbe | null>(null)
  const [icepakCheck, setIcepakCheck] = useState<IcepakSelfCheck>(emptyIcepakCheck)
  const [icepakAutoCheckStarted, setIcepakAutoCheckStarted] = useState(false)
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [authorized, setAuthorized] = useState(!isLanClient)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dshStatus, setDshStatus] = useState<DshStatus>({ phase: 'starting' })
  const [dshSessions, setDshSessions] = useState<DshSession[]>([])
  const [dshError, setDshError] = useState('')
  const [selectedSession, setSelectedSession] = useState('')
  const [archivingSessionId, setArchivingSessionId] = useState('')
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)
  const [historyLimit, setHistoryLimit] = useState(10)
  const [agentAction, setAgentAction] = useState<AgentAction | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [createDraftId, setCreateDraftId] = useState<string | null>(null)

  useEffect(() => { void window.thermalDesktop?.setTitleBarTheme(dark).catch(() => undefined) }, [dark])

  function openTask(taskId: string) { setSelectedTaskId(taskId); setPage('task-detail') }
  function openCreateTask(draftId: string | null = null) { setCreateDraftId(draftId); setPage('task-create') }

  const refreshDsh = useCallback(async () => {
    if (isLanClient) return
    try {
      const response = await fetch('/api/agent/status')
      const body = await response.json() as { agent?: DshStatus; error?: { message?: string } }
      if (!response.ok || !body.agent) throw new Error(body.error?.message ?? 'DSH 状态读取失败')
      setDshStatus(body.agent)
      if (body.agent.phase === 'ready') {
        const sessionsResponse = await fetch('/api/agent/sessions')
        const sessionsBody = await sessionsResponse.json() as { sessions?: DshSession[]; error?: { message?: string } }
        if (!sessionsResponse.ok || !sessionsBody.sessions) throw new Error(sessionsBody.error?.message ?? '会话列表读取失败')
        setDshSessions(sessionsBody.sessions)
      } else setDshSessions([])
      setDshError('')
    } catch (reason) { setDshError(reason instanceof Error ? reason.message : 'DSH 状态读取失败') }
  }, [])

  useEffect(() => {
    if (isLanClient) return
    void refreshDsh()
    const timer = window.setInterval(() => void refreshDsh(), 10_000)
    return () => window.clearInterval(timer)
  }, [refreshDsh])

  function openSession(sessionId: string) {
    setPage('agent')
    setAgentAction({ kind: 'session', sessionId, key: Date.now() })
  }

  async function newSession() {
    try {
      const response = await fetch('/api/agent/sessions', { method: 'POST' })
      const body = await response.json() as { sessionId?: string; error?: { message?: string } }
      if (!response.ok || !body.sessionId) throw new Error(body.error?.message ?? '新建对话失败')
      await refreshDsh()
      openSession(body.sessionId)
    } catch (reason) { setDshError(reason instanceof Error ? reason.message : '新建对话失败') }
  }

  async function archiveSession(sessionId: string) {
    setArchiveBusy(true)
    try {
      const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/archive`, { method: 'POST' })
      if (!response.ok) throw new Error('归档对话失败')
      if (selectedSession === sessionId) setSelectedSession('')
      setArchivingSessionId('')
      await refreshDsh()
    } catch (reason) { setDshError(reason instanceof Error ? reason.message : '归档对话失败') }
    finally { setArchiveBusy(false) }
  }

  const finishAgentAction = useCallback((sessionId?: string) => {
    if (sessionId) setSelectedSession(sessionId)
    setAgentAction(null)
  }, [])

  const refresh = useCallback(async () => {
    if (!authorized) return
    setLoading(true)
    setError('')
    try {
      const [tasksResponse, probeResponse, skillsResponse, autoResponse] = await Promise.all([
        fetch('/api/tasks'), fetch('/api/plugins/icepak/probe'), fetch('/api/skills'),
        isLanClient ? Promise.resolve(null) : fetch('/api/auto-dispatch'),
      ])
      if (!tasksResponse.ok || !probeResponse.ok || !skillsResponse.ok || (autoResponse && !autoResponse.ok)) throw new Error('本地 Core 暂时无法返回完整状态')
      const tasksBody = await tasksResponse.json() as { tasks: TaskRecord[] }
      const probeBody = await probeResponse.json() as { probe: IcepakEnvironmentProbe }
      const skillsBody = await skillsResponse.json() as { skills: SkillRecord[] }
      setTasks(tasksBody.tasks)
      setAutoDispatches(autoResponse ? ((await autoResponse.json()) as { requests: AutoDispatchRecord[] }).requests : [])
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
      <div className={`${styles.shell} ${dark ? 'theme-dark' : 'theme-light'} ${window.thermalDesktop ? 'desktop-shell' : ''} ${window.thermalDesktop?.platform === 'darwin' ? 'desktop-mac' : ''}`}>
        <aside className={styles.sidebar}>
          {window.thermalDesktop?.platform === 'darwin' && <div className="desktop-title-drag" aria-hidden="true" />}
            <div className={`${styles.brand} app-brand`}><span className={styles.brandMark}><img src="/logo.svg" alt="" width="24" height="24" /></span>Thermal Agent</div>
          <nav className={`${styles.nav} shell-nav`} aria-label="主导航">
            <div className="nav-group-label">工作空间</div>
            {navItems.filter(item => item.page !== 'settings').map(item => <div key={item.page} className={item.page === 'agent' ? 'agent-nav-row' : undefined}>
              <Button className={`${styles.navButton} ${(page === item.page || item.page === 'tasks' && (page === 'task-create' || page === 'task-detail')) ? 'nav-active' : ''}`} appearance="subtle" icon={(page === item.page || item.page === 'tasks' && (page === 'task-create' || page === 'task-detail')) ? item.activeIcon : item.icon} aria-current={page === item.page ? 'page' : undefined} onClick={() => setPage(item.page)}>{item.label}</Button>
              {item.page === 'agent' && !isLanClient && window.thermalDesktop && <>
                <div className="agent-nav-actions">
                  <button type="button" title="新建对话" aria-label="新建对话" disabled={dshStatus.phase !== 'ready'} onClick={() => void newSession()}><Add20Regular /></button>
                  <button type="button" title={historyOpen ? '收起对话记录' : '展开对话记录'} aria-label={historyOpen ? '收起对话记录' : '展开对话记录'} aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>{historyOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />}</button>
                </div>
                {historyOpen && <div className="chat-session-menu" aria-label="对话记录">
                  {dshStatus.phase !== 'ready' ? <div className="chat-session-hint">DSH 就绪后显示对话</div>
                    : dshSessions.length === 0 ? <div className="chat-session-hint">暂无对话记录</div>
                      : <>{dshSessions.slice(0, historyLimit).map(session => <div key={session.sessionId}>
                        <div className={`chat-session-row ${selectedSession === session.sessionId ? 'selected' : ''}`}>
                        <button className="chat-session-item" type="button" title={session.title} onClick={() => openSession(session.sessionId)}><Chat20Regular /><span>{session.title}</span></button>
                        <button className="chat-session-archive" type="button" title={`归档 ${session.title}`} aria-label={`归档 ${session.title}`} disabled={archiveBusy} onClick={() => setArchivingSessionId(session.sessionId)}><Archive16Regular /></button>
                        </div>
                        {archivingSessionId === session.sessionId && <div className="chat-session-confirm"><span>从列表移除？DSH 原始对话仍会保留。</span><div><button type="button" disabled={archiveBusy} onClick={() => setArchivingSessionId('')}>取消</button><button type="button" disabled={archiveBusy} onClick={() => void archiveSession(session.sessionId)}>{archiveBusy ? '归档中…' : '确认归档'}</button></div></div>}
                      </div>)}{dshSessions.length > historyLimit && <button className="chat-load-more" type="button" onClick={() => setHistoryLimit(value => value + 10)}>加载更多 · 还有 {dshSessions.length - historyLimit} 条</button>}</>}
                </div>}
              </>}
            </div>)}
            <div className="nav-group-label system-label">系统</div>
            <Button className={`${styles.navButton} ${page === 'settings' ? 'nav-active' : ''}`} appearance="subtle" icon={page === 'settings' ? <Settings20Filled /> : <Settings20Regular />} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}>设置</Button>
          </nav>
          {dshError && <div className="sidebar-error" role="alert" title={dshError}>{dshError}</div>}
          <div className={styles.sidebarFooter}><span className={`status-light ${isLanClient ? 'stopped' : dshStatus.phase}`} /> <strong>{isLanClient ? 'LAN Web' : `DSH ${dshStatus.phase.toUpperCase()}`}</strong><div className="footer-note">{isLanClient ? 'Agent 对话仅在主机 App 开放' : '数据保存在本机 · 局域网默认关闭'}</div></div>
        </aside>
        <main className={styles.main}>
          {window.thermalDesktop && <div className="desktop-title-drag desktop-main-title" aria-hidden="true"><span>{navItems.find(item => item.page === (page === 'task-create' || page === 'task-detail' ? 'tasks' : page))?.label ?? '工作台'}</span></div>}
          <div className={page === 'agent' ? `${styles.agentContent} ${window.thermalDesktop ? 'desktop-agent-content' : ''}` : styles.content}>
            {page === 'overview' && <Overview styles={styles} tasks={tasks} activeCount={activeTasks.length} completedCount={completedTasks.length} probe={probe} loading={loading} error={error} onOpenTask={openTask} onCreateTask={() => openCreateTask()} />}
            {page === 'agent' && <AgentWorkspace styles={styles} status={dshStatus} action={agentAction} onActionDone={finishAgentAction} onStatusChanged={refreshDsh} />}
            {page === 'tasks' && <TaskList styles={styles} tasks={tasks} loading={loading} onOpenTask={openTask} onCreateTask={() => openCreateTask()} />}
            {page === 'task-create' && <CreateTaskPanel key={createDraftId ?? 'new'} styles={styles} tasks={tasks} initialDraftId={createDraftId} onCreated={async taskId => { await refresh(); openTask(taskId) }} onCancel={() => setPage('tasks')} />}
            {page === 'task-detail' && selectedTaskId && <TaskDetail key={selectedTaskId} styles={styles} taskId={selectedTaskId} task={tasks.find(item => item.id === selectedTaskId) ?? null} autoDispatch={autoDispatches.find(item => item.taskId === selectedTaskId)} onBack={() => setPage('tasks')} onEdit={() => openCreateTask(selectedTaskId)} onChanged={refresh} />}
            {page === 'skills' && <SkillLibrary styles={styles} skills={skills} onChanged={refresh} />}
            {page === 'nodes' && <NodeWorkspace styles={styles} />}
            {page === 'settings' && <><div className={styles.intro}><div><h1 className={styles.title}>设置</h1><p className={styles.subtitle}>模型与 Agent 预设由 DSH 管理；网络发布与 Icepak 验证保留在 App 中。</p></div></div><div className={styles.panel} style={{ marginBottom: 14 }}><h2 className={styles.panelTitle}>界面与状态</h2><div className={styles.headerActions}><Badge appearance="outline" color={probe?.status === 'READY' ? 'success' : 'informative'}>{probe ? `Icepak ${probe.status}` : '正在探测'}</Badge><Button icon={<ArrowClockwise20Regular />} onClick={() => void refresh()}>刷新状态</Button><Button icon={dark ? <WeatherSunny20Regular /> : <WeatherMoon20Regular />} onClick={() => setDark(value => !value)}>{dark ? '浅色外观' : '深色外观'}</Button></div></div><div className={styles.panel} style={{ marginBottom: 14 }}><h2 className={styles.panelTitle}>App 工作空间</h2><p className={styles.details}>DSH Agent 与 App 使用同一个工作空间；每个任务位于其 tasks 子目录。工作空间由 App 管理，不能在 DSH 中单独修改。</p><code>{dshStatus.workspacePath ?? '正在准备本地工作空间'}</code></div><div className={styles.panel} style={{ marginBottom: 14 }}><h2 className={styles.panelTitle}><Bot20Regular />DSH 原生设置</h2><p className={styles.details}>模型、API 密钥、Agent 预设与插件直接写入当前本机 DSH Profile。</p><Button disabled={isLanClient || dshStatus.phase !== 'ready' || !window.thermalDesktop} onClick={() => { setPage('agent'); setAgentAction({ kind: 'settings', key: Date.now() }) }}>打开 DSH 设置</Button></div><LanSettings styles={styles} /><IcepakSettings styles={styles} probe={probe} onProbeUpdated={setProbe} check={icepakCheck} onCheckUpdated={setIcepakCheck} autoRun={!icepakAutoCheckStarted} onAutoRunStarted={() => setIcepakAutoCheckStarted(true)} /></>}
          </div>
        </main>
      </div>
      <nav className={styles.mobileNav} aria-label="移动端导航">
        {navItems.map(item => <Button key={item.page} appearance={page === item.page ? 'primary' : 'subtle'} icon={page === item.page ? item.activeIcon : item.icon} aria-label={item.label} onClick={() => setPage(item.page)} />)}
      </nav>
    </FluentProvider>
  )
}

function Overview({ styles, tasks, activeCount, completedCount, probe, loading, error, onOpenTask, onCreateTask }: {
  styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; activeCount: number; completedCount: number
  probe: IcepakEnvironmentProbe | null; loading: boolean; error: string; onOpenTask(taskId: string): void; onCreateTask(): void
}) {
  return <>
    <div className={styles.intro}><div><h1 className={styles.title}>散热仿真工作台</h1><p className={styles.subtitle}>从需求和模型开始，在任务详情中确认方案、推进求解并复核结果。</p></div><Button appearance="primary" icon={<Add20Regular />} onClick={onCreateTask}>新建任务</Button></div>
    <section className={styles.summaryGrid} aria-label="运行摘要">
      <div className={styles.panel}><h2 className={styles.panelTitle}><DocumentData20Regular />任务队列</h2><div className={styles.metric}>{activeCount}</div><div className={styles.metricLabel}>个任务正在准备或执行</div></div>
      <div className={styles.panel}><h2 className={styles.panelTitle}><DesktopPulse20Regular />Icepak 能力</h2><div className={styles.statusRow}><Badge color={probe?.status === 'READY' ? 'success' : 'warning'}>{probe?.status ?? 'CHECKING'}</Badge></div><p className={styles.details}>{probe?.diagnostics[0] ?? '正在读取插件证据'}</p></div>
      <div className={styles.panel}><h2 className={styles.panelTitle}><DocumentData20Regular />已完成</h2><div className={styles.metric}>{completedCount}</div><div className={styles.metricLabel}>个任务已形成完整结果</div></div>
    </section>
    <TaskPanel styles={styles} tasks={tasks} loading={loading} error={error} onOpenTask={onOpenTask} />
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

function AgentWorkspace({ styles, status, action, onActionDone, onStatusChanged }: {
  styles: ReturnType<typeof useStyles>; status: DshStatus; action: AgentAction | null
  onActionDone(sessionId?: string): void; onStatusChanged(): Promise<void>
}) {
  const [error, setError] = useState('')
  const [restarting, setRestarting] = useState(false)
  const [frameReady, setFrameReady] = useState(false)

  useEffect(() => { setFrameReady(false) }, [status.url])

  useEffect(() => {
    if (!action || !frameReady || !window.thermalDesktop) return
    let cancelled = false
    void (async () => {
      try {
        if (action.kind === 'session') await window.thermalDesktop!.openDshSession(action.sessionId)
        else await window.thermalDesktop!.openDshSettings()
        if (!cancelled) { setError(''); onActionDone(action.kind === 'session' ? action.sessionId : undefined) }
      } catch (reason) {
        if (!cancelled) { setError(reason instanceof Error ? reason.message : 'DSH 操作失败'); onActionDone() }
      }
    })()
    return () => { cancelled = true }
  }, [action, frameReady, onActionDone])

  async function restart() {
    setRestarting(true); setError('')
    try {
      const response = await fetch('/api/agent/restart', { method: 'POST' })
      if (!response.ok) throw new Error('DSH Host 重启失败')
      await onStatusChanged()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'DSH Host 重启失败')
    } finally { setRestarting(false) }
  }

  if (isLanClient) return <div className={styles.agentFallback}><div><Bot20Regular fontSize={28} /><p>DSH 对话仅在安装 App 的本机桌面开放。局域网浏览器可查看和管理结构化 Task、Skill 与仿真结果。</p></div></div>
  return <>
    {status.phase === 'ready' && status.url
      ? <iframe className={styles.agentFrame} src={status.url} title="Thermal Agent DSH 对话" onLoad={() => { void window.thermalDesktop?.styleDshFrame().catch(() => undefined).finally(() => setFrameReady(true)); if (!window.thermalDesktop) setFrameReady(true) }} />
      : <div className={styles.agentFallback}><div><Spinner label={status.detail ?? '正在启动 DSH Host'} /><p className={styles.details}>{status.workspacePath ?? '正在准备本地工作目录'}</p><Button disabled={restarting} onClick={() => void restart()}>{restarting ? '重启中' : '重启运行时'}</Button></div></div>}
    {error && <div className={styles.agentError} role="alert">{error}</div>}
  </>
}

function TaskPanel({ styles, tasks, loading, error, onOpenTask }: { styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; loading: boolean; error: string; onOpenTask(taskId: string): void }) {
  return <div className={styles.panel}><h2 className={styles.panelTitle}>最近任务</h2>{loading ? <div className={styles.empty}><Spinner label="正在读取本地任务" /></div> : error ? <p className={styles.error}>{error}</p> : tasks.length === 0 ? <div className={styles.empty}><div><DocumentData20Regular fontSize={28} /><p>还没有任务。请从“新建任务”开始记录需求。</p></div></div> : <TaskTable styles={styles} tasks={tasks.slice(0, 8)} onOpenTask={onOpenTask} />}</div>
}

function TaskList({ styles, tasks, loading, onOpenTask, onCreateTask }: { styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; loading: boolean; onOpenTask(taskId: string): void; onCreateTask(): void }) {
  return <><div className={styles.intro}><div><h1 className={styles.title}>任务</h1><p className={styles.subtitle}>选择任务查看需求、AI 建议、专家确认和 Icepak 执行证据。</p></div><Button appearance="primary" icon={<Add20Regular />} onClick={onCreateTask}>新建任务</Button></div><div className={styles.panel}>{loading ? <Spinner label="正在加载任务" /> : tasks.length ? <TaskTable styles={styles} tasks={tasks} onOpenTask={onOpenTask} /> : <div className={styles.empty}>当前没有任务。点击“新建任务”开始。</div>}</div></>
}

function TaskTable({ styles, tasks, onOpenTask }: { styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; onOpenTask(taskId: string): void }) {
  return <div style={{ overflowX: 'auto' }}><table className={styles.table}><thead className={styles.tableHead}><tr><th className={styles.tableCell}>任务</th><th className={styles.tableCell}>模型</th><th className={styles.tableCell}>执行状态</th><th className={styles.tableCell}>热判定</th><th className={styles.tableCell}>审批</th></tr></thead><tbody>{tasks.map(task => <tr key={task.id}><td className={styles.tableCell}><Button appearance="transparent" className="task-title-link" onClick={() => onOpenTask(task.id)}>{task.title}</Button><div className={styles.details}>{task.description || '尚未填写详细需求'}</div></td><td className={styles.tableCell}>{String(task.requirementSnapshot.modelOriginalName ?? '待上传')}</td><td className={styles.tableCell}><Badge appearance="outline">{task.executionStatus}</Badge></td><td className={styles.tableCell}>{task.thermalVerdict}</td><td className={styles.tableCell}>{task.approvalStatus}</td></tr>)}</tbody></table></div>
}

interface TaskDetailResponse {
  task: TaskRecord
  runs: Array<RunRecord & { attempts: Array<AttemptRecord & { artifacts: AttemptArtifactRecord[]; resultSummary: { tmaxC: number | null; converged: boolean | null } | null }> }>
  events: TaskEvent[]
}

function TaskDetail({ styles, taskId, task, autoDispatch, onBack, onEdit, onChanged }: {
  styles: ReturnType<typeof useStyles>; taskId: string; task: TaskRecord | null; autoDispatch?: AutoDispatchRecord
  onBack(): void; onEdit(): void; onChanged(): Promise<void>
}) {
  const [detail, setDetail] = useState<TaskDetailResponse | null>(null)
  const [error, setError] = useState('')
  const [noteAuthor, setNoteAuthor] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  useEffect(() => {
    let active = true
    void fetch(`/api/tasks/${taskId}`).then(async response => {
      const body = await response.json() as TaskDetailResponse & { error?: { message?: string } }
      if (!response.ok || !body.task) throw new Error(body.error?.message ?? '任务详情读取失败')
      if (active) { setDetail(body); setError('') }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : '任务详情读取失败') })
    return () => { active = false }
  }, [taskId, task?.version])
  async function addNote(event: FormEvent) {
    event.preventDefault(); setSavingNote(true); setError('')
    try {
      const response = await fetch(`/api/tasks/${taskId}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: noteAuthor, content: noteContent }) })
      const body = await response.json() as { event?: TaskEvent; error?: { message?: string } }
      if (!response.ok || !body.event) throw new Error(body.error?.message ?? '补充记录保存失败')
      setDetail(current => current ? { ...current, events: [...current.events, body.event as TaskEvent] } : current)
      setNoteContent('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '补充记录保存失败') }
    finally { setSavingNote(false) }
  }
  const current = detail?.task ?? task
  if (!current) return <div className={styles.panel}>{error || '正在读取任务详情'}</div>
  const snapshot = current.requirementSnapshot
  const attachments = Array.isArray(snapshot.conversationAttachments) ? snapshot.conversationAttachments.filter((item): item is { originalName: string; sizeBytes: number; taskPath: string } =>
    !!item && typeof item === 'object' && typeof item.originalName === 'string' && typeof item.taskPath === 'string' && typeof item.sizeBytes === 'number') : []
  const suggestions = Array.isArray(snapshot.optimizationSuggestions) ? snapshot.optimizationSuggestions as OptimizationRecommendation[] : []
  const selectedIds = Array.isArray(snapshot.selectedOptimizationSkillIds) ? snapshot.selectedOptimizationSkillIds.filter((id): id is string => typeof id === 'string') : []
  const assessment = snapshot.capabilityAssessment && typeof snapshot.capabilityAssessment === 'object' ? snapshot.capabilityAssessment as ModelCapabilityAssessment : null
  const textValue = (key: string) => typeof snapshot[key] === 'string' && String(snapshot[key]).trim() ? String(snapshot[key]) : '未填写'
  const selectedNames = selectedIds.map(id => suggestions.find(item => item.skillId === id)?.name ?? id)
  return <div className="task-detail-page">
    <div className="task-detail-top"><Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={onBack}>返回任务列表</Button><span className={styles.details}>创建于 {new Date(current.createdAt).toLocaleString('zh-CN')}</span></div>
    <div className={styles.intro}><div><h1 className={styles.title}>{current.title}</h1><p className={styles.subtitle}>{current.description || '尚未填写详细散热需求'}</p></div><div className={styles.headerActions}><Badge appearance="outline">{current.executionStatus}</Badge>{current.executionStatus === 'DRAFT' && <Button appearance="primary" icon={<Edit20Regular />} onClick={onEdit}>继续完善需求</Button>}</div></div>
    <div className="task-detail-layout">
      <div className="task-detail-main">
        <section className="task-detail-section"><h2>需求输入</h2><div className="task-detail-fields">
          <div><span>客户</span><strong>{textValue('customer')}</strong></div><div><span>项目</span><strong>{textValue('projectName')}</strong></div>
          <div><span>产品型号</span><strong>{textValue('productModel')}</strong></div><div><span>工况</span><strong>{textValue('workCondition')}</strong></div>
          <div><span>最高温度目标</span><strong>{typeof snapshot.targetTmaxC === 'number' ? `${snapshot.targetTmaxC} °C` : '待填写'}</strong></div><div><span>模型文件</span><strong>{textValue('modelOriginalName')}</strong></div>
          <div><span>关键监测点</span><strong>{textValue('criticalPoints')}</strong></div><div><span>可调整范围</span><strong>{textValue('adjustmentBounds')}</strong></div>
        </div><p className={styles.details}>任务工作目录：{textValue('taskWorkspacePath')}</p>{attachments.length > 0 && <div className="task-detail-list">{attachments.map((item, index) => <div key={`${item.taskPath}:${index}`}><strong>{item.originalName}</strong><span>{(item.sizeBytes / 1024 / 1024).toFixed(2)} MB</span><small>已从 Agent 会话归档到本任务：{item.taskPath}</small></div>)}</div>}</section>
        <section className="task-detail-section"><h2>模型能力</h2>{assessment ? <><p className={styles.details}>{assessment.modelKind === 'CAD' ? 'CAD 已归档，需建立 Icepak 工程后再判断可执行动作。' : assessment.status === 'READY_FOR_BASELINE' ? `工程 ${assessment.projectName ?? ''} 已通过 Baseline 前检查。` : assessment.diagnostics.join('；')}</p><div className="task-detail-list">{assessment.items.map(item => <div key={item.skillKey}><strong>{capabilityNames[item.skillKey] ?? item.skillKey}</strong><span>{capabilityStatuses[item.status]}</span><small>目标：{item.targetNames.join('、') || '未识别'}。{item.reason}</small></div>)}</div><ParameterCatalogView styles={styles} assessment={assessment} /></> : <p className={styles.details}>尚未完成模型能力检查。</p>}</section>
        <section className="task-detail-section"><h2>AI / 规则初筛建议</h2><p className={styles.details}>根据需求关键词给出排查方向，尚未用 Baseline 结果验证物理诊断。</p>{suggestions.length ? <div className="task-detail-list">{suggestions.map(item => <div key={item.skillId}><strong>{item.name}</strong><span>待仿真验证</span><small>命中依据：{item.matchedSignals.join('、') || '默认排查'}。{item.guidance.diagnosticBasis}</small></div>)}</div> : <p className={styles.details}>当前任务没有保存候选建议。旧任务可能只保存了简要匹配记录。</p>}</section>
        <section className="task-detail-section"><h2>人工确认与补充</h2><p>{snapshot.planConfirmed === true ? '方案已人工确认' : '方案尚待人工确认'}</p><div className="task-detail-list">{selectedNames.length ? selectedNames.map((name, index) => <div key={`${selectedIds[index]}:${index}`}><strong>{name}</strong><small>{snapshot.autoFanRatio && selectedIds[index] === snapshot.fanSkillId ? '已授权 Baseline 失败后尝试一次风扇 +10%' : '确认纳入本任务的方案范围；不代表已具备自动修改能力'}</small></div>) : <p className={styles.details}>尚未选定优化方案；仍可先执行 Baseline 以获得诊断证据。</p>}</div><div className="task-expert-note"><span>人工补充建议 / 约束</span><p>{textValue('expertSupplement')}</p></div></section>
        <section className="task-detail-section"><h2>Icepak 模拟与结果</h2>{detail?.runs.length ? <div className="task-detail-list">{detail.runs.map(run => <div key={run.id}><strong>{run.kind} #{run.sequence}</strong><span>{run.status}</span>{run.attempts.map(attempt => <small key={attempt.id}>尝试 {attempt.id.slice(0, 8)}：{attempt.status}{attempt.resultSummary?.tmaxC != null ? `，最高温度 ${attempt.resultSummary.tmaxC} °C` : ''}{attempt.resultSummary?.converged != null ? `，${attempt.resultSummary.converged ? '已收敛' : '未收敛'}` : ''}，执行节点 {attempt.executorNodeId.slice(0, 8)}，证据 {attempt.artifacts.map(artifact => artifact.role).join('、') || '待生成'}{attempt.errorMessage ? `；${attempt.errorMessage}` : ''}</small>)}</div>)}</div> : <p className={styles.details}>尚无求解记录。任务确认后可启动 Baseline；求解完成后结果会回写到本任务。</p>}</section>
        <section className="task-detail-section"><h2>任务推进记录</h2>{detail?.events.length ? <div className="task-detail-timeline">{detail.events.map(event => <div key={event.id}><time>{new Date(event.createdAt).toLocaleString('zh-CN')}</time><strong>{event.eventType === 'task.note_added' ? `人工补充：${String(event.payload.author ?? '')}` : event.eventType}</strong><span>{event.eventType === 'task.note_added' ? String(event.payload.content ?? '') : event.reason || [event.fromStatus, event.toStatus].filter(Boolean).join(' → ')}</span></div>)}</div> : <p className={styles.details}>暂无推进记录。</p>}<form className="task-detail-note-form" onSubmit={addNote}><Field label="记录人" required><Input value={noteAuthor} maxLength={100} onChange={(_, data) => setNoteAuthor(data.value)} /></Field><Field label="补充建议或下一步判断" hint="追加到任务时间线，不会自动改模或启动求解。" required><Textarea value={noteContent} maxLength={2000} onChange={(_, data) => setNoteContent(data.value)} /></Field><Button type="submit" icon={<Save20Regular />} disabled={savingNote || !noteAuthor.trim() || !noteContent.trim()}>{savingNote ? '保存中' : '追加记录'}</Button></form></section>
      </div>
      <aside className="task-detail-aside"><div className={styles.panel}><h2 className={styles.panelTitle}>当前状态与下一步</h2><div className="task-detail-status"><span>执行</span><strong>{current.executionStatus}</strong><span>热判定</span><strong>{current.thermalVerdict}</strong><span>人工审批</span><strong>{current.approvalStatus}</strong></div><TaskAction styles={styles} task={current} autoDispatch={autoDispatch} onChanged={onChanged} /></div></aside>
    </div>{error && <p className={styles.error}>{error}</p>}
  </div>
}

function TaskAction({ styles, task, autoDispatch, onChanged }: { styles: ReturnType<typeof useStyles>; task: TaskRecord; autoDispatch?: AutoDispatchRecord; onChanged(): Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const projectPath = typeof task.requirementSnapshot.projectPath === 'string' ? task.requirementSnapshot.projectPath : ''
  async function act(kind: 'confirm' | 'baseline' | 'remote-baseline' | 'auto-baseline' | 'cancel-auto' | 'retry-offer' | 'candidate' | 'retry' | 'skill' | 'report' | 'approve' | 'reject') {
    setBusy(true); setError(''); setNotice('')
    try {
      let response: Response
      if (kind === 'auto-baseline') {
        response = await fetch(`/api/tasks/${task.id}/auto-dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedVersion: task.version, projectPath, version: task.requirementSnapshot.aedtVersion ?? '2024.2',
            cores: task.requirementSnapshot.cores ?? 4 }) })
      } else if (kind === 'cancel-auto') {
        response = await fetch(`/api/tasks/${task.id}/auto-dispatch`, { method: 'DELETE' })
      } else if (kind === 'remote-baseline' || kind === 'retry-offer') {
        let retryExecutorNodeId = task.executorNodeId
        if (kind === 'retry-offer' && !retryExecutorNodeId) {
          const detailResponse = await fetch(`/api/tasks/${task.id}`)
          const detail = await detailResponse.json() as { runs?: Array<{ attempts: Array<{ executorNodeId: string }> }> }
          if (!detailResponse.ok) throw new Error('无法读取待重发任务的执行节点')
          retryExecutorNodeId = detail.runs?.at(-1)?.attempts.at(-1)?.executorNodeId ?? null
        }
        const discoveryResponse = await fetch('/api/nodes/discovery')
        const discoveryBody = await discoveryResponse.json() as { discovery?: DiscoveryStatus; error?: { message?: string } }
        if (!discoveryResponse.ok || !discoveryBody.discovery) throw new Error(discoveryBody.error?.message ?? '无法查询空闲计算节点')
        const version = String(task.requirementSnapshot.aedtVersion ?? '2024.2')
        const candidates = discoveryBody.discovery.discovered.filter(peer => peer.trusted && peer.heartbeat.pluginStatus === 'READY' &&
          peer.heartbeat.activeAttempts < peer.heartbeat.maxConcurrent && peer.heartbeat.aedtVersions.includes(version))
          .sort((a, b) => a.heartbeat.activeAttempts - b.heartbeat.activeAttempts)
        const peer = kind === 'retry-offer'
          ? discoveryBody.discovery.discovered.find(item => item.identity.nodeId === retryExecutorNodeId && item.trusted)
          : candidates[0]
        if (!peer) throw new Error(kind === 'retry-offer' ? '原执行节点当前不可发现或已撤销信任' : '当前没有 READY 且空闲的兼容 Icepak 节点')
        response = await fetch(`/api/tasks/${task.id}/runs/remote-baseline${kind === 'retry-offer' ? '/retry-offer' : ''}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ peerNodeId: peer.identity.nodeId, expectedVersion: task.version,
            ...(kind === 'remote-baseline' ? { projectPath, version, cores: task.requirementSnapshot.cores ?? 4 } : {}) }),
        })
      } else response = kind === 'confirm'
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
      const body = await response.json() as { delivered?: boolean; deliveryError?: string; error?: { message?: string } }
      if (!response.ok) throw new Error(body.error?.message ?? '操作未完成')
      if (kind === 'report') window.open(`/api/tasks/${task.id}/report`, '_blank', 'noopener,noreferrer')
      if (kind === 'remote-baseline' || kind === 'retry-offer') {
        setNotice(body.delivered ? '执行节点已接收任务，将自动下载输入并启动受管求解。' : `Offer 未被接收，可稍后重发：${body.deliveryError ?? '节点暂时不可用'}`)
      }
      await onChanged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作未完成') }
    finally { setBusy(false) }
  }
  if (task.executionStatus === 'DRAFT' && task.requirementSnapshot.intakeVersion === 2) return <p className={styles.details}>{task.requirementSnapshot.modelKind === 'CAD' ? 'CAD 已归档。请完善 Icepak 工程后，点击上方“继续完善需求”上传 .aedt。' : '请点击上方“继续完善需求”，核对模型能力并确认方案。'}</p>
  if (task.executionStatus === 'DRAFT') return <div><Button size="small" icon={<Checkmark20Regular />} disabled={!projectPath || busy} onClick={() => void act('confirm')}>确认需求</Button>{!projectPath && <div className={styles.error}>缺少工程路径</div>}{error && <div className={styles.error}>{error}</div>}</div>
  if (task.executionStatus === 'READY' && autoDispatch?.status === 'WAITING') return <div><Badge appearance="outline">等待兼容空闲节点</Badge> <Button size="small" icon={<Stop20Regular />} disabled={busy} onClick={() => void act('cancel-auto')}>撤销自动派发</Button>{autoDispatch.errorMessage && <div className={styles.details}>{autoDispatch.errorMessage}</div>}{error && <div className={styles.error}>{error}</div>}</div>
  if (task.executionStatus === 'READY') return <div><div className={styles.headerActions}><Button size="small" icon={<Play20Regular />} appearance="primary" disabled={!projectPath || busy} onClick={() => void act('baseline')}>{busy ? '启动中' : '本机 Baseline'}</Button>{!isLanClient && <><Button size="small" icon={<Send20Regular />} disabled={!projectPath || busy} onClick={() => void act('remote-baseline')}>派发到空闲节点</Button><Button size="small" icon={<Send20Regular />} disabled={!projectPath || busy} onClick={() => void act('auto-baseline')}>授权自动派发</Button></>}</div>{autoDispatch?.status === 'FAILED' && <div className={styles.error}>自动派发失败：{autoDispatch.errorMessage}</div>}{notice && <div className={styles.details}>{notice}</div>}{error && <div className={styles.error}>{error}</div>}</div>
  if ((task.executionStatus === 'QUEUED' || task.executionStatus === 'LEASED') && !isLanClient) return autoDispatch?.status === 'WAITING' || autoDispatch?.status === 'DELIVERED'
    ? <span className={styles.details}>{autoDispatch.status === 'DELIVERED' ? '自动派单已送达，等待执行节点处理' : '自动重试远程 Offer 中'}</span>
    : <div><Button size="small" icon={<ArrowClockwise20Regular />} disabled={busy} onClick={() => void act('retry-offer')}>{busy ? '重发中' : '重发远程 Offer'}</Button>{notice && <div className={styles.details}>{notice}</div>}{error && <div className={styles.error}>{error}</div>}</div>
  if (task.executionStatus === 'WAITING_FOR_APPROVAL') {
    const selected = task.requirementSnapshot.selectedOptimizationSkillIds
    const fanAllowed = task.requirementSnapshot.intakeVersion !== 2 ||
      (Array.isArray(selected) && selected.some(id => typeof id === 'string' && id === task.requirementSnapshot.fanSkillId))
    return <div><div className={styles.headerActions}><Button size="small" icon={<Checkmark20Regular />} appearance="primary" disabled={busy} onClick={() => void act('approve')}>接受结果</Button>{task.thermalVerdict === 'FAIL' && fanAllowed && <Button size="small" icon={<Play20Regular />} disabled={busy} onClick={() => void act('candidate')}>批准风扇 +10%</Button>}<Button size="small" icon={<Dismiss20Regular />} disabled={busy} onClick={() => void act('reject')}>拒绝并升级</Button></div>{error && <div className={styles.error}>{error}</div>}</div>
  }
  if (task.executionStatus === 'COMPLETED') return <div><div className={styles.headerActions}><Button size="small" icon={<DocumentPdf20Regular />} disabled={busy} onClick={() => void act('report')}>{busy ? '生成中' : '查看 PDF 报告'}</Button><Button size="small" icon={<DocumentAdd20Regular />} disabled={busy} onClick={() => void act('skill')}>沉淀 Skill 草稿</Button></div>{error && <div className={styles.error}>{error}</div>}</div>
  if (task.executionStatus === 'FAILED' || task.executionStatus === 'CANCELLED') return <div><Button size="small" icon={<ArrowClockwise20Regular />} disabled={busy} onClick={() => void act('retry')}>{busy ? '重试中' : '重试最近 Run'}</Button>{error && <div className={styles.error}>{error}</div>}</div>
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
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null)

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
    <div className={styles.intro}><div><h1 className={styles.title}>散热技能库</h1><p className={styles.subtitle}>优化策略可新建和版本化修改，也可让 Agent 根据对话创建；已验证执行流程仍需证据与人工审核。</p></div><Button appearance="primary" onClick={() => setEditorMode('create')}>新建策略 Skill</Button></div>
    {skills.length === 0 ? <div className={styles.panel}><div className={styles.empty}><div><BrainCircuit20Regular fontSize={28} /><p>暂无 Skill。请先从具备完整证据的已完成任务沉淀草稿。</p></div></div></div> :
      <section className={styles.skillGrid}>
        <div className={styles.panel}><h2 className={styles.panelTitle}>技能</h2><div className={styles.skillList}>{skills.map(skill => <Button key={skill.id} className={styles.skillButton} appearance={selectedId === skill.id && !editorMode ? 'primary' : 'subtle'} onClick={() => { setEditorMode(null); setSelectedId(skill.id) }}><span>{skill.name}</span><Badge appearance="outline">{skill.kind === 'OPTIMIZATION' ? '策略方案' : skill.status}</Badge></Button>)}</div></div>
        <div className={styles.panel}>{editorMode ? <OptimizationSkillEditor key={editorMode === 'create' ? 'create' : `edit-${detail?.id}-${detail?.activeVersion}`} styles={styles} detail={editorMode === 'edit' ? detail : null} onCancel={() => setEditorMode(null)} onSaved={async skill => { setEditorMode(null); setSelectedId(skill.id); setDetail(skill); await onChanged() }} /> : detail ? <>
          <div className={styles.statusRow}><div><h2 className={styles.panelTitle}>{detail.name}</h2><p className={styles.details}>{detail.description}</p></div><Badge color={detail.kind === 'OPTIMIZATION' ? 'informative' : detail.status === 'ENABLED' ? 'success' : detail.status === 'DRAFT' ? 'warning' : 'informative'}>{detail.kind === 'OPTIMIZATION' ? '策略 Skill' : detail.status}</Badge></div>
          {detail.kind === 'OPTIMIZATION' && <div className={styles.headerActions}><Button onClick={() => setEditorMode('edit')}>修改此策略</Button><span className={styles.details}>版本 v{detail.activeVersion} · 修改后仍仅用于建议，不会自动求解</span></div>}
          {detail.version.definition.optimization && <div className={styles.section}>
            <p className={styles.details}>优化顺序：{detail.version.definition.optimization.priority}　·　降温幅度是用户提供的经验估计，不能作为仿真结果或保证值。</p>
            <div className={styles.resultGrid}>
              <div className={styles.resultItem}><div className={styles.details}>核心物理机理</div><div className={styles.resultValue}>{detail.version.definition.optimization.mechanism}</div></div>
              <div className={styles.resultItem}><div className={styles.details}>诊断依据</div><div className={styles.resultValue}>{detail.version.definition.optimization.diagnosticBasis}</div></div>
              <div className={styles.resultItem}><div className={styles.details}>优化方向 / 措施</div><div className={styles.resultValue}>{detail.version.definition.optimization.measure}</div></div>
              <div className={styles.resultItem}><div className={styles.details}>预期降温幅度</div><div className={styles.resultValue}>{detail.version.definition.optimization.expectedTemperatureDrop}</div></div>
              <div className={styles.resultItem}><div className={styles.details}>是否当前可改项</div><div className={styles.resultValue}>{detail.version.definition.optimization.applicability === 'CUSTOMER_RECOMMENDATION' ? '建议项，需客户系统更改' : detail.version.definition.optimization.applicability === 'COST_WEIGHT_TRADEOFF' ? '可改，但成本和重量增加' : '当前可改，需人工确认'}</div></div>
              <div className={styles.resultItem}><div className={styles.details}>备注 / 约束</div><div className={styles.resultValue}>{detail.version.definition.optimization.constraints}</div></div>
            </div>
          </div>}
          <div className={styles.section}><strong>步骤与验收</strong><ol>{detail.version.definition.steps.map(step => <li key={step.id}><strong>{step.title}</strong><div className={styles.details}>{step.description}<br />验证：{step.verification}</div></li>)}</ol></div>
          <div className={styles.section}><strong>权限边界</strong><ul>{detail.version.definition.permissions.map(item => <li key={item}>{item}</li>)}</ul></div>
          {detail.kind === 'WORKFLOW' && <p className={styles.details}>来源任务：{detail.sources.length} · 版本：v{detail.activeVersion} · 运行：{detail.runCount} · 成功：{detail.successCount} · 连续失败：{detail.consecutiveFailures}{detail.publishedPath ? ` · 已发布到 ${detail.publishedPath}` : ''}</p>}
          {error && <p className={styles.error}>{error}</p>}
          {detail.kind === 'WORKFLOW' && (detail.status === 'DRAFT' || detail.status === 'DISABLED')
            ? <Button appearance="primary" disabled={busy} onClick={() => void review('enable')}>{busy ? '处理中' : '审核并启用'}</Button>
            : detail.kind === 'WORKFLOW' && detail.status === 'ENABLED' ? <Button disabled={busy} onClick={() => void review('disable')}>{busy ? '处理中' : '停用并撤回'}</Button> : null}
          {detail.kind === 'WORKFLOW' && detail.status === 'ENABLED' && <div className={styles.section}><strong>从此 Skill 创建任务</strong><div className={styles.form}><Field label="任务名称" required><Input value={runTitle} onChange={(_, data) => setRunTitle(data.value)} /></Field><Field label="Windows 工程路径" required><Input value={runProjectPath} onChange={(_, data) => setRunProjectPath(data.value)} placeholder="C:\\ThermalModels\\Project1.aedt" /></Field><Field label="最高温度目标（°C）"><Input type="number" value={runTarget} onChange={(_, data) => setRunTarget(data.value)} /></Field><Button appearance="primary" disabled={busy || !runTitle.trim() || !runProjectPath.trim()} onClick={() => void startRun()}>{busy ? '环境检查中' : '检查环境并创建 Skill Run'}</Button>{runMessage && <p className={styles.details}>{runMessage}</p>}</div></div>}
        </> : <Spinner label="正在读取 Skill 详情" />}</div>
      </section>}
  </>
}

function OptimizationSkillEditor({ styles, detail, onCancel, onSaved }: {
  styles: ReturnType<typeof useStyles>
  detail: SkillDetail | null
  onCancel(): void
  onSaved(skill: SkillDetail): Promise<void>
}) {
  const existing = detail?.version.definition.optimization
  const [draft, setDraft] = useState<OptimizationSkillInput>({
    name: detail?.name ?? '',
    description: detail?.description ?? '',
    guidance: existing ? { ...existing, keywords: [...existing.keywords] } : {
      priority: 7, mechanism: '', diagnosticBasis: '', measure: '', expectedTemperatureDrop: '待模型验证',
      applicability: 'LOCAL_ADJUSTABLE', constraints: '', keywords: [],
    },
  })
  const [keywords, setKeywords] = useState(existing?.keywords.join('、') ?? '')
  const [changeSummary, setChangeSummary] = useState('调整策略内容')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  function guidanceField<K extends keyof OptimizationSkillGuidance>(key: K, value: OptimizationSkillGuidance[K]) {
    setDraft(current => ({ ...current, guidance: { ...current.guidance, [key]: value } }))
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try {
      const payload = { ...draft, guidance: { ...draft.guidance, keywords } }
      const response = await fetch(detail ? `/api/optimization/skills/${detail.id}` : '/api/optimization/skills', {
        method: detail ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(detail ? { ...payload, expectedVersion: detail.activeVersion, changeSummary } : payload),
      })
      const body = await response.json() as { skill?: SkillDetail; error?: { message?: string } }
      if (!response.ok || !body.skill) throw new Error(body.error?.message ?? '策略保存失败')
      await onSaved(body.skill)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '策略保存失败') }
    finally { setSaving(false) }
  }
  return <form className={styles.form} onSubmit={submit}>
    <h2 className={styles.panelTitle}>{detail ? `修改策略 Skill · v${detail.activeVersion}` : '新建策略 Skill'}</h2>
    <p className={styles.details}>用于 Agent 分析和候选推荐；预期降温仅为待验证估计。保存不会修改 AEDT 工程或启动求解。</p>
    <Field label="名称" required><Input value={draft.name} onChange={(_, data) => setDraft(current => ({ ...current, name: data.value }))} /></Field>
    <Field label="说明" required><Textarea value={draft.description} onChange={(_, data) => setDraft(current => ({ ...current, description: data.value }))} /></Field>
    <Field label="优化顺序" required><Input type="number" min={1} max={999} value={String(draft.guidance.priority)} onChange={(_, data) => guidanceField('priority', Number(data.value))} /></Field>
    <Field label="核心物理机理" required><Textarea value={draft.guidance.mechanism} onChange={(_, data) => guidanceField('mechanism', data.value)} /></Field>
    <Field label="诊断依据（何时采用）" required><Textarea value={draft.guidance.diagnosticBasis} onChange={(_, data) => guidanceField('diagnosticBasis', data.value)} /></Field>
    <Field label="优化方向 / 措施" required><Textarea value={draft.guidance.measure} onChange={(_, data) => guidanceField('measure', data.value)} /></Field>
    <Field label="预期降温幅度" hint="未知时填写“待模型验证”，不要编造数值。" required><Input value={draft.guidance.expectedTemperatureDrop} onChange={(_, data) => guidanceField('expectedTemperatureDrop', data.value)} /></Field>
    <Field label="可改性" required><Select value={draft.guidance.applicability} onChange={(_, data) => guidanceField('applicability', data.value as OptimizationSkillGuidance['applicability'])}><option value="LOCAL_ADJUSTABLE">当前可改（需人工确认）</option><option value="CUSTOMER_RECOMMENDATION">客户系统建议项</option><option value="COST_WEIGHT_TRADEOFF">可改，但有成本 / 重量代价</option></Select></Field>
    <Field label="备注 / 约束" required><Textarea value={draft.guidance.constraints} onChange={(_, data) => guidanceField('constraints', data.value)} /></Field>
    <Field label="需求匹配关键词" hint="用逗号或顿号分隔，Agent 用这些词进行初筛。" required><Input value={keywords} onChange={(_, data) => setKeywords(data.value)} /></Field>
    {detail && <Field label="修改说明" required><Input value={changeSummary} onChange={(_, data) => setChangeSummary(data.value)} /></Field>}
    {error && <div className={styles.error}>{error}</div>}
    <div className={styles.headerActions}><Button type="submit" appearance="primary" disabled={saving}>{saving ? '正在保存' : detail ? '保存新版本' : '创建策略 Skill'}</Button><Button type="button" disabled={saving} onClick={onCancel}>取消</Button></div>
  </form>
}

const capabilityNames: Record<string, string> = {
  'optimization-01-tim': '导热贴（厚度 / 导热性能）',
  'optimization-02-fin-geometry': '片间距 / 片厚',
  'optimization-03-heat-spreader': '热管 / VC',
  'optimization-04-fan-selection': '风扇选型 / 转速',
  'optimization-05-system-vents': '系统进 / 出风口',
  'optimization-06-copper': '散热器材质（铝 → 铜）',
}

const capabilityStatuses: Record<ModelCapabilityAssessment['items'][number]['status'], string> = {
  EXECUTABLE: '已验证可自动执行',
  ADVISORY_ONLY: '仅供人工建议',
  NEEDS_MAPPING: '需识别对象，暂不能自动执行',
  UNAVAILABLE: '此模型不能自动执行',
}

function ParameterCatalogView({ styles, assessment }: { styles: ReturnType<typeof useStyles>; assessment: Pick<ModelCapabilityAssessment, 'parameterCatalog' | 'modelKind' | 'modelSha256' | 'projectName' | 'activeDesign' | 'checkedAt'> }) {
  const catalog = assessment.parameterCatalog
  if (!catalog) return assessment.modelKind === 'AEDT' ? <p className={styles.details}>此模型尚无参数清单，请重新检查模型。</p> : null
  function download() {
    const payload = { modelSha256: assessment.modelSha256, projectName: assessment.projectName,
      activeDesign: assessment.activeDesign, checkedAt: assessment.checkedAt, parameterCatalog: catalog }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `icepak-parameters-${assessment.modelSha256.slice(0, 12)}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className={styles.resultItem}>
    <strong>模型可操作参数 · 只读发现</strong>
    <p className={styles.details}>发现的变量、对象和边界不等于已确认可修改；目前仅“已验证”的曲线风扇支持自动候选。</p>
    <Button type="button" size="small" icon={<ArrowDownload20Regular />} onClick={download}>导出 JSON 清单</Button>
    <details className="parameter-catalog-details"><summary>查看清单：变量 {catalog.variables.length} · 材料对象 {catalog.materials.length} · 边界 {catalog.boundaries.length} · 风扇 {catalog.fans.length}</summary><div className="task-detail-list parameter-catalog-scroll">
      {catalog.variables.map(item => <div key={`var:${item.name}`}><strong>{item.name}</strong><span>{item.readOnly ? '只读' : item.used === true ? '已引用，待映射' : '引用未确认'}</span><small>{item.scope === 'project' ? '项目变量' : '设计变量'} · {item.expression}{item.units ? ` · 单位 ${item.units}` : ''}</small></div>)}
      {catalog.materials.map(item => <div key={`mat:${item.objectName}`}><strong>{item.objectName}</strong><span>材料对象，待映射</span><small>当前材料：{item.materialName}</small></div>)}
      {catalog.boundaries.map(item => <div key={`boundary:${item.name}`}><strong>{item.name}</strong><span>{item.type} 边界，待映射</span><small>{JSON.stringify(item.properties)}</small></div>)}
      {catalog.fans.map(item => <div key={`fan:${item.name}`}><strong>{item.name}</strong><span>{item.actionStatus === 'VERIFIED' ? '风扇动作已验证' : '仅发现，未验证'}</span><small>风扇类型：{item.flowType || '未知'}</small></div>)}
    </div></details>
    {catalog.diagnostics.map((item, index) => <p key={index} className={styles.details}>读取提示：{item}</p>)}
  </div>
}

function CreateTaskPanel({ styles, tasks, initialDraftId, onCreated, onCancel }: { styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; initialDraftId: string | null; onCreated(taskId: string): Promise<void>; onCancel(): void }) {
  const [editing, setEditing] = useState<TaskRecord | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [customer, setCustomer] = useState('')
  const [projectName, setProjectName] = useState('')
  const [productModel, setProductModel] = useState('')
  const [workCondition, setWorkCondition] = useState('')
  const [criticalPoints, setCriticalPoints] = useState('')
  const [adjustmentBounds, setAdjustmentBounds] = useState('')
  const [expertSupplement, setExpertSupplement] = useState('')
  const [aedtVersion, setAedtVersion] = useState('2024.2')
  const [modelFile, setModelFile] = useState<File | null>(null)
  const [modelSha256, setModelSha256] = useState('')
  const [modelName, setModelName] = useState('')
  const [modelKind, setModelKind] = useState<'AEDT' | 'CAD' | null>(null)
  const [assessment, setAssessment] = useState<ModelCapabilityAssessment | null>(null)
  const [checkingModel, setCheckingModel] = useState(false)
  const [notice, setNotice] = useState('')
  const [targetTmaxC, setTargetTmaxC] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [recommendations, setRecommendations] = useState<OptimizationRecommendation[] | null>(null)
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([])
  const [autoFan, setAutoFan] = useState(false)
  const [planConfirmed, setPlanConfirmed] = useState(false)
  const [startNow, setStartNow] = useState(false)
  const intakeDrafts = tasks.filter(task => task.executionStatus === 'DRAFT' && task.requirementSnapshot.intakeVersion === 2)
  function loadDraft(taskId: string) {
    const task = intakeDrafts.find(item => item.id === taskId) ?? null
    setEditing(task); setRecommendations(null); setSelectedSkillIds([]); setPlanConfirmed(false); setModelFile(null)
    setTitle(task?.title ?? ''); setDescription(task?.description ?? '')
    const snapshot = task?.requirementSnapshot ?? {}
    setCustomer(String(snapshot.customer ?? '')); setProjectName(String(snapshot.projectName ?? ''))
    setProductModel(String(snapshot.productModel ?? '')); setWorkCondition(String(snapshot.workCondition ?? ''))
    setCriticalPoints(String(snapshot.criticalPoints ?? '')); setAdjustmentBounds(String(snapshot.adjustmentBounds ?? ''))
    setExpertSupplement(String(snapshot.expertSupplement ?? ''))
    setTargetTmaxC(snapshot.targetTmaxC === undefined ? '' : String(snapshot.targetTmaxC))
    setAedtVersion(String(snapshot.aedtVersion ?? '2024.2'))
    setModelSha256(String(snapshot.modelSha256 ?? '')); setModelName(String(snapshot.modelOriginalName ?? ''))
    setModelKind(snapshot.modelKind === 'AEDT' || snapshot.modelKind === 'CAD' ? snapshot.modelKind : null)
    setAssessment(snapshot.capabilityAssessment && typeof snapshot.capabilityAssessment === 'object' ? snapshot.capabilityAssessment as ModelCapabilityAssessment : null)
  }
  useEffect(() => { if (initialDraftId) loadDraft(initialDraftId) }, [])
  async function uploadAndCheck(): Promise<{ sha256: string; modelKind: 'AEDT' | 'CAD'; assessment: ModelCapabilityAssessment; originalName: string }> {
    setCheckingModel(true); setError(''); setNotice('')
    try {
      let sha = modelSha256
      let kind = modelKind
      let originalName = modelName
      if (modelFile) {
        const upload = await fetch('/api/models/upload', { method: 'POST', headers: { 'X-Model-Name': encodeURIComponent(modelFile.name), 'Content-Type': 'application/octet-stream' }, body: modelFile })
        const uploaded = await upload.json() as { model?: { sha256: string; originalName: string; modelKind: 'AEDT' | 'CAD' }; error?: { message?: string } }
        if (!upload.ok || !uploaded.model) throw new Error(uploaded.error?.message ?? '模型上传失败')
        sha = uploaded.model.sha256; kind = uploaded.model.modelKind; originalName = uploaded.model.originalName
        setModelSha256(sha); setModelKind(kind); setModelName(originalName); setModelFile(null)
      }
      if (!sha || !kind) throw new Error('请先选择 .aedt 或 CAD 模型文件')
      const checked = await fetch(`/api/models/${sha}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: aedtVersion }) })
      const body = await checked.json() as { assessment?: ModelCapabilityAssessment; error?: { message?: string } }
      if (!checked.ok || !body.assessment) throw new Error(body.error?.message ?? '模型能力检查失败')
      setAssessment(body.assessment)
      return { sha256: sha, modelKind: kind, assessment: body.assessment, originalName }
    } finally { setCheckingModel(false) }
  }
  async function analyze() {
    setAnalyzing(true); setError('')
    try {
      const response = await fetch('/api/optimization/recommendations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requirement: `${title}\n${description}\n${workCondition}\n${criticalPoints}` }),
      })
      const body = await response.json() as { recommendations?: OptimizationRecommendation[]; error?: { message?: string } }
      if (!response.ok || !body.recommendations) throw new Error(body.error?.message ?? '优化方案分析失败')
      setRecommendations(body.recommendations.filter(item => item.suggested)); setPlanConfirmed(false)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '优化方案分析失败') }
    finally { setAnalyzing(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice(''); setSaving(true)
    try {
      const target = Number(targetTmaxC)
      if (!title.trim() || !description.trim()) throw new Error('任务名称和详细散热需求必须填写')
      if (!modelFile && !modelSha256) throw new Error('请选择并上传 .aedt 或 CAD 模型文件')
      const model = modelFile || !assessment || assessment.aedtVersion !== (modelKind === 'CAD' ? null : aedtVersion)
        ? await uploadAndCheck() : { sha256: modelSha256, modelKind: modelKind as 'AEDT' | 'CAD', assessment, originalName: modelName }
      const isAedt = model.modelKind === 'AEDT'
      const readyForRun = isAedt && model.assessment.status === 'READY_FOR_BASELINE'
      if (readyForRun && (!Number.isFinite(target) || !targetTmaxC.trim())) throw new Error('Icepak 求解任务必须填写最高温度目标')
      if (readyForRun && (!recommendations || !planConfirmed)) throw new Error('请先分析候选方案，并确认本次任务的方案选择')
      const selectedFan = recommendations?.find(item => selectedSkillIds.includes(item.skillId) && item.key === 'optimization-04-fan-selection')
      const fanSelected = Boolean(selectedFan)
      if (readyForRun && fanSelected && autoFan && model.assessment.items.find(item => item.skillKey === 'optimization-04-fan-selection')?.status !== 'EXECUTABLE') {
        throw new Error('该模型的风扇动作未验证通过，不能授权自动二次仿真')
      }
      const requirementSnapshot = { intakeVersion: 2, customer, projectName, productModel, workCondition,
        criticalPoints, adjustmentBounds, expertSupplement, aedtVersion, cores: 4, ...(targetTmaxC.trim() ? { targetTmaxC: target } : {}), modelSha256: model.sha256,
        selectedOptimizationSkillIds: readyForRun ? selectedSkillIds : [], planConfirmed: readyForRun ? planConfirmed : false,
        ...(selectedFan ? { fanSkillId: selectedFan.skillId } : {}),
        ...(readyForRun && fanSelected && autoFan ? { autoFanRatio: 1.1 } : {}) }
      const response = await fetch(editing ? `/api/tasks/${editing.id}` : '/api/tasks', {
        method: editing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, requirementSnapshot, ...(editing ? { expectedVersion: editing.version } : {}) }),
      })
      const created = await response.json() as { task?: TaskRecord; error?: { message?: string } }
      if (!response.ok || !created.task) throw new Error(created.error?.message ?? '任务未创建')
      setEditing(created.task); setModelSha256(model.sha256); setModelName(model.originalName); setModelKind(model.modelKind); setAssessment(model.assessment); setModelFile(null)
      if (!readyForRun) {
        setNotice(isAedt
          ? 'Icepak 工程已保存为草稿，但能力检查未通过；请检查 AEDT 环境、工程和 Setup 后重新检查，不能启动求解。'
          : 'CAD 几何已保存为需求草稿。请先建立含材料、热源、边界条件、监测点和 Setup 的 Icepak 工程，再回到此处载入草稿并上传 .aedt。')
        await onCreated(created.task.id)
        return
      }
      const confirmation = await fetch(`/api/tasks/${created.task.id}/transitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'READY', expectedVersion: created.task.version, reason: '用户已核对需求、模型和优化方案' }) })
      const confirmed = await confirmation.json() as { task?: TaskRecord; error?: { message?: string } }
      if (!confirmation.ok || !confirmed.task) throw new Error(confirmed.error?.message ?? '需求确认失败，任务仍为草稿')
      loadDraft(''); setModelSha256(''); setModelName(''); setModelKind(null); setAssessment(null); setTargetTmaxC(''); setAutoFan(false); setStartNow(false)
      if (startNow) {
        const run = await fetch(`/api/tasks/${created.task.id}/runs/baseline`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath: confirmed.task.requirementSnapshot.projectPath, version: aedtVersion, cores: 4 }) })
        if (!run.ok) { const failure = await run.json() as { error?: { message?: string } }; throw new Error(`任务已创建并确认，但 Icepak 未启动：${failure.error?.message ?? '请从任务列表重试'}`) }
      }
      await onCreated(created.task.id)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '任务未创建') }
    finally { setSaving(false) }
  }
  return <div className="task-create-page"><div className={styles.intro}><div><h1 className={styles.title}>{editing ? '完善散热任务' : '新建散热任务'}</h1><p className={styles.subtitle}>人工填表或载入 DSH Agent 草稿。先记录需求与模型，再核对能力和候选方案。</p></div><Button appearance="subtle" onClick={onCancel}>返回任务列表</Button></div><div className={styles.panel}><form className={styles.form} onSubmit={submit}>
    {intakeDrafts.length > 0 && <Field label="载入待完善需求"><Select value={editing?.id ?? ''} onChange={(_, data) => loadDraft(data.value)}><option value="">新建人工任务</option>{intakeDrafts.map(task => <option key={task.id} value={task.id}>{task.title} · {task.requirementSnapshot.modelKind === 'CAD' ? 'CAD 待建模' : '待补齐'}</option>)}</Select></Field>}
    <Field label="任务名称" required><Input value={title} onChange={(_, data) => { setTitle(data.value); setRecommendations(null) }} /></Field>
    <div className="form-pair"><Field label="客户"><Input value={customer} onChange={(_, data) => setCustomer(data.value)} placeholder="客户名称" /></Field><Field label="项目"><Input value={projectName} onChange={(_, data) => setProjectName(data.value)} placeholder="项目名称" /></Field></div>
    <div className="form-pair"><Field label="产品型号"><Input value={productModel} onChange={(_, data) => setProductModel(data.value)} placeholder="产品型号" /></Field><Field label="工况"><Input value={workCondition} onChange={(_, data) => { setWorkCondition(data.value); setRecommendations(null) }} placeholder="工况、环境温度、功耗等" /></Field></div>
    <Field label="详细散热需求" required><Textarea resize="vertical" value={description} onChange={(_, data) => { setDescription(data.value); setRecommendations(null) }} placeholder="热点、现状、目标、不可变条件和客户要求" /></Field>
    <Field label="最高温度目标（°C）" hint="CAD 需求阶段可暂缺；Icepak 求解前必填。"><Input type="number" value={targetTmaxC} onChange={(_, data) => setTargetTmaxC(data.value)} /></Field>
    <Field label="关键监测点"><Textarea value={criticalPoints} onChange={(_, data) => { setCriticalPoints(data.value); setRecommendations(null) }} placeholder="芯片壳温、鳍片根部、进出口温度等" /></Field>
    <Field label="允许的调整范围"><Textarea value={adjustmentBounds} onChange={(_, data) => setAdjustmentBounds(data.value)} placeholder="材料、风扇、结构、成本与噪声限制" /></Field>
    <Field label="专家补充建议 / 约束" hint="与 AI 初筛分开保存，可写客户禁改项、优先级和需要人工核对的判断。"><Textarea value={expertSupplement} onChange={(_, data) => setExpertSupplement(data.value)} placeholder="人工经验判断与补充约束" /></Field>
    <Field label="AEDT 版本"><Input value={aedtVersion} onChange={(_, data) => setAedtVersion(data.value)} /></Field>
    <Field label="模型文件" hint="可先上传单个 STEP、IGES、Parasolid、ACIS CAD 几何，作为待建模需求；只有通过能力检查的 .aedt 才能启动求解。" required><input type="file" accept=".aedt,.step,.stp,.iges,.igs,.x_t,.x_b,.sat,.sab" onChange={event => { setModelFile(event.target.files?.[0] ?? null); setModelSha256(''); setModelKind(null); setAssessment(null) }} />{modelName && !modelFile && <span className={styles.details}>已上传：{modelName}</span>}</Field>
    <Button type="button" icon={<ArrowUpload20Regular />} disabled={(!modelFile && !modelSha256) || checkingModel || saving} onClick={() => void uploadAndCheck().catch(reason => setError(reason instanceof Error ? reason.message : '模型检查失败'))}>{checkingModel ? '正在上传 / 检查' : '上传并检查模型能力'}</Button>
    {assessment && <><div className={styles.resultItem}><strong>{assessment.modelKind === 'CAD' ? 'CAD 需求输入 · 待建立 Icepak 工程' : assessment.status === 'READY_FOR_BASELINE' ? 'Icepak 工程可启动 Baseline' : 'Icepak 工程暂不能启动 Baseline'}</strong><p className={styles.details}>{assessment.projectName ? `${assessment.projectName} / ${assessment.activeDesign} · Setup：${assessment.setups.join('、') || '无'}` : assessment.diagnostics.join('；')}</p>{assessment.items.map(item => <p key={item.skillKey} className={styles.details}>{capabilityNames[item.skillKey] ?? item.skillKey} · {capabilityStatuses[item.status]} · 目标对象：{item.targetNames.join('、') || '未识别'}；{item.reason}</p>)}</div><ParameterCatalogView styles={styles} assessment={assessment} /></>}
    <Button type="button" icon={<BrainCircuit20Regular />} disabled={!title.trim() || !description.trim() || analyzing} onClick={() => void analyze()}>{analyzing ? '分析中' : '分析适合的优化方案'}</Button>
    {recommendations && <div className={styles.resultItem}><strong>候选方案 · 人工选择</strong>{recommendations.map(item => { const capability = assessment?.items.find(check => check.skillKey === item.key); return <label key={item.skillId} style={{ display: 'block', marginTop: 10 }}><input type="checkbox" checked={selectedSkillIds.includes(item.skillId)} onChange={event => { setSelectedSkillIds(current => event.target.checked ? [...current, item.skillId] : current.filter(id => id !== item.skillId)); setPlanConfirmed(false) }} /> {item.guidance.priority}. {item.name} · {capability?.status === 'EXECUTABLE' ? `可执行：${capability.targetNames.join('、')}` : capability?.status === 'ADVISORY_ONLY' ? '仅客户建议' : capability?.status === 'UNAVAILABLE' ? '此模型不可自动执行' : '需对象映射，当前仅建议'}<span className={styles.details}>　命中：{item.matchedSignals.join('、') || '默认排查'}；{item.guidance.diagnosticBasis}</span></label> })}<p className={styles.details}>这些是初筛假设；真实诊断须结合 Baseline 结果。未选方案时只运行 Baseline。</p></div>}
    {recommendations && assessment?.items.find(item => item.skillKey === 'optimization-04-fan-selection')?.status === 'EXECUTABLE' && selectedSkillIds.some(id => recommendations.find(item => item.skillId === id)?.key === 'optimization-04-fan-selection') && <label><input type="checkbox" checked={autoFan} onChange={event => setAutoFan(event.target.checked)} /> 若 Baseline 判定 FAIL，授权自动尝试列出的所有风扇转速 +10%（仅一次）</label>}
    {recommendations && modelKind !== 'CAD' && <label><input type="checkbox" checked={planConfirmed} onChange={event => setPlanConfirmed(event.target.checked)} /> 我已核对需求、模型能力与候选方案；允许按所选范围执行</label>}
    {modelKind !== 'CAD' && <label><input type="checkbox" checked={startNow} onChange={event => setStartNow(event.target.checked)} /> 提交后立即启动 Icepak Baseline（占用求解许可证）</label>}
    {notice && <div className={styles.details}>{notice}</div>}{error && <div className={styles.error}>{error}</div>}<Button type="submit" icon={startNow ? <Play20Regular /> : <Save20Regular />} appearance="primary" disabled={saving}>{saving ? '上传模型并提交中' : modelKind === 'CAD' ? '保存 CAD 需求草稿' : startNow ? '确认方案并启动仿真' : '确认方案并创建任务'}</Button>
  </form></div></div>
}

function IcepakSettings({ styles, probe, onProbeUpdated, check, onCheckUpdated, autoRun, onAutoRunStarted }: {
  styles: ReturnType<typeof useStyles>; probe: IcepakEnvironmentProbe | null; onProbeUpdated(probe: IcepakEnvironmentProbe): void
  check: IcepakSelfCheck; onCheckUpdated: Dispatch<SetStateAction<IcepakSelfCheck>>; autoRun: boolean; onAutoRunStarted(): void
}) {
  const [projectPath, setProjectPath] = useState('')
  const [version, setVersion] = useState(probe?.selectedVersion ?? '')
  const [ratio, setRatio] = useState('1.1')
  const [running, setRunning] = useState<'inspect' | 'fan-check' | null>(null)
  const [result, setResult] = useState<IcepakProjectOperationResult | null>(null)
  const [error, setError] = useState('')
  const startedRef = useRef(false)
  const [startingVerification, setStartingVerification] = useState(false)
  const [verificationTaskId, setVerificationTaskId] = useState('')
  useEffect(() => { if (probe?.selectedVersion) setVersion(probe.selectedVersion) }, [probe?.selectedVersion])

  function setStep(index: 0 | 1 | 2, status: CheckStatus, detail: string) {
    onCheckUpdated(current => ({ ...current, steps: current.steps.map((step, position) =>
      position === index ? { status, detail } : step) as IcepakSelfCheck['steps'] }))
  }

  async function runSelfCheck() {
    if (check.running || isLanClient) return
    setError('')
    onCheckUpdated({ ...emptyIcepakCheck(), running: true, steps: [
      { status: 'running', detail: '正在扫描 AEDT 安装和 PyAEDT' },
      { status: 'waiting', detail: '等待环境探测' },
      { status: 'waiting', detail: '等待启动验证' },
    ] })
    try {
      const environmentResponse = await fetch('/api/plugins/icepak/probe')
      const environmentBody = await environmentResponse.json() as { probe?: IcepakEnvironmentProbe; error?: { message?: string } }
      if (!environmentResponse.ok || !environmentBody.probe) throw new Error(environmentBody.error?.message ?? '环境探测失败')
      const environment = environmentBody.probe
      onProbeUpdated(environment)
      if (!['DETECTED', 'LAUNCHABLE', 'PROJECT_COMPATIBLE', 'READY'].includes(environment.status) || !environment.aedtVersions.length) {
        setStep(0, 'failed', environment.diagnostics.join('；') || `环境状态：${environment.status}`)
        setStep(1, 'skipped', 'AEDT／PyAEDT 未就绪，未启动会话')
        setStep(2, 'skipped', '等待环境可用后再检查示例工程')
        return
      }
      setStep(0, 'passed', `检测到 AEDT ${environment.aedtVersions.join('、')}；PyAEDT ${environment.pyaedtAvailable ? '可用' : '不可用'}`)
      const selected = version && environment.aedtVersions.includes(version) ? version : environment.selectedVersion ?? environment.aedtVersions.at(-1) ?? ''
      if (!selected) throw new Error('没有可用的 AEDT 版本')
      setVersion(selected)
      onCheckUpdated(current => ({ ...current, version: selected }))
      setStep(1, 'running', `正在启动并释放 AEDT ${selected}，可能需要数分钟`)
      const launchResponse = await fetch('/api/plugins/icepak/probe-launchability', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: selected }),
      })
      const launchBody = await launchResponse.json() as { probe?: IcepakEnvironmentProbe; error?: { message?: string } }
      if (!launchResponse.ok || !launchBody.probe) throw new Error(launchBody.error?.message ?? 'Icepak 启动验证失败')
      if (launchBody.probe.status !== 'LAUNCHABLE') {
        setStep(1, 'failed', launchBody.probe.diagnostics.join('；') || `启动状态：${launchBody.probe.status}`)
        setStep(2, 'skipped', 'Icepak 尚不能启动，未打开示例工程')
        return
      }
      setStep(1, 'passed', `AEDT ${selected} 独立会话已启动并释放；求解许可证仍未验证`)
      setStep(2, 'running', '正在用内置 Project1.aedt 的副本检查工程')
      const sampleResponse = await fetch('/api/plugins/icepak/sample-inspect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: selected }),
      })
      const sampleBody = await sampleResponse.json() as { result?: IcepakProjectOperationResult; error?: { message?: string } }
      if (!sampleResponse.ok || !sampleBody.result) throw new Error(sampleBody.error?.message ?? '内置示例工程检查失败')
      onCheckUpdated(current => ({ ...current, sampleResult: sampleBody.result ?? null }))
      if (!sampleBody.result.validation.verified || sampleBody.result.status !== 'ok') {
        setStep(2, 'failed', '示例工程已打开，但能力校验未通过；请查看检查结果')
        return
      }
      setStep(2, 'passed', `已识别 ${sampleBody.result.project.name || '示例工程'} / ${sampleBody.result.project.activeDesign || '未命名设计'}；尚未运行求解`)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Icepak 自动探测失败'
      onCheckUpdated(current => ({ ...current, steps: current.steps.map(step => step.status === 'running' ? { status: 'failed', detail: message } : step.status === 'waiting' ? { status: 'skipped', detail: '前一步未通过' } : step) as IcepakSelfCheck['steps'] }))
    } finally {
      onCheckUpdated(current => ({ ...current, running: false, checkedAt: new Date().toISOString() }))
    }
  }

  useEffect(() => {
    if (!autoRun || isLanClient || startedRef.current) return
    startedRef.current = true
    onAutoRunStarted()
    void runSelfCheck()
  }, [autoRun])

  async function verifySolver() {
    if (!window.confirm('这会在工程副本上执行一次真实 Icepak 求解，可能耗时较长并占用许可证。确认创建能力验证任务吗？')) return
    setStartingVerification(true); setError('')
    try {
      const response = await fetch('/api/plugins/icepak/verify-solver', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, version, authorizeSolve: true }),
      })
      const body = await response.json() as { task?: TaskRecord; error?: { message?: string } }
      if (!response.ok || !body.task) throw new Error(body.error?.message ?? '真实求解验证未能启动')
      setVerificationTaskId(body.task.id)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '真实求解验证未能启动') }
    finally { setStartingVerification(false) }
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
    <div className={styles.intro}><div><h1 className={styles.title}>Icepak 插件</h1><p className={styles.subtitle}>自动完成环境识别、启动验证和内置示例工程检查；不会自动执行求解。</p></div><Button appearance="primary" icon={<ArrowClockwise20Regular />} disabled={isLanClient || check.running || running !== null || startingVerification} onClick={() => void runSelfCheck()}>{check.running ? '探测中' : '重新探测'}</Button></div>
    <section className={styles.settingsGrid}>
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}><DesktopPulse20Regular />三级自动探测</h2>
        <div className={styles.statusRow}><Badge color={probe?.status === 'READY' ? 'success' : 'warning'}>{probe?.status ?? 'CHECKING'}</Badge><span className={styles.details}>{probe?.selectedVersion ?? '未检测到 AEDT 版本'}</span></div>
        <div className="task-detail-list" aria-live="polite">{check.steps.map((step, index) => <div key={index}><strong>{index + 1}. {['识别 AEDT / PyAEDT', '验证 Icepak 可启动', '检查内置示例工程'][index]}</strong><Badge color={step.status === 'passed' ? 'success' : step.status === 'failed' ? 'danger' : step.status === 'running' ? 'informative' : 'subtle'}>{({ waiting: '待执行', running: '进行中', passed: '通过', failed: '未通过', skipped: '已跳过' } as const)[step.status]}</Badge><small>{step.detail}</small></div>)}</div>
        {check.checkedAt && <p className={styles.details}>最近探测：{new Date(check.checkedAt).toLocaleString('zh-CN')} · 版本 {check.version || '未选定'}</p>}
        {isLanClient && <p className={styles.details}>自动探测仅能在安装了 App 的 Windows 主机本机执行。</p>}
        <p className={styles.details}>第三步只检查内置工程副本，不启动求解；通过不代表其他任务模型也兼容。</p>
      </div>
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>示例工程检查结果</h2>
        {check.running && <Spinner label="自动探测中，AEDT 启动可能需要数分钟" />}
        {check.sampleResult ? <div className={styles.resultGrid}>
          <ResultItem styles={styles} label="工程" value={check.sampleResult.project.name || '未命名'} />
          <ResultItem styles={styles} label="活动设计" value={check.sampleResult.project.activeDesign || '未识别'} />
          <ResultItem styles={styles} label="AEDT 版本" value={check.sampleResult.project.aedtVersion || '未识别'} />
          <ResultItem styles={styles} label="Setup" value={check.sampleResult.project.setups.join(', ') || '未识别'} />
          <ResultItem styles={styles} label="能力校验" value={check.sampleResult.validation.verified ? '通过' : '未通过'} />
          <ResultItem styles={styles} label="求解许可证" value="未验证；未执行求解" />
        </div> : <div className={styles.empty}><div><DesktopPulse20Regular fontSize={28} /><p>等待自动探测完成。</p></div></div>}
      </div>
    </section>
    <div className={styles.panel} style={{ marginTop: 16 }}><h2 className={styles.panelTitle}>可选：指定工程与真实求解</h2><p className={styles.details}>任务中的模型仍需单独检查。此处仅供工程师手动验证指定工程或明确授权一次真实求解，不影响上方自动探测。</p><div className={styles.form}>
      <Field label="Windows 主机上的 AEDT 工程路径" hint="例如 C:\\ThermalModels\\Project1.aedt"><Input value={projectPath} onChange={(_, data) => setProjectPath(data.value)} /></Field>
      <Field label="AEDT 版本"><Select value={version} onChange={(_, data) => setVersion(data.value)}><option value="">请选择检测到的版本</option>{probe?.aedtVersions.map(item => <option key={item} value={item}>{item}</option>)}</Select></Field>
      <Field label="风扇转速比例" hint="仅用于动作验证，范围 (1.0, 1.5]"><Input type="number" min={1.01} max={1.5} step={0.01} value={ratio} onChange={(_, data) => setRatio(data.value)} /></Field>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.headerActions}><Button disabled={!projectPath.trim() || !version || check.running || running !== null} onClick={() => void run('inspect')}>{running === 'inspect' ? '正在检查工程' : '检查指定工程'}</Button><Button disabled={!projectPath.trim() || !version || check.running || running !== null} onClick={() => void run('fan-check')}>{running === 'fan-check' ? '正在验证动作' : '验证风扇动作'}</Button></div>
      <Button disabled={!projectPath.trim() || !version || check.running || startingVerification || running !== null} onClick={() => void verifySolver()}>{startingVerification ? '正在创建验证任务' : '真实求解验证（占用许可证）'}</Button>
      <p className={styles.details}>真实求解需再次确认；将创建可审计的 Baseline 任务。成功且证据完整后，本节点最多 30 分钟向可信节点发布 READY，实际许可证仍可能变化。</p>
      {verificationTaskId && <p className={styles.details}>验证任务已启动：{verificationTaskId}。请到“任务”页查看进度和复核结果。</p>}
      {probe?.readinessExpiresAt && <p className={styles.details}>最近真实求解证明：{probe.readinessVerifiedAt}；到期：{probe.readinessExpiresAt}</p>}
      {running ? <Spinner label="正在检查指定工程" /> : result && <div className={styles.resultGrid}>
        <ResultItem styles={styles} label="工程" value={result.project.name || '未命名'} />
        <ResultItem styles={styles} label="活动设计" value={result.project.activeDesign || '未识别'} />
        <ResultItem styles={styles} label="AEDT 版本" value={result.project.aedtVersion || '未识别'} />
        <ResultItem styles={styles} label="Setup" value={result.project.setups.join(', ') || '未识别'} />
        <ResultItem styles={styles} label="温度 Monitor" value={result.project.monitors.join(', ') || '未识别'} />
        <ResultItem styles={styles} label="能力校验" value={result.validation.verified ? '通过' : '未通过'} />
        {result.fanAction && <ResultItem styles={styles} label="风扇动作" value="写入及回读验证通过" />}
      </div>}
      {result?.mode === 'inspect' && <ParameterCatalogView styles={styles} assessment={{ modelKind: 'AEDT', modelSha256: result.inputSha256,
        projectName: result.project.name, activeDesign: result.project.activeDesign, checkedAt: new Date().toISOString(),
        parameterCatalog: result.parameterCatalog }} />}
    </div></div>
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
      <div className={styles.statusRow} style={{ marginTop: 0 }}><div><h2 className={styles.panelTitle}>远程任务接单</h2><p className={styles.details}>默认关闭。开启后仅接收可信节点的加密 Baseline Offer，并要求本机 Icepak 真正 READY；输入校验通过后会自动启动受管求解、续租并回传结果。</p></div><Badge color={remoteEnabled ? 'warning' : 'informative'}>{remoteEnabled ? '已开启' : '已关闭'}</Badge></div>
      <Button appearance={remoteEnabled ? 'secondary' : 'primary'} disabled={busy} onClick={() => void toggleRemoteExecution()}>{remoteEnabled ? '停止远程接单' : '显式开启远程接单'}</Button>
      {remoteJobs.length > 0 && <div className={styles.skillList}>{remoteJobs.map(job => <div key={job.attemptId} className={styles.statusRow}><div><strong>{job.taskId}</strong><div className={styles.details}>Owner {job.ownerNodeId} · Attempt {job.attemptId} · 输入 {job.inputOriginalName}</div>{job.errorMessage && <div className={styles.error}>{job.errorCode}: {job.errorMessage}</div>}</div><Badge>{job.status}</Badge></div>)}</div>}
    </div>}
    {!isLanClient && <div className={styles.panel} style={{ marginTop: 16 }}><h2 className={styles.panelTitle}>局域网发现</h2><p className={styles.details}>{discovery?.enabled ? `已开启 · UDP ${discovery.group}:${discovery.udpPort}` : '未开启；请先在设置中开启局域网发布'}{discovery?.lastError ? ` · ${discovery.lastError}` : ''}</p>{discovery?.discovered.length ? <div className={styles.skillList}>{discovery.discovered.map(peer => <div key={peer.identity.nodeId} className={styles.statusRow}><div><strong>{peer.identity.nodeId}</strong><div className={styles.details}>{peer.address}:{peer.servicePort} · Icepak {peer.heartbeat.pluginStatus} · 负载 {peer.heartbeat.activeAttempts}/{peer.heartbeat.maxConcurrent} · {peer.heartbeat.aedtVersions.join(', ') || '未知 AEDT 版本'}</div>{peer.trusted && verifiedPeers[peer.identity.nodeId] && <div className={styles.details}>最近身份握手：{new Date(verifiedPeers[peer.identity.nodeId]).toLocaleString()}</div>}{peer.trusted && securePeers[peer.identity.nodeId] && Date.parse(securePeers[peer.identity.nodeId]) > Date.now() && <div className={styles.details}>临时加密会话至 {new Date(securePeers[peer.identity.nodeId]).toLocaleTimeString()}（可测试 ping；其他操作仍需任务租约）</div>}</div><div className={styles.headerActions}><Badge color={peer.trusted ? 'success' : 'warning'}>{peer.trusted ? '可信签名' : '未登记'}</Badge>{peer.trusted ? <><Button size="small" disabled={busy} onClick={() => void verifyPeer(peer.identity.nodeId)}>验证身份</Button><Button size="small" disabled={busy} onClick={() => void connectPeer(peer.identity.nodeId)}>测试加密通道</Button></> : <Button size="small" onClick={() => { setNodeId(peer.identity.nodeId); setPublicKey(peer.identity.publicKey); setDisplayName(peer.identity.nodeId) }}>填入登记</Button>}</div></div>)}</div> : <p className={styles.placeholder}>还没有发现其他 App。两台电脑需在同一局域网开启发布，且网络允许 UDP 组播。</p>}</div>}
    {!isLanClient && <div className={styles.panel} style={{ marginTop: 16 }}><h2 className={styles.panelTitle}>已登记节点</h2>{peers.length ? <div className={styles.skillList}>{peers.map(peer => <div key={peer.nodeId} className={styles.statusRow}><div><strong>{peer.displayName}</strong><div className={styles.details}>{peer.nodeId} · {peer.pluginStatus} · {peer.lastSeenAt ?? '尚无能力心跳'}</div></div><div className={styles.headerActions}><Badge color={peer.trustStatus === 'TRUSTED' ? 'success' : 'danger'}>{peer.trustStatus}</Badge>{peer.trustStatus === 'TRUSTED' && <Button size="small" disabled={busy} onClick={() => void revoke(peer)}>撤销信任</Button>}</div></div>)}</div> : <p className={styles.placeholder}>还没有登记其他计算节点。</p>}</div>}
    {error && <p className={styles.error}>{error}</p>}
  </>
}
