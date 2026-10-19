import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { parseCreateSkillRunInput, parseCreateTaskInput, parseExpectedVersionInput, parseIcepakCandidateInput, parseIcepakProjectOperationInput, parseOptimizationSkillInput, parseUpdateOptimizationSkillInput, parseSkillReviewInput, parseTaskApprovalDecisionInput, parseTaskTransitionInput } from '@thermal-agent/contracts'
import { createTask, InvalidTaskTransitionError } from '@thermal-agent/domain'
import { LocalDatabase, PeerConflictError, SkillConflictError, SkillNotFoundError, TaskApprovalConflictError, TaskNotFoundError, VersionConflictError } from '@thermal-agent/sqlite-store'
import { type IcepakPluginPort } from './icepak-plugin-client.js'
import { PluginHost } from './plugin-host.js'
import { pluginRuntimeReferences } from './plugin-runtime-references.js'
import { MAX_PLUGIN_RELEASE_BYTES } from './plugin-release.js'
import { ParameterPlanManager } from './parameter-plans.js'
import { ModelPreparationManager, ModelPreparationConflict } from './model-preparations.js'
import { taskModelFiles } from './task-model-files.js'
import { ModelPreparationStore } from '@thermal-agent/sqlite-store'
import { lockIcepakOperations, IcepakOperationBusyError } from './icepak-operation-lock.js'
import { IcepakExecutionManager } from './execution-manager.js'
import { DshRuntime } from './dsh-runtime.js'
import { SkillPublisher } from './skill-publisher.js'
import { CoreEventStream } from './event-stream.js'
import { LanPublisher } from './lan-publisher.js'
import { type ReportPort } from './report-client.js'
import { ReportConflictError, ReportManager } from './report-manager.js'
import { NodeIdentity } from './node-identity.js'
import { PeerDiscovery, type PeerDiscoveryOptions } from './peer-discovery.js'
import { PeerAuth, PeerAuthError } from './peer-auth.js'
import { PeerSecureChannel, PeerSecureError } from './peer-secure-channel.js'
import { PeerArtifactError, PeerArtifactTransfer } from './peer-artifact-transfer.js'
import { PeerLeaseControl, PeerLeaseError } from './peer-lease-control.js'
import { PeerTaskInbox, PeerTaskError } from './peer-task-inbox.js'
import { PeerTaskDispatcher, PeerDispatchError } from './peer-task-dispatcher.js'
import { PeerRemoteInputProcessor } from './peer-remote-input-processor.js'
import { PeerRemoteRunControl, PeerRemoteRunError } from './peer-remote-run-control.js'
import { PeerRemoteSolveProcessor } from './peer-remote-solve-processor.js'
import { PeerAutoDispatcher } from './peer-auto-dispatcher.js'
import { effectiveIcepakProbe } from './icepak-readiness.js'
import { recommendOptimizationSkills } from './optimization-recommender.js'
import { CAD_EXTENSIONS, aedtModelAssessment, cadModelAssessment, curveFanNames, failedAedtAssessment } from './model-capabilities.js'
import { heartbeatFreeDiskBytes, localFreeDiskBytes } from './peer-disk-capacity.js'
import { TaskWorkspace } from './task-workspace.js'
import type { IcepakEnvironmentProbe, PeerHeartbeat } from '@thermal-agent/contracts'

export interface CoreAppOptions {
  home: string
  sampleProjectPath?: string
  pluginClient?: IcepakPluginPort
  pluginHost?: PluginHost
  webRoot?: string
  startAgentRuntime?: boolean
  reportClient?: ReportPort
  discoveryOptions?: PeerDiscoveryOptions
  startRemoteSolve?: boolean
}

export interface CoreApp {
  server: Server
  database: LocalDatabase
  artifacts: ArtifactStore
  nodeIdentity: NodeIdentity
  plugins: PluginHost
  close(): Promise<void>
}

