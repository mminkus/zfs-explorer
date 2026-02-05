import { useEffect, useMemo, useState, useCallback } from 'react'
import './App.css'
import { ObjectGraph } from './components/ObjectGraph'

const API_BASE = 'http://localhost:9000'
const MOS_PAGE_LIMIT = 200

type DmuType = {
  id: number
  name: string
  metadata: boolean
  encrypted: boolean
}

type MosObject = {
  id: number
  type: number
  type_name: string
  bonus_type: number
  bonus_type_name: string
}

type MosListResponse = {
  start: number
  limit: number
  count: number
  next: number | null
  objects: MosObject[]
}

type DnodeInfo = {
  id: number
  type: { id: number; name: string }
  bonus_type: { id: number; name: string }
  is_zap: boolean
  bonus_decoded: BonusDecoded | null
  semantic_edges: SemanticEdge[]
  nlevels: number
  nblkptr: number
  indblkshift: number
  indirect_block_size: number
  data_block_size: number
  metadata_block_size: number
  bonus_size: number
  bonus_len: number
  checksum: number
  compress: number
  flags: number
  maxblkid: number
  used_bytes: number
  fill_count: number
  physical_blocks_512: number
  max_offset: number
  indirection: number
  dnodesize: number
}

type DvaInfo = {
  vdev: number
  offset: number
  asize: number
  is_gang: boolean
}

type BlkptrInfo = {
  index: number
  is_spill: boolean
  is_hole: boolean
  is_embedded: boolean
  is_gang: boolean
  level: number
  type: number
  lsize: number
  psize: number
  asize: number
  birth_txg: number
  logical_birth: number
  physical_birth: number
  fill: number
  checksum: number
  compression: number
  dedup: boolean
  ndvas: number
  dvas: DvaInfo[]
}

type BlkptrResponse = {
  id: number
  nblkptr: number
  has_spill: boolean
  blkptrs: BlkptrInfo[]
}

type ZapInfo = {
  object: number
  kind: string
  block_size: number
  num_entries: number
  num_blocks: number
  num_leafs: number
  ptrtbl_len: number
  ptrtbl_zt_blk: number
  ptrtbl_zt_numblks: number
  ptrtbl_zt_shift: number
  ptrtbl_blks_copied: number
  ptrtbl_nextblk: number
  zap_block_type: number
  zap_magic: number
  zap_salt: number
}

type ZapEntry = {
  name: string
  key_u64: number | null
  integer_length: number
  num_integers: number
  value_preview: string
  value_u64: number | null
  ref_objid: number | null
  maybe_object_ref: boolean
  target_obj: number | null
  truncated: boolean
}

type ZapResponse = {
  object: number
  cursor: number
  next: number | null
  count: number
  entries: ZapEntry[]
}

type SemanticEdge = {
  source_obj: number
  target_obj: number
  label: string
  kind: string
  confidence?: number
  notes?: string
}

type BonusDecodedDslDir = {
  kind: 'dsl_dir'
  head_dataset_obj: number
  parent_dir_obj: number
  origin_obj: number
  child_dir_zapobj: number
  props_zapobj: number
}

type BonusDecodedDslDataset = {
  kind: 'dsl_dataset'
  dir_obj: number
  prev_snap_obj: number
  next_snap_obj: number
  snapnames_zapobj: number
}

type BonusDecoded = BonusDecodedDslDir | BonusDecodedDslDataset | { kind: string }

