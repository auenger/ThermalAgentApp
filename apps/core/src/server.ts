import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { parseCreateSkillRunInput, parseCreateTaskInput, parseExpectedVersionInput, parseIcepakCandidateInput, parseIcepakProjectOperationInput, parseSkillReviewInput, parseTaskApprovalDecisionInput, parseTaskTransitionInput } from '@thermal-agent/contracts'
import { createTask, InvalidTaskTransitionError } from '@thermal-agent/domain'
import { LocalDatabase, PeerConflictError, SkillConflictError, SkillNotFoundError, TaskApprovalConflictError, TaskNotFoundError, VersionConflictError } from '@thermal-agent/sqlite-store'
import { IcepakPluginClient, type IcepakPluginPort } from './icepak-plugin-client.js'
import { IcepakExecutionManager } from './execution-manager.js'
import { DshRuntime } from './dsh-runtime.js'
import { SkillPublisher } from './skill-publisher.js'
import { CoreEventStream } from './event-stream.js'
import { LanPublisher } from './lan-publisher.js'
import { ReportClient, type ReportPort } from './report-client.js'
import { ReportConflictError, ReportManager } from './report-manager.js'
import { NodeIdentity } from './node-identity.js'
import { PeerDiscovery, type PeerDiscoveryOptions } from './peer-discovery.js'
import { PeerAuth, PeerAuthError } from './peer-auth.js'
import { PeerSecureChannel, PeerSecureError } from './peer-secure-channel.js'
import { PeerArtifactError, PeerArtifactTransfer } from './peer-artifact-transfer.js'
import { PeerLeaseControl, PeerLeaseError } from './peer-lease-control.js'
import { PeerTaskInbox, PeerTaskError } from './peer-task-inbox.js'
import { PeerTaskDispatcher, PeerDispatchError } from './peer-task-dispatcher.js'
import type { IcepakEnvironmentProbe, PeerHeartbeat } from '@thermal-agent/contracts'

export interface CoreAppOptions {
  home: string
  pluginClient?: IcepakPluginPort
  webRoot?: string
  startAgentRuntime?: boolean
  reportClient?: ReportPort
  discoveryOptions?: PeerDiscoveryOptions
}

export interface CoreApp {
  server: Server
  database: LocalDatabase
  artifacts: ArtifactStore
  nodeIdentity: NodeIdentity
  close(): Promise<void>
}

