import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { arrangeTables } from './erLayout.js'

const HEADER_HEIGHT = 56
const SPLITTER_HEIGHT = 8
const MIN_PANEL = 8

// 各スキーマのテーブル名は schema.tables から取得するため、ハードコードしない

// デフォルトで使用するスキーマID
const DEFAULT_SCHEMA_ID = 'schema1'

const DEFAULT_WIDTH = 240
const DEFAULT_HEIGHT = -10

function parseCsv(text) {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = lines[0].split(',').map((h) => h.trim())
  const rows = lines.slice(1).map((line) => line.split(','))
  return { headers, rows }
}

function getColumnKind(table, columnName) {
  if (table.primaryKey.includes(columnName)) return 'pk'
  return table.foreignKeys.some((fk) => fk.columns.includes(columnName)) ? 'fk' : null
}

// 2つのセル値を比較する。両方が数値なら数値比較、それ以外は大文字小文字を無視した文字列比較。
function compareCell(a, b) {
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return na - nb
  }
  return String(a ?? '').toLowerCase().localeCompare(String(b ?? '').toLowerCase())
}

// --- 連結（外部結合）処理 ---

// 指定パスのCSVを読み込んで { headers, rows } 形式で返す。
async function loadSchemaCsv(path) {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`)
  if (!res.ok) throw new Error('CSVの読み込みに失敗しました')
  return parseCsv(await res.text())
}

// 連結対象テーブル間の外部キー関係を隣接リストへまとめる。
// 各エッジは { partner, selfCol, otherCol }。selfCol は adjacency が属するテーブル（外部キーを持つ側）の列、
// otherCol は partner（される側＝主キー）の列。
function buildAdjacency(checkedNames, tables) {
  const adj = {}
  checkedNames.forEach((n) => {
    adj[n] = []
  })
  tables.forEach((t) => {
    ;(t.foreignKeys || []).forEach((fk) => {
      if (!fk.referencesTable) return
      if (!checkedNames.includes(fk.referencesTable)) return
      adj[t.name].push({
        partner: fk.referencesTable,
        selfCol: fk.columns[0],
        otherCol: fk.referencesColumns[0],
      })
    })
  })
  return adj
}

// 外部キーでつながった順序でチェック済みテーブルを並べる（BFS）。
// 孤立した要素は新しい先頭として別途並べる。
function buildJoinOrder(start, adj, checkedNames) {
  const order = []
  const visited = new Set()
  const walk = (node) => {
    const queue = [node]
    visited.add(node)
    while (queue.length > 0) {
      const n = queue.shift()
      order.push(n)
      for (const e of adj[n] || []) {
        if (!visited.has(e.partner)) {
          visited.add(e.partner)
          queue.push(e.partner)
        }
      }
    }
  }
  walk(start)
  for (const n of checkedNames) if (!visited.has(n)) walk(n)
  return order
}

// 結合済み集合 S にテーブル T を結合するときの結合キーを決める。
// keyR は结合済み側（R）の列、keyT は T の列。
function findJoinKey(S, T, adj) {
  for (const X of S) {
    for (const e of (adj[X] || [])) {
      if (e.partner === T.name) {
        // X が T を参照: selfCol は X の列（R にある）、otherCol は T の列
        return { keyR: { table: X, name: e.selfCol }, keyT: e.otherCol }
      }
    }
  }
  for (const e of (adj[T.name] || [])) {
    if (S.has(e.partner)) {
      // T が e.partner を参照: selfCol は T の列、otherCol は partner の列（R にある）
      return { keyR: { table: e.partner, name: e.otherCol }, keyT: e.selfCol }
    }
  }
  return null
}

// 2つのテーブルをフル外部結合する。key があればそのキーで結合し、なければ結合せず並べる。
function fullOuterJoin(R, T, key) {
  const empty = (len) => Array(len).fill(null)
  const outCols = [...R.cols, ...T.cols.map((c) => ({ table: T.name, name: c.name }))]
  if (!key) {
    const rows = [
      ...R.rows.map((r) => [...r, ...empty(T.cols.length)]),
      ...T.rows.map((r) => [...empty(R.cols.length), ...r]),
    ]
    return { cols: outCols, rows }
  }
  const rIdx = R.cols.findIndex((c) => c.table === key.keyR.table && c.name === key.keyR.name)
  const tIdx = T.cols.findIndex((c) => c.name === key.keyT)
  const index = new Map()
  const used = new Array(T.rows.length).fill(false)
  T.rows.forEach((row, i) => {
    const k = row[tIdx]
    if (!index.has(k)) index.set(k, [])
    index.get(k).push(i)
  })
  const rows = []
  for (const r of R.rows) {
    const k = r[rIdx]
    const matches = index.get(k)
    if (!matches || matches.length === 0) {
      rows.push([...r, ...empty(T.cols.length)])
    } else {
      for (const oi of matches) {
        used[oi] = true
        rows.push([...r, ...T.rows[oi]])
      }
    }
  }
  for (let i = 0; i < T.rows.length; i++) if (!used[i]) rows.push([...empty(R.cols.length), ...T.rows[i]])
  return { cols: outCols, rows }
}

// 並べた順序で順に結合し、最終的な結合結果を返す。
function joinTables(first, order, adj, tableMap) {
  let R = { cols: first.cols.map((c) => ({ table: first.name, name: c.name })), rows: first.rows }
  const S = new Set([first.name])
  for (let i = 1; i < order.length; i++) {
    const T = tableMap.get(order[i])
    R = fullOuterJoin(R, T, findJoinKey(S, T, adj))
    S.add(T.name)
  }
  return R
}

function App() {
  const containerRef = useRef(null)
  const erGridRef = useRef(null)
  const resizing = useRef(false)
  const [topHeight, setTopHeight] = useState(250)
  const [selectedTable, setSelectedTable] = useState('')
  const [table, setTable] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [schema, setSchema] = useState(null)
  const [schemaError, setSchemaError] = useState(null)

  // 有効なスキーマ一覧と、現在選択中のスキーマ
  const [schemaList, setSchemaList] = useState([])
  const [selectedSchema, setSelectedSchema] = useState(DEFAULT_SCHEMA_ID)
  const [schemaMenuOpen, setSchemaMenuOpen] = useState(false)
  const schemaSelectorRef = useRef(null)

  // ER図：各テーブルカードの配置・サイズ・ドラッグ状態
  const entityRefs = useRef({})
  const columnRefs = useRef({})
  const [dimensions, setDimensions] = useState({})
  const [positions, setPositions] = useState({})
  const [containerHeight, setContainerHeight] = useState(0)
  const [anchors, setAnchors] = useState({})
  const [dragging, setDragging] = useState(null)
  const [sort, setSort] = useState({ column: -1, asc: true })
  const [checked, setChecked] = useState({})
  const [joinResult, setJoinResult] = useState(null)
  const [joinLoading, setJoinLoading] = useState(false)
  const [joinError, setJoinError] = useState(null)

  // リレーション（外部キー）の接続情報
  const schemaTable = useMemo(
    () => (schema ? schema.tables.find((t) => t.name === selectedTable) : null),
    [schema, selectedTable]
  )

  const fkEdges = useMemo(
    () =>
    schema
      ? schema.tables.flatMap((from) =>
          (from.foreignKeys || []).map((fk) => {
            const col = (from.columns || []).find((c) => c.name === fk.columns[0])
            return {
              from: from.name,
              fromColumn: fk.columns[0],
              to: fk.referencesTable,
              toColumn: fk.referencesColumns[0],
              nullable: !!(col && col.nullable),
            }
          })
        )
      : [],
    [schema]
  )

  useEffect(() => {
    if (!selectedTable || !selectedSchema) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${import.meta.env.BASE_URL}schemas/${selectedSchema}/tables/${selectedTable}.csv`)
      .then((res) => {
        if (!res.ok) throw new Error('CSVの読み込みに失敗しました')
        return res.text()
      })
      .then((text) => {
        if (!cancelled) setTable(parseCsv(text))
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedSchema, selectedTable])

  // 列ソートのトグル：同じ列を再クリックで昇順・降順を切り替える
  const toggleSort = (column) => {
    setSort((prev) =>
      prev.column === column ? { column, asc: !prev.asc } : { column, asc: true }
    )
  }

  // ソート適用済み行数（未ソートなら元のデータ順）
  const sortedRows = useMemo(() => {
    if (!table || sort.column < 0) return table?.rows ?? []
    const col = sort.column
    const dir = sort.asc ? 1 : -1
    return [...table.rows].sort((a, b) => compareCell(a[col], b[col]) * dir)
  }, [table, sort])

  // 選択中のスキーマが変われば、前の連結結果は壊れるのでクリアする
  useEffect(() => {
    setJoinResult(null)
    setJoinError(null)
    setJoinLoading(false)
  }, [selectedSchema])

  // 選択済みチェックのテーブルを外部結合（フル結合）し、結果を返す
  const performConnect = async () => {
    if (!schema) return
    const checkedNames = schema.tables
      .filter((t) => checked[t.name])
      .map((t) => t.name)
    if (checkedNames.length === 0) {
      setJoinError('2つ以上のテーブルチェックして連結してください')
      return
    }
    setJoinLoading(true)
    setJoinError(null)
    try {
      const tableMap = new Map()
      for (const name of checkedNames) {
        const data = await loadSchemaCsv(`schemas/${selectedSchema}/tables/${name}.csv`)
        tableMap.set(name, {
          name,
          cols: data.headers.map((h) => ({ name: h })),
          rows: data.rows,
        })
      }
      const adj = buildAdjacency(checkedNames, schema.tables)
      const order = buildJoinOrder(checkedNames[0], adj, checkedNames)
      const first = tableMap.get(order[0])
      const result = joinTables(first, order, adj, tableMap)
      setJoinResult(result)
    } catch (err) {
      setJoinError(err.message)
    } finally {
      setJoinLoading(false)
    }
  }

  // スキーマ一覧（マスタートブル）の読み込み
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}schemas/index.json`)
      .then((res) => res.json())
      .then((data) => setSchemaList(Array.isArray(data) ? data : []))
      .catch(() => setSchemaList([]))
  }, [])

  // 選択中のスキーマの rdb.json を読み込む
  useEffect(() => {
    let cancelled = false
    setSchema(null)
    setSchemaError(null)
    fetch(`${import.meta.env.BASE_URL}schemas/${selectedSchema}/rdb.json`)
      .then((res) => {
        if (!res.ok) throw new Error('ER図情報の読み込みに失敗しました')
        return res.json()
      })
      .then((data) => {
        if (!cancelled) setSchema(data)
      })
      .catch((err) => {
        if (!cancelled) setSchemaError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [selectedSchema])

  // スキーマが変わったときはソート状態をリセットする
  useEffect(() => {
    setSort({ column: -1, asc: true })
  }, [selectedSchema])

  // 選択中のテーブルが新スキーマに無ければ、初めのテーブルに合わせる
  useEffect(() => {
    if (!schema) return
    if (!schema.tables.some((t) => t.name === selectedTable)) {
      setSelectedTable(schema.tables[0]?.name ?? '')
    }
  }, [schema])

  // 現在選択中のスキーマの情報（名前の表示用）
  const currentSchema = useMemo(
    () => schemaList.find((s) => s.id === selectedSchema),
    [schemaList, selectedSchema]
  )

  // スキーマメニュー外クリック・ESCで閉じる
  useEffect(() => {
    if (!schemaMenuOpen) return
    const handleClick = (event) => {
      if (schemaSelectorRef.current && !schemaSelectorRef.current.contains(event.target)) {
        setSchemaMenuOpen(false)
      }
    }
    const handleKey = (event) => {
      if (event.key === 'Escape') setSchemaMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [schemaMenuOpen])

  // カードのサイズを計測し、初回の配置（グリッド整列）を決定する
  useEffect(() => {
    if (!schema) return
    const names = schema.tables.map((t) => t.name)
    const measured = {}
    names.forEach((name, i) => {
      const el = entityRefs.current[name]
      measured[name] = {
        w: el ? el.offsetWidth : DEFAULT_WIDTH,
        h: el ? el.offsetHeight : DEFAULT_HEIGHT,
      }
    })
  setDimensions(measured)

  setPositions(arrangeTables(schema, {}, measured))
}, [schema])

  // ドラッグ中にカードを移動させる
  const startDrag = (e, name) => {
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    const base = positions[name] || { x: 0, y: 0 }
    let moved = false
    const onMouseMove = (ev) => {
      const nx = base.x + (ev.clientX - start.x)
      const ny = base.y + (ev.clientY - start.y)
      setPositions((prev) => ({ ...prev, [name]: { x: Math.max(0, nx), y: Math.max(0, ny) } }))
      moved = true
    }
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      if (moved) setDragging(null)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    setDragging(name)
    document.body.style.userSelect = 'none'
  }

  // ドラッグ・レイアウト後にコンテナの高さを調整する
  useEffect(() => {
    if (Object.keys(positions).length === 0) return
    let max = 0
    for (const name in positions) {
      const { y } = positions[name]
      const { h } = dimensions[name] || {}
      if (h != null) max = Math.max(max, y + h)
    }
    setContainerHeight(max > 0 ? max : DEFAULT_HEIGHT)
  }, [positions, dimensions])

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!resizing.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const available = rect.height - HEADER_HEIGHT - SPLITTER_HEIGHT
      let h = e.clientY - rect.top - HEADER_HEIGHT
      if (h < MIN_PANEL) h = MIN_PANEL
      if (h > available - MIN_PANEL) h = available - MIN_PANEL
      setTopHeight(h)
    }
    const onPointerUp = () => {
      resizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onPointerUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onPointerUp)
    }
  }, [])

  const startResize = () => {
    resizing.current = true
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  // ヘッダーのボタンで上面板の高さを切り替える
  const availableHeight = () => {
    if (!containerRef.current) return 0
    return containerRef.current.getBoundingClientRect().height - HEADER_HEIGHT - SPLITTER_HEIGHT
  }

  const setTopHeightPercent = (ratio) => {
    const available = availableHeight()
    setTopHeight(Math.min(Math.max(MIN_PANEL, available * ratio), available - MIN_PANEL))
  }

  // 「テーブル」:上面板を最大まで広げる
  const showTable = () => setTopHeightPercent(1)

  // 「ER図」:下面板を最大まで広げる（上面板を最小）
  const showER = () => setTopHeightPercent(0)

  // 「画面分割」:約50%に分割
  const splitView = () => setTopHeightPercent(0.5)

  // 「整列」ボタン：外部キーの構造に従ってテーブルを再配置する。
  // 外部キーが多いテーブルを起点に、参照対象を右へ（複数なら上下に）配置し、
  // 重なりがあれば上下にずらしながらBFSで辿っていく。
  const alignLayout = () => {
    if (!schema) return
    setPositions(arrangeTables(schema, positions, dimensions))
  }

  // 矩形の4辺の中心座標を返す
  const sideCenters = (rect) => {
    const cx = (rect.left + rect.right) / 2
    const cy = (rect.top + rect.bottom) / 2
    return {
      left: { x: rect.left, y: cy },
      right: { x: rect.right, y: cy },
      top: { x: cx, y: rect.top },
      bottom: { x: cx, y: rect.bottom },
    }
  }

  const dist2 = (a, b) => {
    const dx = a.x - b.x
    const dy = a.y - b.y
    return dx * dx + dy * dy
  }

  // 2点を方向の単位ベクトルで返す
  const dirBetween = (x1, y1, x2, y2) => {
    const dx = x2 - x1
    const dy = y2 - y1
    const d = Math.hypot(dx, dy) || 1
    return { x: dx / d, y: dy / d }
  }

  // 指定した方向へ広がるカサ（多）の記号の3本の枝の先端を返す
  const crowsFoot = (px, py, dir, spread = 0.4, len = 6) => {
    const rot = (a) => ({
      x: dir.x * Math.cos(a) - dir.y * Math.sin(a),
      y: dir.x * Math.sin(a) + dir.y * Math.cos(a),
    })
    return {
      top: { x: px + rot(spread).x * len, y: py + rot(spread).y * len },
      mid: { x: px + dir.x * len, y: py + dir.y * len },
      bot: { x: px + rot(-spread).x * len, y: py + rot(-spread).y * len },
    }
  }

  // 2点を折れ線で結ぶパスを生成する。丸みをつける。
  // 必ず最初に横に伸びてから縦へ折れ、最後に横に伸びて目標に届くエルボー。
  const orthoPath = (sx, sy, tx, ty, r = 10) => {
    const midX = (sx + tx) / 2
    const sX = tx === sx ? 0 : Math.sign(tx - sx) // 横方向の進行方向
    const sY = ty === sy ? 0 : Math.sign(ty - sy) // 縦方向の進行方向
    return [
      `M ${sx} ${sy}`,
      `L ${midX - sX * r} ${sy}`,
      `Q ${midX} ${sy} ${midX} ${sy + sY * r}`,
      `L ${midX} ${ty - sY * r}`,
      `Q ${midX} ${ty} ${midX + sX * r} ${ty}`,
      `L ${tx} ${ty}`,
    ].join(' ')
  }

  // ドラッグ・レイアウト後に、接続点の座標を計測する
  useEffect(() => {
    if (!schema || !erGridRef.current) return
    const gridRect = erGridRef.current.getBoundingClientRect()
    const result = {}
    fkEdges
      .forEach((edge) => {
        const sEl = columnRefs.current[`${edge.from}.${edge.fromColumn}`]
        const tEl = columnRefs.current[`${edge.to}.${edge.toColumn}`]
        if (!sEl || !tEl) return
        const s = sEl.getBoundingClientRect()
        const t = tEl.getBoundingClientRect()
        const sRect = {
          left: s.left - gridRect.left,
          top: s.top - gridRect.top,
          right: s.right - gridRect.left,
          bottom: s.bottom - gridRect.top,
        }
        const tRect = {
          left: t.left - gridRect.left,
          top: t.top - gridRect.top,
          right: t.right - gridRect.left,
          bottom: t.bottom - gridRect.top,
        }
        const sC = { x: (sRect.left + sRect.right) / 2, y: (sRect.top + sRect.bottom) / 2 }
        const tC = { x: (tRect.left + tRect.right) / 2, y: (tRect.top + tRect.bottom) / 2 }
        const sAnchor = Object.values(sideCenters(sRect)).reduce(
          (best, p) => (dist2(p, tC) < dist2(best, tC) ? p : best)
        )
        const tAnchor = Object.values(sideCenters(tRect)).reduce(
          (best, p) => (dist2(p, sC) < dist2(best, sC) ? p : best)
        )
        result[`${edge.from}.${edge.fromColumn}>>${edge.to}.${edge.toColumn}`] = {
          path: orthoPath(sAnchor.x, sAnchor.y, tAnchor.x, tAnchor.y),
          sx: sAnchor.x,
          sy: sAnchor.y,
          tx: tAnchor.x,
          ty: tAnchor.y,
        }
      })
    setAnchors(result)
  }, [schema, positions, fkEdges])

  return (
    <div ref={containerRef} className="layout">
      <header className="header">
        <h1 className="page-title">virtualRDBViwer</h1>
        <div className="header-actions">
          <div className="view-buttons">
            <button type="button" className="menu-item view-btn" onClick={showTable}>
              テーブル
            </button>
            <button type="button" className="menu-item view-btn" onClick={showER}>
              ER図
            </button>
            <button type="button" className="menu-item view-btn" onClick={splitView}>
              画面分割
            </button>
          </div>
          <button type="button" className="menu-item align-button" onClick={alignLayout}>
            整列
          </button>
          <div className="schema-selector" ref={schemaSelectorRef}>
            <button
              type="button"
              className="menu-item schema-toggle"
              aria-haspopup="menu"
              aria-expanded={schemaMenuOpen ? 'true' : 'false'}
              onClick={() => setSchemaMenuOpen((open) => !open)}
            >
              <span className="schema-toggle-label">{currentSchema?.name ?? selectedSchema}</span>
              <span className="schema-toggle-arrow" aria-hidden="true">▾</span>
            </button>
            {schemaMenuOpen && (
              <div className="schema-menu" role="menu">
                {schemaList.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="menuitem"
                    className={`schema-menu-item ${s.id === selectedSchema ? 'is-active' : ''}`}
                    onClick={() => {
                      setSelectedSchema(s.id)
                      setSchemaMenuOpen(false)
                    }}
                  >
                    <span className="schema-menu-name">{s.name}</span>
                    <span className="schema-menu-desc">{s.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <nav className="menu" aria-label="メインメニュー">
            <button type="button" className="menu-item">詳細</button>
            <button type="button" className="menu-item">設定</button>
          </nav>
        </div>
      </header>

      <div className="main">
        <div className="panel top-panel" style={{ height: topHeight }}>
          <div className="panel-inner">
            <div className="panel-heading-row">
              <h2 className="panel-heading">{selectedTable}</h2>
              <select
                className="table-select"
                value={selectedTable}
                onChange={(e) => setSelectedTable(e.target.value)}
              >
                  {schema?.tables?.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </div>
            {joinError ? (
              <p className="table-error">{joinError}</p>
            ) : joinLoading ? (
              <p className="table-loading">連結中…</p>
            ) : joinResult ? (
              <div className="join-view">
                <div className="panel-heading-row">
                  <h2 className="panel-heading">連結結果</h2>
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      {joinResult.cols.map((c, i) => (
                        <th key={i} className="table-header-col">
                          <span className="table-header-name">{c.table}.{c.name}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {joinResult.rows.map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j}>{cell ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : error ? (
              <p className="table-error">{error}</p>
            ) : loading || !table ? (
              <p className="table-loading">読み込み中…</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    {table.headers.map((h, i) => {
                      const kind = schemaTable ? getColumnKind(schemaTable, h) : null
                      return (
                        <th key={i} className="table-header-col">
                          {kind && (
                            <span className={`table-badge table-badge-${kind}`}>
                              {kind === 'pk' ? 'PK' : 'FK'}
                            </span>
                          )}
                          <span className="table-header-name">{h}</span>
                          {(() => {
                            const active = sort.column === i
                            return (
                              <button
                                type="button"
                                className={`sort-btn ${active ? 'active ' + (sort.asc ? 'asc' : 'desc') : ''}`}
                                aria-label={`${h} でソート`}
                                title={`${h} でソート（再度クリックで逆順）}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleSort(i)
                                }}
                              >
                                <svg
                                  className={`sort-arrow ${active ? (sort.asc ? 'up' : 'down') : 'neutral'}`}
                                  viewBox="0 0 12 12"
                                  aria-hidden="true"
                                >
                                  <path
                                    d={
                                      active
                                        ? sort.asc
                                          ? 'M6 2 L10 8 L2 8 Z'
                                          : 'M6 10 L10 4 L2 4 Z'
                                        : 'M2 4 L10 4 M2 8 L10 8'
                                    }
                                  />
                                </svg>
                              </button>
                            )
                          })()}
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div
          className="splitter"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="horizontal"
          title="ドラッグして大きさを変えられます"
        />

        <div className="panel bottom-panel">
          <div className="panel-inner">
            <div className="panel-heading-row">
              <h2 className="panel-heading">ER図</h2>
              <button
                type="button"
                className="menu-item connect-button"
                onClick={performConnect}
                disabled={joinLoading || !schema}
              >
                連結
              </button>
            </div>
            {schemaError ? (
              <p className="table-error">{schemaError}</p>
            ) : !schema ? (
              <p className="table-loading">読み込み中…</p>
            ) : (
              <div className="er-grid" style={{ height: containerHeight }} ref={erGridRef}>
                <svg
                  className="er-connections"
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    zIndex: 0,
                  }}
                >
                  {fkEdges
                    .map((edge) => {
                      const a = anchors[`${edge.from}.${edge.fromColumn}>>${edge.to}.${edge.toColumn}`]
                      if (!a) return null
                      const dir = dirBetween(a.sx, a.sy, a.tx, a.ty)
                      const fp = crowsFoot(a.sx, a.sy, dir)
                      const perp = { x: -dir.y, y: dir.x }
                      const barHalf = 4
                      const barP1 = { x: a.tx + perp.x * barHalf, y: a.ty + perp.y * barHalf }
                      const barP2 = { x: a.tx - perp.x * barHalf, y: a.ty - perp.y * barHalf }
                      return (
                        <g key={edge.from + edge.fromColumn + edge.to + edge.toColumn}>
                          <path d={a.path} className="er-connector" />
                          {/* 起点（外部キー側）：カサ（多）。任意なら円を付ける */}
                          {edge.nullable && (
                            <circle className="er-conn-optional" cx={a.sx} cy={a.sy} r={3.5} />
                          )}
                          <path
                            className="er-conn-crowfoot"
                            d={`M ${a.sx} ${a.sy} L ${fp.top.x} ${fp.top.y} M ${a.sx} ${a.sy} L ${fp.mid.x} ${fp.mid.y} M ${a.sx} ${a.sy} L ${fp.bot.x} ${fp.bot.y}`}
                          />
                          {/* 終点（参照対象側）：一（one）*/}
                          <line
                            className="er-conn-one"
                            x1={barP1.x}
                            y1={barP1.y}
                            x2={barP2.x}
                            y2={barP2.y}
                          />
                        </g>
                      )
                    })}
                </svg>
                {schema.tables
                  .map((t) => (
                  <div
                    key={t.name}
                    ref={(el) => {
                      entityRefs.current[t.name] = el
                    }}
                    className={`er-entity ${dragging === t.name ? 'dragging' : ''}`}
                    role="button"
                    tabIndex={0}
                    onMouseDown={(e) => startDrag(e, t.name)}
                    onClick={() => {
                      setSelectedTable(t.name)
                      setJoinResult(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedTable(t.name)
                      }
                    }}
                    title={`${t.name} のデータを表示`}
                    style={{
                      left: positions[t.name]?.x ?? 0,
                      top: positions[t.name]?.y ?? 0,
                    }}
                  >
                    <div className="er-entity-title">
                        <input
                          type="checkbox"
                          className="er-entity-checkbox"
                          checked={!!checked[t.name]}
                          onChange={() =>
                            setChecked((prev) => ({
                              ...prev,
                              [t.name]: !prev[t.name],
                            }))
                          }
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="er-entity-name">{t.name}</span>
                    </div>
                    <ul className="er-columns">
                      {t.columns.map((c) => {
                        const kind = getColumnKind(t, c.name)
                        return (
                          <li
                            key={c.name}
                            ref={(el) => {
                              columnRefs.current[`${t.name}.${c.name}`] = el
                            }}
                            className={`er-column ${kind ?? ''}`}
                          >
                            {kind && (
                              <span className={`er-badge er-badge-${kind}`}>
                                {kind === 'pk' ? 'PK' : 'FK'}
                              </span>
                            )}
                            <span className="er-column-name">{c.name}</span>
                            <span className="er-column-type">{c.type}</span>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
