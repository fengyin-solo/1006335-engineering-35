/**
 * 应急演练初始化链路（构建与部署共用同一条）：
 *   generate  按演练编号确定性生成样例 + 存量台账，落盘 seed.json 并写入校验和
 *   verify    重新生成一遍，与落盘文件逐字节比对，校验和不一致即失败
 *             同时执行 bootstrap + 全量自检，打印条数，任何一步非零退出
 *
 * 本地开发、CI、Docker 构建跑的都是这个文件；浏览器导入的就是它落盘的 seed.json，
 * 从而保证「本地与线上落库的那份数据」同源一致。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bootstrap, runChecks, selectCounts, assertInvariants } from '../src/domain/emergency/engine'
import { buildSeedBundle } from '../src/domain/emergency/generator'
import { GENERATED_AT } from '../src/domain/emergency/policy'
import type { SeedBundle } from '../src/domain/emergency/types'

const here = dirname(fileURLToPath(import.meta.url))
const SEED_PATH = resolve(here, '../src/domain/emergency/seed.json')

type SeedFile = {
  meta: {
    seedRevision: number
    schemaVersion: number
    generatedAt: string
    checksum: string
    checksumAlgorithm: 'sha256'
    sampleCount: number
    legacyCount: number
  }
  bundle: SeedBundle
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 规范序列化：键排序、无多余空白，保证同内容永远同字节。 */
function canonical(bundle: SeedBundle): string {
  return JSON.stringify(bundle, Object.keys(bundle).sort(), 2)
}

function buildSeedFile(): SeedFile {
  const bundle = buildSeedBundle()
  return {
    meta: {
      seedRevision: bundle.seedRevision,
      schemaVersion: bundle.schemaVersion,
      generatedAt: bundle.generatedAt,
      checksum: sha256(canonical(bundle)),
      checksumAlgorithm: 'sha256',
      sampleCount: bundle.samples.length,
      legacyCount: bundle.legacy.length,
    },
    bundle,
  }
}

async function writeSeed(): Promise<void> {
  const file = buildSeedFile()
  await mkdir(dirname(SEED_PATH), { recursive: true })
  await writeFile(SEED_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  console.log(`[generate] 样例 ${file.meta.sampleCount} 条、存量 ${file.meta.legacyCount} 条已写入`)
  console.log(`[generate] ${SEED_PATH}`)
  console.log(`[generate] sha256=${file.meta.checksum.slice(0, 16)}… generatedAt=${file.meta.generatedAt}`)
}

async function readSeed(): Promise<SeedFile> {
  return JSON.parse(await readFile(SEED_PATH, 'utf8')) as SeedFile
}

async function verifySeed(): Promise<boolean> {
  let ok = true
  const expected = buildSeedFile()
  let actual: SeedFile
  try {
    actual = await readSeed()
  } catch (error) {
    console.error(`[verify] seed.json 不存在或无法解析：${(error as Error).message}`)
    console.error('[verify] 请先执行 npm run emergency:generate')
    return false
  }

  if (canonical(actual.bundle) !== canonical(expected.bundle)) {
    console.error('[verify] 落盘种子与重新生成结果不一致（样例被手改过或脚本口径变了）')
    ok = false
  }
  const actualChecksum = sha256(canonical(actual.bundle))
  if (actual.meta.checksum !== actualChecksum) {
    console.error('[verify] seed.json 内校验和与内容不符，文件可能被损坏或篡改')
    ok = false
  }
  if (actual.meta.checksum !== expected.meta.checksum) {
    console.error('[verify] 校验和与确定性重算结果不符')
    ok = false
  }
  if (actual.meta.generatedAt !== GENERATED_AT) {
    console.error('[verify] generatedAt 必须是固定时间戳，不允许取系统时间')
    ok = false
  }

  // 链路自检：在干净状态上跑一遍初始化，断言条数口径
  const state = bootstrap(null, actual.bundle, { now: GENERATED_AT })
  const findings = runChecks(state)
  const counts = selectCounts(state)
  const invariantProblems = assertInvariants(state)

  console.log('[verify] 初始化结果：')
  console.log(
    `           演练总数=${counts.total}（样例 ${actual.meta.sampleCount} + 迁入）`,
  )
  console.log(
    `           待组织=${counts.byStatus['待组织']} 演练中=${counts.byStatus['演练中']} ` +
      `已评估=${counts.byStatus['已评估']} 已取消=${counts.byStatus['已取消']}`,
  )
  console.log(`           处置待办=${counts.todos}（应等于已评估有结论=${counts.concluded}）`)
  console.log(`           缺项待确认=${counts.pendings}`)
  console.log(`           自检问题=${counts.findings}：`)
  for (const finding of findings) {
    console.log(`             - [${finding.kind}] ${finding.drillCode}：${finding.reason}`)
  }
  console.log(`           迁移账=${state.ledger.length} 条`)

  if (counts.concluded !== counts.todos) {
    console.error('[verify] 已评估有结论条数与处置待办条数不一致')
    ok = false
  }
  if (invariantProblems.length > 0) {
    for (const problem of invariantProblems) {
      console.error(`[verify] 不变量被破坏：${problem}`)
    }
    ok = false
  }
  if (findings.length !== counts.findings) {
    console.error('[verify] 自检条数与计数对不上')
    ok = false
  }

  if (ok) {
    console.log('[verify] 通过：种子确定性、校验和、初始化口径、条数一致性全部正确')
  }
  return ok
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'generate') {
    await writeSeed()
    return
  }
  if (command === 'verify') {
    const ok = await verifySeed()
    process.exitCode = ok ? 0 : 1
    return
  }
  console.error('用法: emergency-pipeline.mts <generate|verify>')
  process.exitCode = 2
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
