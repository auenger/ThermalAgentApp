import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const THERMAL_PRESET = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: >-',
  '      你是 Thermal Agent 的散热工程助手。通过受控工具读取任务、探测 Icepak 和检查 AEDT 工程。创建任务后等待用户在 App 中确认；不得自动开始昂贵求解、绕过审批或把求解完成表述为热设计通过。缺少工程证据时明确标记未知。',
  '    complete: true',
  '    includeRuntimeContext: false',
  '',
  '- id: agent-instructions',
  "  name: '@deepseek-ai/dsh-agent-instructions'",
  '  config:',
  '    maxBytes: 65536',
  '',
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  "  disabled: !!js process.platform === 'win32'",
  '',
  '- id: tool-pwsh',
  "  name: '@deepseek-ai/dsh-tool-pwsh'",
  "  disabled: !!js process.platform !== 'win32'",
  '',
  '- id: tool-fs',
  "  name: '@deepseek-ai/dsh-tool-fs'",
  '',
  '- id: tool-fs-search',
  "  name: '@deepseek-ai/dsh-tool-fs-search'",
  '  config:',
  '    sampleOverCapGlobResults: false',
  '',
  '- id: tool-skill',
  "  name: '@deepseek-ai/dsh-tool-skill'",
  '',
].join('\n')

export function prepareDshProfile(dshHome: string, pluginPath: string): string {
  const presetRoot = resolve(dshHome, 'thermal-presets')
  const presetDir = join(presetRoot, 'thermal-agent')
  mkdirSync(presetDir, { recursive: true, mode: 0o700 })
  const composition = join(presetDir, 'agent.cordis.yml')
  writeFileSync(composition, THERMAL_PRESET, { mode: 0o600 })
  chmodSync(composition, 0o600)
  const patch = resolve(dshHome, 'thermal-agent.cordis.patch.yml')
  writeFileSync(patch, [
    '- id: agent-presets',
    '  config:',
    '    default: thermal-agent',
    '    includeShippedRoot: true',
    '    roots:',
    `      - path: ${JSON.stringify(presetRoot)}`,
    '        trust: system',
    '    includeUserRoot: true',
    '- insert:',
    '    - id: thermal-agent-tools',
    `      name: ${JSON.stringify(resolve(pluginPath))}`,
    '',
  ].join('\n'), { mode: 0o600 })
  chmodSync(patch, 0o600)
  return patch
}

