import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { SkillDetail } from '@thermal-agent/contracts'

export class SkillPublisher {
  private readonly root: string

  constructor(workspace: string) {
    this.root = resolve(workspace, '.agents', 'skills')
  }

  publish(skill: SkillDetail): string {
    const directory = resolve(this.root, `thermal-${skill.key}`)
    if (!directory.startsWith(`${this.root}${sep}`)) throw new Error('skill publish path is invalid')
    const target = join(directory, 'SKILL.md')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${target}.tmp`
    writeFileSync(temporary, renderSkill(skill), { mode: 0o600 })
    renameSync(temporary, target)
    return target
  }

  unpublish(path: string | null): void {
    if (!path) return
    const target = resolve(path)
    if (!target.startsWith(`${this.root}${sep}`) || target !== join(dirname(target), 'SKILL.md')) {
      throw new Error('skill publish path is outside the managed directory')
    }
    rmSync(target, { force: true })
  }
}

function renderSkill(skill: SkillDetail): string {
  const definition = skill.version.definition
  const parameters = definition.parameters.map(item =>
    `- \`${item.key}\`${item.required ? '（必填）' : '（可选）'}：${item.description}`,
  ).join('\n')
  const steps = definition.steps.map((step, index) =>
    `${index + 1}. ${step.title}：${step.description}\n   验证：${step.verification}`,
  ).join('\n')
  return `---
name: ${JSON.stringify(`thermal-${skill.key}`)}
description: ${JSON.stringify(skill.description)}
---

# ${skill.name}

这是经过 Thermal Agent 人工审核的散热流程。只能通过 Thermal Agent 提供的受控工具读取任务与 Icepak 证据。

## 参数

${parameters}

## 步骤

${steps}

## 权限边界

${definition.permissions.map(item => `- ${item}`).join('\n')}

不得用 Shell 或文件工具修改源 AEDT 工程。不得自动确认需求、启动 Baseline、应用风扇动作或发布新 Skill；这些动作必须回到 App 由用户明确触发。

## 成功标准

${definition.successCriteria.map(item => `- ${item}`).join('\n')}

## 失败策略

${definition.failureStrategy}

无论执行结果如何，始终分别陈述执行状态、热设计判定和人工审批状态。缺少证据时标记未知。
`
}
