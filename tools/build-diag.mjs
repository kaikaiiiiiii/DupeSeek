// 构建 diag-lazy 无头诊断包：把 electron-vite 的 ?nodeWorker 导入改写为
// 指向同级 worker 文件路径的字符串（诊断里哈希 worker 不可用也能查树）。
import esbuild from 'esbuild'
import path from 'path'

const entry = process.argv[2] ?? 'diag-lazy.mts'

await esbuild.build({
  entryPoints: ['tools/' + entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'out/' + entry.replace(/\.mts$/, '.mjs'),
  external: ['7zip-bin', 'node-unrar-js'],
  alias: { electron: path.resolve('tools/electron-stub.mjs') },
  plugins: [
    {
      name: 'nodeWorker',
      setup(build) {
        build.onResolve({ filter: /\?nodeWorker$/ }, (args) => ({
          path: path.basename(args.path.replace('?nodeWorker', '')),
          namespace: 'node-worker'
        }))
        build.onLoad({ filter: /.*/, namespace: 'node-worker' }, (args) => ({
          contents: `import { Worker } from 'node:worker_threads'; export default (options) => new Worker(new URL('./${args.path}.js', import.meta.url), options)`,
          loader: 'js'
        }))
      }
    }
  ]
})
console.log('built out/diag-lazy.mjs')
