// es.exe -export-json 产物的解析 worker：读盘 + JSON.parse 都可能达数百 MB
// （全盘目标），放主进程会长时间阻塞事件循环（窗口拖动/重绘全停）。
import { parentPort } from 'node:worker_threads'
import fs from 'fs'

interface EsRow {
  filename: string
  size?: number
  date_modified?: string
}

const port = parentPort
if (!port) process.exit(1)

port.on('message', (paths: string[]) => {
  try {
    const [outFile, outDir, outReparse] = paths
    const parse = (p: string): EsRow[] => {
      let text = fs.readFileSync(p, 'utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      if (text.trim() === '') return []
      return JSON.parse(text) as EsRow[]
    }
    const files = parse(outFile)
    const dirs = parse(outDir).map((r) => r.filename.replace(/[\\/]+$/, ''))
    const reparse = parse(outReparse).map((r) => r.filename.replace(/[\\/]+$/, ''))
    port.postMessage({
      ok: true,
      files: files.map((r) => ({
        filename: r.filename,
        size: r.size ?? 0,
        mtimeMs: r.date_modified ? Date.parse(r.date_modified) || 0 : 0
      })),
      dirs,
      reparse
    })
  } catch (err) {
    port.postMessage({ ok: false, error: String(err) })
  }
})
