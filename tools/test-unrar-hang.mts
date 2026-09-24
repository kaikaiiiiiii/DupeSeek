// UnRAR 固实卷逐条目解压病理的复现脚本：单条 ~2s × 数千条会拖死哈希阶段
// （已由批量解压修复，本脚本留作回归对照）
// 用法：node --experimental-strip-types test-unrar-hang.mts
import { spawn } from 'node:child_process'

const UNRAR = 'D:\\Coding\\DupeSeek\\resources\\bin\\UnRAR.exe'
const RAR = 'D:\\Coding\\vosscript.rar'
const ENTRY =
  'vosscript\\datasample\\mods\\heroes.stormmod\\enus.stormassets\\localizeddata\\sounds\\vo\\dvabase_vox_angry_p03.ogg'

interface Case {
  label: string
  extraArgs: string[]
  stdio: ('ignore' | 'pipe')[]
}

interface Result {
  label: string
  why: string
  ms: number
  bytes: number
  exitCode: number | null
}

function repro(c: Case): Promise<Result> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(UNRAR, ['p', ...c.extraArgs, '-y', RAR, ENTRY], {
      windowsHide: c.stdio[0] === 'pipe'
    })
    const stdio =
      c.stdio[0] === 'pipe' ? ['ignore', 'pipe', 'pipe'] : (['ignore', 'ignore', 'pipe'] as const)
    void stdio
    let bytes = 0
    let settled = false
    const done = (why: string): void => {
      if (settled) return
      settled = true
      const result: Result = {
        label: c.label,
        why,
        ms: Date.now() - t0,
        bytes,
        exitCode: child.exitCode
      }
      console.log(JSON.stringify(result))
      try {
        child.kill()
      } catch {
        // 进程已退出
      }
      resolve(result)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes >= 1048576) done('cap-1MB')
    })
    child.stderr?.on('data', (): void => undefined)
    child.on('exit', (code) => done(`exit-${code}`))
    setTimeout(() => done('timeout-45s'), 45000)
  })
}

async function main(): Promise<void> {
  const cases: Case[] = [
    { label: 'A: app 条件复现（pipe+windowsHide）', extraArgs: ['-inul'], stdio: ['pipe', 'pipe'] },
    { label: 'B: 无 -inul', extraArgs: [], stdio: ['pipe', 'pipe'] },
    { label: 'C: stdout 丢弃', extraArgs: ['-inul'], stdio: ['ignore', 'pipe'] }
  ]
  for (const c of cases) await repro(c)
  console.log('ALL-DONE')
  process.exit(0)
}

void main()
