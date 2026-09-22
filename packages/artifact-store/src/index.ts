import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { Transform } from 'node:stream'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ArtifactRecord } from '@thermal-agent/contracts'

export class ArtifactStore {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.root, 'sha256'), { recursive: true })
    await mkdir(join(this.root, 'tmp'), { recursive: true })
  }

  async putBytes(data: Uint8Array, originalName: string, mediaType = 'application/octet-stream'): Promise<ArtifactRecord> {
    await this.initialize()
    const tempPath = join(this.root, 'tmp', randomUUID())
    await writeFile(tempPath, data)
    return this.commitTempFile(tempPath, createHash('sha256').update(data).digest('hex'), originalName, mediaType)
  }

  async importFile(sourcePath: string, originalName = basename(sourcePath), mediaType = 'application/octet-stream'): Promise<ArtifactRecord> {
    await this.initialize()
    const tempPath = join(this.root, 'tmp', randomUUID())
    const hash = createHash('sha256')
    const hashTap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(createReadStream(sourcePath), hashTap, createWriteStream(tempPath, { flags: 'wx' }))
      return await this.commitTempFile(tempPath, hash.digest('hex'), originalName, mediaType)
    } catch (error) {
      await unlink(tempPath).catch(() => undefined)
      throw error
    }
  }

  async importStream(source: Readable, originalName: string, maxBytes: number, mediaType = 'application/octet-stream'): Promise<ArtifactRecord> {
    await this.initialize()
    const tempPath = join(this.root, 'tmp', randomUUID())
    const hash = createHash('sha256')
    let size = 0
    const hashTap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (size > maxBytes) { callback(new Error('model file exceeds upload limit')); return }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(source, hashTap, createWriteStream(tempPath, { flags: 'wx' }))
      if (size === 0) throw new Error('model file is empty')
      return await this.commitTempFile(tempPath, hash.digest('hex'), originalName, mediaType)
    } catch (error) {
      await unlink(tempPath).catch(() => undefined)
      throw error
    }
  }

  resolveArtifact(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('artifact sha256 is invalid')
    return join(this.root, 'sha256', sha256.slice(0, 2), sha256)
  }

  async materialize(sha256: string, destination: string): Promise<string> {
    const source = this.resolveArtifact(sha256)
    const target = resolve(destination)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    return target
  }

  private async commitTempFile(tempPath: string, sha256: string, originalName: string, mediaType: string): Promise<ArtifactRecord> {
    const target = this.resolveArtifact(sha256)
    await mkdir(join(this.root, 'sha256', sha256.slice(0, 2)), { recursive: true })
    try {
      await access(target)
      await unlink(tempPath)
    } catch {
      await rename(tempPath, target)
    }
    const info = await stat(target)
    return {
      sha256,
      sizeBytes: info.size,
      mediaType: mediaType.trim() || 'application/octet-stream',
      originalName: basename(originalName) || 'artifact.bin',
      relativePath: relative(this.root, target).replaceAll('\\', '/'),
      createdAt: new Date().toISOString(),
    }
  }
}
