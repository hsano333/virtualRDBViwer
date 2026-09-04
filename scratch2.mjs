import { readFileSync } from 'node:fs'
import { collapseConnections } from './src/erLayout.js'

const schema = JSON.parse(readFileSync('./public/rdb.json', 'utf8'))
const names = schema.tables.map((t) => t.name)

// 高さは列数で決まる（タイトル約36 + 列約30）
const cols = Object.fromEntries(schema.tables.map((t) => [t.name, t.columns.length]))
const dimensions = {}
names.forEach((n) => { dimensions[n] = { w: 240, h: 36 + cols[n] * 30 } })

// ドラッグで離散した（適当な）始点
const seed = {
  accounts: { x: 100, y: 400 },
  categories: { x: 600, y: 40 },
  orders: { x: 400, y: 300 },
  products: { x: 300, y: 500 },
}
const positions = {}
names.forEach((n) => { positions[n] = { ...seed[n] } })

const next = collapseConnections(schema, positions, dimensions)

console.log('=== 整列後の座標 ===')
for (const n of names) console.log(n.padEnd(12), JSON.stringify(next[n]))

const w = (n) => dimensions[n].w, h = (n) => dimensions[n].h
console.log('\n=== ペアの中心間距離 (整列後) ===')
schema.tables.forEach((from) => {
  ;(from.foreignKeys || []).forEach((fk) => {
    const a = next[from.name], b = next[fk.referencesTable]
    const cx = Math.abs((a.x + w(from.name) / 2) - (b.x + w(fk.referencesTable) / 2))
    const cy = Math.abs((a.y + h(from.name) / 2) - (b.y + h(fk.referencesTable) / 2))
    console.log(`${from.name} -> ${fk.referencesTable}: dx=${cx.toFixed(0)} dy=${cy.toFixed(0)}`)
  })
})
