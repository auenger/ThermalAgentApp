import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = new URL('../', import.meta.url)
const rootManifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const pinned = rootManifest.dependencies['@deepseek-ai/dsh']
const problems = []
for (const file of ['package.json', 'apps/core/package.json', 'plugins/dsh-thermal/package.json']) {
  const manifest = JSON.parse(await readFile(new URL(file, root), 'utf8'))
  for (const [name, wanted] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue
    if (wanted !== pinned) problems.push(`${file}: ${name} declares ${wanted}, expected ${pinned}`)
    try {
      const installed = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8')).version
      if (installed !== wanted) problems.push(`${name}: installed ${installed}, declared ${wanted}`)
    } catch { problems.push(`${name}: package is not installed`) }
  }
}
const workspace = await readFile(new URL('pnpm-workspace.yaml', root), 'utf8')
for (const match of (workspace.match(/^overrides:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/mu)?.[1] ?? '').matchAll(/'(@deepseek-ai\/dsh[^']+)':\s*(\S+)/gu)) {
  if (match[2] !== pinned) problems.push(`override ${match[1]}: ${match[2]}, expected ${pinned}`)
}
if (problems.length) throw new Error(problems.join('\n'))
console.log(`DSH dependency check passed: ${pinned} (${pinned.includes('-') ? 'prerelease' : 'stable'})`)
if (process.argv.includes('--online')) {
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh', { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Official registry returned HTTP ${response.status}`)
  const metadata = await response.json()
  const stable = Object.keys(metadata.versions).filter(version => /^\d+\.\d+\.\d+$/u.test(version))
    .sort((a, b) => {
      const left = a.split('.').map(Number), right = b.split('.').map(Number)
      return right[0] - left[0] || right[1] - left[1] || right[2] - left[2]
    })[0]
  console.log(JSON.stringify({ installed: pinned, latest: metadata['dist-tags'].latest, stable: stable ?? null,
    note: stable ? 'A stable release exists; compatibility must be tested before switching.' : 'No stable release published. latest is not a stability guarantee.' }, null, 2))
}
