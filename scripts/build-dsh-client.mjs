import ts from 'typescript'
import { readFile, writeFile } from 'node:fs/promises'
const source = await readFile(new URL('../plugins/dsh-thermal/src/client.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} })
await writeFile(new URL('../plugins/dsh-thermal/dist/client.js', import.meta.url),
  `window.__ModuleLoader__.load({id: '@thermal-agent/dsh-thermal', factory: (require) => {\nconst module = {exports: {}}; const exports = module.exports;\n${outputText}\nreturn module.exports;\n}});\n`)

await writeFile(new URL('../plugins/dsh-thermal/dist/launcher.mjs', import.meta.url), await readFile(new URL('../plugins/dsh-thermal/src/launcher.mjs', import.meta.url)))
