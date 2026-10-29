// 诊断：无头驱动 ScanEngine，验证体积树拉取协议（roots/children/files）。
// 用法：node --experimental-strip-types tools/diag-lazy.mts [目标目录]
import path from 'path'
import { ScanEngine } from '../src/main/scan/engine.ts'
import { defaultScanDraft } from '../src/shared/defaults.ts'

process.env['DUPESEEK_BIN_DIR'] = path.resolve('resources/bin')
// everything.ts 的 es.exe 候选首项引用 electron 全局，无头环境补齐
;(process as { resourcesPath?: string }).resourcesPath = path.resolve('resources')

const target = process.argv[2] ?? 'D:\\Clash Party'
// 多目标以逗号分隔，用于验证嵌套覆盖的去重
const settings = { ...defaultScanDraft(), targets: target.split(',') }

const engine = new ScanEngine(() => {})

// 主进程响应性测量：25ms 心跳采样事件循环最大间隙（窗口冻结 = 间隙秒级）
let maxGap = 0
let last = Date.now()
const ticker = setInterval(() => {
  const now = Date.now()
  maxGap = Math.max(maxGap, now - last)
  last = now
}, 25)

const startedAt = Date.now()
try {
  await Promise.race([
    engine.syncTargets(settings),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        engine.stop()
        resolve()
      }, 25000)
    })
  ])
} catch (err) {
  console.error('[summary] 同步失败：', err)
}
clearInterval(ticker)
// @ts-expect-error 诊断直通私有状态
console.log(
  '[timing] elapsed =',
  Date.now() - startedAt,
  'ms; maxEventLoopGap =',
  maxGap,
  'ms; entries =',
  engine.entries.size
)

const roots = engine.treeRoots('size', true)
// @ts-expect-error 诊断直通私有状态
const internal = {
  entries: engine.entries.size,
  owners: engine.owners.size,
  covered: [...engine.coveredTargets],
  dirs: engine.dirs.size
}
console.log('[internal]', JSON.stringify(internal))
console.log('[roots] dirs =', roots.dirs.length, 'stats =', JSON.stringify(roots.stats))
for (const r of roots.dirs) {
  console.log(
    `  root ${r.path} size=${r.size} dup=${r.dupWasted} childDirs=${r.childDirs} fileCount=${r.fileCount}`
  )
}
if (roots.dirs.length > 0) {
  const first = roots.dirs[0]
  const kids = engine.treeChildren(first.path, 'size', true)
  console.log(
    `[children ${first.path}] dirs = ${kids?.dirs.length ?? 'null'} agg = ${JSON.stringify(kids?.agg)}`
  )
  for (const d of kids?.dirs.slice(0, 3) ?? []) {
    console.log(
      `  child ${d.name} size=${d.size} childDirs=${d.childDirs} fileCount=${d.fileCount}`
    )
  }
  const files = engine.treeFiles(first.path, 'size', true, 0, 5)
  console.log(`[files ${first.path}] total = ${files?.total} rows = ${files?.rows.length}`)
}
process.exit(0)
