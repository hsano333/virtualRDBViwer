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

// 矩形の重なり（AABB）を判定する。辺が接するだけ（一致）は重なりとしない。
function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  const overlapX = ax < bx + bw && ax + aw > bx
  const overlapY = ay < by + bh && ay + ah > by
  return overlapX && overlapY
}

// あるテーブルカードを動かしたとき、他のテーブルと重なっているか判定する。
// positions は { name: { x, y } }（各カードの左上座標）、dimensions は { name: { w, h } }。
// `name` のカードが他のどれかと1つ重なれば false、一つも重なっていれば true を返す。
export function noOverlapWithOthers(name, positions, dimensions) {
  const a = positions[name]
  if (!a) return true
  const aw = dimensions[name]?.w ?? 240
  const ah = dimensions[name]?.h ?? 160
  for (const other in positions) {
    if (other === name) continue
    const b = positions[other]
    if (!b) continue
    const bw = dimensions[other]?.w ?? 240
    const bh = dimensions[other]?.h ?? 160
    if (rectsOverlap(a.x, a.y, aw, ah, b.x, b.y, bw, bh)) return false
  }
  return true
}

// 指定したテーブルを、軸（x軸またはy軸）に沿って指定座標に移動する。
// axis に 'x' を指定すると横座標、'y' を指定すると縦座標が target に変わる。
// 選ばれなかった軸の座標は変化せず、新しい positions を返す（元オブジェクトは変更しない）。
// axis が 'x'/'y' 以外なら positions をそのまま返す。
export function moveToAxis(name, axis, target, positions) {
  const pos = positions[name]
  if (!pos) return positions
  if (axis === 'x') {
    return { ...positions, [name]: { x: target, y: pos.y } }
  }
  if (axis === 'y') {
    return { ...positions, [name]: { x: pos.x, y: target } }
  }
  return positions
}

// 整列処理：線がつながっている2つのテーブル（の端点＝全テーブル）を、
// x/y 軸に沿って少しずつずらし、ずらした先に重なり（noOverlapWithOthers）が
// 無ければ実際に動かす。x 軸・y 軸の両方でこれを行い、全テーブルを
// 「1度も動かなくなった」まで繰り返す。繰り返すごとに移動量 step を半分にし、
// 小さく微調整しながら収束させる。
// 重なっていないテーブルは動かさない（動かすと終了点がなくなるため）。
// 元の positions は変更せず、新しい positions を返す。
// step の既定値は第4引数で変更できる。
export function alignTables(schema, positions, dimensions, { step = 48 } = {}) {
  const names = schema ? schema.tables.map((t) => t.name) : []
  let result = { ...positions }

  let movedAny = true
  let curStep = step
  while (curStep >= 1) {
    movedAny = false

    for (const name of names) {
      // 今重なっていないテーブルはスkip（終点がなくなるため）。
      if (noOverlapWithOthers(name, result, dimensions)) continue
      const cur = result[name]
      if (!cur) continue

      // x 軸方向に ±step ずつ動かす。重なりが解消できれば確定する。
      for (const sign of [-1, 1]) {
        const moved = moveToAxis(name, 'x', cur.x + sign * curStep, result)
        if (noOverlapWithOthers(name, moved, dimensions)) {
          result = moved
          movedAny = true
          break
        }
      }

      // y 軸方向に ±step ずつ動かす。
      for (const sign of [-1, 1]) {
        const moved = moveToAxis(name, 'y', cur.y + sign * curStep, result)
        if (noOverlapWithOthers(name, moved, dimensions)) {
          result = moved
          movedAny = true
          break
        }
      }
    }

    if (!movedAny) break
    curStep = Math.round(curStep / 2)
  }

  return result
}

