// 图标探针 v2：把各路径的 getFileIcon 结果落盘为 PNG 供人工目检。
// 用法：npx electron tools/icon-probe.js "路径1" "路径2" ...
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

app.whenReady().then(async () => {
  const outDir = path.resolve('out/icon-probe')
  fs.mkdirSync(outDir, { recursive: true })
  for (const d of process.argv.slice(2)) {
    try {
      const icon = await app.getFileIcon(d, { size: 'large' })
      const png = icon.toPNG()
      const name =
        d.replace(/[\\/]+$/, '').replace(/[\\/:*?"<>|]/g, '_').replace(/^_+/, '') || 'ROOT'
      fs.writeFileSync(path.join(outDir, name + '.png'), png)
      console.log(`${d} → ${name}.png (${png.length} bytes)`)
    } catch (err) {
      console.log(`${d} → ERROR ${err.message}`)
    }
  }
  // 参照物：无扩展名新建临时目录（纯文件夹）、txt 与 exe 文件
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'iconref-'))
  const refs = [
    ['folder-ref', tmp],
    ['txt-ref', path.join(tmp, 'a.txt')],
    ['exe-ref', 'C:\\Windows\\System32\\notepad.exe']
  ]
  for (const [name, p] of refs) {
    try {
      const icon = await app.getFileIcon(p, { size: 'large' })
      fs.writeFileSync(path.join(outDir, name + '.png'), icon.toPNG())
      console.log(`${p} → ${name}.png`)
    } catch (err) {
      console.log(`${p} → ERROR ${err.message}`)
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('输出目录：' + outDir)
  app.quit()
})
