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
  WeatherSunny20Regular,
  WeatherMoon20Regular,
} from '@fluentui/react-icons'
import type { IcepakEnvironmentProbe, IcepakProjectOperationResult, TaskRecord } from '@thermal-agent/contracts'

const brand: BrandVariants = {
  10: '#130903', 20: '#281006', 30: '#421706', 40: '#5c2009', 50: '#742b10',
  60: '#8d3718', 70: '#a54420', 80: '#bd522a', 90: '#d1643b', 100: '#df7954',
  110: '#e78f70', 120: '#eda58d', 130: '#f2bba8', 140: '#f6d0c4', 150: '#fae5df', 160: '#fff8f6',
}

const lightTheme = createLightTheme(brand)
const darkTheme = createDarkTheme(brand)

type Page = 'overview' | 'tasks' | 'skills' | 'nodes' | 'settings'

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
  iconMuted: { color: tokens.colorNeutralForeground3 },
  mobileNav: {
    display: 'none',
    '@media (max-width: 900px)': {
      position: 'fixed', display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', left: 0, right: 0, bottom: 0,
      zIndex: 10, backgroundColor: tokens.colorNeutralBackground1, borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
      paddingTop: '6px', paddingRight: '6px', paddingBottom: '6px', paddingLeft: '6px',
    },
  },
})

const navItems: Array<{ page: Page; label: string; icon: JSX.Element }> = [
  { page: 'overview', label: '概览', icon: <Home20Regular /> },
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [tasksResponse, probeResponse] = await Promise.all([fetch('/api/tasks'), fetch('/api/plugins/icepak/probe')])
      if (!tasksResponse.ok || !probeResponse.ok) throw new Error('本地 Core 暂时无法返回完整状态')
      const tasksBody = await tasksResponse.json() as { tasks: TaskRecord[] }
      const probeBody = await probeResponse.json() as { probe: IcepakEnvironmentProbe }
      setTasks(tasksBody.tasks)
      setProbe(probeBody.probe)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '状态读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const activeTasks = useMemo(() => tasks.filter(task => !['COMPLETED', 'FAILED', 'CANCELLED', 'ESCALATED'].includes(task.executionStatus)), [tasks])
  const completedTasks = useMemo(() => tasks.filter(task => task.executionStatus === 'COMPLETED'), [tasks])

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
              <Button appearance="subtle" icon={dark ? <WeatherSunny20Regular /> : <WeatherMoon20Regular />} aria-label="切换主题" onClick={() => setDark(value => !value)} />
            </div>
          </header>
          <div className={styles.content}>
            {page === 'overview' && <Overview styles={styles} tasks={tasks} activeCount={activeTasks.length} completedCount={completedTasks.length} probe={probe} loading={loading} error={error} onCreated={refresh} />}
            {page === 'tasks' && <TaskList styles={styles} tasks={tasks} loading={loading} />}
            {page === 'skills' && <Placeholder styles={styles} icon={<BrainCircuit20Regular />} title="技能库正在迁移" body="下一阶段接入 DSH 后，成功任务会沉淀为待审核的散热 Skill 草稿。" />}
            {page === 'nodes' && <Placeholder styles={styles} icon={<DesktopPulse20Regular />} title="当前只有本机节点" body="节点发现、设备配对和任务租约会在单机求解闭环稳定后启用。" />}
            {page === 'settings' && <IcepakSettings styles={styles} probe={probe} />}
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
      <TaskPanel styles={styles} tasks={tasks} loading={loading} error={error} />
      <CreateTaskPanel styles={styles} onCreated={onCreated} />
    </section>
  </>
}

