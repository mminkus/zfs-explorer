import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import './App.css'
import { ObjectGraph } from './components/ObjectGraph'
import { ZapMapView } from './components/ZapMapView'

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

type RawBlockResponse = {
  vdev: number
  offset: number
  size: number
  asize: number
  requested: number
  truncated: boolean
  data_hex: string
}

type DatasetTreeNode = {
  name: string
  dsl_dir_obj: number
  head_dataset_obj: number | null
  child_dir_zapobj: number | null
  children: DatasetTreeNode[]
}

type DatasetTreeResponse = {
  root: DatasetTreeNode
  depth: number
  limit: number
  truncated: boolean
  count: number
}

type FsEntry = {
  name: string
  objid: number
  type: number
  type_name: string
}

type FsDirResponse = {
  objset_id: number
  dir_obj: number
  cursor: number
  next: number | null
  count: number
  entries: FsEntry[]
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

type GraphNode = {
  objid: number
  type: number | null
  bonus_type: number | null
}

type GraphResponse = {
  nodes: GraphNode[]
  edges: SemanticEdge[]
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

type PinnedObject = {
  objid: number
  typeName?: string
}

function App() {
  const [pools, setPools] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedPool, setSelectedPool] = useState<string | null>(null)
  const [formatMode, setFormatMode] = useState<'dec' | 'hex'>('dec')
  const [typeFilter, setTypeFilter] = useState<number | null>(null)
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
  const [datasetTree, setDatasetTree] = useState<DatasetTreeResponse | null>(null)
  const [datasetExpanded, setDatasetExpanded] = useState<Record<number, boolean>>({})
  const [datasetLoading, setDatasetLoading] = useState(false)
  const [datasetError, setDatasetError] = useState<string | null>(null)
  const [fsState, setFsState] = useState<{
    datasetName: string
    dslDirObj: number
    headDatasetObj: number
    objsetId: number
    rootObj: number
    currentDir: number
    path: { name: string; objid: number }[]
  } | null>(null)
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([])
  const [fsNext, setFsNext] = useState<number | null>(null)
  const [fsLoading, setFsLoading] = useState(false)
  const [fsError, setFsError] = useState<string | null>(null)
  const [navStack, setNavStack] = useState<number[]>([])
  const [navIndex, setNavIndex] = useState(-1)
  const [inspectorTab, setInspectorTab] = useState<'summary' | 'zap' | 'blkptr' | 'raw'>('summary')
  const [rawView, setRawView] = useState<'json' | 'hex'>('json')
  const [hexDump, setHexDump] = useState<RawBlockResponse | null>(null)
  const [hexLoading, setHexLoading] = useState(false)
  const [hexError, setHexError] = useState<string | null>(null)
  const [zdbCopied, setZdbCopied] = useState(false)
  const [leftPaneTab, setLeftPaneTab] = useState<'datasets' | 'mos' | 'fs'>('datasets')
  const [pinnedByPool, setPinnedByPool] = useState<Record<string, PinnedObject[]>>({})
  const [graphSearch, setGraphSearch] = useState('')
  const [showBlkptrDetails, setShowBlkptrDetails] = useState(false)
  const [showPhysicalEdges, setShowPhysicalEdges] = useState(false)
  const [graphExtraEdges, setGraphExtraEdges] = useState<SemanticEdge[]>([])
  const [graphExtraNodes, setGraphExtraNodes] = useState<number[]>([])
  const [graphExpandedFrom, setGraphExpandedFrom] = useState<number[]>([])
  const [graphExpanding, setGraphExpanding] = useState(false)
  const [graphExpandError, setGraphExpandError] = useState<string | null>(null)
  const [centerView, setCenterView] = useState<'explore' | 'graph' | 'physical'>('explore')
  const hexRequestKey = useRef<string | null>(null)

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

  const formatHexDump = (hex: string, baseOffset: number) => {
    const bytesPerLine = 16
    const lines: string[] = []
    for (let i = 0; i < hex.length; i += bytesPerLine * 2) {
      const slice = hex.slice(i, i + bytesPerLine * 2)
      const bytes = slice.match(/.{1,2}/g) ?? []
      const hexPart = bytes.map(b => b.padEnd(2, ' ')).join(' ')
      const asciiPart = bytes
        .map(b => {
          const val = Number.parseInt(b, 16)
          if (Number.isNaN(val)) return '.'
          return val >= 32 && val <= 126 ? String.fromCharCode(val) : '.'
        })
        .join('')
      const offset = (baseOffset + i / 2).toString(16).padStart(8, '0')
      const paddedHex = hexPart.padEnd(bytesPerLine * 3 - 1, ' ')
      lines.push(`${offset}  ${paddedHex}  ${asciiPart}`)
    }
    return lines.join('\n')
  }

  const resetInspector = () => {
    setSelectedObject(null)
    setObjectInfo(null)
    setBlkptrs(null)
    setZapInfo(null)
    setZapEntries([])
    setZapNext(null)
    setZapError(null)
    setHexDump(null)
    setHexLoading(false)
    setHexError(null)
    setGraphExtraEdges([])
    setGraphExtraNodes([])
    setGraphExpandedFrom([])
    setGraphExpandError(null)
    setShowPhysicalEdges(false)
    setCenterView('explore')
  }

  const pinnedObjects = selectedPool ? pinnedByPool[selectedPool] ?? [] : []
  const isPinned =
    selectedObject !== null && pinnedObjects.some(entry => entry.objid === selectedObject)

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

  const fetchDatasetTree = async (pool: string) => {
    setDatasetLoading(true)
    setDatasetError(null)
    try {
      const params = new URLSearchParams()
      params.set('depth', '4')
      params.set('limit', '500')
      const res = await fetch(
        `${API_BASE}/api/pools/${encodeURIComponent(pool)}/datasets/tree?${params.toString()}`
      )
      if (!res.ok) {
        throw new Error(`Dataset tree HTTP ${res.status}`)
      }
      const data: DatasetTreeResponse = await res.json()
      setDatasetTree(data)
      setDatasetExpanded({ [data.root.dsl_dir_obj]: true })
    } catch (err) {
      setDatasetError((err as Error).message)
    } finally {
      setDatasetLoading(false)
    }
  }

  const toggleDatasetNode = (dirObj: number) => {
    setDatasetExpanded(prev => ({ ...prev, [dirObj]: !prev[dirObj] }))
  }

  const renderDatasetNode = (node: DatasetTreeNode, depth: number) => {
    const expanded = datasetExpanded[node.dsl_dir_obj] ?? depth === 0
    const children = node.children ?? []
    const hasChildren = children.length > 0

    return (
      <div key={`${node.dsl_dir_obj}-${node.name}`} style={{ marginLeft: depth * 12 }}>
        <div className="dsl-node">
          <button
            className="dsl-toggle"
            onClick={() => toggleDatasetNode(node.dsl_dir_obj)}
            disabled={!hasChildren}
          >
            {hasChildren ? (expanded ? '▾' : '▸') : '•'}
          </button>
          <button className="dsl-name" onClick={() => enterFsFromDataset(node)}>
            {node.name}
          </button>
          <span className="dsl-id">#{node.dsl_dir_obj}</span>
        </div>
        {expanded && hasChildren && (
          <div className="dsl-children">
            {children.map(child => renderDatasetNode(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  const handleFsPathClick = (index: number) => {
    if (!fsState) return
    const nextPath = fsState.path.slice(0, index + 1)
    const target = nextPath[nextPath.length - 1]
    fetchFsDir(fsState.objsetId, target.objid, nextPath)
  }

  const handleFsEntryClick = (entry: FsEntry) => {
    if (!fsState) return
    if (entry.type_name !== 'dir') {
      return
    }
    const nextPath = [...fsState.path, { name: entry.name, objid: entry.objid }]
    fetchFsDir(fsState.objsetId, entry.objid, nextPath)
  }

  const fetchFsDir = async (
    objsetId: number,
    dirObj: number,
    path: { name: string; objid: number }[]
  ) => {
    if (!selectedPool) return
    setFsLoading(true)
    setFsError(null)
    try {
      const params = new URLSearchParams()
      params.set('cursor', '0')
      params.set('limit', '500')
      const res = await fetch(
        `${API_BASE}/api/pools/${encodeURIComponent(
          selectedPool
        )}/objset/${objsetId}/dir/${dirObj}/entries?${params.toString()}`
      )
      if (!res.ok) {
        throw new Error(`FS entries HTTP ${res.status}`)
      }
      const data: FsDirResponse = await res.json()
      setFsEntries(data.entries ?? [])
      setFsNext(data.next ?? null)
      setFsState(prev => {
        if (!prev) {
          return null
        }
        return {
          ...prev,
          currentDir: dirObj,
          path,
        }
      })
    } catch (err) {
      setFsError((err as Error).message)
    } finally {
      setFsLoading(false)
    }
  }

  const enterFsFromDataset = async (node: DatasetTreeNode) => {
    if (!selectedPool) return
    setLeftPaneTab('fs')
    setFsLoading(true)
    setFsError(null)
    try {
      const headRes = await fetch(
        `${API_BASE}/api/pools/${encodeURIComponent(
          selectedPool
        )}/dataset/${node.dsl_dir_obj}/head`
      )
      if (!headRes.ok) {
        throw new Error(`Dataset head HTTP ${headRes.status}`)
      }
      const headData = await headRes.json()
      const objsetId = Number(headData.objset_id)
      const headDatasetObj = Number(headData.head_dataset_obj)
      if (!objsetId) {
        throw new Error('Missing objset_id from dataset head')
      }

      const rootRes = await fetch(
        `${API_BASE}/api/pools/${encodeURIComponent(
          selectedPool
        )}/objset/${objsetId}/root`
      )
      if (!rootRes.ok) {
        throw new Error(`Objset root HTTP ${rootRes.status}`)
      }
      const rootData = await rootRes.json()
      const rootObj = Number(rootData.root_obj)
      if (!rootObj) {
        throw new Error('Missing root_obj from objset root')
      }

      setFsState({
        datasetName: node.name,
        dslDirObj: node.dsl_dir_obj,
        headDatasetObj,
        objsetId,
        rootObj,
        currentDir: rootObj,
        path: [{ name: node.name, objid: rootObj }],
      })

      await fetchFsDir(objsetId, rootObj, [{ name: node.name, objid: rootObj }])
    } catch (err) {
      setFsError((err as Error).message)
    } finally {
      setFsLoading(false)
    }
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
      setDatasetTree(null)
      setDatasetExpanded({})
      setFsState(null)
      setFsEntries([])
      setFsNext(null)
      setFsLoading(false)
      setFsError(null)
      setNavStack([])
      setNavIndex(-1)
      setShowBlkptrDetails(false)
      return
    }
    resetInspector()
    setNavStack([])
    setNavIndex(-1)
    setShowBlkptrDetails(false)
    fetchMosObjects(0, false)
  }, [selectedPool, typeFilter])

  useEffect(() => {
    if (!selectedPool) {
      return
    }
    fetchDatasetTree(selectedPool)
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
    setShowBlkptrDetails(false)
    setShowPhysicalEdges(false)
    setHexDump(null)
    setHexLoading(false)
    setHexError(null)
    setGraphExtraEdges([])
    setGraphExtraNodes([])
    setGraphExpandedFrom([])
    setGraphExpandError(null)
    setCenterView('explore')
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

  const pinSelectedObject = () => {
    if (!selectedPool || selectedObject === null) return
    setPinnedByPool(prev => {
      const current = prev[selectedPool] ?? []
      if (current.some(entry => entry.objid === selectedObject)) {
        return prev
      }
      const typeName =
        objectInfo?.type?.name ?? mosObjectMap.get(selectedObject)?.type_name ?? undefined
      const updated = [{ objid: selectedObject, typeName }, ...current]
      return { ...prev, [selectedPool]: updated }
    })
  }

  const unpinObject = (objid: number) => {
    if (!selectedPool) return
    setPinnedByPool(prev => {
      const current = prev[selectedPool] ?? []
      return { ...prev, [selectedPool]: current.filter(entry => entry.objid !== objid) }
    })
  }

  const handleGraphSearch = () => {
    const trimmed = graphSearch.trim()
    if (!trimmed) return
    const objid = Number.parseInt(trimmed, 0)
    if (Number.isNaN(objid)) return
    navigateTo(objid)
    setGraphSearch('')
  }

  const semanticEdges = objectInfo?.semantic_edges ?? []

  const baseNeighborIds = useMemo(() => {
    const ids = new Set<number>()
    semanticEdges.forEach(edge => {
      if (edge.target_obj !== undefined) ids.add(edge.target_obj)
    })
    zapEntries.forEach(entry => {
      if (entry.maybe_object_ref && entry.target_obj !== null) {
        ids.add(entry.target_obj)
      }
    })
    return Array.from(ids)
  }, [semanticEdges, zapEntries])

  const effectiveCenterView = useMemo(() => {
    if (centerView === 'explore') {
      return objectInfo?.is_zap ? 'map' : 'graph'
    }
    return centerView
  }, [centerView, objectInfo?.is_zap])

  const showSemanticEdges = effectiveCenterView !== 'physical'
  const showZapEdges = effectiveCenterView !== 'physical'
  const showPhysicalEdgesActive =
    effectiveCenterView === 'physical' ? true : showPhysicalEdges

  const firstDataDva = useMemo(() => {
    const list = blkptrs?.blkptrs ?? []
    for (const bp of list) {
      if (!bp.is_hole && bp.dvas.length > 0) {
        return { bpIndex: bp.index, dvaIndex: 0, dva: bp.dvas[0] }
      }
    }
    return null
  }, [blkptrs])

  const formattedHexDump = useMemo(() => {
    if (!hexDump) return ''
    return formatHexDump(hexDump.data_hex, hexDump.offset)
  }, [hexDump])

  useEffect(() => {
    if (!selectedPool || selectedObject === null || rawView !== 'hex') {
      return
    }

    if (!firstDataDva) {
      setHexError('No readable DVA found for this object.')
      return
    }

    const { dva } = firstDataDva
    const limit = 64 * 1024
    const key = `${selectedPool}:${selectedObject}:${dva.vdev}:${dva.offset}:${dva.asize}:${limit}`
    if (hexRequestKey.current === key) {
      return
    }

    hexRequestKey.current = key
    setHexLoading(true)
    setHexError(null)

    const params = new URLSearchParams()
    params.set('vdev', String(dva.vdev))
    params.set('offset', String(dva.offset))
    params.set('asize', String(dva.asize))
    params.set('limit', String(limit))

    fetch(`${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/block?${params}`)
      .then(res => {
        if (!res.ok) {
          throw new Error(`Raw block HTTP ${res.status}`)
        }
        return res.json()
      })
      .then((data: RawBlockResponse) => {
        setHexDump(data)
      })
      .catch(err => {
        setHexError((err as Error).message)
      })
      .finally(() => {
        setHexLoading(false)
      })
  }, [selectedPool, selectedObject, rawView, firstDataDva])

  useEffect(() => {
    if (!showPhysicalEdgesActive) {
      setShowBlkptrDetails(false)
    }
  }, [showPhysicalEdgesActive])

  const expandGraph = async () => {
    if (!selectedPool || selectedObject === null || graphExpanding) return

    const knownNodes = new Set<number>([selectedObject, ...baseNeighborIds, ...graphExtraNodes])
    graphExtraEdges.forEach(edge => {
      knownNodes.add(edge.source_obj)
      knownNodes.add(edge.target_obj)
    })

    const alreadyExpanded = new Set(graphExpandedFrom)
    const frontier = Array.from(knownNodes)
      .filter(objid => objid !== selectedObject && !alreadyExpanded.has(objid))
      .slice(0, 8)

    if (frontier.length === 0) {
      setGraphExpandError('No additional nodes to expand yet.')
      return
    }

    setGraphExpanding(true)
    setGraphExpandError(null)

    try {
      const results = await Promise.all(
        frontier.map(async objid => {
          const res = await fetch(
            `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/graph/from/${objid}?include=semantic,zap`
          )
          if (!res.ok) {
            throw new Error(`Graph expand HTTP ${res.status}`)
          }
          return (await res.json()) as GraphResponse
        })
      )

      const newNodes = new Set<number>(graphExtraNodes)
      const newEdges = new Map<string, SemanticEdge>()

      graphExtraEdges.forEach(edge => {
        const key = `${edge.kind}:${edge.source_obj}:${edge.target_obj}:${edge.label}`
        newEdges.set(key, edge)
      })

      results.forEach(result => {
        result.nodes?.forEach(node => {
          if (node.objid !== selectedObject) {
            newNodes.add(node.objid)
          }
        })
        result.edges?.forEach(edge => {
          const key = `${edge.kind}:${edge.source_obj}:${edge.target_obj}:${edge.label}`
          newEdges.set(key, edge)
        })
      })

      setGraphExtraNodes(Array.from(newNodes))
      setGraphExtraEdges(Array.from(newEdges.values()))
      setGraphExpandedFrom(prev => Array.from(new Set([...prev, ...frontier])))
    } catch (err) {
      setGraphExpandError((err as Error).message)
    } finally {
      setGraphExpanding(false)
    }
  }

  const resetGraphExpansion = () => {
    setGraphExtraEdges([])
    setGraphExtraNodes([])
    setGraphExpandedFrom([])
    setGraphExpandError(null)
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

  const renderPinnedSection = () => {
    if (!selectedPool) return null
    return (
      <div className="pinned-section">
        <h3>Pinned Objects</h3>
        {pinnedObjects.length === 0 && <p className="muted">No pinned objects yet.</p>}
        {pinnedObjects.length > 0 && (
          <ul className="pinned-list">
            {pinnedObjects.map(entry => (
              <li key={entry.objid} className="pinned-item">
                <button className="pinned-link" onClick={() => navigateTo(entry.objid)}>
                  Object {entry.objid}
                </button>
                {entry.typeName && <span className="pinned-hint">({entry.typeName})</span>}
                <button
                  className="pinned-remove"
                  onClick={() => unpinObject(entry.objid)}
                  title="Remove pin"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <strong>ZFS Explorer</strong>
          <p className="subtitle">Milestone 6: Filesystem Navigation</p>
        </div>
        <div className="status">
          <div className="status-item">
            <span>Format</span>
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
            title={`Pool ${selectedPool}`}
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
          title="MOS object list"
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
              title={`Object ${objid}${mosObjectMap.get(objid)?.type_name ? ` · ${mosObjectMap.get(objid)?.type_name}` : ''}`}
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
          <div className="panel-header">
            <h2>Navigator</h2>
          </div>

          <div className="left-pane-tabs">
            <button
              className={`tab ${leftPaneTab === 'datasets' ? 'active' : ''}`}
              onClick={() => setLeftPaneTab('datasets')}
            >
              Datasets
            </button>
            <button
              className={`tab ${leftPaneTab === 'fs' ? 'active' : ''}`}
              onClick={() => setLeftPaneTab('fs')}
            >
              FS
            </button>
            <button
              className={`tab ${leftPaneTab === 'mos' ? 'active' : ''}`}
              onClick={() => setLeftPaneTab('mos')}
            >
              MOS
            </button>
          </div>

          {leftPaneTab === 'datasets' && (
            <div className="left-pane-content">
              {renderPinnedSection()}
              <div className="pool-selector">
                <label>Pool</label>
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
                  <select
                    value={selectedPool ?? ''}
                    onChange={e => setSelectedPool(e.target.value)}
                    className="pool-select"
                  >
                    {pools.map(pool => (
                      <option key={pool} value={pool}>
                        {pool}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {selectedPool && (
                <div className="dataset-tree">
                  <h3>Dataset Tree</h3>
                  {datasetLoading && <p className="muted">Loading dataset tree...</p>}
                  {datasetError && <p className="muted">Error: {datasetError}</p>}
                  {datasetTree && renderDatasetNode(datasetTree.root, 0)}
                  {datasetTree?.truncated && (
                    <p className="muted">
                      Tree truncated at {datasetTree.count} nodes (limit {datasetTree.limit}).
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {leftPaneTab === 'fs' && (
            <div className="left-pane-content">
              {renderPinnedSection()}
              <div className="pool-selector">
                <label>Pool</label>
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
                  <select
                    value={selectedPool ?? ''}
                    onChange={e => setSelectedPool(e.target.value)}
                    className="pool-select"
                  >
                    {pools.map(pool => (
                      <option key={pool} value={pool}>
                        {pool}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="fs-panel">
                <h3>Filesystem Navigator</h3>
                {!fsState && (
                  <p className="muted">
                    Select a dataset from the Datasets tab to start browsing.
                  </p>
                )}
                {fsState && (
                  <>
                    <div className="fs-path">
                      {fsState.path.map((seg, idx) => (
                        <button
                          key={`${seg.objid}-${idx}`}
                          className={`fs-path-seg ${idx === fsState.path.length - 1 ? 'active' : ''}`}
                          onClick={() => handleFsPathClick(idx)}
                        >
                          {seg.name}
                        </button>
                      ))}
                    </div>

                    <div className="fs-meta">
                      <span>objset {fsState.objsetId}</span>
                      <span>dir {fsState.currentDir}</span>
                    </div>

                    {fsLoading && <p className="muted">Loading directory…</p>}
                    {fsError && <p className="muted">Error: {fsError}</p>}

                    {!fsLoading && !fsError && (
                      <div className="fs-table">
                        <div className="fs-row fs-header">
                          <div>Name</div>
                          <div>Type</div>
                          <div>Object</div>
                        </div>
                        {fsEntries.map(entry => (
                          <div
                            key={`${entry.name}-${entry.objid}`}
                            className={`fs-row ${entry.type_name === 'dir' ? 'clickable' : ''}`}
                            onClick={() => handleFsEntryClick(entry)}
                          >
                            <div className="fs-name">{entry.name}</div>
                            <div className="fs-type">{entry.type_name}</div>
                            <div className="fs-obj">#{entry.objid}</div>
                          </div>
                        ))}
                        {fsEntries.length === 0 && (
                          <div className="fs-empty">No entries found.</div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {leftPaneTab === 'mos' && (
            <div className="left-pane-content">
              {renderPinnedSection()}
              <div className="pool-selector">
                <label>Pool</label>
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
                  <select
                    value={selectedPool ?? ''}
                    onChange={e => setSelectedPool(e.target.value)}
                    className="pool-select"
                  >
                    {pools.map(pool => (
                      <option key={pool} value={pool}>
                        {pool}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {selectedPool && (
                <>
                  <div className="type-filter-section">
                    <label>Type filter</label>
                    {typesError && <p className="muted">Error: {typesError}</p>}
                    {!typesError && (
                      <select
                        value={typeFilter === null ? '' : String(typeFilter)}
                        onChange={e => {
                          const val = e.target.value
                          setTypeFilter(val === '' ? null : Number(val))
                        }}
                        className="pool-select"
                      >
                        <option value="">All types</option>
                        {typeOptions.map(option => (
                          <option key={option.id} value={option.id}>
                            {option.name} ({option.id})
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="mos-objects-section">
                    <h3>MOS Objects</h3>
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
                  </div>
                </>
              )}
            </div>
          )}
        </aside>

        <section className="panel pane-center">
          <div className="panel-header graph-header">
            <div>
              <h2>Object Graph</h2>
              <span className="muted">1-hop neighborhood</span>
            </div>
            <div className="graph-controls">
              <div className="graph-view-toggle">
                <button
                  className={`graph-btn ${centerView === 'explore' ? 'active' : ''}`}
                  type="button"
                  onClick={() => setCenterView('explore')}
                >
                  Explore
                </button>
                <button
                  className={`graph-btn ${centerView === 'graph' ? 'active' : ''}`}
                  type="button"
                  onClick={() => setCenterView('graph')}
                >
                  Graph
                </button>
                <button
                  className={`graph-btn ${centerView === 'physical' ? 'active' : ''}`}
                  type="button"
                  onClick={() => setCenterView('physical')}
                >
                  Physical
                </button>
              </div>
              <input
                className="graph-search"
                placeholder="Go to object ID"
                value={graphSearch}
                onChange={e => setGraphSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    handleGraphSearch()
                  }
                }}
              />
              <button className="graph-btn" type="button" onClick={handleGraphSearch}>
                Go
              </button>
              {effectiveCenterView !== 'map' && (
                <>
                  {effectiveCenterView !== 'physical' && (
                    <button
                      className="graph-btn"
                      type="button"
                      onClick={expandGraph}
                      disabled={graphExpanding || selectedObject === null}
                    >
                      {graphExpanding ? 'Expanding…' : 'Expand +1 hop'}
                    </button>
                  )}
                  {effectiveCenterView !== 'physical' && (
                    <button
                      className={`graph-btn ${showPhysicalEdges ? 'active' : ''}`}
                      type="button"
                      onClick={() => setShowPhysicalEdges(prev => !prev)}
                    >
                      Physical edges
                    </button>
                  )}
                  <button
                    className={`graph-btn ${showBlkptrDetails ? 'active' : ''}`}
                    type="button"
                    onClick={() => setShowBlkptrDetails(prev => !prev)}
                    disabled={!showPhysicalEdgesActive}
                  >
                    {showBlkptrDetails ? 'Collapse blkptrs' : 'Expand blkptrs'}
                  </button>
                  {(graphExtraEdges.length > 0 || graphExtraNodes.length > 0) && (
                    <button className="graph-btn" type="button" onClick={resetGraphExpansion}>
                      Reset
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="graph">
            {effectiveCenterView === 'map' ? (
              <ZapMapView
                entries={zapEntries}
                mosObjectMap={mosObjectMap}
                onNavigate={navigateTo}
              />
            ) : (
              <ObjectGraph
                selectedObject={selectedObject}
                objectTypeName={objectInfo?.type?.name ?? ''}
                semanticEdges={semanticEdges}
                zapEntries={zapEntries}
                blkptrs={blkptrs?.blkptrs ?? []}
                extraEdges={graphExtraEdges}
                extraNodes={graphExtraNodes}
                showSemantic={showSemanticEdges}
                showZap={showZapEdges}
                showPhysical={showPhysicalEdgesActive}
                showBlkptrDetails={showBlkptrDetails}
                onNavigate={navigateTo}
              />
            )}
            {graphExpandError && <div className="graph-error">{graphExpandError}</div>}
          </div>
        </section>

        <section className="panel pane-right">
          <div className="panel-header">
            <h2>Inspector</h2>
            <div className="panel-actions">
              {inspectorLoading && <span className="muted">Loading…</span>}
              {selectedObject !== null && (
                <button
                  type="button"
                  className={`pin-btn ${isPinned ? 'active' : ''}`}
                  onClick={pinSelectedObject}
                  disabled={isPinned}
                >
                  {isPinned ? 'Pinned' : 'Pin'}
                </button>
              )}
            </div>
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
                  <div className="inspector-section raw-section">
                    <div className="raw-tabs">
                      <button
                        className={`tab ${rawView === 'json' ? 'active' : ''}`}
                        onClick={() => setRawView('json')}
                      >
                        JSON
                      </button>
                      <button
                        className={`tab ${rawView === 'hex' ? 'active' : ''}`}
                        onClick={() => setRawView('hex')}
                      >
                        Hex
                      </button>
                    </div>
                    <div className="raw-panel">
                      {rawView === 'json' && (
                        <pre className="raw-preview">
                          {JSON.stringify(objectInfo, null, 2)}
                        </pre>
                      )}
                    {rawView === 'hex' && (
                      <div className="raw-preview raw-hex-container">
                          {hexLoading && <p className="muted">Loading hex dump…</p>}
                          {hexError && (
                            <p className="muted">
                              Error: {hexError}
                            </p>
                          )}
                          {!hexLoading && !hexError && hexDump && (
                            <div className="raw-hex">
                              <div className="raw-hex-meta">
                                {firstDataDva && (
                                  <span>
                                    blkptr {firstDataDva.bpIndex} · DVA {firstDataDva.dvaIndex}
                                  </span>
                                )}
                                <span>vdev {hexDump.vdev}</span>
                                <span>off {formatAddr(hexDump.offset)}</span>
                                <span>
                                  read {formatAddr(hexDump.size)} / {formatAddr(hexDump.asize)} B
                                </span>
                                {hexDump.truncated && <span>truncated</span>}
                              </div>
                              <pre className="raw-hex-dump">{formattedHexDump}</pre>
                            </div>
                          )}
                          {!hexLoading && !hexError && !hexDump && (
                            <p className="muted">No hex data available.</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <footer>
        <p>v0.01, OpenZFS commit: 21bbe7cb6</p>
      </footer>
    </div>
  )
}

export default App
