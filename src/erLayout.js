// ER図のテーブル配置を決定するレイアウト計算。
//
// 要件は2つ。
//   1. 外部キーが多いテーブルほど中央に配置する。
//   2. テーブル間に重なりが生じないようにする。
//
// 力Directed（バネ・反発・重力）のシミュレーションで解き、そのあと左上を
// GRID_PAD に合わせてオフセットする。乱数は固定seedで使用するため結果は
// 決定性（同じ入力なら同じ配置）になる。

// 小型の決定性PRNG（mulberry32）。Math.random を使わない。
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 2ノードの中心距离から矩形重なりを判定する（カードサイズは dimensions を使用）
function nodesOverlap(a, b, w, h) {
  return (
    Math.abs(a.x - b.x) < (w(a.name) + w(b.name)) / 2 &&
    Math.abs(a.y - b.y) < (h(a.name) + h(b.name)) / 2
  )
}

// 位置関係（force レイアウト結果）を維持したまま辺を短くする整列。
// 各ノードを隣接ノードへ引き寄せるが、移動が他のテーブルと重なり始めたら
// そのノードを凍結（今後移動させない）。重なった片方だけを固定にし、
// 全体としては停止しない。
function shortenEdges(nodes, edges, nameToIndex, w, h, step) {
  const frozen = new Set()
  const ITER = 120

  for (let it = 0; it < ITER; it++) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (frozen.has(node.name)) continue

      // 辺の先へ引き寄せ。各辺方向を合成して.unit 方向とする。
      let dx = 0
      let dy = 0
      let count = 0
      for (let e = 0; e < edges.length; e++) {
        const from = edges[e][0]
        const to = edges[e][1]
        let partner = -1
        if (from === node.name) partner = nameToIndex.get(to)
        else if (to === node.name) partner = nameToIndex.get(from)
        if (partner < 0) continue
        const p = nodes[partner]
        dx += p.x - node.x
        dy += p.y - node.y
        count++
      }
      if (count === 0) continue

      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const ux = dx / len
      const uy = dy / len
      const nx = node.x + ux * step
      const ny = node.y + uy * step

      // 重なりのないか試す。重なれば元に戻してノードを凍結する。
      node.x = nx
      node.y = ny
      let hit = false
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue
        if (nodesOverlap(nodes[j], node, w, h)) {
          hit = true
          break
        }
      }
      if (hit) {
        node.x -= ux * step
        node.y -= uy * step
        frozen.add(node.name)
      }
    }
  }
}

/**
 * ER図のテーブル配置を計算する。
 *
 * 力 directedのシミュレーションでリレーションに沿った位置関係をさせた後、
 * `shorten` が true なら辺を短くする整列をかける。辺を縮めながら、移動が
 * 他のテーブルと重なるテーブルができればそれを凍結（移動停止）し、重なった
 * テーブルだけが固定される。全体としては停止せず、重なった片方のみを凍結する。
 *
 * @param {Array}      schema.tables rdb.json 形式のテーブル一覧
 * @param {Object}     dimensions    { name: { w, h } } カードサイズ
 * @param {number}     cx            配置領域の中心X
 * @param {number}     cy            配置領域の中心Y
 * @param {Object}     [initPositions] 現在の配置（あれば尊重して近傍検索する）
 * @param {{shorten?: boolean}} [opts]  オプション。shorten で辺短縮整列
 * @returns {Object}  { name: { x, y } } 各テーブルカードの左上座標
 */
