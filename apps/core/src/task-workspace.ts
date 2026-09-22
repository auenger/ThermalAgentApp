import { mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { ArtifactRecord } from '@thermal-agent/contracts'
import type { ArtifactStore } from '@thermal-agent/artifact-store'

const TASK_ID = /^[0-9a-f-]{36}$/iu
const SHA256 = /^[a-f0-9]{64}$/u

export class TaskWorkspace {
  readonly root: string

  constructor(home: string) {
    this.root = resolve(home, 'workspace')
    mkdirSync(join(this.root, 'tasks'), { recursive: true })
  }

  taskDir(taskId: string): string {
    if (!TASK_ID.test(taskId)) throw new Error('task ID is invalid')
    return join(this.root, 'tasks', taskId)
  }

  ensure(taskId: string): string {
    const path = this.taskDir(taskId)
    mkdirSync(join(path, 'inputs'), { recursive: true })
    mkdirSync(join(path, 'runs'), { recursive: true })
    return path
  }

  async attachArtifact(taskId: string, artifact: ArtifactRecord, store: ArtifactStore): Promise<string> {
    if (!SHA256.test(artifact.sha256) || !artifact.originalName || artifact.originalName !== basename(artifact.originalName) ||
      /[/\\\0]/u.test(artifact.originalName)) throw new Error('task input artifact is invalid')
    const target = join(this.ensure(taskId), 'inputs', artifact.sha256, artifact.originalName)
    await store.materialize(artifact.sha256, target)
    return target
  }
}