export function createCoreApp(options: CoreAppOptions): CoreApp {
  const home = resolve(options.home)
  mkdirSync(home, { recursive: true })
  const database = new LocalDatabase(join(home, 'data', 'thermal.db'))
  let plugins: PluginHost
  try { plugins = options.pluginHost ?? new PluginHost(join(home, 'plugins')) }
  catch (error) { database.close(); throw error }
  let nodeIdentity: NodeIdentity
  try {
    nodeIdentity = NodeIdentity.loadOrCreate(home, database.getLocalIdentity()?.nodeId)
    database.bindLocalIdentity(nodeIdentity.publicIdentity)
  } catch (error) {
    database.close()
    void plugins.close()
    throw error
  }
  const modelStore = new ModelPreparationStore(database.path)
  try { modelStore.recover() }
  catch (error) { modelStore.close(); database.close(); void plugins.close(); throw error }
  database.adoptLegacyLocalTasks(nodeIdentity.nodeId)
  database.reconcileLeases()
  const leaseSweep = setInterval(() => {
    try { database.reconcileLeases() }
    catch (error) { console.error('lease reconciliation failed', error) }
  }, 10_000)
  leaseSweep.unref()
  const artifacts = new ArtifactStore(join(home, 'artifacts'))
  const taskWorkspace = new TaskWorkspace(home)
  const sampleProjectPath = resolve(options.sampleProjectPath ?? process.env.THERMAL_ICEPAK_SAMPLE_PROJECT ?? 'assets/icepak/Project1.aedt')
  for (const task of database.listTasks(500)) taskWorkspace.ensure(task.id)
  plugins.attachEngineeringStore(modelStore)
  plugins.attachRuntimeReferences(() => pluginRuntimeReferences(database, modelStore, artifacts))
  const pluginClient = lockIcepakOperations(options.pluginClient ?? plugins.icepak, modelStore)
  const modelPreparations = new ModelPreparationManager(home, database, artifacts, modelStore, pluginClient)
  const readinessProbe = async (): Promise<IcepakEnvironmentProbe> =>
    effectiveIcepakProbe(await pluginClient.probeEnvironment(), database, artifacts)
  const pendingLaunchProbes = new Map<string, Promise<IcepakEnvironmentProbe>>()
  const launchProbe = (version?: string): Promise<IcepakEnvironmentProbe> => {
    if (!pluginClient.probeLaunchability) throw new RequestError(501, 'PROBE_UNAVAILABLE', 'Icepak launch probe is not supported by this plugin client')
    const key = version ?? ''
    const existing = pendingLaunchProbes.get(key)
    if (existing) return existing
    const pending = pluginClient.probeLaunchability(version).finally(() => pendingLaunchProbes.delete(key))
    pendingLaunchProbes.set(key, pending)
    return pending
  }
  let cachedProbe: IcepakEnvironmentProbe | null = null
  let probedAt = 0
  const capabilityHeartbeat = async (): Promise<PeerHeartbeat> => {
    if (!cachedProbe || Date.now() - probedAt > 60_000 ||
      (!options.pluginClient && !plugins.isCurrentIcepakRuntime(cachedProbe.pluginRuntime))) {
      try { cachedProbe = await pluginClient.probeEnvironment() }
      catch { cachedProbe = null }
      probedAt = Date.now()
    }
    const effective = cachedProbe ? await effectiveIcepakProbe(cachedProbe, database, artifacts) : null
    let freeDiskBytes = 0
    try { freeDiskBytes = heartbeatFreeDiskBytes(await localFreeDiskBytes(dirname(database.path))) }
    catch { /* fail closed: do not advertise capacity when disk cannot be measured */ }
    const operation = modelStore.reconcileRecoveredOperation()
    const status = freeDiskBytes > 0 ? (operation ? 'BUSY' : effective?.status ?? 'DEGRADED') : 'DEGRADED'
    return {
      pluginStatus: status,
      aedtVersions: effective?.aedtVersions ?? [],
      maxConcurrent: status === 'READY' ? 1 : 0,
      activeAttempts: Math.max(database.listActiveAttempts().length, operation ? 1 : 0),
      freeDiskBytes,
    }
  }
  const discovery = new PeerDiscovery(nodeIdentity, database, capabilityHeartbeat, options.discoveryOptions)
  const peerAuth = new PeerAuth(nodeIdentity, database)
  const peerSecure = new PeerSecureChannel(nodeIdentity, database)
  const peerArtifacts = new PeerArtifactTransfer(nodeIdentity.nodeId, database, artifacts)
  const peerLeases = new PeerLeaseControl(nodeIdentity.nodeId, database)
  const remoteRuns = new PeerRemoteRunControl(nodeIdentity.nodeId, database, artifacts)
  const remoteSolve = new PeerRemoteSolveProcessor(home, database, artifacts, pluginClient, discovery, peerSecure, peerArtifacts, readinessProbe)
  const remoteInput = new PeerRemoteInputProcessor(database, discovery, peerSecure, peerArtifacts, () => remoteSolve.wake())
  const peerTasks = new PeerTaskInbox(nodeIdentity.nodeId, database, pluginClient, () => remoteInput.wake(true), readinessProbe)
  const peerDispatcher = new PeerTaskDispatcher(nodeIdentity.nodeId, database, artifacts, peerSecure)
  const autoDispatcher = new PeerAutoDispatcher(nodeIdentity.nodeId, database, discovery, peerDispatcher)
  const executions = new IcepakExecutionManager(home, database, artifacts, pluginClient, modelStore)
  const parameterPlans = new ParameterPlanManager(home, database, artifacts, pluginClient, executions)
  const agentRuntime = new DshRuntime(home, database, pluginClient, nodeIdentity.nodeId, plugins)
  const skillPublisher = new SkillPublisher(join(home, 'workspace'))
  const eventStream = new CoreEventStream(database)
  const reports = new ReportManager(home, database, artifacts, options.reportClient ?? plugins.report)
  remoteInput.start()
  if (options.startRemoteSolve !== false) remoteSolve.start()
  autoDispatcher.start()
  if (options.startAgentRuntime !== false) void agentRuntime.start()
  const webRoot = resolve(options.webRoot ?? process.env.THERMAL_AGENT_WEB_ROOT ?? 'apps/web/dist')

  let lanPublisher: LanPublisher
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void route(request, response, database, artifacts, taskWorkspace, pluginClient, launchProbe, sampleProjectPath, executions, parameterPlans, modelPreparations, plugins, agentRuntime, skillPublisher, reports, eventStream, lanPublisher, discovery, peerAuth, peerSecure, peerArtifacts, peerLeases, remoteRuns, peerTasks, peerDispatcher, autoDispatcher, webRoot, home, nodeIdentity).catch(error => writeError(response, error))
  }
  const server = createServer(handler)
  lanPublisher = new LanPublisher(handler)

  return {
    server,
    database,
    artifacts,
    nodeIdentity,
    plugins,
    async close() {
      clearInterval(leaseSweep)
      await remoteInput.close()
      await remoteSolve.close()
      await autoDispatcher.close()
      await discovery.stop()
      await lanPublisher.stop()
      peerSecure.close()
      eventStream.close()
      await new Promise<void>((resolveClose, reject) => {
        if (!server.listening) { resolveClose(); return }
        server.close(error => error ? reject(error) : resolveClose())
      })
      await modelPreparations.close()
      await parameterPlans.close()
      await executions.close()
      await agentRuntime.close()
      await plugins.close()
      modelStore.close()
      database.close()
    },
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  database: LocalDatabase,
  artifacts: ArtifactStore,
  taskWorkspace: TaskWorkspace,
  pluginClient: IcepakPluginPort,
  launchProbe: (version?: string) => Promise<IcepakEnvironmentProbe>,
  sampleProjectPath: string,
  executions: IcepakExecutionManager,
  parameterPlans: ParameterPlanManager,
  modelPreparations: ModelPreparationManager,
  plugins: PluginHost,
  agentRuntime: DshRuntime,
  skillPublisher: SkillPublisher,
  reports: ReportManager,
  eventStream: CoreEventStream,
  lanPublisher: LanPublisher,
  discovery: PeerDiscovery,
  peerAuth: PeerAuth,
  peerSecure: PeerSecureChannel,
  peerArtifacts: PeerArtifactTransfer,
  peerLeases: PeerLeaseControl,
  remoteRuns: PeerRemoteRunControl,
  peerTasks: PeerTaskInbox,
  peerDispatcher: PeerTaskDispatcher,
  autoDispatcher: PeerAutoDispatcher,
  webRoot: string,
  home: string,
  nodeIdentity: NodeIdentity,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/api/plugin-runtime' || url.pathname.startsWith('/api/plugin-runtime/')) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', '插件管理仅限本机 App')
    if (request.method === 'GET' && url.pathname === '/api/plugin-runtime') {
      writeJson(response, 200, plugins.status()); return
    }
    if (request.method !== 'POST') throw new RequestError(405, 'METHOD_NOT_ALLOWED', '请使用 POST 更新插件设置')
    assertLocalWriteOrigin(request)
    const body = await readJsonBody(request, url.pathname === '/api/plugin-runtime/install' ? MAX_PLUGIN_RELEASE_BYTES : 2048)
    if (!isObject(body)) throw new RequestError(400, 'INVALID_SETTING', '插件设置必须是对象')
    if (url.pathname === '/api/plugin-runtime/install') {
      plugins.installRelease(Buffer.from(JSON.stringify(body)))
    } else if (url.pathname === '/api/plugin-runtime/policy') {
      if (typeof body.automaticUpdates !== 'boolean') throw new RequestError(400, 'INVALID_SETTING', 'automaticUpdates 必须是布尔值')
      plugins.setAutomaticUpdates(body.automaticUpdates)
    } else if (url.pathname === '/api/plugin-runtime/reconcile') {
      await plugins.reconcile()
    } else if (url.pathname === '/api/plugin-runtime/rollback' || url.pathname === '/api/plugin-runtime/resume') {
      if (typeof body.id !== 'string') throw new RequestError(400, 'INVALID_SETTING', '插件 ID 不能为空')
      if (url.pathname.endsWith('/rollback')) await plugins.rollback(body.id)
      else plugins.resume(body.id)
    } else throw new RequestError(404, 'NOT_FOUND', '未知插件操作')
    writeJson(response, 200, plugins.status()); return
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    writeJson(response, 200, { status: 'ok', service: 'thermal-agent-core', version: '0.1.0' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/workspace') {
    writeJson(response, 200, { path: taskWorkspace.root, taskRoot: join(taskWorkspace.root, 'tasks'), agentPath: taskWorkspace.root })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/peer/v1/challenge') {
    writeJson(response, 200, { response: peerAuth.acceptChallenge(await readJsonBody(request, 8_192)) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/peer/v1/session') {
    writeJson(response, 200, { answer: peerSecure.accept(await readJsonBody(request, 8_192)) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/peer/v1/message') {
    const decrypted = peerSecure.decrypt(await readJsonBody(request, 400_000))
    let message: unknown
    try { message = JSON.parse(decrypted.plaintext.toString('utf8')) as unknown }
    catch { throw new PeerSecureError('INVALID_MESSAGE', 'peer message plaintext is not JSON') }
    let reply: object
    if (isObject(message) && message.operation === 'ping') {
      reply = { operation: 'pong', nodeId: nodeIdentity.nodeId }
    } else if (isObject(message) && message.operation === 'artifact.input.chunk') {
      reply = await peerArtifacts.readLeasedInput(decrypted.peerNodeId, message)
    } else if (isObject(message) && message.operation === 'artifact.result.chunk') {
      reply = await peerArtifacts.receiveResultChunk(decrypted.peerNodeId, message)
    } else if (isObject(message) && message.operation === 'lease.renew') {
      reply = peerLeases.renewForExecutor(decrypted.peerNodeId, message)
    } else if (isObject(message) && message.operation === 'task.baseline.start') {
      reply = remoteRuns.start(decrypted.peerNodeId, message)
    } else if (isObject(message) && message.operation === 'task.baseline.complete') {
      reply = await remoteRuns.complete(decrypted.peerNodeId, message)
    } else if (isObject(message) && message.operation === 'task.baseline.fail') {
      reply = remoteRuns.fail(decrypted.peerNodeId, message)
    } else if (isObject(message) && message.operation === 'task.baseline.offer') {
      reply = await peerTasks.receive(decrypted.peerNodeId, message)
    } else {
      throw new PeerSecureError('OPERATION_DENIED', 'peer operation is not enabled')
    }
    writeJson(response, 200, { message: peerSecure.encrypt(decrypted.sessionId, Buffer.from(JSON.stringify(reply))) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/nodes/local') {
    writeJson(response, 200, { node: nodeIdentity.publicIdentity })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/nodes/discovery') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'peer discovery state is local-only')
    writeJson(response, 200, { discovery: discovery.status() })
    return
  }
  if (url.pathname === '/api/nodes/remote-execution') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'remote execution settings are local-only')
    if (request.method === 'GET') {
      writeJson(response, 200, { enabled: database.remoteExecutionEnabled(), jobs: database.listRemoteJobs() })
      return
    }
    if (request.method === 'POST') {
      assertLocalWriteOrigin(request)
      const value = await readJsonBody(request, 1_024)
      if (!isObject(value) || typeof value.enabled !== 'boolean') throw new RequestError(400, 'INVALID_SETTING', 'enabled must be boolean')
      writeJson(response, 200, { enabled: database.setRemoteExecutionEnabled(value.enabled) })
      return
    }
  }
  if (url.pathname === '/api/nodes/peers') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'peer trust can only be managed from the local App')
    if (request.method === 'GET') {
      writeJson(response, 200, { peers: database.listPeers() })
      return
    }
    if (request.method === 'POST') {
      assertLocalWriteOrigin(request)
      const value = await readJsonBody(request)
      if (!isObject(value) || typeof value.nodeId !== 'string' || typeof value.publicKey !== 'string' || typeof value.displayName !== 'string') {
        throw new RequestError(400, 'INVALID_PEER', 'nodeId, publicKey and displayName are required')
      }
      if (value.nodeId === nodeIdentity.nodeId) throw new RequestError(409, 'SELF_PAIRING', 'a node cannot pair with itself')
      writeJson(response, 201, { peer: database.trustPeer({ nodeId: value.nodeId, algorithm: 'Ed25519', publicKey: value.publicKey }, value.displayName) })
      return
    }
  }
  const revokePeerMatch = url.pathname.match(/^\/api\/nodes\/peers\/(node-[a-f0-9]{32})\/revoke$/iu)
  if (request.method === 'POST' && revokePeerMatch) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'peer trust can only be managed from the local App')
    assertLocalWriteOrigin(request)
    writeJson(response, 200, { peer: database.revokePeer(revokePeerMatch[1]) })
    return
  }
  const verifyPeerMatch = url.pathname.match(/^\/api\/nodes\/peers\/(node-[a-f0-9]{32})\/verify$/iu)
  if (request.method === 'POST' && verifyPeerMatch) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'peer identity verification is local-only')
    assertLocalWriteOrigin(request)
    const peer = discovery.status().discovered.find(item => item.identity.nodeId === verifyPeerMatch[1])
    if (!peer) throw new RequestError(409, 'PEER_NOT_DISCOVERED', 'peer is not currently discovered')
    writeJson(response, 200, { verification: await peerAuth.verifyDiscovered(peer) })
    return
  }
  const connectPeerMatch = url.pathname.match(/^\/api\/nodes\/peers\/(node-[a-f0-9]{32})\/connect$/iu)
  if (request.method === 'POST' && connectPeerMatch) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'peer secure connection is local-only')
    assertLocalWriteOrigin(request)
    const peer = discovery.status().discovered.find(item => item.identity.nodeId === connectPeerMatch[1])
    if (!peer) throw new RequestError(409, 'PEER_NOT_DISCOVERED', 'peer is not currently discovered')
    const connection = await peerSecure.connect(peer)
    writeJson(response, 200, { connection: { nodeId: connection.nodeId, expiresAt: connection.expiresAt } })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/events') {
    eventStream.subscribe(response)
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/lan/status') {
    const local = isLoopbackAddress(request.socket.remoteAddress)
    writeJson(response, 200, { lan: lanPublisher.status(local) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/lan/start') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'LAN publishing can only be managed from the local App')
    const value = await readJsonBody(request)
    const port = typeof value === 'object' && value !== null && 'port' in value ? Number(value.port) : 43111
    const lan = await lanPublisher.start(port)
    try { await discovery.start(lan.port ?? port) }
    catch (error) { console.error('peer discovery unavailable; LAN web remains enabled', error) }
    writeJson(response, 200, { lan, discovery: discovery.status() })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/lan/stop') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'LAN publishing can only be managed from the local App')
    await discovery.stop()
    await lanPublisher.stop()
    peerSecure.close()
    writeJson(response, 200, { lan: lanPublisher.status(false) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/agent/status') {
    const status = agentRuntime.getStatus()
    writeJson(response, 200, { agent: isLoopbackAddress(request.socket.remoteAddress) ? status : { ...status, url: undefined, workspacePath: undefined } })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/agent/restart') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'DSH control is local-only')
    assertLocalWriteOrigin(request)
    await agentRuntime.restart()
    writeJson(response, 202, { agent: agentRuntime.getStatus() })
    return
  }
  if (url.pathname === '/api/agent/sessions') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'DSH sessions are local-only')
    if (request.method === 'GET') { writeJson(response, 200, { sessions: await agentRuntime.listSessions() }); return }
    if (request.method === 'POST') {
      assertLocalWriteOrigin(request)
      writeJson(response, 201, { sessionId: await agentRuntime.createSession() })
      return
    }
  }
  const archiveSessionMatch = url.pathname.match(/^\/api\/agent\/sessions\/(session-[0-9a-f-]{36})\/archive$/iu)
  if (request.method === 'POST' && archiveSessionMatch) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'DSH sessions are local-only')
    assertLocalWriteOrigin(request)
    await agentRuntime.archiveSession(archiveSessionMatch[1])
    writeJson(response, 200, { archived: true })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/skills') {
    writeJson(response, 200, { skills: database.listSkills() })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/models/upload') {
    const encodedName = request.headers['x-model-name']
    if (typeof encodedName !== 'string') throw new RequestError(400, 'MODEL_NAME_REQUIRED', 'model filename is required')
    let name: string
    try { name = decodeURIComponent(encodedName) }
    catch { throw new RequestError(400, 'INVALID_MODEL_NAME', 'model filename is invalid') }
    const extension = extname(name).toLowerCase()
    if (name !== basename(name) || /[/\\\0]/u.test(name) || (extension !== '.aedt' && !CAD_EXTENSIONS.has(extension)) || name.length > 255) {
      throw new RequestError(400, 'INVALID_MODEL_NAME', 'upload one .aedt, STEP, IGES, Parasolid or ACIS file with a valid filename')
    }
    const maxBytes = 2 * 1024 * 1024 * 1024
    const length = Number(request.headers['content-length'] ?? 0)
    if (length > maxBytes) throw new RequestError(413, 'MODEL_TOO_LARGE', 'model exceeds 2 GiB upload limit')
    const model = await artifacts.importStream(request, name, maxBytes)
    database.upsertArtifact(model)
    const projectPath = await artifacts.materialize(model.sha256, join(home, 'models', model.sha256, model.originalName))
    writeJson(response, 201, { model: { sha256: model.sha256, originalName: model.originalName, sizeBytes: model.sizeBytes,
      modelKind: extension === '.aedt' ? 'AEDT' : 'CAD', projectPath } })
    return
  }
  const attemptArtifact = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})\/runs\/([0-9a-f-]{36})\/attempts\/([0-9a-f-]{36})\/artifacts\/([a-f0-9]{64})$/u)
  if (request.method === 'GET' && attemptArtifact) {
    const [, taskId, runId, attemptId, sha] = attemptArtifact
    const run = database.getRun(runId)
    const attempt = database.getAttempt(attemptId)
    if (!run || run.taskId !== taskId || !attempt || attempt.runId !== runId || !database.listAttemptArtifacts(attemptId).some(a => a.sha256 === sha)) {
      throw new RequestError(404, 'ATTEMPT_ARTIFACT_NOT_FOUND', '求解产物不属于指定任务、运行和尝试')
    }
    const artifact = database.getArtifact(sha)
    if (!artifact) throw new RequestError(404, 'ATTEMPT_ARTIFACT_NOT_FOUND', '求解产物不存在')
    response.writeHead(200, { 'Content-Type': artifact.originalName.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'Content-Length': String(artifact.sizeBytes), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.originalName)}`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' })
    await pipeline(createReadStream(artifacts.resolveArtifact(sha)), response); return
  }
  const taskFiles = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})\/model-files(?:\/([a-f0-9]{64}))?(\/location)?$/u)
  if (taskFiles && (request.method === 'GET' || request.method === 'POST')) {
    const [, taskId, sha, location] = taskFiles
    const task = database.getTask(taskId)
    if (!task) throw new TaskNotFoundError(taskId)
    if (location) {
      if (request.method !== 'POST') throw new RequestError(405, 'METHOD_NOT_ALLOWED', '请使用 POST 定位文件')
      if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', '文件定位仅限本机 App')
      assertLocalWriteOrigin(request)
      assertLocalOwner(database, taskId, nodeIdentity.nodeId)
    } else if (request.method !== 'GET') throw new RequestError(405, 'METHOD_NOT_ALLOWED', '请使用 GET 查看文件')
    const listing = taskModelFiles(taskId, database, modelPreparations, taskWorkspace)
    if (!sha) {
      if (location) { writeJson(response, 200, { path: taskWorkspace.ensure(taskId), kind: 'directory' }); return }
      const local = isLoopbackAddress(request.socket.remoteAddress)
      writeJson(response, 200, { workspacePath: local ? listing.workspacePath : undefined,
        files: listing.files.map(file => ({ ...file, path: local ? file.path : undefined })) }); return
    }
    const file = listing.files.find(file => file.sha256 === sha)
    if (!file) throw new RequestError(404, 'TASK_MODEL_FILE_NOT_FOUND', '模型文件不属于当前任务')
    if (location) {
      try { await stat(file.path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await artifacts.materialize(sha, file.path)
      }
      writeJson(response, 200, { path: file.path, kind: 'file' }); return
    }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.sizeBytes),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' })
    await pipeline(createReadStream(artifacts.resolveArtifact(sha)), response); return
  }
  const cadSource = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})\/cad-source\/([a-f0-9]{64})$/u)
  if (request.method === 'GET' && cadSource) {
    const [, taskId, sha] = cadSource
    const task = database.getTask(taskId)
    const original = task?.requirementSnapshot.sourceModel as { sha256?: string } | undefined
    const current = task?.requirementSnapshot.modelKind === 'CAD' ? task.requirementSnapshot.modelSha256 : undefined
    if (!task || (original?.sha256 !== sha && current !== sha && !modelPreparations.context(taskId).inspections.some(i => i.sourceSha256 === sha))) {
      throw new RequestError(404, 'CAD_SOURCE_NOT_FOUND', '源 CAD 不属于当前任务')
    }
    const artifact = database.getArtifact(sha)
    if (!artifact || !/\.(step|stp)$/iu.test(artifact.originalName)) throw new RequestError(404, 'CAD_SOURCE_NOT_FOUND', '只支持 STEP/STP 预览')
    if (artifact.sizeBytes > 32 * 1024 * 1024) throw new RequestError(413, 'CAD_PREVIEW_TOO_LARGE', '首版 3D 预览支持不超过 32 MiB 的 STEP；原建模流程不受影响')
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(artifact.sizeBytes),
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' })
    await pipeline(createReadStream(artifacts.resolveArtifact(sha)), response); return
  }
  const modelArtifact = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})\/model-artifacts\/([a-f0-9]{64})$/u)
  if (request.method === 'GET' && modelArtifact) {
    const [, taskId, sha] = modelArtifact
    const context = modelPreparations.context(taskId)
    if (!context.jobs.some(job => job.artifacts.some(a => a.sha256 === sha))) throw new RequestError(404, 'MODEL_ARTIFACT_NOT_FOUND', '产物不属于当前任务')
    const artifact = database.getArtifact(sha)
    if (!artifact) throw new RequestError(404, 'MODEL_ARTIFACT_NOT_FOUND', '产物不存在')
    const type = artifact.originalName.endsWith('.jpg') ? 'image/jpeg' : artifact.originalName.endsWith('.json') ? 'application/json' : 'application/octet-stream'
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': String(artifact.sizeBytes),
      'Content-Disposition': `${type === 'image/jpeg' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(artifact.originalName)}`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' })
    await pipeline(createReadStream(artifacts.resolveArtifact(sha)), response); return
  }
  const modelRoute = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})\/(cad-inspections|model-preparations|model-spec|model-preparation-jobs)(?:\/([0-9a-f-]{36})(?:\/(validate|activate|cancel|initial-spec))?)?$/iu)
  if (modelRoute) {
    const [, taskId, collection, id, action] = modelRoute
    assertLocalOwner(database, taskId, nodeIdentity.nodeId)
    if (request.method === 'GET' && collection === 'model-preparations' && !id) {
      writeJson(response, 200, modelPreparations.context(taskId)); return
    }
    if (request.method === 'GET' && collection === 'cad-inspections' && id && action === 'initial-spec') {
      writeJson(response, 200, { spec: modelPreparations.initialSpec(taskId, id) }); return
    }
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'CAD 建模操作仅限本机 App')
    assertLocalWriteOrigin(request)
    const body = await readJsonBody(request, 2 * 1024 * 1024)
    if (!isObject(body)) throw new RequestError(400, 'INVALID_REQUEST', '建模请求必须为对象')
    if (request.method === 'POST' && collection === 'cad-inspections' && !id) {
      writeJson(response, 202, { job: modelPreparations.inspect(taskId, { requestId: String(body.requestId ?? ''), version: String(body.version ?? ''), healing: body.healing as boolean }) }); return
    }
    if (request.method === 'PUT' && collection === 'model-spec' && !id) {
      writeJson(response, 200, { draft: modelPreparations.saveDraft(taskId, body.spec, Number(body.expectedVersion)) }); return
    }
    if (request.method === 'POST' && collection === 'model-preparations' && !id) {
      writeJson(response, 202, { job: modelPreparations.prepare(taskId, { requestId: String(body.requestId ?? ''), draftVersion: Number(body.draftVersion) }) }); return
    }
    if (request.method === 'POST' && collection === 'model-preparations' && id && action === 'validate') {
      writeJson(response, 202, { job: modelPreparations.validate(taskId, id, String(body.requestId ?? '')) }); return
    }
    if (request.method === 'POST' && collection === 'model-preparations' && id && action === 'activate') {
      writeJson(response, 200, { task: await modelPreparations.activate(taskId, id, Number(body.expectedVersion)) }); return
    }
    if (request.method === 'POST' && collection === 'model-preparation-jobs' && id && action === 'cancel') {
      writeJson(response, 200, { job: modelPreparations.cancel(taskId, id) }); return
    }
    throw new RequestError(404, 'NOT_FOUND', '不支持的建模操作')
  }
  const checkModelMatch = url.pathname.match(/^\/api\/models\/([a-f0-9]{64})\/check$/u)
  if (request.method === 'POST' && checkModelMatch) {
    const sha = checkModelMatch[1]
    const model = database.getArtifact(sha)
    if (!model) throw new RequestError(404, 'MODEL_NOT_FOUND', 'uploaded model was not found')
    const versionInput = await readJsonBody(request, 1_024)
    const version = isObject(versionInput) && typeof versionInput.version === 'string' && versionInput.version.trim()
      ? versionInput.version.trim().slice(0, 50) : '2024.2'
    const extension = extname(model.originalName).toLowerCase()
    if (CAD_EXTENSIONS.has(extension)) {
      const assessment = cadModelAssessment(sha)
      database.saveModelCapabilityAssessment(assessment)
      writeJson(response, 200, { assessment })
      return
    }
    if (extension !== '.aedt') throw new RequestError(400, 'INVALID_MODEL', 'unsupported model type')
    const projectPath = join(home, 'models', sha, model.originalName)
    let assessment
    try {
      const inspection = await pluginClient.inspectProject({ projectPath, version, outputDir: join(home, 'runs', 'model-check', randomUUID()) })
      let fanCheck = null
      let fanCheckError = null
      if (curveFanNames(inspection).length) {
        try { fanCheck = await pluginClient.fanCheck({ projectPath, version, fanSpeedRatio: 1.1, outputDir: join(home, 'runs', 'model-fan-check', randomUUID()) }) }
        catch (error) { fanCheckError = error instanceof Error ? error.message.slice(0, 500) : 'fan action check failed' }
      }
      assessment = aedtModelAssessment(sha, version, inspection, fanCheck, fanCheckError)
    } catch (error) {
      assessment = failedAedtAssessment(sha, version, error instanceof Error ? error.message.slice(0, 500) : 'Icepak project inspection failed')
    }
    database.saveModelCapabilityAssessment(assessment)
    writeJson(response, 200, { assessment })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/optimization/skills') {
    const input = parseOptimizationSkillInput(await readJsonBody(request, 32_000))
    writeJson(response, 201, { skill: database.createOptimizationSkill(input, 'app') })
    return
  }
  const editOptimizationSkillMatch = url.pathname.match(/^\/api\/optimization\/skills\/([0-9a-f-]+)$/iu)
  if (request.method === 'PATCH' && editOptimizationSkillMatch) {
    const input = parseUpdateOptimizationSkillInput(await readJsonBody(request, 32_000))
    writeJson(response, 200, { skill: database.updateOptimizationSkill(editOptimizationSkillMatch[1], input) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/optimization/recommendations') {
    const input = await readJsonBody(request, 16_000)
    if (!isObject(input) || typeof input.requirement !== 'string' || input.requirement.length > 12_000) {
      throw new RequestError(400, 'INVALID_REQUIREMENT', 'requirement must be a string of at most 12000 characters')
    }
    writeJson(response, 200, { recommendations: recommendOptimizationSkills(database, input.requirement), basis: 'keyword-pre-screening; all diagnostics and temperature drops are unverified' })
    return
  }
  const skillMatch = url.pathname.match(/^\/api\/skills\/([0-9a-f-]+)$/iu)
  if (request.method === 'GET' && skillMatch) {
    const skill = database.getSkill(skillMatch[1])
    if (!skill) throw new SkillNotFoundError(skillMatch[1])
    writeJson(response, 200, { skill })
    return
  }
  const skillRunMatch = url.pathname.match(/^\/api\/skills\/([0-9a-f-]+)\/runs$/iu)
  if (request.method === 'POST' && skillRunMatch) {
    const input = parseCreateSkillRunInput(await readJsonBody(request))
    const skill = database.getSkill(skillRunMatch[1])
    if (!skill) throw new SkillNotFoundError(skillRunMatch[1])
    if (skill.kind === 'OPTIMIZATION') throw new SkillConflictError('optimization guidance cannot start a Skill Run')
    if (skill.status !== 'ENABLED') throw new SkillConflictError('skill must be ENABLED before it can run')
    const detected = await pluginClient.probeEnvironment()
    const probe = detected.status === 'DETECTED' && pluginClient.probeLaunchability
      ? await launchProbe(input.version)
      : detected
    if (!['LAUNCHABLE', 'PROJECT_COMPATIBLE', 'READY'].includes(probe.status)) {
      throw new RequestError(409, 'ICEPAK_NOT_LAUNCHABLE', `Icepak environment is ${probe.status}`)
    }
    const inspectOutput = join(home, 'runs', 'skill-inspect', randomUUID())
    const inspection = await pluginClient.inspectProject({
      projectPath: input.projectPath, version: input.version, outputDir: inspectOutput,
    })
    if (!inspection.validation.verified) throw new RequestError(409, 'ICEPAK_PROJECT_INVALID', 'Icepak project inspection was not verified')
    const taskId = randomUUID()
    const task = createTask({
      title: input.title, description: input.description, ownerNodeId: nodeIdentity.nodeId,
      requirementSnapshot: {
        taskWorkspacePath: taskWorkspace.ensure(taskId),
        projectPath: input.projectPath, aedtVersion: input.version ?? probe.selectedVersion ?? undefined,
        cores: input.cores ?? 4, ...(input.targetTmaxC === undefined ? {} : { targetTmaxC: input.targetTmaxC }),
        skillId: skill.id, skillVersion: skill.activeVersion,
        inspection: { inputSha256: inspection.inputSha256, design: inspection.project.activeDesign, verified: inspection.validation.verified },
      },
    }, undefined, taskId)
    const created = database.createTaskFromSkill(skill.id, task, { ...input }, {
      probe: { status: probe.status, selectedVersion: probe.selectedVersion, capabilities: probe.capabilities },
      inspect: { inputSha256: inspection.inputSha256, activeDesign: inspection.project.activeDesign, verified: inspection.validation.verified },
    })
    writeJson(response, 201, created)
    return
  }
  const draftSkillMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/skill-draft$/iu)
  if (request.method === 'POST' && draftSkillMatch) {
    writeJson(response, 201, { skill: database.createSkillDraftFromTask(draftSkillMatch[1]) })
    return
  }
  const enableSkillMatch = url.pathname.match(/^\/api\/skills\/([0-9a-f-]+)\/enable$/iu)
  if (request.method === 'POST' && enableSkillMatch) {
    const input = parseSkillReviewInput(await readJsonBody(request))
    const skill = database.getSkill(enableSkillMatch[1])
    if (!skill) throw new SkillNotFoundError(enableSkillMatch[1])
    if (skill.kind === 'OPTIMIZATION') throw new SkillConflictError('built-in optimization guidance is not a solved workflow')
    if (skill.updatedAt !== input.expectedUpdatedAt) throw new SkillConflictError('skill was changed by another operation')
    const publishedPath = skillPublisher.publish(skill)
    writeJson(response, 200, { skill: database.reviewSkill(skill.id, 'ENABLED', input.reviewer, input.expectedUpdatedAt, publishedPath) })
    return
  }
  const disableSkillMatch = url.pathname.match(/^\/api\/skills\/([0-9a-f-]+)\/disable$/iu)
  if (request.method === 'POST' && disableSkillMatch) {
    const input = parseSkillReviewInput(await readJsonBody(request))
    const skill = database.getSkill(disableSkillMatch[1])
    if (!skill) throw new SkillNotFoundError(disableSkillMatch[1])
    if (skill.kind === 'OPTIMIZATION') throw new SkillConflictError('built-in optimization guidance cannot be disabled as a solved workflow')
    if (skill.updatedAt !== input.expectedUpdatedAt) throw new SkillConflictError('skill was changed by another operation')
    skillPublisher.unpublish(skill.publishedPath)
    writeJson(response, 200, { skill: database.reviewSkill(skill.id, 'DISABLED', input.reviewer, input.expectedUpdatedAt, null) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/tasks') {
    const limit = Number(url.searchParams.get('limit') ?? '100')
    const tasks = database.listTasks(Number.isFinite(limit) ? limit : 100)
    for (const task of tasks) taskWorkspace.ensure(task.id)
    writeJson(response, 200, { tasks })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const value = await readJsonBody(request)
    const input = parseCreateTaskInput({ ...(isObject(value) ? value : {}), ownerNodeId: nodeIdentity.nodeId })
    const id = randomUUID()
    const snapshot = await prepareIntakeSnapshot(input.requirementSnapshot, database, home)
    const taskSnapshot = await bindTaskSnapshot(id, snapshot, taskWorkspace, artifacts, database)
    const hypotheses = recommendOptimizationSkills(database, `${input.title}\n${input.description}\n${String(taskSnapshot.workCondition ?? '')}\n${String(taskSnapshot.criticalPoints ?? '')}`).filter(item => item.suggested)
    const task = database.createTask(createTask({ ...input, requirementSnapshot: {
      ...taskSnapshot,
      optimizationHypotheses: hypotheses.map(item => ({ skillKey: item.key, matchedSignals: item.matchedSignals, evidenceStatus: item.evidenceStatus })),
      optimizationSuggestions: hypotheses,
    } }, undefined, id))
    writeJson(response, 201, { task })
    return
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/iu)
  if (request.method === 'PATCH' && taskMatch) {
    const value = await readJsonBody(request)
    if (!isObject(value)) throw new RequestError(400, 'INVALID_TASK', 'task input must be an object')
    const current = database.getTask(taskMatch[1])
    if (!current) throw new TaskNotFoundError(taskMatch[1])
    if (current.ownerNodeId !== nodeIdentity.nodeId) throw new RequestError(403, 'NOT_OWNER', 'only the owner may edit this draft')
    const input = parseCreateTaskInput({ ...value, ownerNodeId: nodeIdentity.nodeId })
    const snapshot = await prepareIntakeSnapshot(input.requirementSnapshot, database, home)
    const taskSnapshot = await bindTaskSnapshot(current.id, snapshot, taskWorkspace, artifacts, database)
    const hypotheses = recommendOptimizationSkills(database, `${input.title}\n${input.description}\n${String(snapshot.workCondition ?? '')}\n${String(snapshot.criticalPoints ?? '')}`).filter(item => item.suggested)
    const expectedVersion = parseExpectedVersionInput(value).expectedVersion
    writeJson(response, 200, { task: database.updateTaskDraft(taskMatch[1], input.title, input.description, {
      ...taskSnapshot,
      ...(current.requirementSnapshot.source === 'dsh-natural-language' ? { source: 'dsh-natural-language' } : {}),
      ...(current.requirementSnapshot.sourceSessionId ? { sourceSessionId: current.requirementSnapshot.sourceSessionId } : {}),
      ...(current.requirementSnapshot.conversationAttachments ? { conversationAttachments: current.requirementSnapshot.conversationAttachments } : {}),
      optimizationHypotheses: hypotheses.map(item => ({ skillKey: item.key, matchedSignals: item.matchedSignals, evidenceStatus: item.evidenceStatus })),
      optimizationSuggestions: hypotheses,
    }, expectedVersion) })
    return
  }
  const taskNotesMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/notes$/iu)
  if (request.method === 'POST' && taskNotesMatch) {
    assertLocalOwner(database, taskNotesMatch[1], nodeIdentity.nodeId)
    const input = await readJsonBody(request, 4_096)
    if (!isObject(input) || typeof input.author !== 'string' || !input.author.trim() || input.author.length > 100 ||
      typeof input.content !== 'string' || !input.content.trim() || input.content.length > 2_000) {
      throw new RequestError(400, 'INVALID_TASK_NOTE', 'author and content are required within the size limit')
    }
    writeJson(response, 201, { event: database.addTaskNote(taskNotesMatch[1], input.author.trim(), input.content.trim()) })
    return
  }
  if (request.method === 'GET' && taskMatch) {
    const task = database.getTask(taskMatch[1])
    if (!task) throw new TaskNotFoundError(taskMatch[1])
    taskWorkspace.ensure(task.id)
    const runs = await Promise.all(database.listTaskRuns(task.id).map(async run => ({
      ...run,
      attempts: await Promise.all(database.listRunAttempts(run.id).map(async attempt => {
        const linked = database.listAttemptArtifacts(attempt.id)
        const result = linked.find(item => item.role === 'SOLVER_RESULT')
        let resultSummary: { tmaxC: number | null; converged: boolean | null } | null = null
        if (result) {
          try {
            const parsed = JSON.parse(await readFile(artifacts.resolveArtifact(result.sha256), 'utf8')) as { metrics?: Record<string, unknown> }
            const tmax = parsed.metrics?.tmaxC == null ? Number.NaN : Number(parsed.metrics.tmaxC)
            resultSummary = { tmaxC: Number.isFinite(tmax) ? tmax : null,
              converged: typeof parsed.metrics?.converged === 'boolean' ? parsed.metrics.converged : null }
          } catch { /* Preserve artifact links even when a result cannot be summarized. */ }
        }
        return { ...attempt, artifacts: linked, resultSummary }
      })),
    })))
    writeJson(response, 200, { task, runs, events: database.listTaskEvents(task.id), parameterPlans: database.listParameterPlans(task.id), skillRun: database.getSkillRunForTask(task.id) })
    return
  }
  const reportMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/report$/iu)
  if (request.method === 'POST' && reportMatch) {
    writeJson(response, 201, { report: await reports.createTaskReport(reportMatch[1]) })
    return
  }
  if (request.method === 'GET' && reportMatch) {
    const report = reports.getTaskReport(reportMatch[1])
    if (!report) throw new RequestError(404, 'REPORT_NOT_FOUND', 'task report has not been generated')
    const data = await readFile(artifacts.resolveArtifact(report.artifact.sha256))
    response.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': String(data.length),
      'Content-Disposition': `inline; filename="${report.artifact.originalName.replaceAll('"', '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(data)
    return
  }
  const transitionMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/transitions$/iu)
  if (request.method === 'POST' && transitionMatch) {
    const input = parseTaskTransitionInput(await readJsonBody(request))
    if (!['READY', 'CANCELLED'].includes(input.status)) {
      throw new RequestError(400, 'TRANSITION_REQUIRES_WORKFLOW', 'this task transition must be performed by its controlled workflow')
    }
    if (input.status === 'READY') {
      if (modelPreparations.hasActiveTask(transitionMatch[1])) throw new RequestError(409, 'MODEL_PREPARATION_ACTIVE', '当前任务仍在导入、生成或验证模型，请完成或取消作业后再确认需求')
      const draft = database.getTask(transitionMatch[1])
      if (!draft) throw new TaskNotFoundError(transitionMatch[1])
      if (draft.requirementSnapshot.intakeVersion === 2) {
        const snapshot = draft.requirementSnapshot
        if (typeof snapshot.modelSha256 !== 'string' || !database.getArtifact(snapshot.modelSha256)) {
          throw new RequestError(409, 'MODEL_REQUIRED', 'upload and attach a model before confirming the task')
        }
        if (snapshot.simulationInput) modelPreparations.assertSimulationInput(draft.id)
        if (snapshot.modelKind !== 'AEDT') {
          throw new RequestError(409, 'ICEPAK_MODEL_REQUIRED', 'CAD intake must be prepared as an Icepak .aedt project before simulation')
        }
        const assessment = database.getModelCapabilityAssessment(snapshot.modelSha256)
        if (!assessment || assessment.status !== 'READY_FOR_BASELINE' || assessment.aedtVersion !== snapshot.aedtVersion) {
          throw new RequestError(409, 'MODEL_CHECK_REQUIRED', 'run the Icepak model capability check before confirming the task')
        }
        if (snapshot.autoFanRatio !== undefined && assessment.items.find(item => item.skillKey === 'optimization-04-fan-selection')?.status !== 'EXECUTABLE') {
          throw new RequestError(409, 'FAN_NOT_EXECUTABLE', 'fan adjustment was not verified for this model')
        }
        if (!draft.description.trim() || !Number.isFinite(snapshot.targetTmaxC)) {
          throw new RequestError(409, 'REQUIREMENT_INCOMPLETE', 'thermal requirement and maximum temperature target are required')
        }
        if (snapshot.planConfirmed !== true) throw new RequestError(409, 'PLAN_NOT_CONFIRMED', 'review and confirm the optimization plan before execution')
      }
    }
    const task = database.transitionTask(transitionMatch[1], input.status, input.expectedVersion, input.reason)
    if (input.status === 'CANCELLED') modelPreparations.cancelTaskJobs(task.id)
    if (input.status === 'READY') database.updateSkillRunStep(task.id, 'confirm', 'COMPLETED', { taskVersion: task.version })
    writeJson(response, 200, { task })
    return
  }
  const approvalMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/approval$/iu)
  if (request.method === 'POST' && approvalMatch) {
    const input = parseTaskApprovalDecisionInput(await readJsonBody(request))
    const task = database.resolveTaskApproval(approvalMatch[1], input.decision, input.expectedVersion, input.reason)
    database.updateSkillRunStep(task.id, 'judge', input.decision === 'APPROVED' ? 'COMPLETED' : 'FAILED', {
      thermalVerdict: task.thermalVerdict, approvalStatus: task.approvalStatus,
    }, input.decision === 'REJECTED' ? { code: 'USER_REJECTED_RESULT', message: input.reason ?? '用户拒绝当前结果' } : undefined)
    const skillResult = database.finishSkillRunForTask(task.id, input.decision === 'APPROVED', input.reason ?? `结果${input.decision}`)
    if (skillResult?.skill.status === 'NEEDS_REPAIR' && skillResult.skill.publishedPath) {
      skillPublisher.unpublish(skillResult.skill.publishedPath)
      database.clearSkillPublishedPath(skillResult.skill.id)
    }
    writeJson(response, 200, { task })
    return
  }
  const baselineMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/runs\/baseline$/iu)
  if (request.method === 'POST' && baselineMatch) {
    assertLocalOwner(database, baselineMatch[1], nodeIdentity.nodeId)
    if (database.getAutoDispatch(baselineMatch[1])?.status === 'WAITING') {
      throw new RequestError(409, 'AUTO_DISPATCH_PENDING', 'cancel automatic dispatch before starting a local Baseline')
    }
    if (modelPreparations.busy) throw new IcepakOperationBusyError()
    if (parameterPlans.busy) throw new RequestError(409, 'PARAMETERS_BUSY', '参数验证进行中，请稍后启动求解')
    const input = parseIcepakProjectOperationInput(await readJsonBody(request))
    const started = await executions.startBaseline(baselineMatch[1], input)
    database.updateSkillRunStep(baselineMatch[1], 'solve', 'RUNNING', { runId: started.run.id, attemptId: started.attempt.id })
    writeJson(response, 202, started)
    return
  }
  const remoteBaselineMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/runs\/remote-baseline$/iu)
  if (request.method === 'POST' && remoteBaselineMatch) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'remote dispatch is local-only')
    assertLocalWriteOrigin(request)
    assertLocalOwner(database, remoteBaselineMatch[1], nodeIdentity.nodeId)
    const value = await readJsonBody(request)
    if (!isObject(value) || typeof value.peerNodeId !== 'string') throw new RequestError(400, 'INVALID_DISPATCH', 'peerNodeId is required')
    const version = parseExpectedVersionInput(value).expectedVersion
    const input = parseIcepakProjectOperationInput(value)
    const peer = discovery.status().discovered.find(item => item.identity.nodeId === value.peerNodeId)
    if (!peer) throw new RequestError(409, 'PEER_NOT_DISCOVERED', 'executor is not currently discovered')
    writeJson(response, 202, await peerDispatcher.dispatchBaseline(remoteBaselineMatch[1], peer, version, input))
    return
  }
  if (url.pathname === '/api/auto-dispatch' && request.method === 'GET') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'automatic dispatch intents are local-only')
    writeJson(response, 200, { requests: database.listAutoDispatches() })
    return
  }
  const autoDispatchMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/auto-dispatch$/iu)
  if (autoDispatchMatch && request.method === 'POST') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'automatic dispatch is local-only')
    assertLocalWriteOrigin(request)
    assertLocalOwner(database, autoDispatchMatch[1], nodeIdentity.nodeId)
    const value = await readJsonBody(request)
    const version = parseExpectedVersionInput(value).expectedVersion
    const input = parseIcepakProjectOperationInput(value)
    const intent = await peerDispatcher.queueAutomaticBaseline(autoDispatchMatch[1], version, input)
    autoDispatcher.wake()
    writeJson(response, 202, { request: intent })
    return
  }
  if (autoDispatchMatch && request.method === 'DELETE') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'automatic dispatch is local-only')
    assertLocalWriteOrigin(request)
    assertLocalOwner(database, autoDispatchMatch[1], nodeIdentity.nodeId)
    writeJson(response, 200, { request: database.cancelAutoDispatch(autoDispatchMatch[1], nodeIdentity.nodeId) })
    return
  }
  const retryOfferMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/runs\/remote-baseline\/retry-offer$/iu)
  if (request.method === 'POST' && retryOfferMatch) {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'remote dispatch is local-only')
    assertLocalWriteOrigin(request)
    assertLocalOwner(database, retryOfferMatch[1], nodeIdentity.nodeId)
    const value = await readJsonBody(request, 2_048)
    if (!isObject(value) || typeof value.peerNodeId !== 'string') throw new RequestError(400, 'INVALID_DISPATCH', 'peerNodeId is required')
    const version = parseExpectedVersionInput(value).expectedVersion
    const peer = discovery.status().discovered.find(item => item.identity.nodeId === value.peerNodeId)
    if (!peer) throw new RequestError(409, 'PEER_NOT_DISCOVERED', 'executor is not currently discovered')
    writeJson(response, 202, await peerDispatcher.retryOffer(retryOfferMatch[1], peer, version))
    return
  }
  const parameterArtifactMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/parameter-plans\/([0-9a-f-]+)\/(project|evidence)$/iu)
  if (request.method === 'GET' && parameterArtifactMatch) {
    const plan = database.getParameterPlan(parameterArtifactMatch[2])
    if (!plan || plan.taskId !== parameterArtifactMatch[1]) throw new RequestError(404, 'PLAN_NOT_FOUND', '修改方案不存在')
    const project = parameterArtifactMatch[3] === 'project'
    const sha = project ? plan.verifiedProjectSha256 : plan.evidenceSha256
    if (!sha) throw new RequestError(404, 'EVIDENCE_NOT_FOUND', '验证产物尚未生成')
    const artifact = database.getArtifact(sha)
    if (!artifact) throw new RequestError(404, 'EVIDENCE_NOT_FOUND', '验证产物不存在')
    const path = artifacts.resolveArtifact(sha)
    const info = await stat(path)
    response.writeHead(200, { 'Content-Type': project ? 'application/octet-stream' : 'application/json',
      'Content-Length': info.size, 'Content-Disposition': `attachment; filename="parameters-v${plan.revision}.${project ? 'aedt' : 'json'}"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
    await pipeline(createReadStream(path), response)
    return
  }
  const parameterContextMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/parameters$/iu)
  if (request.method === 'GET' && parameterContextMatch) {
    writeJson(response, 200, await parameterPlans.context(parameterContextMatch[1]))
    return
  }
  const parameterRefreshMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/parameters\/refresh$/iu)
  if (request.method === 'POST' && parameterRefreshMatch) {
    assertLocalWriteOrigin(request)
    assertLocalOwner(database, parameterRefreshMatch[1], nodeIdentity.nodeId)
    writeJson(response, 200, await parameterPlans.refreshCatalog(parameterRefreshMatch[1]))
    return
  }
  const parameterPlanMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/parameter-plans(?:\/([0-9a-f-]+)\/execute)?$/iu)
  if (parameterPlanMatch && request.method === 'POST') {
    assertLocalWriteOrigin(request)
    assertLocalOwner(database, parameterPlanMatch[1], nodeIdentity.nodeId)
    const value = await readJsonBody(request, 64_000)
    const plan = parameterPlanMatch[2]
      ? await parameterPlans.execute(parameterPlanMatch[1], parameterPlanMatch[2], parseExpectedVersionInput(value).expectedVersion)
      : await parameterPlans.submit(parameterPlanMatch[1], value)
    writeJson(response, 202, { plan })
    return
  }
  if (parameterPlanMatch && request.method === 'GET' && !parameterPlanMatch[2]) {
    const plans = database.listParameterPlans(parameterPlanMatch[1])
    writeJson(response, 200, { plans })
    return
  }
  const candidateMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/runs\/candidate$/iu)
  if (request.method === 'POST' && candidateMatch) {
    assertLocalOwner(database, candidateMatch[1], nodeIdentity.nodeId)
    if (modelPreparations.busy) throw new IcepakOperationBusyError()
    if (parameterPlans.busy) throw new RequestError(409, 'PARAMETERS_BUSY', '参数验证进行中，请稍后启动求解')
    const input = parseIcepakCandidateInput(await readJsonBody(request))
    const started = await executions.startCandidate(candidateMatch[1], input)
    database.updateSkillRunStep(candidateMatch[1], 'solve', 'RUNNING', { runId: started.run.id, attemptId: started.attempt.id, kind: 'CANDIDATE' })
    writeJson(response, 202, started)
    return
  }
  const retryMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/runs\/retry$/iu)
  if (request.method === 'POST' && retryMatch) {
    assertLocalOwner(database, retryMatch[1], nodeIdentity.nodeId)
    const input = parseExpectedVersionInput(await readJsonBody(request))
    const started = await executions.retryLatestRun(retryMatch[1], input.expectedVersion)
    database.updateSkillRunStep(retryMatch[1], 'solve', 'RUNNING', { runId: started.run.id, attemptId: started.attempt.id, retry: true })
    writeJson(response, 202, started)
    return
  }
  const cancelAttemptMatch = url.pathname.match(/^\/api\/attempts\/([0-9a-f-]+)\/cancel$/iu)
  if (request.method === 'POST' && cancelAttemptMatch) {
    executions.cancel(cancelAttemptMatch[1])
    writeJson(response, 202, { accepted: true, attemptId: cancelAttemptMatch[1] })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/plugins/icepak/probe') {
    writeJson(response, 200, { probe: await effectiveIcepakProbe(await pluginClient.probeEnvironment(), database, artifacts) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/plugins/icepak/probe-launchability') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'Icepak launch probe can only run from the local App')
    assertLocalWriteOrigin(request)
    const input = await readJsonBody(request)
    const version = input && typeof input === 'object' && 'version' in input ? input.version : undefined
    if (version !== undefined && (typeof version !== 'string' || !/^20\d{2}\.[12]$/u.test(version))) {
      throw new RequestError(400, 'INVALID_VERSION', 'version must be an AEDT year.release value')
    }
    writeJson(response, 200, { probe: await launchProbe(version) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/plugins/icepak/sample-inspect') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'sample inspection is local-only')
    assertLocalWriteOrigin(request)
    const input = await readJsonBody(request)
    const version = isObject(input) ? input.version : undefined
    if (typeof version !== 'string' || !/^20\d{2}\.[12]$/u.test(version)) {
      throw new RequestError(400, 'INVALID_VERSION', 'select a detected AEDT version for sample inspection')
    }
    const detected = await pluginClient.probeEnvironment()
    if (detected.platform !== 'win32' || !detected.pyaedtAvailable || !detected.aedtVersions.includes(version)) {
      throw new RequestError(409, 'ICEPAK_NOT_DETECTED', 'selected AEDT/PyAEDT environment is not available on this Windows node')
    }
    const sample = await stat(sampleProjectPath).catch(() => null)
    if (!sample?.isFile() || sample.size < 1) throw new RequestError(503, 'SAMPLE_NOT_AVAILABLE', 'bundled Icepak sample project is unavailable')
    const result = await pluginClient.inspectProject({ projectPath: sampleProjectPath, version,
      outputDir: join(home, 'runs', 'icepak-self-check', randomUUID()) })
    writeJson(response, 200, { result, sampleName: basename(sampleProjectPath) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/plugins/icepak/verify-solver') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'solver verification is local-only')
    assertLocalWriteOrigin(request)
    const value = await readJsonBody(request)
    if (!isObject(value) || value.authorizeSolve !== true) {
      throw new RequestError(400, 'SOLVE_APPROVAL_REQUIRED', 'real Icepak solve requires explicit authorization')
    }
    const input = parseIcepakProjectOperationInput(value)
    if (!input.version || !/^20\d{2}\.[12]$/u.test(input.version)) {
      throw new RequestError(400, 'INVALID_VERSION', 'select an AEDT version before solver verification')
    }
    const detected = await pluginClient.probeEnvironment()
    if (detected.platform !== 'win32' || !detected.pyaedtAvailable ||
      !detected.aedtVersions.includes(input.version)) {
      throw new RequestError(409, 'ICEPAK_NOT_DETECTED', 'selected AEDT/PyAEDT environment is not available on this Windows node')
    }
    let source
    try { source = await stat(input.projectPath) }
    catch { throw new RequestError(400, 'PROJECT_NOT_FOUND', 'Icepak project file is unavailable') }
    if (!source.isFile() || source.size < 1) throw new RequestError(400, 'PROJECT_NOT_FOUND', 'Icepak project file is empty or not a file')
    const taskId = randomUUID()
    const taskPath = taskWorkspace.ensure(taskId)
    const inputArtifact = await artifacts.importFile(input.projectPath)
    database.upsertArtifact(inputArtifact)
    const stagedPath = await taskWorkspace.attachArtifact(taskId, inputArtifact, artifacts)
    const task = database.createTask(createTask({ title: `Icepak 能力验证 · ${basename(input.projectPath)}`,
      description: '用户显式授权的一次真实求解，用于验证本机 Icepak 能力与许可证；结果仍需人工复核。',
      ownerNodeId: nodeIdentity.nodeId,
      requirementSnapshot: { taskWorkspacePath: taskPath, projectPath: stagedPath, aedtVersion: input.version, diagnosticReadinessProbe: true },
    }, undefined, taskId))
    database.transitionTask(task.id, 'READY', task.version, '用户明确授权真实 Icepak 求解验证')
    const started = await executions.startBaseline(task.id, { ...input, projectPath: stagedPath })
    writeJson(response, 202, { task: database.getTask(task.id), run: started.run, attempt: started.attempt })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/plugins/icepak/inspect') {
    const input = parseIcepakProjectOperationInput(await readJsonBody(request))
    const outputDir = join(home, 'runs', 'icepak', randomUUID())
    writeJson(response, 200, { result: await pluginClient.inspectProject({ ...input, outputDir }) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/plugins/icepak/fan-check') {
    const input = parseIcepakProjectOperationInput(await readJsonBody(request))
    const outputDir = join(home, 'runs', 'icepak', randomUUID())
    writeJson(response, 200, { result: await pluginClient.fanCheck({ ...input, outputDir }) })
    return
  }
  if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
    await serveWeb(response, webRoot, url.pathname)
    return
  }
  writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function prepareIntakeSnapshot(snapshot: Record<string, unknown>, database: LocalDatabase, home: string): Promise<Record<string, unknown>> {
  if (snapshot.intakeVersion !== 2) return snapshot
  const selected = snapshot.selectedOptimizationSkillIds
  if (!Array.isArray(selected) || selected.some(id => typeof id !== 'string' || database.getSkill(id)?.kind !== 'OPTIMIZATION')) {
    throw new RequestError(400, 'INVALID_PLAN', 'selected optimization Skills must exist')
  }
  const fanId = database.listSkills().find(skill => skill.key === 'optimization-04-fan-selection')?.id
  const autoFanRatio = snapshot.autoFanRatio
  if (autoFanRatio !== undefined && (typeof autoFanRatio !== 'number' || autoFanRatio <= 1 || autoFanRatio > 1.5 || !fanId || !selected.includes(fanId))) {
    throw new RequestError(400, 'INVALID_FAN_PLAN', 'automatic fan adjustment requires selecting the fan Skill and a ratio in (1.0, 1.5]')
  }
  const sha = snapshot.modelSha256
  if (sha === undefined || sha === '') return { ...snapshot, fanSkillId: fanId && selected.includes(fanId) ? fanId : undefined, projectPath: undefined, modelSha256: undefined }
  if (typeof sha !== 'string' || !/^[a-f0-9]{64}$/u.test(sha)) throw new RequestError(400, 'INVALID_MODEL', 'modelSha256 is invalid')
  const model = database.getArtifact(sha)
  if (!model) throw new RequestError(400, 'MODEL_NOT_FOUND', 'uploaded model was not found')
  const extension = extname(model.originalName).toLowerCase()
  if (extension !== '.aedt' && !CAD_EXTENSIONS.has(extension)) throw new RequestError(400, 'INVALID_MODEL', 'unsupported model type')
  const projectPath = join(home, 'models', sha, model.originalName)
  return { ...snapshot, fanSkillId: fanId && selected.includes(fanId) ? fanId : undefined, modelSha256: sha,
    modelKind: extension === '.aedt' ? 'AEDT' : 'CAD', modelOriginalName: model.originalName,
    projectPath: extension === '.aedt' ? projectPath : undefined, cadSourcePath: extension === '.aedt' ? undefined : projectPath,
    capabilityAssessment: database.getModelCapabilityAssessment(sha) }
}

async function bindTaskSnapshot(taskId: string, snapshot: Record<string, unknown>, workspace: TaskWorkspace,
  artifacts: ArtifactStore, database: LocalDatabase): Promise<Record<string, unknown>> {
  const taskWorkspacePath = workspace.ensure(taskId)
  const sha = snapshot.modelSha256
  if (typeof sha !== 'string') return { ...snapshot, taskWorkspacePath }
  const artifact = database.getArtifact(sha)
  if (!artifact) throw new RequestError(400, 'MODEL_NOT_FOUND', 'uploaded model was not found')
  const path = await workspace.attachArtifact(taskId, artifact, artifacts)
  return { ...snapshot, taskWorkspacePath,
    projectPath: snapshot.modelKind === 'AEDT' ? path : undefined,
    cadSourcePath: snapshot.modelKind === 'CAD' ? path : undefined }
}

function assertLocalOwner(database: LocalDatabase, taskId: string, nodeId: string): void {
  const task = database.getTask(taskId)
  if (!task) throw new TaskNotFoundError(taskId)
  if (task.ownerNodeId !== nodeId) throw new RequestError(403, 'NOT_TASK_OWNER', 'this node does not own the task')
}

function assertLocalWriteOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin
  if (!origin) return
  try {
    const parsed = new URL(origin)
    if (parsed.host === request.headers.host && parsed.protocol === 'http:') return
  } catch { /* reject invalid origin */ }
  throw new RequestError(403, 'ORIGIN_REJECTED', 'request origin does not match the local App')
}

async function serveWeb(response: ServerResponse, webRoot: string, pathname: string): Promise<void> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    throw new RequestError(400, 'INVALID_PATH', 'request path is invalid')
  }
  const candidate = resolve(webRoot, `.${decoded === '/' ? '/index.html' : decoded}`)
  if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${sep}`)) {
    throw new RequestError(400, 'INVALID_PATH', 'request path is outside the web root')
  }
  let target = candidate
  try {
    if (!(await stat(target)).isFile()) target = join(webRoot, 'index.html')
  } catch {
    target = join(webRoot, 'index.html')
  }
  let data: Buffer
  try {
    data = await readFile(target)
  } catch {
    throw new RequestError(503, 'WEB_NOT_BUILT', 'web application has not been built')
  }
  const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
  }
  const cadWorker = /^step\.worker-[\w-]+\.js$/u.test(basename(target))
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(data.length),
    'Cache-Control': extname(target) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    // The pinned Emscripten binding needs dynamic functions only inside this dedicated worker.
    'Content-Security-Policy': cadWorker
      ? "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self'"
      : "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src http://127.0.0.1:*",
  })
  response.end(data)
}

