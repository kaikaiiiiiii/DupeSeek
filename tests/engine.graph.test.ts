// 目录关系图回归：展示单元聚合、深度上卷、阈值过滤、组内多副本按 min 计数。
import { beforeEach, expect, it, vi } from 'vitest'

vi.mock('../src/main/scan/everything', async () => await import('./everything-mock'))
vi.mock('../src/main/scan/hashPool', async () => await import('./hashpool-mock'))

import {
  T,
  describeWin,
  mkEngine,
  mkSettings,
  resetAllFixtures,
  setContentFixtures,
  setFixtures,
  useWin32Platform,
  type FileSpec
} from './helpers'
import type { ScanEngine } from '../src/main/scan/engine'

const ROOT = T('graph')
const A = T('graph\\a')
const B = T('graph\\b')
const A_SUB = T('graph\\a\\sub')
const B_SUB = T('graph\\b\\sub')

let engine: ScanEngine

beforeEach(() => {
  useWin32Platform()
  resetAllFixtures()
})

/** 注册一个目标的磁盘现状并完成同步扫描 */
async function scan(files: FileSpec[], dirs: string[] = []): Promise<void> {
  setFixtures([{ target: ROOT, dirs, files }])
  setContentFixtures(files)
  await engine.syncTargets(mkSettings({ targets: [ROOT], useEverything: true }))
}

describeWin('目录关系图', () => {
  it('同内容类按展示单元聚合为一条无向边，节点含祖先链与体积', async () => {
    engine = await mkEngine()
    await scan([
      { path: A + '\\x.txt', size: 100, head: 'H1', full: 'F1' },
      { path: B + '\\x.txt', size: 100, head: 'H1', full: 'F1' },
      { path: A + '\\only.txt', size: 50, head: 'H2', full: 'F2' }
    ])

    const g = engine.graphRelations(1, 1)
    expect(g.rev).toBeGreaterThan(0)
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0].sharedBytes).toBe(100)
    expect(g.edges[0].sharedFiles).toBe(1)
    expect([g.edges[0].source, g.edges[0].target].sort()).toEqual([A, B].sort())

    expect(g.nodes.map((n) => n.id).sort()).toEqual([ROOT, A, B].sort())
    const root = g.nodes.find((n) => n.id === ROOT)
    const nodeA = g.nodes.find((n) => n.id === A)
    const nodeB = g.nodes.find((n) => n.id === B)
    expect(root?.depth).toBe(0)
    expect(root?.hasChildren).toBe(true)
    expect(nodeA?.parentId).toBe(ROOT)
    expect(nodeA?.depth).toBe(1)
    expect(nodeA?.bytes).toBe(150)
    expect(nodeB?.bytes).toBe(100)
    // 重复占用：一组两个成员，保留一份，另一份计入各自目录链
    expect((nodeA?.reclaim ?? 0) + (nodeB?.reclaim ?? 0)).toBe(100)
  })

  it('深度参数决定展示单元：depth=2 时下钻到二级目录', async () => {
    engine = await mkEngine()
    await scan(
      [
        { path: A_SUB + '\\x.txt', size: 200, head: 'H1', full: 'F1' },
        { path: B_SUB + '\\x.txt', size: 200, head: 'H1', full: 'F1' }
      ],
      [A, B, A_SUB, B_SUB]
    )

    const shallow = engine.graphRelations(1, 1)
    expect([shallow.edges[0].source, shallow.edges[0].target].sort()).toEqual([A, B].sort())
    expect(shallow.nodes.map((n) => n.id).sort()).toEqual([ROOT, A, B].sort())

    const deep = engine.graphRelations(2, 1)
    expect([deep.edges[0].source, deep.edges[0].target].sort()).toEqual([A_SUB, B_SUB].sort())
    expect(deep.nodes.map((n) => n.id).sort()).toEqual([ROOT, A, B, A_SUB, B_SUB].sort())
    expect(deep.nodes.find((n) => n.id === A_SUB)?.parentId).toBe(A)
    expect(deep.nodes.find((n) => n.id === A_SUB)?.depth).toBe(2)
  })

  it('组内多副本按两侧最小副本数计共享量', async () => {
    engine = await mkEngine()
    await scan([
      { path: A + '\\x.txt', size: 100, head: 'H1', full: 'F1' },
      { path: A + '\\y.txt', size: 100, head: 'H1', full: 'F1' },
      { path: B + '\\z.txt', size: 100, head: 'H1', full: 'F1' }
    ])
    // 名称不同，需按大小分组（ignoreName）才能形成同组三成员
    setFixtures([
      {
        target: ROOT,
        dirs: [],
        files: [
          { path: A + '\\x.txt', size: 100, head: 'H1', full: 'F1' },
          { path: A + '\\y.txt', size: 100, head: 'H1', full: 'F1' },
          { path: B + '\\z.txt', size: 100, head: 'H1', full: 'F1' }
        ]
      }
    ])
    await engine.rescanAll(mkSettings({ targets: [ROOT], useEverything: true, ignoreName: true }))

    const g = engine.graphRelations(1, 1)
    expect(g.edges).toHaveLength(1)
    // A 两份、B 一份 → 两侧最小副本数为 1
    expect(g.edges[0].sharedFiles).toBe(1)
    expect(g.edges[0].sharedBytes).toBe(100)
  })

  it('minSharedBytes 阈值过滤边；无关系时返回空图', async () => {
    engine = await mkEngine()
    await scan([
      { path: A + '\\x.txt', size: 100, head: 'H1', full: 'F1' },
      { path: B + '\\x.txt', size: 100, head: 'H1', full: 'F1' }
    ])

    expect(engine.graphRelations(1, 1).edges).toHaveLength(1)
    const filtered = engine.graphRelations(1, 101)
    expect(filtered.edges).toHaveLength(0)
    expect(filtered.nodes).toHaveLength(0)
  })
})
