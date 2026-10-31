// 引擎同步与树服务回归用例：启动扫描、嵌套去重、盘根自指、规范化、树查询。
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/scan/everything', async () => await import('./everything-mock'))
vi.mock('../src/main/scan/hashPool', async () => await import('./hashpool-mock'))

import {
  T,
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

const PROJ = T('proj')

function baseFixtures(): void {
  // L0 桶按「文件名+大小」分组：重复对必须同名同大小、位于不同目录
  const files: FileSpec[] = [
    { path: T('proj\\a.txt'), size: 1000, head: 'H1', full: 'F1' },
    { path: T('proj\\sub\\a.txt'), size: 1000, head: 'H1', full: 'F1' }, // a 的重复
    { path: T('proj\\c.txt'), size: 1000, head: 'H2', full: 'F2' },
    { path: T('proj\\sub\\c.txt'), size: 1000, head: 'H2b', full: 'F2b' }, // 同桶但 head 不同 → 不成组
    { path: T('proj\\sub\\d.txt'), size: 500, head: 'H3', full: 'F3' },
    { path: T('proj\\big.bin'), size: 2_000_000, head: 'HB', full: 'FB' },
    { path: T('proj\\sub\\big.bin'), size: 2_000_000, head: 'HB', full: 'FB' }, // 大文件重复（head→full 阶梯）
    { path: T('proj\\sub2\\e.txt'), size: 3000, head: 'H4', full: 'F4' }
  ]
  setFixtures([
    {
      target: PROJ,
      dirs: [T('proj\\sub'), T('proj\\sub2')],
      files
    }
  ])
  setContentFixtures(files)
}

let engine: ScanEngine

beforeEach(() => {
  useWin32Platform()
  vi.stubEnv('DUPESEEK_MICA', '')
  resetAllFixtures()
})

describeWin('同步与树服务', () => {
  it('启动扫描：条目登记、根行出现、体量与版本号正确', async () => {
    engine = await mkEngine()
    baseFixtures()
    const summary = await engine.syncTargets(mkSettings({ targets: [PROJ] }))
    expect(engine.diag().entries).toBe(8)
    expect(summary.filesFound).toBe(8)
    expect(summary.treeRev).toBeGreaterThan(0)

    const roots = engine.treeRoots('size', true)
    expect(roots.dirs).toHaveLength(1)
    expect(roots.dirs[0].path).toBe(PROJ)
    // 1000*4 + 500 + 2M*2 + 3000 = 4,007,500
    expect(roots.dirs[0].size).toBe(4_007_500)
  })

  it('子级查询：目录按体量降序、直属文件聚合行正确', async () => {
    engine = await mkEngine()
    baseFixtures()
    await engine.syncTargets(mkSettings({ targets: [PROJ] }))

    const kids = engine.treeChildren(PROJ, 'size', true)
    expect(kids?.dirs.map((d) => d.name)).toEqual(['sub', 'sub2'])
    const agg = kids?.agg
    expect(agg?.count).toBe(3) // a/c/big 直属 proj
    expect(agg?.size).toBe(2_002_000)

    const files = engine.treeFiles(PROJ, 'size', true, 0, 10)
    expect(files?.total).toBe(3)
    expect(files?.rows[0].size).toBe(2_000_000)
  })

  it('重复分组：同内容成组、同桶异内容不成组，dup 归集到目录与文件行', async () => {
    engine = await mkEngine()
    baseFixtures()
    const summary = await engine.syncTargets(mkSettings({ targets: [PROJ] }))
    // a 对一组、big 对一组；c 对同桶但 head 不同 → 不成组
    expect(summary.dupeGroups).toBe(2)
    expect(summary.wastedBytes).toBe(1000 + 2_000_000)

    // 文件行：每组保留最早修改的一份，其余计 dupWasted
    // proj 直属：a（保留）/c/big（保留）→ dup 和为 0；重复副本在 sub 下
    const projFiles = engine.treeFiles(PROJ, 'size', true, 0, 10)
    expect((projFiles?.rows ?? []).reduce((s, f) => s + f.dupWasted, 0)).toBe(0)
    const subFiles = engine.treeFiles(T('proj\\sub'), 'size', true, 0, 10)
    expect((subFiles?.rows ?? []).reduce((s, f) => s + f.dupWasted, 0)).toBe(2_001_000)
  })

  it('回归：盘根目标自指——盘根作为目标时根节点必须出现在树中', async () => {
    engine = await mkEngine()
    const driveRoot = 'C:\\'
    setFixtures([
      {
        target: driveRoot,
        dirs: ['C:\\Users'],
        files: [
          { path: 'C:\\dstop.txt', size: 100, head: 'T1', full: 'TF1' },
          { path: 'C:\\Users\\u.txt', size: 200, head: 'T2', full: 'TF2' }
        ]
      }
    ])
    setContentFixtures([
      { path: 'C:\\dstop.txt', head: 'T1', full: 'TF1' },
      { path: 'C:\\Users\\u.txt', head: 'T2', full: 'TF2' }
    ])
    await engine.syncTargets(mkSettings({ targets: [driveRoot] }))

    const roots = engine.treeRoots('size', true)
    expect(roots.dirs).toHaveLength(1)
    expect(roots.dirs[0].path).toBe('C:\\')
    expect(roots.dirs[0].size).toBe(300)
    const kids = engine.treeChildren('C:\\', 'size', true)
    expect(kids?.dirs.some((d) => d.name === 'Users')).toBe(true)
  })

  it('回归：目标规范化——尾斜杠/大小写变体不产生第二份会话', async () => {
    engine = await mkEngine()
    baseFixtures()
    await engine.syncTargets(mkSettings({ targets: [PROJ] }))
    const first = engine.diag()

    // 变体：尾斜杠 + 大小写差异 → coveredTargets 已覆盖，无新增枚举
    await engine.syncTargets(mkSettings({ targets: [PROJ.toLowerCase() + '\\'] }))
    expect(engine.diag().entries).toBe(first.entries)
    expect(engine.treeRoots('size', true).dirs).toHaveLength(1)
    expect(engine.treeRoots('size', true).dirs[0].path).toBe(PROJ)
  })

  it('回归：嵌套目标去重——父子同为目标时条目唯一、无自配对', async () => {
    engine = await mkEngine()
    const inner = T('data\\inner')
    setFixtures([
      {
        target: T('data'),
        dirs: [inner],
        files: [
          { path: T('data\\f.txt'), size: 500, head: 'K1', full: 'KF1' },
          { path: T('data\\inner\\f.txt'), size: 500, head: 'K1', full: 'KF1' },
          { path: T('data\\inner\\g.txt'), size: 700, head: 'K2', full: 'KF2' }
        ]
      },
      {
        target: inner,
        dirs: [],
        files: [
          { path: T('data\\inner\\f.txt'), size: 500, head: 'K1', full: 'KF1' },
          { path: T('data\\inner\\g.txt'), size: 700, head: 'K2', full: 'KF2' }
        ]
      }
    ])
    setContentFixtures([
      { path: T('data\\f.txt'), head: 'K1', full: 'KF1' },
      { path: T('data\\inner\\f.txt'), head: 'K1', full: 'KF1' },
      { path: T('data\\inner\\g.txt'), head: 'K2', full: 'KF2' }
    ])
    const summary = await engine.syncTargets(mkSettings({ targets: [T('data'), inner] }))

    // 嵌套去重：inner\f.txt 虽被两个目标枚举，但全局只存一份 → 3 条目
    expect(engine.diag().entries).toBe(3)
    expect(summary.filesFound).toBe(3)
    // f 的两份是不同路径的真实重复（1 组）；inner 的重复枚举不产生自配对
    expect(summary.dupeGroups).toBe(1)

    // 两个根行都在（同一数据多处引用）
    const roots = engine.treeRoots('size', true)
    expect(roots.dirs.map((d) => d.path).sort()).toEqual([T('data'), inner].sort())
  })
})
