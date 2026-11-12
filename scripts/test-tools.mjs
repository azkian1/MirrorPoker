import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function spawnEsbuild(args, options) {
  const cli = fileURLToPath(new URL('../node_modules/esbuild/bin/esbuild', import.meta.url))
  // npm keeps a JS launcher on Windows and may install a native executable on Unix.
  return process.platform === 'win32'
    ? spawnSync(process.execPath, [cli, ...args], options)
    : spawnSync(cli, args, options)
}
