/** Internal plugin request. Core owns project/output paths and execution authorization. */
export interface DynamicScriptInput {
  source: string
  scriptSha256: string
  parameters: Record<string, unknown>
  projectPath: string
  projectSha256: string
  outputDir: string
  version: string
  design?: string
}

export interface DynamicScriptResult {
  schemaVersion: 1
  status: 'ok'
  scriptSha256: string
  inputSha256: string
  sourceProject: string
  workingProject: string
  parameters: Record<string, unknown>
  executionKind: 'native-aedt' | 'test-double'
  scriptExecuted: boolean
  persistedReadback: boolean
  readbackEvidenceSource: 'script-reported-after-reopen'
  readback: { passed: boolean; checks: unknown[] }
  output: Record<string, unknown>
  verifiedProjectPath: string
  verifiedProjectSha256: string
  evidencePath: string
  logPath: string
  solve: { hostRequested: false; status: 'not-verified' }
}
