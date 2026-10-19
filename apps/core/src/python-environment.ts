import { spawn } from 'node:child_process'
import type { PluginEnvironment } from '@thermal-agent/contracts'
import { terminateProcessTree } from '@thermal-agent/process-control'
import { pythonPluginEnv } from './python-plugin-launch.js'

// Runs trusted host code under the same isolated interpreter flags as plugin calls.
// Hash installed distribution bytes (including their installed dependency closure), not just version labels.
const PROBE = String.raw`
import hashlib, importlib.metadata as metadata, json, os, platform, re, sys, sysconfig
from pathlib import Path

def digest_file(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk: break
            h.update(chunk)
    return h.hexdigest()

def canonical(name):
    return re.sub(r'[-_.]+', '-', name).lower()

versions = {'python': platform.python_version(), 'python-abi': sysconfig.get_config_var('SOABI') or sys.implementation.cache_tag}
executable = Path(sys.executable).absolute()  # Preserve a venv launcher; resolving its symlink changes site-packages.
versions['python-executable'] = digest_file(executable)
runtime = []
stdlib = Path(sysconfig.get_paths()['stdlib'])
for directory, dirs, files in os.walk(stdlib):
    dirs[:] = sorted(name for name in dirs if name not in ('site-packages', 'dist-packages', '__pycache__'))
    for name in sorted(files):
        if name.endswith(('.py', '.so', '.pyd', '.dll', '.dylib', '.zip')):
            path = Path(directory) / name
            runtime.append([str(path), digest_file(path)])
for path in [Path(sys.prefix) / 'pyvenv.cfg', *[Path(item) for item in sys.path if item.endswith('.zip')]]:
    if path.is_file(): runtime.append([str(path), digest_file(path)])
versions['python-runtime'] = hashlib.sha256(json.dumps(sorted(runtime), separators=(',', ':')).encode()).hexdigest()
todo = list(json.loads(sys.argv[1]))
seen = set()
records = []
file_count = 0
total_bytes = 0
while todo:
    name = canonical(todo.pop())
    if name in seen: continue
    seen.add(name)
    if len(seen) > 500: raise RuntimeError('Python dependency closure exceeds 500 distributions')
    try:
        dist = metadata.distribution(name)
    except metadata.PackageNotFoundError:
        versions[name] = 'missing'
        records.append([name, 'missing'])
        continue
    versions[name] = dist.version
    files = dist.files
    if files is None: raise RuntimeError('Distribution has no file inventory: ' + name)
    for requirement in dist.requires or []:
        match = re.match(r'([A-Za-z0-9][A-Za-z0-9._-]*)', requirement)
        if match: todo.append(match.group(1))
    # Includes optional requirements conservatively: changing an installed optional dependency invalidates evidence too.
    for entry in sorted(files, key=str):
        if str(entry).endswith(('.pyc', '.pyo')): continue
        path = Path(dist.locate_file(entry)).resolve()
        file_count += 1
        if file_count > 50000: raise RuntimeError('Python dependency inventory exceeds 50000 files')
        if not path.is_file(): raise RuntimeError('Distribution file is missing: ' + str(entry))
        total_bytes += path.stat().st_size
        if total_bytes > 4 * 1024 ** 3: raise RuntimeError('Python dependency inventory exceeds 4 GiB')
        records.append([name, str(entry), str(path), digest_file(path)])
versions['python-dependencies'] = hashlib.sha256(json.dumps(sorted(records), separators=(',', ':')).encode()).hexdigest()
machine = platform.machine().lower()
architecture = {'amd64': 'x64', 'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64', 'i386': 'ia32', 'i686': 'ia32', 'x86': 'ia32'}.get(machine, machine)
print(json.dumps({'executable': str(executable), 'environment': {'platform': sys.platform, 'architecture': architecture, 'versions': versions}}))
`

export interface PythonRuntimeSnapshot { executable: string; environment: PluginEnvironment }

export async function inspectPythonRuntime(python: string, distributions: readonly string[], timeoutMs = 60_000): Promise<PythonRuntimeSnapshot> {
  if (distributions.length > 20 || distributions.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u.test(name))) throw new Error('Invalid Python distribution names')
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-B', '-c', PROBE, JSON.stringify(distributions)], {
      env: pythonPluginEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let stdout = '', stderr = '', stopped = false
    const stop = () => { stopped = true; terminateProcessTree(child, { force: true }) }
    const timer = setTimeout(stop, timeoutMs)
    timer.unref()
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 256_000) stop() })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (stopped) { reject(new Error('Python environment inspection exceeded its time or output limit')); return }
      if (code !== 0) { reject(new Error(`Python environment inspection failed: ${stderr.trim()}`)); return }
      try {
        const value = JSON.parse(stdout) as PythonRuntimeSnapshot
        if (typeof value.executable !== 'string' || !value.executable || typeof value.environment?.platform !== 'string' ||
          typeof value.environment.architecture !== 'string' || !value.environment.versions ||
          Object.values(value.environment.versions).some(version => typeof version !== 'string') ||
          !/^[a-f0-9]{64}$/u.test(value.environment.versions['python-executable'] ?? '') ||
          !/^[a-f0-9]{64}$/u.test(value.environment.versions['python-dependencies'] ?? '')) throw new Error('Invalid Python environment probe response')
        resolve(value)
      } catch (error) { reject(error) }
    })
  })
}
