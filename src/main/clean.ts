import fs from 'fs'
import { shell } from 'electron'
import type { CleanAction, CleanReport } from '../shared/types'

/** 首版仅支持删除进回收站；硬链接 / 合并移动为后续迭代 */
export async function runClean(action: CleanAction): Promise<CleanReport> {
  const report: CleanReport = { ok: 0, failed: [], freedBytes: 0 }

  const sizes = await Promise.all(
    action.removePaths.map((p) =>
      fs.promises
        .stat(p)
        .then((st) => st.size)
        .catch(() => 0)
    )
  )

  for (let i = 0; i < action.removePaths.length; i++) {
    const p = action.removePaths[i]
    try {
      await shell.trashItem(p)
      report.ok++
      report.freedBytes += sizes[i]
    } catch (err) {
      report.failed.push({ path: p, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}
