import { readFileSync } from 'node:fs'

/** Load the tray raster generated from the shared brand SVG. */
export function createTrayIconPng(path: string): Buffer {
  return readFileSync(path)
}
