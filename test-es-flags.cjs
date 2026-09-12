// 权威对照：/aL 取 junction 清单 → 分类各查询形式的结果
const { spawn } = require('child_process')

const ES = 'D:\\Coding\\DupeSeek\\resources\\bin\\es.exe'
const SCOPE = 'C:\\Users\\kaikai\\scoop\\persist\\bun\\install\\cache'

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(ES, args, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => (out += c.toString('utf8')))
    child.on('exit', () => resolve(out))
  })
}

function parse(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (!text.trim()) return []
  return JSON.parse(text).map((r) => r.filename.replace(/[\\/]+$/, ''))
}

async function main() {
  // 真值：junction 全集（<pkg>\<ver>@@@1 形式，用户 fsutil 已验证该模式为 mount point）
  const junctions = new Set(
    parse(await run(['-path', SCOPE, '-n', '5000', '-json', '-full-path-and-name', '/aL'])).filter(
      (p) => /@@@1$/.test(p)
    )
  )
  console.log('junction 真值数量:', junctions.size)

  for (const flag of ['/ad-L', '/a-d-L', '/ad', '/a-d']) {
    const rows = parse(await run(['-path', SCOPE, '-n', '5000', '-json', '-full-path-and-name', flag]))
    const leakedJunctions = rows.filter((p) => junctions.has(p))
    // 扁平真实目录（<pkg>@<ver>@@@1）：不应被任何目录排除误伤
    const flattened = rows.filter((p) => /@@@1$/.test(p) && !junctions.has(p))
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

main()
