// ESM 加载钩子：.ts/.mts 交给 esbuild 转成 ESM；.json 直接包成 default 导出，
// 这样 Node 侧可以和 Vite 侧用同一条 import 语句读种子文件。
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Node ESM 要求相对导入带扩展名，源码沿用 Vite 的无扩展名写法，这里统一补 .ts。
export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.(ts|mts|js|mjs|json)$/.test(specifier)
  ) {
    try {
      const resolved = new URL(specifier, context.parentURL)
      if (existsSync(`${fileURLToPath(resolved)}.ts`)) {
        return {
          url: new URL(`${specifier}.ts`, context.parentURL).href,
          shortCircuit: true,
        }
      }
    } catch {
      // 落到默认解析
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file://')) {
    return nextLoad(url, context)
  }
  if (url.endsWith('.json')) {
    const raw = await readFile(fileURLToPath(url), 'utf8')
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${raw};`,
    }
  }
  if (url.endsWith('.ts') || url.endsWith('.mts')) {
    const raw = await readFile(fileURLToPath(url), 'utf8')
    const result = await transform(raw, url)
    return { format: 'module', shortCircuit: true, source: result.code }
  }
  return nextLoad(url, context)
}

async function transform(source, url) {
  const { transform: esbuildTransform } = await import('esbuild')
  return esbuildTransform(source, {
    loader: url.endsWith('.mts') ? 'ts' : 'ts',
    format: 'esm',
    target: 'es2022',
    sourcefile: fileURLToPath(url),
  })
}