async function readJsonBody(request: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new RequestError(413, 'BODY_TOO_LARGE', 'request body exceeds the allowed size')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RequestError(400, 'INVALID_JSON', 'request body is not valid JSON')
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body))
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(data)
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

class RequestError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message)
  }
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed || response.writableEnded) {
    response.destroy()
    return
  }
  if (error instanceof PeerDispatchError) {
    writeJson(response, 409, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof PeerTaskError) {
    const status = error.code === 'OFFER_NOT_AUTHORIZED' ? 403 : error.code === 'INVALID_OFFER' ? 400 : 409
    writeJson(response, status, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof PeerLeaseError) {
    writeJson(response, error.code === 'LEASE_NOT_AUTHORIZED' ? 403 : 400,
      { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof PeerRemoteRunError) {
    writeJson(response, error.code === 'RUN_NOT_AUTHORIZED' ? 403 : 409,
      { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof PeerArtifactError) {
    writeJson(response, error.code === 'ARTIFACT_NOT_AUTHORIZED' || error.code === 'LEASE_EXPIRED' ? 403 : 409,
      { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof PeerSecureError) {
    writeJson(response, 401, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof PeerAuthError) {
    writeJson(response, 401, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof TaskNotFoundError) {
    writeJson(response, 404, { error: { code: 'TASK_NOT_FOUND', message: error.message } })
    return
  }
  if (error instanceof VersionConflictError) {
    writeJson(response, 409, { error: { code: 'VERSION_CONFLICT', message: error.message } })
    return
  }
  if (error instanceof SkillNotFoundError) {
    writeJson(response, 404, { error: { code: 'SKILL_NOT_FOUND', message: error.message } })
    return
  }
  if (error instanceof SkillConflictError) {
    writeJson(response, 409, { error: { code: 'SKILL_CONFLICT', message: error.message } })
    return
  }
  if (error instanceof PeerConflictError) {
    writeJson(response, 409, { error: { code: 'PEER_CONFLICT', message: error.message } })
    return
  }
  if (error instanceof TaskApprovalConflictError) {
    writeJson(response, 409, { error: { code: 'TASK_APPROVAL_CONFLICT', message: error.message } })
    return
  }
  if (error instanceof ReportConflictError) {
    writeJson(response, 409, { error: { code: 'REPORT_CONFLICT', message: error.message } })
    return
  }
  if (error instanceof InvalidTaskTransitionError) {
    writeJson(response, 409, { error: { code: 'INVALID_TASK_TRANSITION', message: error.message } })
    return
  }
  if (error instanceof ModelPreparationConflict) {
    writeJson(response, error.status, { error: { code: error.code, message: error.message } }); return
  }
  if (error instanceof IcepakOperationBusyError) {
    writeJson(response, 409, { error: { code: error.code, message: error.message } }); return
  }
  if (error instanceof RequestError) {
    writeJson(response, error.statusCode, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof Error && /is required|must be|is invalid|is not active|exceeds/u.test(error.message)) {
    writeJson(response, 400, { error: { code: 'VALIDATION_ERROR', message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : 'unknown error'
  writeJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: message.slice(0, 500) } })
}
