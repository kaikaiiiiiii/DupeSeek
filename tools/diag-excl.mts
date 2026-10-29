// 诊断：目录排除三场景——路径排除子树、名称排除、目标本身被排除
import path from 'path'
import { ScanEngine } from '../src/main/scan/engine.ts'
import { defaultScanDraft } from '../src/shared/defaults.ts'

process.env['DUPESEEK_BIN_DIR'] = path.resolve('resources/bin')
;(process as { resourcesPath?: string }).resourcesPath = path.resolve('resources')

const base = { ...defaultScanDraft(), targets: ['D:\\Coding\\DupeSeek'] }
const engine = new ScanEngine(() => {})

// 场景 1：路径排除 dist 子树
await engine.syncTargets({ ...base, excludeDirPaths: 'D:\\Coding\\DupeSeek\\dist\\' })
let r = engine.treeRoots('size', true)
let kids = engine.treeChildren('D:\\Coding\\DupeSeek', 'size', true)
const dist = kids?.dirs.find((d) => d.name === 'dist')
console.log(
  '[路径排除 dist] totalSize =',
  r.stats.totalSize,
  '| dist =',
  JSON.stringify(dist),
  '| dirs =',
  engine.dirs.size
)
// @ts-expect-error 诊断直通
console.log('[internal] excludedDirs =', engine.excludedDirs.size, JSON.stringify([...engine.excludedDirs.keys()].slice(0, 5)))
// @ts-expect-error 诊断直通
console.log('[internal] dirs.get(dist) =', JSON.stringify(engine.dirs.get('D:\\Coding\\DupeSeek\\dist')))
// @ts-expect-error 诊断直通
console.log('[internal] childDirs(big) =', JSON.stringify(engine.childDirs.get('D:\\Coding\\DupeSeek')?.slice(0, 15)))

// 场景 2：名称排除 dist 与 .git
await engine.rescanAll({ ...base, excludeDirNames: 'dist, .git' })
kids = engine.treeChildren('D:\\Coding\\DupeSeek', 'size', true)
const d1 = kids?.dirs.find((d) => d.name === 'dist')
const d2 = kids?.dirs.find((d) => d.name === '.git')
console.log(
  '[名称排除 dist/.git] dist =',
  JSON.stringify(d1),
  '| .git =',
  JSON.stringify(d2),
  '| dirs =',
  engine.dirs.size
)

// 场景 3：目标本身被排除 → 空目标
await engine.rescanAll({
  ...base,
  targets: ['D:\\Coding\\DupeSeek\\dist'],
  excludeDirPaths: 'D:\\Coding\\DupeSeek\\dist'
})
r = engine.treeRoots('size', true)
// @ts-expect-error 诊断直通
console.log('[目标即排除] childDirs(dist) =', JSON.stringify(engine.childDirs.get('D:\Coding\DupeSeek\dist')))
// @ts-expect-error 诊断直通
console.log('[目标即排除] excludedDirs =', JSON.stringify([...engine.excludedDirs]))
console.log(
  '[目标即排除] roots =',
  r.dirs.length,
  JSON.stringify(r.dirs[0]),
  '| entries =',
  engine.entries.size
)
process.exit(0)
