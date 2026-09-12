// es 属性开关行为矩阵验证（以 /aL 的 junction 清单为真值）
// 注意：不用正则字面量——Node --experimental-strip-types 会损坏含反斜杠的正则
// 用法：node --experimental-strip-types test-es-flags.mts
import { spawn } from 'node:child_process'

const ES = 'D:\\Coding\\DupeSeek\\resources\\bin\\es.exe'
const SCOPE = 'C:\\Users\\kaikai\\scoop\\persist\\bun\\install\\cache'

interface EsRow {
  filename: string
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(ES, args, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('exit', () => resolve(out))
  })
}

/** 剥离 BOM 与首尾分隔符（不用正则：strip-types 会损坏含反斜杠的正则字面量） */
function parse(text: string): string[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (!text.trim()) return []
  return (JSON.parse(text) as EsRow[]).map((r) => {
    let p = r.filename
    while (p.endsWith('\\') || p.endsWith('/')) p = p.slice(0, -1)
    return p
  })
}

const isJunctionRoot = (p: string): boolean => p.endsWith('@@@1')

async function main(): Promise<void> {
  // 真值：junction 全集（<包名>\<版本>@@@1 形式，fsutil 已验证该模式为 mount point）
  const junctions = new Set(
    parse(await run(['-path', SCOPE, '-n', '5000', '-json', '-full-path-and-name', '/aL'])).filter(
      (p) => isJunctionRoot(p)
    )
  )
  console.log('junction 真值数量:', junctions.size)

  for (const flag of ['/ad-L', '/a-d-L', '/ad', '/a-d']) {
    const rows = parse(
      await run(['-path', SCOPE, '-n', '5000', '-json', '-full-path-and-name', flag])
    )
    const leakedJunctions = rows.filter((p) => junctions.has(p))
    // 扁平真实目录（<包名>@<版本>@@@1）：普通目录，不应被任何排除误伤
    const flattened = rows.filter((p) => isJunctionRoot(p) && !junctions.has(p))
    console.log(
      JSON.stringify({
        flag,
        rows: rows.length,
        junctionLeak: leakedJunctions.length,
        flattenedRealDirs: flattened.length
      })
    )
  }
  process.exit(0)
}

void main()
