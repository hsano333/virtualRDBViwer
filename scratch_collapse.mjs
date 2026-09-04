import { readFileSync } from 'node:fs'
import { collapseConnections } from './src/erLayout.js'

const schema = JSON.parse(readFileSync('./public/rdb.json', 'utf8'))

// App.jsx と同じグリッド初期配置・寸法（一律240x160で近似）
const GRID_COLS = 2, GRID_GAP = 16, GRID_PAD = 16
const W = 240, H = 160
const names = schema.tables.map((t) => t.name)
const dimensions = {}
names.forEach((n) => { dimensions[n] = { w: W, h: H } })

const positions = {}
names.forEach((name, i) => {
  positions[name] = {
    x: GRID_PAD + (i % GRID_COLS) * (W + GRID_GAP),
    y: GRID_PAD + Math.floor(i / GRID_COLS) * (H + GRID_GAP),
  }
})

const next = collapseConnections(schema, positions, dimensions)

console.log('=== 整列後の座標 ===')
for (const n of names) console.log(n.padEnd(12), JSON.stringify(next[n]))

// 接続ペアごとの中心間距離
const w = (n) => dimensions[n].w, h = (n) => dimensions[n].h
console.log('\n=== 接続ペアの中心間距離 ===')
schema.tables.forEach((from) => {
  ;(from.foreignKeys || []).forEach((fk) => {
    const a = next[from.name], b = next[fk.referencesTable]
    const cx = Math.abs((a.x + w(from.name) / 2) - (b.x + w(fk.referencesTable) / 2))
    const cy = Math.abs((a.y + h(from.name) / 2) - (b.y + h(fk.referencesTable) / 2))
    console.log(`${from.name} -> ${fk.referencesTable}: dx=${cx.toFixed(1)} dy=${cy.toFixed(1)}`)
  })
})