// 線（外部キー）でつながっている隣接テーブル同士を整理する整列処理。
//
// 横方向（x 軸）は、線でつながっている2テーブルの間に「テーブル幅の0.7倍
// 以上の隙間」を保つ。隙間がそれ未満（重なっている含む）なら、相手を避け
// て離す。離先先に重なり（noOverlapWithOthers）が無ければ実際に動かす。
//
// 縦方向（y 軸）は、線でつながっている2テーブルの間に「テーブル高さの0.5倍
// 以上の隙間」を保つ。横方向（x 軸）と同じ方針で、隙間が未満なら相手から離す。
//
// 各テーブルは「動かす片方」として扱い、隣接するすべてのテーブルに対して
// 試行する。どれか1つでもテーブルが動き（移動量が eps 以上）えば次の
// ループへ、どれもおかしく動かなければ（収束すれば）終了する。
//
// 元の positions はせず、新しい positions を返す。
// eps 以下の移動は「動かなかった」とみなし、無限ループを避ける。
export function collapseConnections(schema, positions, dimensions, { eps = 1 } = {}) {
  const names = schema ? schema.tables.map((t) => t.name) : []
  const w = (name) => dimensions[name]?.w ?? 240
  const h = (name) => dimensions[name]?.h ?? 160

  // 各テーブルにつながっている他テーブルのリスト（双方向）を構築
  const neighbors = {}
  names.forEach((name) => {
    neighbors[name] = []
  })
  schema.tables.forEach((from) => {
    ;(from.foreignKeys || []).forEach((fk) => {
      const target = fk.referencesTable
      if (target && !neighbors[from.name].includes(target)) {
        neighbors[from.name].push(target)
      }
      if (!neighbors[target].includes(from.name)) {
        neighbors[target].push(from.name)
      }
    })
  })

  let result = { ...positions }

  let movedAny = true
  while (movedAny) {
    movedAny = false

    for (const name of names) {
      // 各 neighboring について、現在の座標で再度読み直す（前回の移動を反映）
      for (const target of neighbors[name]) {
        const cur = result[name]
        if (!cur) continue
        const t = result[target]
        if (!t) continue

        // 両テーブルの中心座標
        const acx = cur.x + w(name) / 2
        const acy = cur.y + h(name) / 2
        const bcx = t.x + w(target) / 2
        const bcy = t.y + h(target) / 2

        // 横方向: 線でつながっているテーブル間に、テーブル幅の1.25倍以上の
        // 隙間を保つ。隙間が未満なら相手から離して整列させる。
        const w1 = w(name)
        const w2 = w(target)
        const avgW = (w1 + w2) / 2
        const gapTarget = 0.7 * avgW
        const reach = gapTarget + (w1 + w2) / 2
        const d = bcx - acx
        if (Math.abs(d) < reach) {
          const targetCenter = Math.sign(d) * reach || reach
          const stepX = d - targetCenter
          if (Math.abs(stepX) >= eps) {
            const moved = moveToAxis(name, 'x', cur.x + stepX, result)
            if (noOverlapWithOthers(name, moved, dimensions)) {
              result = moved
              movedAny = true
            }
          }
        }

        // 縦方向: 線でつながっているテーブル間に、テーブル高さの0.5倍以上の
        // 隙間を保つ。隙間が未満なら相手から離して整列させる。
        const h1 = h(name)
        const h2 = h(target)
        const avgH = (h1 + h2) / 2
        const gapTargetV = 0.5 * avgH
        const reachV = gapTargetV + (h1 + h2) / 2
        const dy = bcy - acy
        if (Math.abs(dy) < reachV) {
          const targetCenter = Math.sign(dy) * reachV || reachV
          const stepY = dy - targetCenter
          if (Math.abs(stepY) >= eps) {
            const moved = moveToAxis(name, 'y', cur.y + stepY, result)
            if (noOverlapWithOthers(name, moved, dimensions)) {
              result = moved
              movedAny = true
            }
          }
        }
      }
    }
  }

  // 横方向に離した結果、左下負の座標へ外れるテーブルを避けるため全座標を
  // 領域内（PAD）に合わせます。相対距離（隙間）は変わりません。
  const PAD = 16
  let minX = Infinity
  let minY = Infinity
  for (const name of names) {
    minX = Math.min(minX, result[name].x)
    minY = Math.min(minY, result[name].y)
  }
  for (const name of names) {
    result[name] = {
      x: result[name].x - minX + PAD,
      y: result[name].y - minY + PAD,
    }
  }

  return result
}

