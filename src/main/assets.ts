import { app } from 'electron'
import { join } from 'path'

/**
 * Absolute path to the app icon at runtime. In dev the file lives in the project
 * `resources/` dir; in a packaged build electron-builder copies it under
 * `process.resourcesPath/resources` (see the `extraResources` build config).
 */
export function iconPath(): string {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(root, 'resources', 'icon.png')
}