function TaskPanel({ styles, tasks, loading, error }: { styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; loading: boolean; error: string }) {
  return <div className={styles.panel}><h2 className={styles.panelTitle}>最近任务</h2>{loading ? <div className={styles.empty}><Spinner label="正在读取本地任务" /></div> : error ? <p className={styles.error}>{error}</p> : tasks.length === 0 ? <div className={styles.empty}><div><DocumentData20Regular fontSize={28} /><p>还没有任务。可以先创建一个需求草稿。</p></div></div> : <TaskTable styles={styles} tasks={tasks.slice(0, 8)} />}</div>
}

function TaskList({ styles, tasks, loading }: { styles: ReturnType<typeof useStyles>; tasks: TaskRecord[]; loading: boolean }) {
  return <><div className={styles.intro}><div><h1 className={styles.title}>任务</h1><p className={styles.subtitle}>执行状态、热判定和审批状态分别记录，避免把求解完成误认为热设计达标。</p></div></div><div className={styles.panel}>{loading ? <Spinner label="正在加载任务" /> : tasks.length ? <TaskTable styles={styles} tasks={tasks} /> : <div className={styles.empty}>当前没有任务。</div>}</div></>
}

function TaskTable({ styles, tasks }: { styles: ReturnType<typeof useStyles>; tasks: TaskRecord[] }) {
  return <div style={{ overflowX: 'auto' }}><table className={styles.table}><thead className={styles.tableHead}><tr><th className={styles.tableCell}>任务</th><th className={styles.tableCell}>执行状态</th><th className={styles.tableCell}>热判定</th><th className={styles.tableCell}>版本</th></tr></thead><tbody>{tasks.map(task => <tr key={task.id}><td className={styles.tableCell}><strong>{task.title}</strong><div className={styles.details}>{task.description || '尚未填写补充说明'}</div></td><td className={styles.tableCell}><Badge appearance="outline">{task.executionStatus}</Badge></td><td className={styles.tableCell}>{task.thermalVerdict}</td><td className={styles.tableCell}>{task.version}</td></tr>)}</tbody></table></div>
}

function CreateTaskPanel({ styles, onCreated }: { styles: ReturnType<typeof useStyles>; onCreated(): Promise<void> }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setSaving(true)
    try {
      const response = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description, ownerNodeId: 'local-node', requirementSnapshot: {} }) })
      if (!response.ok) { const body = await response.json() as { error?: { message?: string } }; throw new Error(body.error?.message ?? '任务未创建') }
      setTitle(''); setDescription(''); await onCreated()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '任务未创建') }
    finally { setSaving(false) }
  }
  return <div className={styles.panel}><h2 className={styles.panelTitle}><Add20Regular />新建需求草稿</h2><form className={styles.form} onSubmit={submit}><Field label="任务名称" required><Input value={title} onChange={(_, data) => setTitle(data.value)} /></Field><Field label="需求描述" hint="当前先保存草稿，真实求解前仍需确认参数和模型。"><Textarea resize="vertical" value={description} onChange={(_, data) => setDescription(data.value)} /></Field>{error && <div className={styles.error}>{error}</div>}<Button type="submit" appearance="primary" disabled={!title.trim() || saving}>{saving ? '正在保存' : '保存草稿'}</Button></form></div>
}

function IcepakSettings({ styles, probe }: { styles: ReturnType<typeof useStyles>; probe: IcepakEnvironmentProbe | null }) {
  const [projectPath, setProjectPath] = useState('')
  const [version, setVersion] = useState('2024.2')
  const [ratio, setRatio] = useState('1.1')
  const [running, setRunning] = useState<'inspect' | 'fan-check' | null>(null)
  const [result, setResult] = useState<IcepakProjectOperationResult | null>(null)
  const [error, setError] = useState('')

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

function Placeholder({ styles, icon, title, body }: { styles: ReturnType<typeof useStyles>; icon: JSX.Element; title: string; body: string }) {
  return <div className={styles.panel}><div className={styles.empty}><div className={styles.placeholder}><span className={styles.iconMuted}>{icon}</span><h2>{title}</h2><p>{body}</p></div></div></div>
}
