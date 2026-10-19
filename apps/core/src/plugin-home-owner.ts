import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

/** OS-backed ownership: a crashed process releases its SQLite lock without PID guessing. */
export class PluginHomeOwner {
  private database?: DatabaseSync

  constructor(home: string) {
    const database = new DatabaseSync(join(home, 'host-owner.sqlite'))
    try {
      database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE')
      this.database = database
    } catch (cause) {
      database.close()
      throw new Error('Plugin home is already owned by another Core, or its ownership database is unavailable', { cause })
    }
  }

  release(): void {
    if (!this.database) return
    this.database.close()
    this.database = undefined
  }
}
