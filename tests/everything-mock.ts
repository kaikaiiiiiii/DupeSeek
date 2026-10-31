// everything.ts 的 mock：createEverythingLister 返回按目标注册的假枚举数据，
// 免去真实 es.exe 依赖。测试通过 setFixtures 注册各目标的清单。
export interface MockFile {
  filename: string
  size: number
  mtimeMs: number
}

export interface MockFixture {
  dirs: string[]
  files: MockFile[]
  reparse: string[]
}

const fixtures = new Map<string, MockFixture>()

export function setFixtures(
  entries: Array<{ target: string; dirs: string[]; files: MockFile[]; reparse?: string[] }>
): void {
  fixtures.clear()
  for (const f of entries) fixtures.set(f.target.replace(/[\\/]+$/, '').toLowerCase(), f)
}

export function resetFixtures(): void {
  fixtures.clear()
}

export async function createEverythingLister(): Promise<{
  list: (target: string) => Promise<MockFixture>
}> {
  return {
    list: async (target: string) => {
      const f = fixtures.get(target.replace(/[\\/]+$/, '').toLowerCase())
      if (!f) throw new Error('mock: no fixture for ' + target)
      return f
    }
  }
}

export const __mock = { fixtures }
