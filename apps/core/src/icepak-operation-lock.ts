import { randomUUID } from 'node:crypto'
import type { ModelPreparationStore } from '@thermal-agent/sqlite-store'
import type { IcepakPluginPort, PluginCallOptions } from './icepak-plugin-client.js'

export class IcepakOperationBusyError extends Error {
  readonly code = 'ICEPAK_BUSY'
  constructor() { super('本机 Icepak 正在执行导入、验证或求解，请完成或取消当前作业后重试。') }
}
export class IcepakCleanupPendingError extends Error {
  readonly code = 'ICEPAK_CLEANUP_PENDING'
  constructor() { super('本次 Icepak 操作的受管进程尚未确认退出，已保留执行锁；请等待清理或在本机检查前次会话。') }
}

/** A host validation sequence holds one persisted gate across all candidate and independent reference calls. */
export async function withIcepakOperation<T>(store: ModelPreparationStore, method: string,
  work: (options: PluginCallOptions) => Promise<T>): Promise<T> {
  const id = randomUUID()
  if (!store.acquireOperation(id, method)) throw new IcepakOperationBusyError()
  try {
    return await work({ operationId: id, onProcessStarted: pid => store.registerOperationWorker(id, pid),
      onManagedResource: (pid, creationTime) => store.registerOperationResource(id, pid, creationTime) })
  } finally { if (!store.completeOperation(id)) throw new IcepakCleanupPendingError() }
}

/** Wrap once at Core creation, so every local/remote/Agent consumer shares this gate. */
export function lockIcepakOperations(port: IcepakPluginPort, store: ModelPreparationStore): IcepakPluginPort {
  const protectedMethods = new Set(['inspectCad', 'prepareModel', 'validateModel', 'probeLaunchability', 'inspectProject', 'checkChanges', 'fanCheck', 'solveProject', 'fanSolve'])
  return new Proxy(port, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (key === 'pinRuntime') return async (...args: unknown[]) => {
        const pinned = await value.apply(target, args)
        return { ...pinned, port: lockIcepakOperations(pinned.port, store) }
      }
      if (!protectedMethods.has(String(key))) return value.bind(target)
      return async (...args: unknown[]) => {
        if (target.prepareRuntime) await target.prepareRuntime()
        const id = randomUUID()
        if (!store.acquireOperation(id, String(key))) throw new IcepakOperationBusyError()
        const supplied = args[1] as PluginCallOptions | undefined
        args[1] = { ...supplied, operationId: id, onProcessStarted: (pid: number) => {
          store.registerOperationWorker(id, pid)
          supplied?.onProcessStarted?.(pid)
        }, onManagedResource: (pid: number, creationTime: number) => {
          store.registerOperationResource(id, pid, creationTime)
          supplied?.onManagedResource?.(pid, creationTime)
        } }
        try { return await value.apply(target, args) }
        finally { if (!store.completeOperation(id)) throw new IcepakCleanupPendingError() }
      }
    },
  })
}
