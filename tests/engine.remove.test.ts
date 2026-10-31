// 移除目标的回归用例：异步清理、重归属体量补记、删除反扣与剪枝、单文件目标。
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
  whenSettled,
  type FileSpec
} from './helpers'
import type { ScanEngine } from '../src/main/scan/engine'

const DATA = 'D:\\data'
const INNER = 'D:\\data\\inner'

function innerOwnedFixtures(): void {
  const files: FileSpec[] = [
    { path: DATA + '\\f.txt', size: 500, head: 'K1', full: 'KF1' },
    { path: INNER + '\\h.txt', size: 700, head: 'K2', full: 'KF2' }
  ]
  setFixtures([
    { target: INNER, dirs: [], files: [{ path: INNER + '\\h.txt', size: 700, head: 'K2', full: 'KF2' }] },
    { target: DATA, dirs: [INNER], files: [{ path: DATA + '\\f.txt', size: 500, head: 'K1', full: 'KF1' }] }
  ])
  setContentFixtures(files)
}

let engine: ScanEngine

beforeEach(() => {
  useWin32Platform()
  resetAllFixtures()
})

describeWin('移除目标', () => {
  it('调度即时生效：根行立即从查询结果消失，清理后台收敛', async () => {
    engine = await mkEngine()
    innerOwnedFixtures()
    await engine.syncTargets(mkSettings({ targets: [DATA, INNER] }))
    expect(engine.treeRoots('size', true).dirs).toHaveLength(2)

    engine.scheduleRemoval(INNER)
    const roots = engine.treeRoots('size', true)
    expect(roots.dirs.some((d) => d.path === INNER)).toBe(false)
    await engine.whenSettled()
    expect(engine.diag().entries).toBe(2) // f.txt 保留（仍被 DATA 覆盖）
    expect(engine.treeRoots('size', true).dirs).toHaveLength(1)
  })

  it('回归：移除深层目标向浅覆盖者重归属——体量补记不双计不遗漏', async () => {
    engine = await mkEngine()
    innerOwnedFixtures()
    // 注册顺序：inner 先枚举（拥有自己的文件），DATA 后加入（覆盖两者）
    await engine.syncTargets(mkSettings({ targets: [INNER, DATA] }))
    expect(engine.diag().entries).toBe(2)

    // 移除浅层 DATA：其独有条目（f.txt 无剩余覆盖者）删除，inner 的条目保留
    engine.scheduleRemoval(DATA)
    await engine.whenSettled()
    expect(engine.diag().entries).toBe(1)
    expect(engine.diagDir(INNER)?.size).toBe(700)
    expect(engine.treeRoots('size', true).dirs.some((d) => d.path === INNER)).toBe(true)
  })

  it('回归：移除被覆盖的深层目标——重归属给浅层且祖先链补齐（extendBytes 起点正确）', async () => {
    engine = await mkEngine()
    innerOwnedFixtures()
    // inner 先枚举（拥有 h.txt，字节链止于 inner），DATA 后加入
    await engine.syncTargets(mkSettings({ targets: [INNER, DATA] }))
    // 移除 inner：h.txt 重归属给 DATA，体量需补记到 DATA 根（inner 节点本身注册时已计过，不得双计）
    engine.scheduleRemoval(INNER)
    await engine.whenSettled()

    expect(engine.diag().entries).toBe(2) // f.txt + h.txt 都被 DATA 覆盖
    expect(engine.diagDir(INNER)?.size).toBe(700) // inner 节点体量不变（注册时已计）
    expect(engine.diagDir(DATA)?.size).toBe(1200) // f(500) + h(700)
    const kids = engine.treeChildren(DATA, 'size', true)
    expect(kids?.dirs.some((d) => d.name === 'inner')).toBe(true)
  })

  it('回归：移除唯一目标——条目删除、体量反扣、空链剪枝', async () => {
    engine = await mkEngine()
    innerOwnedFixtures()
    await engine.syncTargets(mkSettings({ targets: [DATA] }))
    // 单文件在目标根：dirs 仅根自身 = 1
    expect(engine.diag().dirs).toBe(1)

    engine.scheduleRemoval(DATA)
    await engine.whenSettled()
    expect(engine.diag().entries).toBe(0)
    expect(engine.treeRoots('size', true).dirs).toHaveLength(0)
    expect(engine.diag().dirs).toBe(0)
  })

  it('回归：单文件目标移除（无重复内容）——精确反扣不误伤', async () => {
    engine = await mkEngine()
    setFixtures([
      {
        target: DATA,
        dirs: [],
        files: [{ path: DATA + '\\f.txt', size: 500, head: 'K1', full: 'KF1' }]
      }
    ])
    setContentFixtures([{ path: DATA + '\\f.txt', head: 'K1', full: 'KF1' }])
    await engine.syncTargets(mkSettings({ targets: [DATA] }))

    engine.scheduleRemoval(DATA)
    await engine.whenSettled()
    expect(engine.diag().entries).toBe(0)
    expect(engine.diag().dirs).toBe(0)
    expect(engine.treeRoots('size', true).dirs).toHaveLength(0)
  })

  it('多个移除排队：一次性移除多个目标全部收敛', async () => {
    engine = await mkEngine()
    setFixtures([
      {
        target: 'D:\\a',
        dirs: [],
        files: [{ path: 'D:\\a\\x.txt', size: 100, head: 'XA', full: 'XA' }]
      },
      {
        target: 'D:\\b',
        dirs: [],
        files: [{ path: 'D:\\b\\y.txt', size: 200, head: 'XB', full: 'XB' }]
      },
      {
        target: 'D:\\c',
        dirs: [],
        files: [{ path: 'D:\\c\\z.txt', size: 300, head: 'XC', full: 'XC' }]
      }
    ])
    setContentFixtures([
      { path: 'D:\\a\\x.txt', head: 'XA' },
      { path: 'D:\\b\\y.txt', head: 'XB' },
      { path: 'D:\\c\\z.txt', head: 'XC' }
    ])
    await engine.syncTargets(mkSettings({ targets: ['D:\\a', 'D:\\b', 'D:\\c'] }))
    expect(engine.diag().entries).toBe(3)

    engine.scheduleRemoval('D:\\a')
    engine.scheduleRemoval('D:\\b')
    await engine.whenSettled()
    expect(engine.diag().entries).toBe(1)
    expect(engine.diag().owners).toBe(1)
    const roots = engine.treeRoots('size', true)
    expect(roots.dirs.map((d) => d.path)).toEqual(['D:\\c'])
  })

  it('移除后重扫描：组与树完全重建', async () => {
    engine = await mkEngine()
    innerOwnedFixtures()
    await engine.syncTargets(mkSettings({ targets: [DATA, INNER] }))
    engine.scheduleRemoval(INNER)
    await engine.whenSettled()

    const summary = await engine.rescanAll(mkSettings({ targets: [DATA] }))
    expect(summary.filesFound).toBe(1)
    expect(engine.diag().dirs).toBe(1)
  })
})
