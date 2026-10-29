// 诊断：模拟"左侧新增目标"——先同步小目标，再增量加入大目标，
// 期间以渲染端的节奏（400ms force 语义）轮询树查询，观察应答是否
// 出现空/加载态。
import { ScanEngine } from '../src/main/scan/engine.ts'
import { defaultScanDraft } from '../src/shared/defaults.ts'

process.env['DUPESEEK_BIN_DIR'] = path.resolve('resources/bin')
;(process as { resourcesPath?: string }).resourcesPath = path.resolve('resources')

import path from 'path'

const docs = 'D:\\Coding\\DupeSeek\\docs'
const big = 'D:\\Coding\\DupeSeek'
const settings1 = { ...defaultScanDraft(), targets: [docs] }
const settings2 = { ...defaultScanDraft(), targets: [docs, big] }

const engine = new ScanEngine(() => {})
await engine.syncTargets(settings1)
console.log('[phase1] 完成：entries =', engine.entries.size)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const p2 = engine.syncTargets(settings2).catch((e) => console.error('[phase2] 失败：', e))

for (let i = 0; i < 12; i++) {
  await sleep(400)
  const roots = engine.treeRoots('size', true)
  const kids = engine.treeChildren(big, 'size', true)
  console.log(
    `#${i} rev=${roots.rev} roots=${roots.dirs.length} stats.dirs=${roots.stats.dirCount} | children(${big}) = ${
      kids === null ? 'null' : `${kids.dirs.length} dirs`
    }`
  )
}
await p2
const roots2 = engine.treeRoots('size', true)
console.log('[final] roots =', roots2.dirs.length, 'rev =', roots2.rev)

// phase 3: 移除——调度应即时返回，清理异步收敛
const bigRow = roots2.dirs.find((r) => r.path === big)
if (bigRow) {
  const t0 = Date.now()
  // @ts-expect-error 诊断直通私有方法
  engine.scheduleRemoval(big)
  const immediate = engine.treeRoots('size', true)
  console.log(
    '[remove big] 调度耗时',
    Date.now() - t0,
    'ms; roots 立即 =',
    immediate.dirs.length,
    '(应不含大目标)'
  )
  for (let i = 0; i < 8; i++) {
    await sleep(300)
    const r = engine.treeRoots('size', true)
    console.log(`[cleanup #${i}] rev=${r.rev} roots=${r.dirs.length} dirs=${r.stats.dirCount}`)
  }
  // @ts-expect-error 诊断直通
  const rec = engine.dirs.get(big)
  // @ts-expect-error 诊断直通
  const kid = engine.dirs.get(big + '\\dist')
  console.log(
    '[internal] big rec =',
    JSON.stringify(rec),
    '| dist rec =',
    JSON.stringify(kid),
    '| dirs =',
    engine.dirs.size
  )
}

// phase 4: 单文件目标移除
const fileTarget = 'D:\\Coding\\DupeSeek\\package.json'
await engine.syncTargets({ ...settings2, targets: [docs, fileTarget] })
console.log('[phase4] file target added, entries =', engine.entries.size)
// @ts-expect-error 诊断直通私有方法
engine.scheduleRemoval(fileTarget)
await sleep(1000)
const r4 = engine.treeRoots('size', true)
console.log('[phase4] after removal roots =', r4.dirs.length, 'stats =', JSON.stringify(r4.stats))
process.exit(0)