function App() {
  const [pools, setPools] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedPool, setSelectedPool] = useState<string | null>(null)
  const [formatMode, setFormatMode] = useState<'dec' | 'hex'>('dec')
  const [typeFilter, setTypeFilter] = useState<number | null>(null)
  const [typeInput, setTypeInput] = useState('')
  const [dmuTypes, setDmuTypes] = useState<DmuType[]>([])
  const [typesError, setTypesError] = useState<string | null>(null)
  const [mosObjects, setMosObjects] = useState<MosObject[]>([])
  const [mosNext, setMosNext] = useState<number | null>(null)
  const [mosLoading, setMosLoading] = useState(false)
  const [mosError, setMosError] = useState<string | null>(null)
  const [selectedObject, setSelectedObject] = useState<number | null>(null)
  const [objectInfo, setObjectInfo] = useState<DnodeInfo | null>(null)
  const [blkptrs, setBlkptrs] = useState<BlkptrResponse | null>(null)
  const [inspectorLoading, setInspectorLoading] = useState(false)
  const [inspectorError, setInspectorError] = useState<string | null>(null)
  const [zapInfo, setZapInfo] = useState<ZapInfo | null>(null)
  const [zapEntries, setZapEntries] = useState<ZapEntry[]>([])
  const [zapNext, setZapNext] = useState<number | null>(null)
  const [zapLoading, setZapLoading] = useState(false)
  const [zapError, setZapError] = useState<string | null>(null)
  const [dslRoot, setDslRoot] = useState<{ root_dataset_obj: number; root_dir_obj: number } | null>(
    null
  )
  const [dslChildren, setDslChildren] = useState<Record<number, { name: string; dir_objid: number }[]>>(
    {}
  )
  const [dslExpanded, setDslExpanded] = useState<Record<number, boolean>>({})
  const [dslLoading, setDslLoading] = useState(false)
  const [dslError, setDslError] = useState<string | null>(null)
  const [navStack, setNavStack] = useState<number[]>([])
  const [navIndex, setNavIndex] = useState(-1)
  const [inspectorTab, setInspectorTab] = useState<'summary' | 'zap' | 'blkptr' | 'raw'>('summary')
  const [zdbCopied, setZdbCopied] = useState(false)

  const zapObjectKeys = useMemo(
    () =>
      new Set([
        'config',
        'root_dataset',
        'features_for_read',
        'features_for_write',
        'pool_props',
        'bootfs',
      ]),
    []
  )

  const mosObjectMap = useMemo(() => {
    const map = new Map<number, MosObject>()
    mosObjects.forEach(obj => map.set(obj.id, obj))
    return map
  }, [mosObjects])

  const formatAddr = (value: number) => {
    if (formatMode === 'hex') {
      return `0x${value.toString(16)}`
    }
    return value.toString(10)
  }

  const formatHexNoPrefix = (value: number) => value.toString(16)

  const formatDvaZdb = (dva: DvaInfo) =>
    `<${dva.vdev}:${formatHexNoPrefix(dva.offset)}:${formatHexNoPrefix(dva.asize)}>`

  const resetInspector = () => {
    setSelectedObject(null)
    setObjectInfo(null)
    setBlkptrs(null)
    setZapInfo(null)
    setZapEntries([])
    setZapNext(null)
    setZapError(null)
  }

  const navigateTo = useCallback(
    (
      objid: number,
      opts?: { reset?: boolean; replace?: boolean; navAction?: 'back' | 'forward' | 'jump'; jumpIndex?: number }
    ) => {
      setSelectedObject(objid)
      fetchInspector(objid)

      if (opts?.navAction === 'back' || opts?.navAction === 'forward') {
        // Just update index, don't modify stack
        return
      }

      if (opts?.navAction === 'jump' && opts.jumpIndex !== undefined) {
        setNavIndex(opts.jumpIndex)
        return
      }

      if (opts?.reset) {
        setNavStack([objid])
        setNavIndex(0)
        return
      }

      if (opts?.replace) {
        setNavStack(prev => {
          if (prev.length === 0) return [objid]
          const newStack = [...prev.slice(0, navIndex), objid]
          return newStack
        })
        // Index stays the same
        return
      }

      // Normal navigation: truncate forward history and append
      setNavStack(prev => {
        // If we're not at the end, truncate forward history
        const base = navIndex >= 0 ? prev.slice(0, navIndex + 1) : prev
        // Don't add duplicate if already there
        if (base.length > 0 && base[base.length - 1] === objid) {
          return base
        }
        return [...base, objid]
      })
      setNavIndex(prev => {
        const base = prev >= 0 ? prev : -1
        return base + 1
      })
    },
    [navIndex, selectedPool]
  )

  const canGoBack = navIndex > 0
  const canGoForward = navIndex < navStack.length - 1

  const goBack = useCallback(() => {
    if (canGoBack) {
      const newIndex = navIndex - 1
      const objid = navStack[newIndex]
      setNavIndex(newIndex)
      setSelectedObject(objid)
      fetchInspector(objid)
    }
  }, [canGoBack, navIndex, navStack, selectedPool])

  const goForward = useCallback(() => {
    if (canGoForward) {
      const newIndex = navIndex + 1
      const objid = navStack[newIndex]
      setNavIndex(newIndex)
      setSelectedObject(objid)
      fetchInspector(objid)
    }
  }, [canGoForward, navIndex, navStack, selectedPool])

  useEffect(() => {
    fetch(`${API_BASE}/api/pools`)
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`)
        }
        return res.json()
      })
      .then(data => {
        setPools(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    fetch(`${API_BASE}/api/mos/types`)
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`)
        }
        return res.json()
      })
      .then((data: DmuType[]) => {
        setDmuTypes(data)
      })
      .catch(err => {
        setTypesError(err.message)
      })
  }, [])

  useEffect(() => {
    if (!selectedPool && pools.length > 0) {
      setSelectedPool(pools[0])
    }
  }, [pools, selectedPool])

  const fetchDslRoot = async (pool: string) => {
    setDslLoading(true)
    setDslError(null)
    try {
      const res = await fetch(`${API_BASE}/api/pools/${encodeURIComponent(pool)}/dsl/root`)
      if (!res.ok) {
        throw new Error(`DSL root HTTP ${res.status}`)
      }
      const data = await res.json()
      setDslRoot(data)
      setDslChildren({})
      setDslExpanded({})
    } catch (err) {
      setDslError((err as Error).message)
    } finally {
      setDslLoading(false)
    }
  }

  const fetchDslChildren = async (pool: string, dirObj: number) => {
    try {
      const res = await fetch(
        `${API_BASE}/api/pools/${encodeURIComponent(pool)}/dsl/dir/${dirObj}/children`
      )
      if (!res.ok) {
        throw new Error(`DSL children HTTP ${res.status}`)
      }
      const data = await res.json()
      setDslChildren(prev => ({ ...prev, [dirObj]: data.children ?? [] }))
    } catch (err) {
      setDslError((err as Error).message)
    }
  }

  const toggleDslNode = (pool: string, dirObj: number) => {
    setDslExpanded(prev => {
      const next = { ...prev, [dirObj]: !prev[dirObj] }
      return next
    })
    if (!dslChildren[dirObj]) {
      fetchDslChildren(pool, dirObj)
    }
  }

  const renderDslNode = (pool: string, name: string, dirObj: number, depth: number) => {
    const expanded = dslExpanded[dirObj]
    const children = dslChildren[dirObj] ?? []

    return (
      <div key={`${dirObj}-${name}`} className="dsl-node" style={{ marginLeft: depth * 12 }}>
        <button className="dsl-toggle" onClick={() => toggleDslNode(pool, dirObj)}>
          {expanded ? '▾' : '▸'}
        </button>
        <button className="dsl-name" onClick={() => navigateTo(dirObj)}>
          {name}
        </button>
        <span className="dsl-id">#{dirObj}</span>
        {expanded && children.length > 0 && (
          <div className="dsl-children">
            {children.map(child => renderDslNode(pool, child.name, child.dir_objid, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  const typeOptions = useMemo(() => {
    return [...dmuTypes].sort((a, b) => a.name.localeCompare(b.name))
  }, [dmuTypes])

  const fetchMosObjects = async (start: number, append: boolean) => {
    if (!selectedPool) return
    setMosLoading(true)
    setMosError(null)

    const params = new URLSearchParams()
    params.set('start', String(start))
    params.set('limit', String(MOS_PAGE_LIMIT))
    if (typeFilter !== null) {
      params.set('type', String(typeFilter))
    }

    try {
      const res = await fetch(
        `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/mos/objects?${params.toString()}`
      )
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      }
      const data: MosListResponse = await res.json()
      setMosObjects(prev => (append ? [...prev, ...data.objects] : data.objects))
      setMosNext(data.next)
    } catch (err) {
      setMosError((err as Error).message)
    } finally {
      setMosLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedPool) {
      setMosObjects([])
      setMosNext(null)
      setDslRoot(null)
      setDslChildren({})
      setDslExpanded({})
      setNavStack([])
      setNavIndex(-1)
      return
    }
    resetInspector()
    setNavStack([])
    setNavIndex(-1)
    fetchMosObjects(0, false)
  }, [selectedPool, typeFilter])

  useEffect(() => {
    if (!selectedPool) {
      return
    }
    fetchDslRoot(selectedPool)
  }, [selectedPool])

  const fetchZapInfo = async (objid: number) => {
    if (!selectedPool) return
    const res = await fetch(
      `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/obj/${objid}/zap/info`
    )
    if (!res.ok) {
      throw new Error(`ZAP info HTTP ${res.status}`)
    }
    const data: ZapInfo = await res.json()
    setZapInfo(data)
  }

  const fetchZapEntries = async (objid: number, cursor: number, append: boolean) => {
    if (!selectedPool) return
    setZapLoading(true)
    setZapError(null)
    try {
      const params = new URLSearchParams()
      params.set('cursor', String(cursor))
      params.set('limit', '200')
      const res = await fetch(
        `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/obj/${objid}/zap?${params.toString()}`
      )
      if (!res.ok) {
        throw new Error(`ZAP entries HTTP ${res.status}`)
      }
      const data: ZapResponse = await res.json()
      setZapEntries(prev => (append ? [...prev, ...data.entries] : data.entries))
      setZapNext(data.next)
    } catch (err) {
      setZapError((err as Error).message)
    } finally {
      setZapLoading(false)
    }
  }

  const fetchInspector = async (objid: number) => {
    if (!selectedPool) return
    setInspectorLoading(true)
    setInspectorError(null)
    setZapInfo(null)
    setZapEntries([])
    setZapNext(null)
    setZapError(null)
    try {
      const infoRes = await fetch(
        `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/obj/${objid}`
      )
      const blkptrRes = await fetch(
        `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/obj/${objid}/blkptrs`
      )

      if (!infoRes.ok) {
        throw new Error(`Object info HTTP ${infoRes.status}`)
      }
      if (!blkptrRes.ok) {
        throw new Error(`Blkptrs HTTP ${blkptrRes.status}`)
      }

      const infoData: DnodeInfo = await infoRes.json()
      const blkData: BlkptrResponse = await blkptrRes.json()
      setObjectInfo(infoData)
      setBlkptrs(blkData)

      if (infoData.is_zap) {
        await fetchZapInfo(objid)
        await fetchZapEntries(objid, 0, false)
      }
    } catch (err) {
      setInspectorError((err as Error).message)
    } finally {
      setInspectorLoading(false)
    }
  }

  const handleSelectObject = (objid: number) => {
    navigateTo(objid, { reset: true })
  }

  const handleCopyZdbCommand = () => {
    if (selectedPool && selectedObject !== null) {
      const cmd = `sudo zdb -dddd ${selectedPool} ${selectedObject}`
      navigator.clipboard.writeText(cmd).then(() => {
        setZdbCopied(true)
        setTimeout(() => setZdbCopied(false), 2000)
      })
    }
  }

  const isZapObjectKey = (entry: ZapEntry) =>
    zapObjectKeys.has(entry.name) && entry.maybe_object_ref && entry.target_obj !== null

  const semanticEdges = objectInfo?.semantic_edges ?? []

  const bonusEntries = useMemo(() => {
    const bonus = objectInfo?.bonus_decoded
    if (!bonus || !('kind' in bonus)) {
      return []
    }
    if (bonus.kind === 'dsl_dir') {
      const b = bonus as BonusDecodedDslDir
      return [
        { key: 'head_dataset_obj', value: b.head_dataset_obj, isRef: true },
        { key: 'parent_dir_obj', value: b.parent_dir_obj, isRef: true },
        { key: 'origin_obj', value: b.origin_obj, isRef: true },
        { key: 'child_dir_zapobj', value: b.child_dir_zapobj, isRef: true },
        { key: 'props_zapobj', value: b.props_zapobj, isRef: true },
      ]
    }
    if (bonus.kind === 'dsl_dataset') {
      const b = bonus as BonusDecodedDslDataset
      return [
        { key: 'dir_obj', value: b.dir_obj, isRef: true },
        { key: 'prev_snap_obj', value: b.prev_snap_obj, isRef: true },
        { key: 'next_snap_obj', value: b.next_snap_obj, isRef: true },
        { key: 'snapnames_zapobj', value: b.snapnames_zapobj, isRef: true },
      ]
    }

    return Object.entries(bonus).map(([key, value]) => ({
      key,
      value: value as number | string,
      isRef: false,
    }))
  }, [objectInfo?.bonus_decoded])

  const handleTypeInput = (value: string) => {
    setTypeInput(value)
    const parsed = Number(value)
    if (!Number.isNaN(parsed) && value.trim() !== '') {
      setTypeFilter(parsed)
    } else if (value.trim() === '') {
      setTypeFilter(null)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>ZFS Explorer</h1>
          <p className="subtitle">Milestone 1: MOS Object Browser</p>
        </div>
        <div className="status">
          <div className="format-toggle">
            <button
              className={formatMode === 'dec' ? 'toggle active' : 'toggle'}
              onClick={() => setFormatMode('dec')}
            >
              DEC
            </button>
            <button
              className={formatMode === 'hex' ? 'toggle active' : 'toggle'}
              onClick={() => setFormatMode('hex')}
            >
              HEX
            </button>
          </div>
          <div className="status-item">
            <span>Backend</span>
            <code>localhost:9000</code>
          </div>
          <div className="status-item">
            <span>Pool</span>
            <strong>{selectedPool ?? 'none'}</strong>
          </div>
        </div>
      </header>

      <div className="breadcrumb">
        <div className="nav-buttons">
          <button
            type="button"
            className="nav-btn"
            onClick={goBack}
            disabled={!canGoBack}
            title="Go back"
          >
            ←
          </button>
          <button
            type="button"
            className="nav-btn"
            onClick={goForward}
            disabled={!canGoForward}
            title="Go forward"
          >
            →
          </button>
        </div>
        {selectedPool ? (
          <button
            className="crumb"
            onClick={() => {
              resetInspector()
              setNavStack([])
              setNavIndex(-1)
              setSelectedPool(selectedPool)
            }}
          >
            Pool {selectedPool}
          </button>
        ) : (
          <span className="crumb muted">No pool selected</span>
        )}
        <span className="crumb-sep">→</span>
        <button
          className="crumb"
          onClick={() => {
            resetInspector()
            setNavStack([])
            setNavIndex(-1)
          }}
        >
          MOS
        </button>
        {navStack.slice(0, navIndex + 1).map((objid, idx) => (
          <span key={`${objid}-${idx}`} className="crumb-group">
            <span className="crumb-sep">→</span>
            <button
              className={`crumb ${idx === navIndex ? 'active' : ''}`}
              onClick={() => {
                if (idx !== navIndex) {
                  setNavIndex(idx)
                  setSelectedObject(objid)
                  fetchInspector(objid)
                }
              }}
            >
              Object {objid}
              {mosObjectMap.get(objid)?.type_name
                ? ` (${mosObjectMap.get(objid)?.type_name})`
                : ''}
            </button>
          </span>
        ))}
      </div>

      <div className="main-grid">
        <aside className="panel pane-left">
          <h2>Tree</h2>
          <div className="tree">
            <details open>
              <summary>Pools</summary>
              {loading && <p className="muted">Loading pools...</p>}
              {error && (
                <div className="error">
                  <strong>Error:</strong> {error}
                  <p className="hint">
                    Make sure the API backend is running on <code>localhost:9000</code>
                  </p>
                </div>
              )}
              {!loading && !error && pools.length === 0 && (
                <p className="muted">No pools found</p>
              )}
              {!loading && !error && pools.length > 0 && (
                <ul className="tree-list">
                  {pools.map(pool => (
                    <li key={pool}>
                      <details open={selectedPool === pool}>
                        <summary
                          className={`tree-item ${selectedPool === pool ? 'active' : ''}`}
                          onClick={e => {
                            e.preventDefault()
                            setSelectedPool(pool)
                          }}
                        >
                          {pool}
                        </summary>
                        <div className="tree-sub">
                          <div className="tree-label">MOS</div>
                          <div className="type-filter">
                            <label>Type filter</label>
                            <input
                              type="text"
                              placeholder="Type id (blank = all)"
                              value={typeInput}
                              onChange={e => handleTypeInput(e.target.value)}
                            />
                          </div>
                          {typesError && (
                            <p className="muted">Type list: {typesError}</p>
                          )}
                          <div className="type-chips">
                            <button
                              className={typeFilter === null ? 'chip active' : 'chip'}
                              onClick={() => {
                                setTypeInput('')
                                setTypeFilter(null)
                              }}
                            >
                              All
                            </button>
                            {typeOptions.slice(0, 12).map(option => (
                              <button
                                key={option.id}
                                className={typeFilter === option.id ? 'chip active' : 'chip'}
                                onClick={() => {
                                  setTypeInput(String(option.id))
                                  setTypeFilter(option.id)
                                }}
                                title={`DMU type ${option.id}`}
                              >
                                {option.name}
                              </button>
                            ))}
                          </div>
                          <div className="tree-sub">
                            <div className="tree-label">Datasets</div>
                            {dslLoading && <p className="muted">Loading dataset tree...</p>}
                            {dslError && <p className="muted">Dataset tree: {dslError}</p>}
                            {dslRoot &&
                              renderDslNode(pool, pool, dslRoot.root_dir_obj, 0)}
                          </div>
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </div>

          <div className="divider" />

          <h2>MOS Objects</h2>

          {mosLoading && <p className="muted">Loading MOS objects...</p>}
          {mosError && (
            <div className="error">
              <strong>Error:</strong> {mosError}
            </div>
          )}

          <ul className="object-list">
            {mosObjects.map(obj => (
              <li
                key={obj.id}
                className={`object-item ${selectedObject === obj.id ? 'active' : ''}`}
                onClick={() => handleSelectObject(obj.id)}
              >
                <div>
                  <span className="object-id">#{obj.id}</span>
                  <span className="object-type">{obj.type_name}</span>
                </div>
                <span className="object-meta">bonus {obj.bonus_type_name}</span>
              </li>
            ))}
          </ul>

          {mosNext !== null && !mosLoading && (
            <button
              className="load-more"
              onClick={() => fetchMosObjects(mosNext, true)}
            >
              Load more
            </button>
          )}
        </aside>

        <section className="panel pane-center">
          <div className="panel-header">
            <h2>Object Graph</h2>
            <span className="muted">1-hop neighborhood</span>
          </div>
          <div className="graph">
            <ObjectGraph
              selectedObject={selectedObject}
              objectTypeName={objectInfo?.type?.name ?? ''}
              semanticEdges={semanticEdges}
              zapEntries={zapEntries}
              blkptrs={blkptrs?.blkptrs ?? []}
              onNavigate={navigateTo}
            />
          </div>
        </section>

        <section className="panel pane-right">
          <div className="panel-header">
            <h2>Inspector</h2>
            {inspectorLoading && <span className="muted">Loading…</span>}
          </div>

          {selectedPool && selectedObject !== null && (
            <div className="zdb-hint">
              <code>sudo zdb -dddd {selectedPool} {selectedObject}</code>
              <button
                type="button"
                className={`zdb-copy-btn ${zdbCopied ? 'copied' : ''}`}
                onClick={handleCopyZdbCommand}
                title="Copy to clipboard"
              >
                {zdbCopied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          )}

          {inspectorError && (
            <div className="error">
              <strong>Error:</strong> {inspectorError}
            </div>
          )}

          {!selectedObject && !inspectorLoading && (
            <p className="muted">Select a MOS object to inspect its dnode.</p>
          )}

          {selectedObject !== null && objectInfo && (
            <>
              <div className="inspector-tabs">
                <button
                  className={`tab ${inspectorTab === 'summary' ? 'active' : ''}`}
                  onClick={() => setInspectorTab('summary')}
                >
                  Summary
                </button>
                {objectInfo.is_zap && (
                  <button
                    className={`tab ${inspectorTab === 'zap' ? 'active' : ''}`}
                    onClick={() => setInspectorTab('zap')}
                  >
                    ZAP {zapInfo && `(${zapInfo.num_entries})`}
                  </button>
                )}
                <button
                  className={`tab ${inspectorTab === 'blkptr' ? 'active' : ''}`}
                  onClick={() => setInspectorTab('blkptr')}
                >
                  Blkptr {blkptrs && `(${blkptrs.blkptrs.length})`}
                </button>
                <button
                  className={`tab ${inspectorTab === 'raw' ? 'active' : ''}`}
                  onClick={() => setInspectorTab('raw')}
                >
                  Raw
                </button>
              </div>

              <div className="inspector-content">
                {inspectorTab === 'summary' && (
                  <>
                    <div className="inspector-section">
                      <h3>Dnode Fields</h3>
                      <dl className="info-grid">
                        <div>
                          <dt>Type</dt>
                          <dd>{objectInfo.type.name}</dd>
                        </div>
                        <div>
                          <dt>Bonus Type</dt>
                          <dd>{objectInfo.bonus_type.name}</dd>
                        </div>
                        <div>
                          <dt>Levels</dt>
                          <dd>{objectInfo.nlevels}</dd>
                        </div>
                        <div>
                          <dt>Blkptrs</dt>
                          <dd>{objectInfo.nblkptr}</dd>
                        </div>
                        <div>
                          <dt>Data Block</dt>
                          <dd>{objectInfo.data_block_size} B</dd>
                        </div>
                        <div>
                          <dt>Meta Block</dt>
                          <dd>{objectInfo.metadata_block_size} B</dd>
                        </div>
                        <div>
                          <dt>Bonus Len</dt>
                          <dd>{objectInfo.bonus_len} B</dd>
                        </div>
                        <div>
                          <dt>Used Bytes</dt>
                          <dd>{objectInfo.used_bytes}</dd>
                        </div>
                        <div>
                          <dt>Checksum</dt>
                          <dd>{objectInfo.checksum}</dd>
                        </div>
                        <div>
                          <dt>Compress</dt>
                          <dd>{objectInfo.compress}</dd>
                        </div>
                        <div>
                          <dt>Max Blkid</dt>
                          <dd>{objectInfo.maxblkid}</dd>
                        </div>
                        <div>
                          <dt>Fill Count</dt>
                          <dd>{objectInfo.fill_count}</dd>
                        </div>
                      </dl>
                    </div>

                    {bonusEntries.length > 0 && (
                      <div className="inspector-section">
                        <h3>Bonus (decoded)</h3>
                        <div className="bonus-table">
                          {bonusEntries.map(entry => (
                            <div key={entry.key} className="bonus-row">
                              <div className="bonus-key">{entry.key}</div>
                              <div className="bonus-value">
                                {entry.isRef && typeof entry.value === 'number' && entry.value !== 0 ? (
                                  <button
                                    className="zap-entry-link"
                                    onClick={() => navigateTo(entry.value as number)}
                                  >
                                    Object {entry.value}
                                  </button>
                                ) : (
                                  <code>{entry.value?.toString() ?? ''}</code>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {inspectorTab === 'zap' && objectInfo.is_zap && (
                  <div className="inspector-section">
                    {zapInfo && (
                      <div className="zap-info">
                        <div>
                          <dt>Kind</dt>
                          <dd>{zapInfo.kind}</dd>
                        </div>
                        <div>
                          <dt>Entries</dt>
                          <dd>{zapInfo.num_entries}</dd>
                        </div>
                        <div>
                          <dt>Blocks</dt>
                          <dd>{zapInfo.num_blocks}</dd>
                        </div>
                        <div>
                          <dt>Leafs</dt>
                          <dd>{zapInfo.num_leafs}</dd>
                        </div>
                      </div>
                    )}

                    {zapError && (
                      <div className="error">
                        <strong>Error:</strong> {zapError}
                      </div>
                    )}

                    {zapLoading && <p className="muted">Loading ZAP entries...</p>}

                    {!zapLoading && zapEntries.length === 0 && (
                      <p className="muted">No ZAP entries found.</p>
                    )}

                    {zapEntries.length > 0 && (
                      <div className="zap-table">
                        <div className="zap-row zap-header">
                          <div>Key</div>
                          <div>Value</div>
                        </div>
                        {zapEntries.map(entry => {
                          const isObjectKey = isZapObjectKey(entry)
                          const refObject = entry.target_obj ?? 0
                          const hint = mosObjectMap.get(refObject)?.type_name
                          return (
                            <div key={`${entry.name}-${entry.key_u64 ?? 'k'}`} className="zap-row">
                              <div className="zap-key">{entry.name}</div>
                              <div className="zap-value">
                                {isObjectKey ? (
                                  <button
                                    className="zap-entry-link"
                                    onClick={() => navigateTo(refObject)}
                                  >
                                    Object {refObject}
                                    {hint ? <span className="zap-hint">({hint})</span> : null}
                                  </button>
                                ) : entry.maybe_object_ref && entry.target_obj !== null ? (
                                  <code>Object {entry.target_obj}</code>
                                ) : (
                                  <code>{entry.value_preview || '(empty)'}</code>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {zapNext !== null && !zapLoading && selectedObject !== null && (
                      <button
                        className="load-more"
                        onClick={() => fetchZapEntries(selectedObject, zapNext, true)}
                      >
                        Load more ZAP entries
                      </button>
                    )}
                  </div>
                )}

                {inspectorTab === 'blkptr' && blkptrs && (
                  <div className="inspector-section">
                    <div className="blkptr-list">
                      {blkptrs.blkptrs.map(bp => (
                        <div key={`${bp.index}-${bp.is_spill}`} className="blkptr-card">
                          <div className="blkptr-header">
                            <strong>
                              {bp.is_spill ? 'Spill' : `Index ${bp.index}`}
                            </strong>
                            <span className="muted">
                              {bp.is_hole ? 'hole' : `${formatAddr(bp.psize)} B`}
                            </span>
                          </div>
                          <div className="blkptr-meta">
                            <span>Level {bp.level}</span>
                            <span>Type {bp.type}</span>
                            <span>Birth {bp.birth_txg}</span>
                            <span>NDVAs {bp.ndvas}</span>
                          </div>
                          {bp.dvas.length > 0 && (
                            <ul className="dva-list">
                              {bp.dvas.map((dva, idx) => (
                                <li key={idx}>
                                  vdev {dva.vdev} · off {formatAddr(dva.offset)} · asize{' '}
                                  {formatAddr(dva.asize)}
                                  {formatMode === 'hex' && (
                                    <span className="dva-zdb"> DVA[{idx}]={formatDvaZdb(dva)}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {inspectorTab === 'raw' && (
                  <div className="inspector-section">
                    <p className="muted">Hex dump coming soon...</p>
                    <pre className="raw-preview">
                      {JSON.stringify(objectInfo, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <footer>
        <p>
          Backend: <code>GET /api/pools</code>
        </p>
        <p>OpenZFS commit: 21bbe7cb6</p>
      </footer>
    </div>
  )
}

export default App
