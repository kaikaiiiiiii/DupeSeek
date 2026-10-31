// 目录排除的回归用例：名称/路径双输入、空节点呈现、顶层收敛、目标自排除。
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/scan/everything', async () => await import('./everything-mock'))
vi.mock('../src/main/scan/hashPool', async () => await import('./hashpool-mock'))

import {
  describeWin,
  mkEngine,
  mkSettings,
  resetAllFixtures,
  setFixtures,
  setContentFixtures,
  useWin32Platform
} from './helpers'
import type { ScanEngine } from '../src/main/scan/engine'

const WEB = 'D:\\web'

function webFixtures(): void {
  setFixtures([
    {
      target: WEB,
      dirs: [
        WEB + '\\node_modules',
        WEB + '\\node_modules\\x',
        WEB + '\\node_modules\\m',
        WEB + '\\node_modules\\@scope\\pkg',
        WEB + '\\assets'
      ],
      files: [
        { path: WEB + '\\index.html', size: 100, head: 'W1', full: 'WF1' },
        { path: WEB + '\\assets\\a.css', size: 200, head: 'W2', full: 'WF2' },
        { path: WEB + '\\node_modules\\m\\index.js', size: 5000, head: 'W3', full: 'WF3' },
        { path: WEB + '\\node_modules\\x\\y.js', size: 600, head: 'W4', full: 'WF4' }
      ]
    }
  ])
  setContentFixtures([
    { path: WEB + '\\index.html', head: 'W1', full: 'WF1' },
    { path: WEB + '\\assets\\a.css', head: 'W2', full: 'WF2' },
    { path: WEB + '\\node_modules\\m\\index.js', head: 'W3', full: 'WF3' },
    { path: WEB + '\\node_modules\\x\\y.js', head: 'W4', full: 'WF4' }
  ])
}

let engine: ScanEngine

beforeEach(() => {
  useWin32Platform()
  resetAllFixtures()
})

describeWin('目录排除', () => {
  it('名称排除：node_modules 空节点呈现，子树条目不进入数据集', async () => {
    engine = await mkEngine()
    webFixtures()
    await engine.syncTargets(mkSettings({ targets: [WEB], excludeDirNames: 'node_modules' }))

    // 空节点：可见、0 字节、无子、无文件
    const kids = engine.treeChildren(WEB, 'size', true)
    const nm = kids?.dirs.find((d) => d.name === 'node_modules')
    expect(nm).toBeDefined()
    expect(nm?.size).toBe(0)
    expect(nm?.childDirs).toBe(0)
    expect(nm?.fileCount).toBe(0)

    // 子树条目不进入数据集；体量只含未排除部分
    expect(engine.diag().entries).toBe(2) // index.html + a.css
    expect(engine.treeRoots('size', true).stats.totalSize).toBe(300)

    // 只登记最顶层命中（node_modules/x 不重复登记）
    expect(engine.diag().excludedDirs).toBe(1)
  })

  it('路径排除：整棵子树按空节点呈现，仅登记最顶层', async () => {
    engine = await mkEngine()
    webFixtures()
    await engine.syncTargets(
      mkSettings({
        targets: [WEB],
        excludeDirNames: '',
        excludeDirPaths: WEB + '\\node_modules\\x'
      })
    )

    const kids = engine.treeChildren(WEB, 'size', true)
    const nm = kids?.dirs.find((d) => d.name === 'node_modules')
    // node_modules 未被整体排除：m/index.js 仍在；x 为排除空节点
    expect(nm?.size).toBe(5000)
    expect(nm?.childDirs).toBe(2) // x（排除空节点）+ m（正常子目录）
    expect(engine.diag().entries).toBe(3) // index.html + a.css + m/index.js
    expect(engine.diag().excludedDirs).toBe(1)
  })

  it('回归：目标本身被排除——整个目标为空目录（0 条目、枚举短路）', async () => {
    engine = await mkEngine()
    webFixtures()
    await engine.syncTargets(
      mkSettings({ targets: [WEB + '\\node_modules'], excludeDirPaths: WEB + '\\node_modules' })
    )

    expect(engine.diag().entries).toBe(0)
    const roots = engine.treeRoots('size', true)
    expect(roots.dirs).toHaveLength(1)
    expect(roots.dirs[0].size).toBe(0)
    expect(roots.dirs[0].childDirs).toBe(0)
    expect(roots.dirs[0].fileCount).toBe(0)
  })

  it('名称命中位于路径排除之内时由路径节点代表，不重复登记', async () => {
    engine = await mkEngine()
    webFixtures()
    await engine.syncTargets(
      mkSettings({
        targets: [WEB],
        excludeDirNames: 'x',
        excludeDirPaths: WEB + '\\node_modules'
      })
    )
    expect(engine.diag().excludedDirs).toBe(1)
    expect(engine.diag().entries).toBe(2) // 只有 web 自身内容
  })

  it('回归：名称排除的子目录骨架不进树——排除目录必须为叶子空节点', async () => {
    engine = await mkEngine()
    webFixtures()
    // node_modules 下还有嵌套 node_modules（真实场景）
    setFixtures([
      {
        target: WEB,
        dirs: [
          WEB + '\\node_modules',
          WEB + '\\node_modules\\x',
          WEB + '\\node_modules\\@scope\\pkg\\node_modules'
        ],
        files: [
          { path: WEB + '\\index.html', size: 100, head: 'W1', full: 'WF1' },
          { path: WEB + '\\node_modules\\x\\y.js', size: 600, head: 'W4', full: 'WF4' }
        ]
      }
    ])
    setContentFixtures([{ path: WEB + '\\index.html', head: 'W1', full: 'WF1' }])
    await engine.syncTargets(mkSettings({ targets: [WEB], excludeDirNames: 'node_modules' }))

    const kids = engine.treeChildren(WEB, 'size', true)
    const nm = kids?.dirs.find((d) => d.name === 'node_modules')
    expect(nm?.childDirs).toBe(0) // 嵌套命中由顶层代表，骨架不入树
    // web 根 + node_modules 空节点 = 2
    expect(engine.treeRoots('size', true).stats.dirCount).toBe(2)
  })
})
