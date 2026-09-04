import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { collapseConnections, recenterConnectedLines } from './erLayout.js'

const HEADER_HEIGHT = 56
const SPLITTER_HEIGHT = 8
const MIN_TOP = 80

// tables ディレクトリにあるCSVファイル名（.csvは除く）
const TABLES = ['accounts', 'categories', 'orders', 'products']
const TABLE_PATH = (name) => `/tables/${name}.csv`

// ER図のカード配置定数
const GRID_COLS = 2
const GRID_GAP = 16
const GRID_PAD = 16
const DEFAULT_WIDTH = 240
const DEFAULT_HEIGHT = 160

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

function App() {
  const containerRef = useRef(null)
  const erGridRef = useRef(null)
  const resizing = useRef(false)
  const [topHeight, setTopHeight] = useState(250)
  const [selectedTable, setSelectedTable] = useState(TABLES[0])
  const [table, setTable] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [schema, setSchema] = useState(null)
  const [schemaError, setSchemaError] = useState(null)

  // ER図：各テーブルカードの配置・サイズ・ドラッグ状態
  const entityRefs = useRef({})
  const columnRefs = useRef({})
  const [dimensions, setDimensions] = useState({})
  const [positions, setPositions] = useState({})
  const [containerHeight, setContainerHeight] = useState(0)
  const [anchors, setAnchors] = useState({})
  const [dragging, setDragging] = useState(null)

  // リレーション（外部キー）の接続情報
  const schemaTable = useMemo(
    () => (schema ? schema.tables.find((t) => t.name === selectedTable) : null),
    [schema, selectedTable]
  )

  const fkEdges = useMemo(
    () =>
      schema
        ? schema.tables.flatMap((from) =>
            (from.foreignKeys || []).map((fk) => ({
              from: from.name,
              fromColumn: fk.columns[0],
              to: fk.referencesTable,
              toColumn: fk.referencesColumns[0],
            }))
          )
        : [],
    [schema]
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(TABLE_PATH(selectedTable))
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
  }, [selectedTable])

  useEffect(() => {
    fetch('/rdb.json')
      .then((res) => {
        if (!res.ok) throw new Error('ER図情報の読み込みに失敗しました')
        return res.json()
      })
      .then((data) => setSchema(data))
      .catch((err) => setSchemaError(err.message))
  }, [])

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

    const laidOut = {}
    names.forEach((name, i) => {
      const { w, h } = measured[name]
      laidOut[name] = {
        x: GRID_PAD + (i % GRID_COLS) * (w + GRID_GAP),
        y: GRID_PAD + Math.floor(i / GRID_COLS) * (h + GRID_GAP),
      }
    })
    setPositions(laidOut)
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
      const maxTop = rect.height - HEADER_HEIGHT - SPLITTER_HEIGHT - MIN_TOP
      let h = e.clientY - rect.top - HEADER_HEIGHT
      if (h < MIN_TOP) h = MIN_TOP
      if (h > maxTop) h = maxTop
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

  // 「整列」ボタン：線（外部キー）でつながっているテーブル同士を、横方向に
  // テーブル幅の1.25以上の隙間を保つよう整列させる（collapseConnections）。
  const alignLayout = () => {
    if (!schema || !erGridRef.current) return
    let next = collapseConnections(schema, positions, dimensions)
    next = recenterConnectedLines(schema, next, dimensions)
    setPositions(next)
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
    fkEdges.forEach((edge) => {
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
          <button type="button" className="menu-item align-button" onClick={alignLayout}>
            整列
          </button>
          <nav className="menu" aria-label="メインメニュー">
            <button type="button" className="menu-item">一覧</button>
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
                {TABLES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            {error ? (
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
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, i) => (
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
            <h2 className="panel-heading">ER図</h2>
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
                  {fkEdges.map((edge) => {
                    const a = anchors[`${edge.from}.${edge.fromColumn}>>${edge.to}.${edge.toColumn}`]
                    if (!a) return null
                    return (
                      <g key={edge.from + edge.fromColumn + edge.to + edge.toColumn}>
                        <path d={a.path} className="er-connector" />
                        <circle className="er-conn-dot" cx={a.sx} cy={a.sy} r={2.5} />
                        <circle className="er-conn-dot" cx={a.tx} cy={a.ty} r={2.5} />
                      </g>
                    )
                  })}
                </svg>
                {schema.tables.map((t) => (
                  <div
                    key={t.name}
                    ref={(el) => {
                      entityRefs.current[t.name] = el
                    }}
                    className={`er-entity ${dragging === t.name ? 'dragging' : ''}`}
                    role="button"
                    tabIndex={0}
                    onMouseDown={(e) => startDrag(e, t.name)}
                    onClick={() => setSelectedTable(t.name)}
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
                    <div className="er-entity-title">{t.name}</div>
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
