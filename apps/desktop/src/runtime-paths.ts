import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface DesktopRuntimePaths {
  appRoot: string
  coreEntry: string
  webRoot: string
  icepakPluginRoot: string
  reportPluginRoot: string
  reportPython?: string
  icepakPython?: string
  dshPlugin: string
  dshCli?: string
  nodeBin?: string
  workingDirectory: string
}

export function resolveDesktopRuntimePaths(options: {
  appPath: string
  resourcesPath: string
  packaged: boolean
  platform?: NodeJS.Platform
  nodeOverride?: string
}): DesktopRuntimePaths {
  const platform = options.platform ?? process.platform
  if (!options.packaged) {
    const appRoot = resolve(options.appPath, '../..')
    return {
      appRoot,
      coreEntry: join(appRoot, 'apps', 'core', 'dist', 'cli.js'),
      webRoot: join(appRoot, 'apps', 'web', 'dist'),
      icepakPluginRoot: join(appRoot, 'plugins', 'icepak-pyaedt', 'python'),
      reportPluginRoot: join(appRoot, 'plugins', 'report-reportlab', 'python'),
      dshPlugin: join(appRoot, 'plugins', 'dsh-thermal', 'dist', 'index.js'),
      nodeBin: options.nodeOverride,
      workingDirectory: appRoot,
    }
  }

  const appRoot = resolve(options.appPath)
  const unpackedRoot = join(options.resourcesPath, 'app.asar.unpacked')
  const packagedNode = join(options.resourcesPath, 'node', platform === 'win32' ? 'node.exe' : 'bin/node')
  const dshCli = join(unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const reportPython = join(options.resourcesPath, 'python', platform === 'win32' ? 'python.exe' : 'bin/python')
  return {
    appRoot,
    coreEntry: join(appRoot, 'apps', 'core', 'dist', 'cli.js'),
    webRoot: join(appRoot, 'apps', 'web', 'dist'),
    icepakPluginRoot: join(unpackedRoot, 'plugins', 'icepak-pyaedt', 'python'),
    reportPluginRoot: join(unpackedRoot, 'plugins', 'report-reportlab', 'python'),
    reportPython: existsSync(reportPython) ? reportPython : undefined,
    icepakPython: existsSync(reportPython) ? reportPython : undefined,
    dshPlugin: join(unpackedRoot, 'plugins', 'dsh-thermal', 'dist', 'index.js'),
    dshCli: existsSync(dshCli) ? dshCli : undefined,
    nodeBin: options.nodeOverride ?? (existsSync(packagedNode) ? packagedNode : undefined),
    workingDirectory: options.resourcesPath,
  }
}

export function validatePackagedRuntime(paths: DesktopRuntimePaths): void {
  const required: Array<[string, string | undefined]> = [
    ['Node.js', paths.nodeBin],
    ['Python', paths.reportPython],
    ['DSH CLI', paths.dshCli],
    ['DSH thermal plugin', paths.dshPlugin],
    ['Icepak plugin', join(paths.icepakPluginRoot, 'thermal_icepak_plugin', '__main__.py')],
    ['PDF report plugin', join(paths.reportPluginRoot, 'thermal_report_plugin', '__main__.py')],
  ]
  const missing = required.filter(([, path]) => !path || !existsSync(path)).map(([name]) => name)
  if (missing.length > 0) throw new Error(`安装包缺少内置运行时：${missing.join('、')}。请重新安装完整的 Thermal Agent App。`)
}
