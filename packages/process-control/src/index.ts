import { spawn } from 'node:child_process'

export interface KillableProcess {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface TerminationPlan {
  command: string
  args: string[]
}

export function windowsTerminationPlan(pid: number, force: boolean): TerminationPlan {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('process pid must be a positive integer')
  return {
    command: 'taskkill.exe',
    args: ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
  }
}

export function terminateProcessTree(
  child: KillableProcess,
  options: { force?: boolean; platform?: NodeJS.Platform } = {},
): void {
  const force = options.force === true
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' || !child.pid) {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* process already exited */ }
    return
  }
  const plan = windowsTerminationPlan(child.pid, force)
  try {
    const killer = spawn(plan.command, plan.args, { stdio: 'ignore', windowsHide: true })
    killer.once('error', () => {
      try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* process already exited */ }
    })
    killer.unref()
  } catch {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* process already exited */ }
  }
}