export function computeERLayout(schema, dimensions, cx, cy, initPositions = null, opts = null) {
  const shorten = opts ? opts.shorten : true
  const names = schema.tables.map((t) => t.name)
  const w = (name) => dimensions[name]?.w ?? 240
  const h = (name) => dimensions[name]?.h ?? 160

  // テーブルごとに外部キーの数を数える（中央へ引かれる強さの材料）
  const fkCount = {}
  schema.tables.forEach((t) => {
    fkCount[t.name] = (t.foreignKeys || []).length
  })

  // リレーション（外部キー）のエッジ。関連テーブルを近くに配置するため。
  const edges = []
  schema.tables.forEach((from) => {
    ;(from.foreignKeys || []).forEach((fk) => {
      edges.push([from.name, fk.referencesTable])
    })
  })

  const rand = mulberry32(1337)

  // 初期位置。現在の配置を尊重し、中心から少しずらす。
  const nodes = names.map((name) => {
    const existing = initPositions ? initPositions[name] : null
    let x
    let y
    if (existing) {
      x = existing.x + w(name) / 2
      y = existing.y + h(name) / 2
    } else {
      x = cx + (rand() - 0.5) * 120
      y = cy + (rand() - 0.5) * 120
    }
    return { name, x, y, vx: 0, vy: 0 }
  })

  const REPULSION = 12000 // 互いのテーブルを弾く力（重なり抑制）
  const GRAVITY_PER_FK = 0.07 // 外部キー1つあたりの中央への引力
  const EDGE_STRENGTH = 0.02 // エッジの吸引力
  const EDGE_REST = 180 // 関連テーブル間の目標距離
  const DAMPING = 0.85 // 減衰
  const MAX_V = 30 // 1ステップあたりの移動上限
  const ITER = 260

  const nameToIndex = new Map(names.map((n, i) => [n, i]))

  for (let it = 0; it < ITER; it++) {
    const cooling = 1 - it / ITER // 時間とともに振る舞いを縮める
    const fx = nodes.map(() => 0)
    const fy = nodes.map(() => 0)

    // 反発力（全ペア）
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[i].x - nodes[j].x
        let dy = nodes[i].y - nodes[j].y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          d2 = 1
          dx = (rand() - 0.5) * 2
          dy = (rand() - 0.5) * 2
        }
        const d = Math.sqrt(d2)
        const force = REPULSION / d2
        const fxx = (dx / d) * force
        const fyy = (dy / d) * force
        fx[i] += fxx
        fy[i] += fyy
        fx[j] -= fxx
        fy[j] -= fyy
      }
    }

    // 中央への重力。外部キーが多いほど強く引かれる。
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const pull = GRAVITY_PER_FK * fkCount[n.name]
      fx[i] += (cx - n.x) * pull
      fy[i] += (cy - n.y) * pull
    }

    // エッジの吸引力（関連テーブルを近くに）
    for (let e = 0; e < edges.length; e++) {
      const ai = nameToIndex.get(edges[e][0])
      const bi = nameToIndex.get(edges[e][1])
      if (ai == null || bi == null) continue
      const a = nodes[ai]
      const b = nodes[bi]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const force = EDGE_STRENGTH * (d - EDGE_REST)
      fx[ai] -= (dx / d) * force
      fy[ai] -= (dy / d) * force
      fx[bi] += (dx / d) * force
      fy[bi] += (dy / d) * force
    }

    // 位置と速度を更新
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      n.vx = (n.vx + fx[i]) * DAMPING * cooling
      n.vy = (n.vy + fy[i]) * DAMPING * cooling
      const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy)
      if (speed > MAX_V) {
        n.vx = (n.vx / speed) * MAX_V
        n.vy = (n.vy / speed) * MAX_V
      }
      n.x += n.vx
      n.y += n.vy
    }
  }

  // 辺を短くする整列（位置関係は保ったまま隣接テーブルへ引き寄せる）
  if (shorten) {
    shortenEdges(nodes, edges, nameToIndex, w, h, 10)
  }

  // 座標をカードの左上に変換し、GRID_PAD でオフセットする
  const PAD = 16
  let minX = Infinity
  let minY = Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x - w(n.name) / 2)
    minY = Math.min(minY, n.y - h(n.name) / 2)
  }
  const result = {}
  for (const n of nodes) {
    result[n.name] = {
      x: Math.max(0, n.x - w(n.name) / 2 - minX + PAD),
      y: Math.max(0, n.y - h(n.name) / 2 - minY + PAD),
    }
  }
  return result
}
