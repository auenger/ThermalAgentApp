import assert from 'node:assert/strict'
import test from 'node:test'
import { createTask, InvalidTaskTransitionError, transitionTask } from '@thermal-agent/domain'

test('new tasks start as versioned drafts with independent verdict states', () => {
  const task = createTask(
    {
      title: '机箱散热验证',
      description: '先检查输入，再执行 Baseline。',
      ownerNodeId: 'node-local',
      requirementSnapshot: { ambientTemperatureC: 30 },
    },
    '2026-09-21T00:00:00.000Z',
    '11111111-1111-4111-8111-111111111111',
  )

  assert.equal(task.executionStatus, 'DRAFT')
  assert.equal(task.thermalVerdict, 'PENDING')
  assert.equal(task.approvalStatus, 'NONE')
  assert.equal(task.version, 1)
})

test('task transitions are explicit and terminal tasks cannot silently restart', () => {
  const draft = createTask({ title: '任务', description: '', ownerNodeId: 'node-local', requirementSnapshot: {} })
  const ready = transitionTask(draft, 'READY')
  const queued = transitionTask(ready, 'QUEUED')
  const running = transitionTask(queued, 'RUNNING')
  const completed = transitionTask(running, 'COMPLETED')

  assert.equal(completed.version, 5)
  assert.throws(() => transitionTask(completed, 'QUEUED'), InvalidTaskTransitionError)
  assert.throws(() => transitionTask(draft, 'RUNNING'), /not allowed/u)
})
