// 本机能力检测：RAR 相关工具的就位情况。仅做存在性探测，不拉起进程校验版本。
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import type { AppCapabilities } from '../shared/types'
import { unrarExe } from './scan/archives'

/** Windows 常见 WinRAR 安装位置（官方默认装 <ProgramFiles>\WinRAR） */
function winRarCandidates(): string[] {
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(
    (d): d is string => typeof d === 'string'
  )
  return roots.flatMap((d) => [
    path.join(d, 'WinRAR', 'WinRAR.exe'),
    path.join(d, 'WinRAR', 'rar.exe')
  ])
}

/** PATH 上查找 rar 命令（unix 用 which；Windows 用 where 兜底便携版） */
function rarOnPath(): Promise<string | null> {
  const tool = process.platform === 'win32' ? 'where' : 'which'
  const arg = process.platform === 'win32' ? 'rar.exe' : 'rar'
  return new Promise((resolve) => {
    const child = spawn(tool, [arg], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    // where/which 不存在或被安全策略拦截时按未检测到处理
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const first = out.split(/\r?\n/).find((l) => l.trim().length > 0)
      resolve(first ? first.trim() : null)
    })
  })
}

export async function detectCapabilities(): Promise<AppCapabilities> {
  const local = winRarCandidates().find((p) => existsSync(p))
  const compress = local ?? (await rarOnPath())
  return { rar: { bundledExtract: unrarExe(), compress } }
}
