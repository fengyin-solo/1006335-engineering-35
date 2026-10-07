/**
 * 极简 KV：默认后端是 localStorage，自检脚本（Node）可注入内存后端。
 * 业务模块只通过 readJSON/writeJSON 落库，保证本地与 CI 跑的是同一条链路。
 */

export type KvBackend = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const memoryStore = new Map<string, string>()
const memoryBackend: KvBackend = {
  getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key)! : null),
  setItem: (key, value) => {
    memoryStore.set(key, value)
  },
}

let backend: KvBackend | null = null

function defaultBackend(): KvBackend {
  if (typeof window !== 'undefined' && window.localStorage) {
    return {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    }
  }
  return memoryBackend
}

/** 自检脚本用：换成全新的内存后端，跑完互不污染。 */
export function useFreshMemoryBackend(): KvBackend {
  memoryStore.clear()
  backend = memoryBackend
  return backend
}

export function useCustomBackend(custom: KvBackend): void {
  backend = custom
}

function kv(): KvBackend {
  if (!backend) {
    backend = defaultBackend()
  }
  return backend
}

export function readJSON<T>(key: string, fallback: T): T {
  const raw = kv().getItem(key)
  if (raw === null) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJSON(key: string, value: unknown): void {
  kv().setItem(key, JSON.stringify(value))
}

export function rawGet(key: string): string | null {
  return kv().getItem(key)
}
