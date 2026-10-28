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
const roots = engine.treeRoots('size', true)
console.log('[final] roots =', roots.dirs.length, 'rev =', roots.rev)
process.exit(0)
