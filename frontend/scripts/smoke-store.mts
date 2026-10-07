/** 浏览器仓库冒烟：用极简 window/localStorage 垫片跑 store，验证引导、持久化、岗位把关与并发。 */
import assert from 'node:assert/strict'

// 在导入 store 前装好浏览器垫片
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}
const storage = new MemoryStorage()
;(globalThis as { window: unknown }).window = { localStorage: storage }

async function run(): Promise<void> {
  const store = await import('../src/domain/emergency/store')
  const {
    ensureBootstrapped,
    counts,
    checkFindings,
    listDrills,
    listTodos,
    submitDrillConclusion,
    emergencyStorageKey,
    __resetMemoryCacheForTest,
  } = store

  const first = ensureBootstrapped()
  console.log(
    '首次引导：drills=%d todos=%d findings=%d pendings=%d',
    first.drills.length,
    first.todos.length,
    checkFindings().length,
    first.pendings.length,
  )

  // 持久化确实写入
  assert.ok(storage.getItem(emergencyStorageKey()), 'state 应已写入 localStorage')
  const persisted = JSON.parse(storage.getItem(emergencyStorageKey())!)
  assert.equal(persisted.drills.length, first.drills.length)

  // 再次引导幂等
  const second = ensureBootstrapped()
  assert.equal(second.drills.length, first.drills.length)
  assert.equal(second.todos.length, first.todos.length)
  assert.equal(second.ledger.length, first.ledger.length)

  // 越权驳回
  const inProgress = listDrills().find((d) => d.status === '演练中')!
  const rejected = submitDrillConclusion({
    code: inProgress.code,
    conclusion: '越权',
    operator: { name: '李', role: '参演班组' },
    expectedVersion: inProgress.version,
  })
  assert.equal(rejected.ok, false)
  assert.match(rejected.message, /越权/)

  // 组织人员提交成功 + 待办 +1 + 持久化
  const todosBefore = listTodos().length
  const ok = submitDrillConclusion({
    code: inProgress.code,
    conclusion: '冒烟结论：合格',
    operator: { name: '周建国', role: '组织人员' },
    expectedVersion: inProgress.version,
  })
  assert.equal(ok.ok, true, ok.message)
  assert.equal(listTodos().length, todosBefore + 1)
  const afterPersist = JSON.parse(storage.getItem(emergencyStorageKey())!)
  assert.equal(afterPersist.todos.length, listTodos().length)

  // 并发：旧 version 再交一次，回退
  const conflict = submitDrillConclusion({
    code: inProgress.code,
    conclusion: '后到',
    operator: { name: '周建国', role: '组织人员' },
    expectedVersion: inProgress.version,
  })
  assert.equal(conflict.ok, false)
  assert.match(conflict.message, /并发冲突/)

  // 待办数 == 有结论评估数
  const c = counts()
  assert.equal(c.todos, c.concluded)

  // 模拟关掉标签页再开：清内存缓存，从 localStorage 冷启动重新引导，数据仍在
  __resetMemoryCacheForTest()
  const reopened = ensureBootstrapped()
  assert.ok(
    reopened.drills.some((d) => d.code === inProgress.code && d.conclusion === '冒烟结论：合格'),
    '重开后刚提交的结论仍在',
  )
  assert.equal(reopened.todos.length, listTodos().length, '重开后待办条数一致')
  console.log('浏览器仓库冒烟通过：引导/持久化/幂等/越权/并发/待办一致/重开续用全部正确')
}

run().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
