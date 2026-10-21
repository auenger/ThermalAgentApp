/** Export from an already built desktop resources directory; never install packages on the target machine. */
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join, sep } from 'node:path'
const [sourceArg, outputArg, platform = process.platform, arch = process.arch] = process.argv.slice(2)
if (!sourceArg || !outputArg || !['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error('Usage: node scripts/export-dsh-runtime.mjs <packaged resources> <new output directory> [platform] [arch]')
}
const source = resolve(sourceArg), output = resolve(outputArg)
if (output === source || output.startsWith(source + sep)) throw new Error('Output must be outside packaged resources')
await mkdir(output, { recursive: false })
for (const [from, to] of [['node', 'node'], ['app.asar.unpacked/node_modules', 'node_modules'], ['app.asar.unpacked/plugins/dsh-thermal', 'plugins/dsh-thermal']]) {
  await cp(join(source, from), join(output, to), { recursive: true, dereference: true, errorOnExist: true, force: false })
}
const files = {}
async function walk(prefix = '') {
  for (const item of await readdir(join(output, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) await walk(path)
    else if (item.isFile()) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(join(output, path))) hash.update(chunk)
      files[path] = hash.digest('hex')
    } else throw new Error(`Unsupported runtime entry: ${path}`)
  }
}
await walk()
const version = JSON.parse(await readFile(join(output, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
await writeFile(join(output, 'runtime.json'), JSON.stringify({ schema: 1, version, platform, arch, bridgeProtocol: 1,
  cli: 'node_modules/@deepseek-ai/dsh/lib/bin.js', node: platform === 'win32' ? 'node/node.exe' : 'node/bin/node',
  plugin: 'plugins/dsh-thermal/dist/index.js', files }, null, 2))
console.log(`Exported DSH ${version} (${platform}/${arch}) with ${Object.keys(files).length} files to ${output}`)
