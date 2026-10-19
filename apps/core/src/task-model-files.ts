import { basename, join } from 'node:path'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import type { ModelPreparationManager } from './model-preparations.js'
import type { TaskWorkspace } from './task-workspace.js'

export function taskModelFiles(taskId: string, database: LocalDatabase, models: ModelPreparationManager, workspace: TaskWorkspace) {
  const task = database.getTask(taskId)
  if (!task) throw new Error('任务不存在')
  const files = new Map<string, { sha256: string; name: string; sizeBytes: number; labels: string[]; path: string; downloadUrl: string }>()
  function add(sha: unknown, label: string) {
    if (typeof sha !== 'string') return
    const artifact = database.getArtifact(sha)
    if (!artifact || !/\.(aedt|step|stp|iges|igs|x_t|x_b|sat|sab)$/iu.test(artifact.originalName)) return
    if (basename(artifact.originalName) !== artifact.originalName || /[/\\\0]/u.test(artifact.originalName)) return
    const existing = files.get(sha)
    if (existing) { if (!existing.labels.includes(label)) existing.labels.push(label); return }
    files.set(sha, { sha256: sha, name: artifact.originalName, sizeBytes: artifact.sizeBytes, labels: [label],
      path: join(workspace.taskDir(taskId), 'model-files', sha, artifact.originalName),
      downloadUrl: `/api/tasks/${taskId}/model-files/${sha}` })
  }
  const snapshot = task.requirementSnapshot
  const source = snapshot.sourceModel as { sha256?: string } | undefined
  add(source?.sha256 ?? snapshot.modelSha256, '原始模型')
  add(snapshot.modelSha256, snapshot.modelKind === 'CAD' ? '当前 CAD' : '当前求解输入')
  const context = models.context(taskId)
  context.inspections.forEach((inspection, index) => {
    add(inspection.sourceSha256, `CAD 导入 ${index + 1} · 源文件`)
    add(inspection.projectSha256, `CAD 导入 ${index + 1} · 几何工程`)
  })
  context.preparations.forEach(preparation => add(preparation.projectSha256, `热模型版本 ${preparation.revision} · ${preparation.status === 'VERIFIED' ? '已验证' : '未验证'}`))
  database.listParameterPlans(taskId).forEach(plan => add(plan.verifiedProjectSha256, `参数方案 ${plan.revision} · 验证工程`))
  database.listTaskRuns(taskId).forEach(run => database.listRunAttempts(run.id).forEach((attempt, index) => {
    database.listAttemptArtifacts(attempt.id).forEach(artifact => add(artifact.sha256, `${run.kind} #${run.sequence} · 尝试 ${index + 1} · ${artifact.role === 'SOLVED_PROJECT' ? '求解工程' : '输入工程'}`))
  }))
  return { workspacePath: workspace.taskDir(taskId), files: [...files.values()] }
}
