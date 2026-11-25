// 分支刷新回归：应用外手工增删后对齐单个子树，不改变目标列表（docs/Cleanup.md）。
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/main/scan/everything', async () => await import('./everything-mock'))
vi.mock('../src/main/scan/hashPool', async () => await import('./hashpool-mock'))

import {
  describeWin,
  mkEngine,
  mkSettings,
  resetAllFixtures,
  setFixtures,
  setContentFixtures,
  useWin32Platform,
  type FileSpec
} from './helpers'
import type { ScanEngine } from '../src/main/scan/engine'

const DATA = 'D:\\branchdata'
const INNER = DATA + '\\inner'

/** 基础磁盘现状：INNER\a.txt 与 DATA\a.txt 同名同大小同内容（成组），c.txt 独立 */
function baseFixtures(): FileSpec[] {
  return [
    { path: DATA + '\\a.txt', size: 100, head: 'H1', full: 'F1' },
    { path: INNER + '\\a.txt', size: 100, head: 'H1', full: 'F1' },
    { path: DATA + '\\c.txt', size: 300, head: 'H3', full: 'F3' }
  ]
}

function setDisk(files: FileSpec[], dirs: string[] = []): void {
  setFixtures([{ target: DATA, dirs, files }])
}

const refreshSettings = (): ReturnType<typeof mkSettings> =>
  mkSettings({ targets: [DATA], useEverything: true })

let engine: ScanEngine

beforeEach(() => {
  useWin32Platform()
  resetAllFixtures()
})

describeWin('分支刷新', () => {
  it('应用外删除的文件在刷新后从会话剔除：条目、组、树同步收敛', async () => {
    engine = await mkEngine()
    const files = baseFixtures()
    setDisk(files, [INNER])
    setContentFixtures(files)
    await engine.syncTargets(refreshSettings())
    expect(engine.diagGroups()).toHaveLength(1) // 同名同大小同内容成组
    expect(engine.diagDir(DATA)?.size).toBe(500)

    // 模拟应用外手工删除 INNER\a.txt：重新注册磁盘现状后刷新
    const after = files.filter((f) => f.path !== INNER + '\\a.txt')
    setDisk(after, [INNER])
    const report = await engine.refreshBranch(refreshSettings(), DATA)
    expect(report.removed).toBe(1)
    expect(report.added).toBe(0)
    expect(engine.diagEntry(INNER + '\\a.txt')).toBeUndefined()
    expect(engine.diagGroups()).toHaveLength(0) // 组不足 2 解散
    expect(engine.diagDir(DATA)?.size).toBe(400)
    expect(engine.treeRoots('size', true).dirs).toHaveLength(1)
  })

  it('新增与变化：刷新登记新文件、更新变化的体积', async () => {
    engine = await mkEngine()
    const files = baseFixtures()
    setDisk(files, [INNER])
    setContentFixtures(files)
    await engine.syncTargets(refreshSettings())

    // c.txt 体积变化（应用内改写）、d.txt 为新文件
    const after: FileSpec[] = [
      files[0],
      files[1],
      { path: DATA + '\\c.txt', size: 600, head: 'H3', full: 'F3' },
      { path: DATA + '\\d.txt', size: 200, head: 'H2', full: 'F2' }
    ]
    setDisk(after, [INNER])
    setContentFixtures(after)
    const report = await engine.refreshBranch(refreshSettings(), DATA)
    expect(report.added).toBe(1)
    expect(report.updated).toBe(1)
    expect(report.removed).toBe(0)
    expect(engine.diagEntry(DATA + '\\c.txt')?.size).toBe(600)
    expect(engine.diagEntry(DATA + '\\d.txt')).toBeDefined()
    expect(engine.diagDir(DATA)?.size).toBe(1000)
  })

  it('子树刷新只影响该前缀：兄弟与祖先条目不受牵连', async () => {
    engine = await mkEngine()
    const files: FileSpec[] = [
      { path: DATA + '\\f.txt', size: 500, head: 'K1', full: 'KF1' },
      { path: INNER + '\\h.txt', size: 700, head: 'K2', full: 'KF2' }
    ]
    setDisk(files, [INNER])
    setContentFixtures(files)
    await engine.syncTargets(mkSettings({ targets: [DATA], useEverything: true }))
    expect(engine.diag().entries).toBe(2)

    // inner 内容被应用外替换：h.txt 消失、h2.txt 出现
    const innerNow: FileSpec[] = [{ path: INNER + '\\h2.txt', size: 800, head: 'K4', full: 'KF4' }]
    setFixtures([{ target: INNER, dirs: [], files: innerNow }])
    setContentFixtures([...files, ...innerNow])
    const report = await engine.refreshBranch(
      mkSettings({ targets: [DATA], useEverything: true }),
      INNER
    )
    expect(report.added).toBe(1)
    expect(report.removed).toBe(1)

    expect(engine.diagEntry(INNER + '\\h.txt')).toBeUndefined()
    expect(engine.diagEntry(INNER + '\\h2.txt')).toBeDefined()
    expect(engine.diagEntry(DATA + '\\f.txt')).toBeDefined() // 前缀之外不受牵连
    expect(engine.diagDir(DATA)?.size).toBe(1300) // f(500) + h2(800)
  })

  it('范围外路径与排除目录拒绝刷新', async () => {
    engine = await mkEngine()
    const files = baseFixtures()
    // skip 目录出现在枚举结果中才会被登记为排除空节点
    setDisk(files, [DATA + '\\skip'])
    setContentFixtures(files)
    await engine.syncTargets(
      mkSettings({ targets: [DATA], useEverything: true, excludeDirPaths: DATA + '\\skip' })
    )
    await expect(
      engine.refreshBranch(mkSettings({ targets: [DATA] }), 'E:\\elsewhere')
    ).rejects.toThrow('该路径不在任何已扫描目标范围内')
    await expect(
      engine.refreshBranch(mkSettings({ targets: [DATA] }), DATA + '\\skip')
    ).rejects.toThrow('排除目录')
  })
})