// 整列処理（その2）：外部キー（線）でつながっているテーブルを、接続線の中点
// （＝線の長さを半分にした座標）へ引き寄せ整列させる。
//
// 各テーブルについて、隣接テーブルとの接続線中点を軸方向ごとに求め（複数接続なら
// その平均）、その座標へ動かす。ただし移動先で他のテーブルと重なり始めたら
// （nodesOverlap が成立する）場合は配置せず、重ならない範囲で留める。x 軸・y 軸の
// 両方で行う。
//
// 移動は「他のテーブルと重ならない（＝対象テーブル×他のテーブルで nodesOverlap が
// すべて False）」ことを条件に配置するため、繰り返せば繰り返すほど接続テーブルを
// 重ならない範囲で近付ける。全テーブルが重ならない状態で終了する。元の positions
// は変更せず、新しい positions を返す。passes の既定値は第4引数で変更できる。
export function recenterConnectedLines(schema, positions, dimensions, { passes = 64 } = {}) {
  const names = schema ? schema.tables.map((t) => t.name) : []
  const w = (name) => dimensions[name]?.w ?? 240
  const h = (name) => dimensions[name]?.h ?? 160

  // 各テーブルの隣接リスト（双方向）を構築
  const neighbors = {}
  names.forEach((name) => {
    neighbors[name] = []
  })
  schema.tables.forEach((from) => {
    ;(from.foreignKeys || []).forEach((fk) => {
      const target = fk.referencesTable
      if (target && !neighbors[from.name].includes(target)) {
        neighbors[from.name].push(target)
      }
      if (!neighbors[target].includes(from.name)) {
        neighbors[target].push(from.name)
      }
    })
  })

  let result = { ...positions }

  for (let pass = 0; pass < passes; pass++) {
    let movedAny = false

    for (const name of names) {
      const nbrs = neighbors[name]
      if (!nbrs.length) continue

      // 現在座標（中心）
      const cur = result[name]
      const cx = cur.x + w(name) / 2
      const cy = cur.y + h(name) / 2

      // 各接続線の中点を軸ごとに平均する（単一接続ならその中点、複数なら平均）
      let mx = 0
      let my = 0
      let count = 0
      for (const other of nbrs) {
        const o = result[other]
        if (!o) continue
        mx += (cx + (o.x + w(other) / 2)) / 2
        my += (cy + (o.y + h(other) / 2)) / 2
        count++
      }
      if (count === 0) continue
      mx /= count
      my /= count

      // x 軸方向：中点へずらし、他のテーブルと重ならないように配置する
      const movedX = moveToAxis(name, 'x', mx - w(name) / 2, result)
      if (noOverlapWithOthers(name, movedX, dimensions)) {
        result = movedX
        movedAny = true
      }

      // y 軸方向：同じく中点へずらし、他のテーブルと重ならないように配置する
      const movedY = moveToAxis(name, 'y', my - h(name) / 2, result)
      if (noOverlapWithOthers(name, movedY, dimensions)) {
        result = movedY
        movedAny = true
      }
    }

    // 少しでも移動があれば次のパスへ。移動がなければ収束。
    if (!movedAny) break
    // 全テーブルが他のテーブルと重ならない状態（全 nodesOverlap がすべて False）で終了
    if (names.every((n) => noOverlapWithOthers(n, result, dimensions))) break
  }

  return result
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

// 外部キーのグラフ構造に従ってER図のテーブルを配置する。
//
//   1. 外部キーが一番多いテーブルを起点（ルート）として配置する。
//   2. ルートが外部キーで参照する対象テーブルを、ルートの横（右）に配置する。
//      対象が複数あれば上下に並べる。
//   3. 既に配置済みのテーブルと重ねば、重ねないように上下にずらす。
//   4. この作業を、配置済みのテーブルをキュー（BFS）で順に取りながら繰り返す。
//      配置が終わったテーブルに印（placed）をつけ、全テーブルに印がついたら完了。
//
// 元の positions は使用せず、グラフ構造から座標を新たに計算して返す。
export function arrangeTables(schema, positions, dimensions) {
  const names = schema ? schema.tables.map((t) => t.name) : []
  if (names.length === 0) return { ...positions }

  const width = (name) => dimensions[name]?.w ?? 240
  const height = (name) => dimensions[name]?.h ?? 160

  // 各テーブルの外部キーが参照する対象テーブル（重複なし）
  const targetsOf = {}
  names.forEach((name) => {
    targetsOf[name] = []
  })
  schema.tables.forEach((from) => {
    ;(from.foreignKeys || []).forEach((fk) => {
      const target = fk.referencesTable
      if (target && !targetsOf[from.name].includes(target)) {
        targetsOf[from.name].push(target)
      }
    })
  })
  const fkCount = {}
  names.forEach((name) => {
    fkCount[name] = targetsOf[name].length
  })

  const PAD = 16
  const GAP_X = 72
  const GAP_Y = 24

  const result = {}
  const placed = new Set()

  // 配置済みのテーブルと矩形が重なるか（1px単位の検査）
  function overlapsAt(x, y, name) {
    for (const other of placed) {
      const b = result[other]
      if (
        rectsOverlap(x, y, width(name), height(name), b.x, b.y, width(other), height(other))
      ) {
        return true
      }
    }
    return false
  }

  // 位置を決定し、配置済みとして印をつける。重ならなくなるまで下にずらす。
  function place(name, x, y) {
    while (overlapsAt(x, y, name)) {
      y += 1
    }
    result[name] = { x, y }
    placed.add(name)
  }

  // 未配置のテーブルうち外部キーが最も多いものを選ぶ（次の起点）
  function pickRoot() {
    let best = null
    for (const name of names) {
      if (placed.has(name)) continue
      if (best === null || fkCount[name] > fkCount[best]) best = name
    }
    return best
  }

  let root = pickRoot()
  while (root !== null) {
    place(root, PAD, PAD)
    const queue = [root]
    while (queue.length > 0) {
      const parent = queue.shift()
      const unplaced = targetsOf[parent].filter((t) => !placed.has(t))
      if (unplaced.length === 0) continue

      const baseX = result[parent].x + width(parent) + GAP_X

      // 配置対象を複数のとき上下に並べる（親の垂直中央に揃える）
      let stackHeight = 0
      for (const t of unplaced) {
        stackHeight += height(t)
      }
      stackHeight += GAP_Y * (unplaced.length - 1)
      let y = result[parent].y + height(parent) / 2 - stackHeight / 2
      if (y < PAD) y = PAD

      for (const t of unplaced) {
        let x = baseX
        while (overlapsAt(x, y, t)) {
          y += 1
        }
        result[t] = { x, y }
        placed.add(t)
        queue.push(t)
        y += height(t) + GAP_Y
      }
    }
    root = pickRoot()
  }

  return result
}

// 外部キー（foreignKeys）を持つテーブルをすべて取得して配列として返す。
// 外部キーを持たないテーブル（foreignKeys が空配列、または未定義）は除外する。
// 返す配列は schema.tables と同じ順序を保つ。
// schema が未指定・不正な場合は防御的に空の配列を返す。
export function getTablesWithForeignKeys(schema) {
  if (!schema || !Array.isArray(schema.tables)) return []
  return schema.tables.filter((t) => (t.foreignKeys || []).length > 0)
}
