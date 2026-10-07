/**
 * 用仓库内锁定版本的 esbuild 把 TS 自检脚本打成临时 ESM，再交给 Node 执行。
 * 不引入额外依赖、不写 dist，本地 / CI / Docker 构建走的是同一条命令：npm run verify。
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const entry = resolve(here, 'verify-pipeline.ts')
const out = path.join(tmpdir(), `emergency-pipeline-verify-${process.pid}.mjs`)

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: out,
    alias: { '@': resolve(root, 'src') },
    logLevel: 'silent',
  })
  await import(pathToFileURL(out).href)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await rm(out, { force: true })
}
