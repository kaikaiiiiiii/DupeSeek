// 测试基建：Windows 路径语义补丁、引擎工厂、fixture 构建器。
// 前置：测试文件需先 vi.mock everything/hashPool 两个模块（factory 见
// tests/everything-mock.ts 与 tests/hashpool-mock.ts，直接转发模块自身）。
import { describe } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ScanEngine } from '../src/main/scan/engine'
import { defaultScanDraft } from '../src/shared/defaults'
import type { ScanSettings } from '../src/shared/types'
import { setFixtures as setEsFixtures, resetFixtures } from './everything-mock'
import { setContentBulk, resetContent } from './hashpool-mock'

export const WIN = process.platform === 'win32'
/** 引擎测试依赖 Windows 路径语义，非 Windows runner 上整组跳过 */
export const describeWin = WIN ? describe : describe.skip

/** 强制 process.platform = win32（本地/CI 可能非 Windows） */
export function useWin32Platform(): () => void {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  return () => {
    if (desc) Object.defineProperty(process, 'platform', desc)
  }
}

/** fixture 根目录：真实存在于临时盘（引擎会 lstat 目标确认存在） */
export const TEST_ROOT = path.join(os.tmpdir(), 'dupeseek-vitest')

/** 相对路径 → 测试根下的 Windows 绝对路径（仅 win32 测试环境使用） */
export function T(rel: string): string {
  return path.join(TEST_ROOT, ...rel.split(/[\/]+/))
}

export interface FileSpec {
  /** Windows 风格绝对路径（引擎按其反斜杠语义处理） */
  path: string
  size: number
  mtime?: number
  /** 内容等价键：相同键 → 相同哈希（用于构造重复组） */
  head: string
  full?: string
}

export interface FixtureSpec {
  target: string
  /** 目标下全部子目录（es /ad 语义，含多级） */
  dirs?: string[]
  files: FileSpec[]
  reparse?: string[]
}

/** 注册目标枚举 fixture（es 通道数据源） */
export function setFixtures(specs: FixtureSpec[]): void {
  resetFixtures()
  // 引擎枚举前会 lstat 目标：fixture 目标与子目录必须真实存在（文件不需要）
  for (const s of specs) {
    try {
      fs.mkdirSync(s.target, { recursive: true })
      for (const d of s.dirs ?? []) fs.mkdirSync(d, { recursive: true })
    } catch {
      // 目标已存在（如盘根）即可满足 lstat 前置
    }
  }
  setEsFixtures(
    specs.map((s) => ({
      target: s.target,
      dirs: s.dirs ?? [],
      files: s.files.map((f) => ({
        filename: f.path,
        size: f.size,
        mtimeMs: f.mtime ?? 1700000000000
      })),
      reparse: s.reparse ?? []
    }))
  )
}

export function setContentFixtures(
  entries: Array<{ path: string; head: string; full?: string }>
): void {
  setContentBulk(entries)
}

export function resetAllFixtures(): void {
  resetFixtures()
  resetContent()
}

export function mkSettings(
  overrides?: Partial<Pick<ScanSettings, 'targets' | 'excludeDirNames' | 'excludeDirPaths' | 'useEverything' | 'scanArchives' | 'excludeHidden' | 'excludeSystem' | 'excludeJunction'>>
): ScanSettings {
  return { ...defaultScanDraft(), ...(overrides ?? {}) }
}

export async function mkEngine(): Promise<ScanEngine> {
  const { ScanEngine } = await import('../src/main/scan/engine')
  return new ScanEngine(() => {})
}

export async function whenSettled(engine: ScanEngine): Promise<void> {
  const e = engine as unknown as {
    cleaningUp: boolean
    removalTasks: string[]
  }
  for (;;) {
    if (!e.cleaningUp && e.removalTasks.length === 0) return
    await new Promise<void>((r) => setImmediate(r))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