export function createCoreApp(options: CoreAppOptions): CoreApp {
  const home = resolve(options.home)
  mkdirSync(home, { recursive: true })
  const database = new LocalDatabase(join(home, 'data', 'thermal.db'))
  let nodeIdentity: NodeIdentity
  try {
    nodeIdentity = NodeIdentity.loadOrCreate(home, database.getLocalIdentity()?.nodeId)
    database.bindLocalIdentity(nodeIdentity.publicIdentity)
  } catch (error) {
    database.close()
    throw error
  }
  database.adoptLegacyLocalTasks(nodeIdentity.nodeId)
  database.reconcileLeases()
  const leaseSweep = setInterval(() => {
    try { database.reconcileLeases() }
    catch (error) { console.error('lease reconciliation failed', error) }
  }, 10_000)
  leaseSweep.unref()
  const artifacts = new ArtifactStore(join(home, 'artifacts'))
  const pluginClient = options.pluginClient ?? new IcepakPluginClient()
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
    if (!cachedProbe || Date.now() - probedAt > 60_000) {
      try { cachedProbe = await pluginClient.probeEnvironment() }
      catch { cachedProbe = null }
      probedAt = Date.now()
    }
    const status = cachedProbe?.status ?? 'DEGRADED'
    return {
      pluginStatus: status,
      aedtVersions: cachedProbe?.aedtVersions ?? [],
      maxConcurrent: status === 'READY' ? 1 : 0,
      activeAttempts: database.listActiveAttempts().length,
    }
  }
  const discovery = new PeerDiscovery(nodeIdentity, database, capabilityHeartbeat, options.discoveryOptions)
  const peerAuth = new PeerAuth(nodeIdentity, database)
  const peerSecure = new PeerSecureChannel(nodeIdentity, database)
  const peerArtifacts = new PeerArtifactTransfer(nodeIdentity.nodeId, database, artifacts)
  const peerLeases = new PeerLeaseControl(nodeIdentity.nodeId, database)
  const peerTasks = new PeerTaskInbox(nodeIdentity.nodeId, database, pluginClient)
  const peerDispatcher = new PeerTaskDispatcher(nodeIdentity.nodeId, database, artifacts, peerSecure)
  const executions = new IcepakExecutionManager(home, database, artifacts, pluginClient)
  const agentRuntime = new DshRuntime(home, database, pluginClient, nodeIdentity.nodeId)
  const skillPublisher = new SkillPublisher(join(home, 'workspace'))
  const eventStream = new CoreEventStream(database)
  const reports = new ReportManager(home, database, artifacts, options.reportClient ?? new ReportClient())
  if (options.startAgentRuntime !== false) void agentRuntime.start()
  const webRoot = resolve(options.webRoot ?? process.env.THERMAL_AGENT_WEB_ROOT ?? 'apps/web/dist')

  let lanPublisher: LanPublisher
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void route(request, response, database, artifacts, pluginClient, launchProbe, executions, agentRuntime, skillPublisher, reports, eventStream, lanPublisher, discovery, peerAuth, peerSecure, peerArtifacts, peerLeases, peerTasks, peerDispatcher, webRoot, home, nodeIdentity).catch(error => writeError(response, error))
  }
  const server = createServer(handler)
  lanPublisher = new LanPublisher(handler)

  return {
    server,
    database,
    artifacts,
    nodeIdentity,
    async close() {
      clearInterval(leaseSweep)
      await discovery.stop()
      await lanPublisher.stop()
      peerSecure.close()
      eventStream.close()
      await new Promise<void>((resolveClose, reject) => {
        if (!server.listening) { resolveClose(); return }
        server.close(error => error ? reject(error) : resolveClose())
      })
      await executions.close()
      await agentRuntime.close()
      database.close()
    },
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  database: LocalDatabase,
  artifacts: ArtifactStore,
  pluginClient: IcepakPluginPort,
  launchProbe: (version?: string) => Promise<IcepakEnvironmentProbe>,
  executions: IcepakExecutionManager,
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
  peerTasks: PeerTaskInbox,
  peerDispatcher: PeerTaskDispatcher,
  webRoot: string,
  home: string,
  nodeIdentity: NodeIdentity,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/api/health') {
    writeJson(response, 200, { status: 'ok', service: 'thermal-agent-core', version: '0.1.0' })
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
    } else if (isObject(message) && message.operation === 'lease.renew') {
      reply = peerLeases.renewForExecutor(decrypted.peerNodeId, message)
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
    writeJson(response, 200, { agent: agentRuntime.getStatus() })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/agent/restart') {
    await agentRuntime.restart()
    writeJson(response, 202, { agent: agentRuntime.getStatus() })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/skills') {
    writeJson(response, 200, { skills: database.listSkills() })
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
    const task = createTask({
      title: input.title, description: input.description, ownerNodeId: nodeIdentity.nodeId,
      requirementSnapshot: {
        projectPath: input.projectPath, aedtVersion: input.version ?? probe.selectedVersion ?? undefined,
        cores: input.cores ?? 4, ...(input.targetTmaxC === undefined ? {} : { targetTmaxC: input.targetTmaxC }),
        skillId: skill.id, skillVersion: skill.activeVersion,
        inspection: { inputSha256: inspection.inputSha256, design: inspection.project.activeDesign, verified: inspection.validation.verified },
      },
    })
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
    if (skill.updatedAt !== input.expectedUpdatedAt) throw new SkillConflictError('skill was changed by another operation')
    skillPublisher.unpublish(skill.publishedPath)
    writeJson(response, 200, { skill: database.reviewSkill(skill.id, 'DISABLED', input.reviewer, input.expectedUpdatedAt, null) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/tasks') {
    const limit = Number(url.searchParams.get('limit') ?? '100')
    writeJson(response, 200, { tasks: database.listTasks(Number.isFinite(limit) ? limit : 100) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const value = await readJsonBody(request)
    const input = parseCreateTaskInput({ ...(isObject(value) ? value : {}), ownerNodeId: nodeIdentity.nodeId })
    const task = database.createTask(createTask(input))
    writeJson(response, 201, { task })
    return
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/iu)
  if (request.method === 'GET' && taskMatch) {
    const task = database.getTask(taskMatch[1])
    if (!task) throw new TaskNotFoundError(taskMatch[1])
    const runs = database.listTaskRuns(task.id).map(run => ({
      ...run,
      attempts: database.listRunAttempts(run.id).map(attempt => ({
        ...attempt,
        artifacts: database.listAttemptArtifacts(attempt.id),
      })),
    }))
    writeJson(response, 200, { task, runs, events: database.listTaskEvents(task.id), skillRun: database.getSkillRunForTask(task.id) })
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
    const task = database.transitionTask(transitionMatch[1], input.status, input.expectedVersion, input.reason)
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
  const candidateMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/runs\/candidate$/iu)
  if (request.method === 'POST' && candidateMatch) {
    assertLocalOwner(database, candidateMatch[1], nodeIdentity.nodeId)
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
    writeJson(response, 200, { probe: await pluginClient.probeEnvironment() })
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
  }
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(data.length),
    'Cache-Control': extname(target) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src http://127.0.0.1:*",
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
