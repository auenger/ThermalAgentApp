import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface DesktopRuntimePaths {
  appRoot: string
  coreEntry: string
  webRoot: string
  icepakPluginRoot: string
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
      dshPlugin: join(appRoot, 'plugins', 'dsh-thermal', 'dist', 'index.js'),
      nodeBin: options.nodeOverride,
      workingDirectory: appRoot,
    }
  }

  const appRoot = resolve(options.appPath)
  const unpackedRoot = join(options.resourcesPath, 'app.asar.unpacked')
  const packagedNode = join(options.resourcesPath, 'node', platform === 'win32' ? 'node.exe' : 'bin/node')
  const dshCli = join(unpackedRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return {
    appRoot,
    coreEntry: join(appRoot, 'apps', 'core', 'dist', 'cli.js'),
    webRoot: join(appRoot, 'apps', 'web', 'dist'),
    icepakPluginRoot: join(unpackedRoot, 'plugins', 'icepak-pyaedt', 'python'),
    dshPlugin: join(unpackedRoot, 'plugins', 'dsh-thermal', 'dist', 'index.js'),
    dshCli: existsSync(dshCli) ? dshCli : undefined,
    nodeBin: options.nodeOverride ?? (existsSync(packagedNode) ? packagedNode : undefined),
    workingDirectory: appRoot,
  }
}
