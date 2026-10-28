// 变体测试：寻找能返回真正文件夹图标的 getFileIcon 查询姿势
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

app.whenReady().then(async () => {
  const outDir = path.resolve('out/icon-probe')
  fs.mkdirSync(outDir, { recursive: true })
  const dir = 'D:\\Clash Party\\Data'
  const variants = [
    ['plain', dir, { size: 'large' }],
    ['trailing-slash', dir + '\\', { size: 'large' }],
    ['small', dir, { size: 'small' }],
    ['jumbo', dir, { size: 'jumbo' }],
    ['nonexistent-ext', dir + '\\x.__dupeseek__', { size: 'large' }],
    ['nonexistent-noext', dir + '\\x', { size: 'large' }],
    ['dot-unc', '\\\\?\\' + dir, { size: 'large' }]
  ]
  let refUrl = null
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'iconref-'))
  for (const [name, p, opts] of variants) {
    try {
      const icon = await app.getFileIcon(p, opts)
      const png = icon.toPNG()
      const fp = crypto.createHash('md5').update(png).digest('hex').slice(0, 8)
      fs.writeFileSync(path.join(outDir, 'v-' + name + '.png'), png)
      console.log(`${name}: fp=${fp} bytes=${png.length}`)
    } catch (err) {
      console.log(`${name}: ERROR ${err.message}`)
    }
  }
  const ref = await app.getFileIcon(tmp, { size: 'large' })
  fs.writeFileSync(path.join(outDir, 'v-folder-ref.png'), ref.toPNG())
  console.log('folder-ref 写出（对照）')
  fs.rmSync(tmp, { recursive: true, force: true })
  app.quit()
})
