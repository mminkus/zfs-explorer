import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import './App.css'
import { ObjectGraph } from './components/ObjectGraph'
import { ZapMapView } from './components/ZapMapView'
import { FsGraph } from './components/FsGraph'
import type {
  BrowserNavState,
  FsLocation,
  FsPathSegment,
  NavigatorMode,
} from './types/navigation'

const API_BASE = 'http://localhost:9000'
const MOS_PAGE_LIMIT = 200

type ApiErrorPayload = {
  error?: string
}

const parseApiErrorMessage = async (response: Response): Promise<string | null> => {
  const fallback = response.statusText || 'Request failed'
  try {
    const text = await response.text()
    if (!text.trim()) {
      return fallback
    }
    try {
      const parsed = JSON.parse(text) as ApiErrorPayload
      if (typeof parsed?.error === 'string' && parsed.error.trim()) {
        return parsed.error
      }
    } catch {
      // Not JSON; fall through to raw text.
    }
    return text.trim()
  } catch {
    return fallback
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    const message = await parseApiErrorMessage(response)
    throw new Error(`HTTP ${response.status}: ${message ?? response.statusText}`)
  }
  return (await response.json()) as T
}

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

type DatasetCatalogEntry = {
  name: string
  type: string
  mountpoint: string | null
  mounted: boolean | null
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

type FsStat = {
  objset_id: number
  objid: number
  mode: number
  type: number
  type_name: string
  uid: number
  gid: number
  size: number
  links: number
  parent: number
  flags: number
  gen: number
  partial: boolean
  atime: { sec: number; nsec: number }
  mtime: { sec: number; nsec: number }
  ctime: { sec: number; nsec: number }
  crtime: { sec: number; nsec: number }
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
  deadlist_obj: number
  next_clones_obj: number
  props_obj: number
  userrefs_obj: number
  num_children: number
  creation_time: number
  creation_txg: number
  referenced_bytes: number
  compressed_bytes: number
  uncompressed_bytes: number
  unique_bytes: number
  fsid_guid: number
  guid: number
  flags: number
}

type BonusDecoded = BonusDecodedDslDir | BonusDecodedDslDataset | { kind: string }

type PinnedObject = {
  objid: number
  typeName?: string
}

const isSameFsLocation = (a: FsLocation, b: FsLocation) => {
  if (a.objsetId !== b.objsetId) return false
  if (a.currentDir !== b.currentDir) return false
  if (a.path.length !== b.path.length) return false
  return a.path.every((seg, idx) => {
    const other = b.path[idx]
    return seg.objid === other.objid && seg.name === other.name
  })
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
  const [zapMapFilter, setZapMapFilter] = useState('')
  const [datasetTree, setDatasetTree] = useState<DatasetTreeResponse | null>(null)
  const [datasetCatalog, setDatasetCatalog] = useState<Record<string, DatasetCatalogEntry>>({})
  const [datasetExpanded, setDatasetExpanded] = useState<Record<number, boolean>>({})
  const [datasetLoading, setDatasetLoading] = useState(false)
  const [datasetError, setDatasetError] = useState<string | null>(null)
  const [fsState, setFsState] = useState<FsLocation | null>(null)
  const [fsHistory, setFsHistory] = useState<FsLocation[]>([])
  const [fsHistoryIndex, setFsHistoryIndex] = useState(-1)
  const [fsEntries, setFsEntries] = useState<FsEntry[]>([])
  const [fsLoading, setFsLoading] = useState(false)
  const [fsError, setFsError] = useState<string | null>(null)
  const [fsPathInput, setFsPathInput] = useState('')
  const [fsPathView, setFsPathView] = useState<'zpl' | 'mount'>('zpl')
  const [fsPathError, setFsPathError] = useState<string | null>(null)
  const [fsPathLoading, setFsPathLoading] = useState(false)
  const [fsSelected, setFsSelected] = useState<{
    name: string
    objid: number
    type_name: string
  } | null>(null)
  const [fsStat, setFsStat] = useState<FsStat | null>(null)
  const [fsStatLoading, setFsStatLoading] = useState(false)
  const [fsStatError, setFsStatError] = useState<string | null>(null)
  const [fsEntryStats, setFsEntryStats] = useState<Record<number, FsStat>>({})
  const [fsEntryStatsLoading, setFsEntryStatsLoading] = useState(false)
  const [fsEntryStatsError, setFsEntryStatsError] = useState<string | null>(null)
  const [fsCenterView, setFsCenterView] = useState<'list' | 'graph'>('list')
  const [fsSearch, setFsSearch] = useState('')
  const [fsSort, setFsSort] = useState<{
    key: 'name' | 'type' | 'size' | 'mtime'
    dir: 'asc' | 'desc'
  }>({ key: 'name', dir: 'asc' })
  const [navStack, setNavStack] = useState<number[]>([])
  const [navIndex, setNavIndex] = useState(-1)
  const [inspectorTab, setInspectorTab] = useState<'summary' | 'zap' | 'blkptr' | 'raw'>('summary')
  const [rawView, setRawView] = useState<'json' | 'hex'>('json')
  const [hexDump, setHexDump] = useState<RawBlockResponse | null>(null)
  const [hexLoading, setHexLoading] = useState(false)
  const [hexError, setHexError] = useState<string | null>(null)
  const [zdbCopied, setZdbCopied] = useState(false)
  const [leftPaneTab, setLeftPaneTab] = useState<NavigatorMode>('datasets')
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
  const [isNarrow, setIsNarrow] = useState(false)
  const hexRequestKey = useRef<string | null>(null)
  const fsStatKey = useRef<string | null>(null)
  const fsFilterRef = useRef<HTMLInputElement | null>(null)
  const fsAutoMetaKey = useRef<string | null>(null)
  const suppressBrowserHistory = useRef(false)
  const historyInitialized = useRef(false)
  const initialHistoryApplied = useRef(false)
  const pendingBrowserState = useRef<BrowserNavState | null>(null)
  const lastBrowserState = useRef<string | null>(null)
  const skipNextHistoryPush = useRef(false)

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

  const mosTypeMap = useMemo(() => {
    const map = new Map<number, string>()
    mosObjects.forEach(obj => map.set(obj.id, obj.type_name))
    return map
  }, [mosObjects])

  const datasetIndex = useMemo(() => {
    const nodeById = new Map<number, DatasetTreeNode>()
    const fullNameById = new Map<number, string>()
    const childZapToNode = new Map<number, DatasetTreeNode>()
    if (!datasetTree) {
      return { nodeById, fullNameById, childZapToNode }
    }

    const walk = (node: DatasetTreeNode, prefix: string) => {
      const fullName = prefix ? `${prefix}/${node.name}` : node.name
      nodeById.set(node.dsl_dir_obj, node)
      fullNameById.set(node.dsl_dir_obj, fullName)
      if (node.child_dir_zapobj) {
        childZapToNode.set(node.child_dir_zapobj, node)
      }
      node.children?.forEach(child => walk(child, fullName))
    }

    walk(datasetTree.root, '')
    return { nodeById, fullNameById, childZapToNode }
  }, [datasetTree])

  const datasetForMos = useMemo(() => {
    if (selectedObject === null) return null
    return (
      datasetIndex.nodeById.get(selectedObject) ??
      datasetIndex.childZapToNode.get(selectedObject) ??
      null
    )
  }, [datasetIndex, selectedObject])

  const dslDatasetBonus = useMemo(() => {
    const bonus = objectInfo?.bonus_decoded
    if (!bonus || !('kind' in bonus) || bonus.kind !== 'dsl_dataset') {
      return null
    }
    return bonus as BonusDecodedDslDataset
  }, [objectInfo?.bonus_decoded])

  const dslDatasetNode = useMemo(() => {
    if (!dslDatasetBonus) return null
    return datasetIndex.nodeById.get(dslDatasetBonus.dir_obj) ?? null
  }, [datasetIndex.nodeById, dslDatasetBonus])

  const filteredFsEntries = useMemo(() => {
    const term = fsSearch.trim().toLowerCase()
    if (!term) return fsEntries
    return fsEntries.filter(entry => {
      if (entry.name.toLowerCase().includes(term)) return true
      return entry.objid.toString().includes(term)
    })
  }, [fsEntries, fsSearch])

  const sortedFsEntries = useMemo(() => {
    const entries = [...filteredFsEntries]
    const dir = fsSort.dir === 'asc' ? 1 : -1
    entries.sort((a, b) => {
      switch (fsSort.key) {
        case 'type': {
          const cmp = a.type_name.localeCompare(b.type_name)
          if (cmp !== 0) return cmp * dir
          return a.name.localeCompare(b.name) * dir
        }
        case 'size': {
          const sizeA = fsEntryStats[a.objid]?.size
          const sizeB = fsEntryStats[b.objid]?.size
          if (sizeA === undefined && sizeB === undefined) {
            return a.name.localeCompare(b.name) * dir
          }
          if (sizeA === undefined) return 1
          if (sizeB === undefined) return -1
          if (sizeA === sizeB) return a.name.localeCompare(b.name) * dir
          return (sizeA - sizeB) * dir
        }
        case 'mtime': {
          const mA = fsEntryStats[a.objid]?.mtime?.sec
          const mB = fsEntryStats[b.objid]?.mtime?.sec
          if (mA === undefined && mB === undefined) {
            return a.name.localeCompare(b.name) * dir
          }
          if (mA === undefined) return 1
          if (mB === undefined) return -1
          if (mA === mB) return a.name.localeCompare(b.name) * dir
          return (mA - mB) * dir
        }
        case 'name':
        default:
          return a.name.localeCompare(b.name) * dir
      }
    })
    return entries
  }, [filteredFsEntries, fsSort, fsEntryStats])

  const fsDisplayPath = useMemo(() => {
    if (!fsState) return '/'

    const relative = fsPathInput
      ? fsPathInput.startsWith('/')
        ? fsPathInput
        : `/${fsPathInput}`
      : '/'

    if (fsPathView === 'mount' && fsState.mountpoint) {
      const base =
        fsState.mountpoint.endsWith('/') && relative !== '/'
          ? fsState.mountpoint.slice(0, -1)
          : fsState.mountpoint
      return relative === '/' ? base : `${base}${relative}`
    }

    return relative === '/' ? fsState.datasetName : `${fsState.datasetName}${relative}`
  }, [fsState, fsPathInput, fsPathView])

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

  const formatTimestamp = (ts?: { sec: number; nsec: number }) => {
    if (!ts) return '—'
    const date = new Date(ts.sec * 1000)
    const ns = ts.nsec.toString().padStart(9, '0')
    return `${date.toLocaleString()} (${ts.sec}.${ns})`
  }

  const formatModeOctal = (mode: number) => `0${mode.toString(8)}`

  const formatBytes = (value: number) => {
    if (!Number.isFinite(value)) return '—'
    if (value < 1024) return `${value} B`
    const units = ['KiB', 'MiB', 'GiB', 'TiB']
    let size = value
    let unitIndex = -1
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024
      unitIndex += 1
    }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`
  }

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1200px)')
    const update = () => setIsNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  const toggleFsSort = (key: 'name' | 'type' | 'size' | 'mtime') => {
    setFsSort(prev => {
      if (prev.key === key) {
        return { ...prev, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      }
      return { key, dir: 'asc' }
    })
  }

  const updateFsHistory = useCallback(
    (
      next: FsLocation,
      opts?: {
        reset?: boolean
        replace?: boolean
        navAction?: 'back' | 'forward'
      }
    ) => {
      if (opts?.navAction === 'back' || opts?.navAction === 'forward') {
        return
      }
      if (opts?.reset) {
        setFsHistory([next])
        setFsHistoryIndex(0)
        return
      }
      if (opts?.replace) {
        setFsHistory(prev => {
          if (prev.length === 0) return [next]
          const idx = fsHistoryIndex >= 0 ? fsHistoryIndex : prev.length - 1
          const updated = [...prev]
          updated[idx] = next
          return updated
        })
        return
      }

      setFsHistory(prev => {
        const base = fsHistoryIndex >= 0 ? prev.slice(0, fsHistoryIndex + 1) : prev
        const last = base[base.length - 1]
        if (last && isSameFsLocation(last, next)) {
          return base
        }
        return [...base, next]
      })
      setFsHistoryIndex(prev => (prev >= 0 ? prev + 1 : 0))
    },
    [fsHistoryIndex]
  )

  const applyBrowserState = useCallback(
    (state: BrowserNavState) => {
      const pool = state.pool ?? null
      if ((selectedPool ?? null) !== pool) {
        pendingBrowserState.current = state
        setSelectedPool(pool)
        return
      }

      if (state.mode === 'datasets') {
        setLeftPaneTab('datasets')
        return
      }

      if (state.mode === 'mos') {
        setLeftPaneTab('mos')
        if (state.objid) {
          setNavStack([state.objid])
          setNavIndex(0)
          setSelectedObject(state.objid)
          fetchInspector(state.objid)
        } else {
          setSelectedObject(null)
          resetInspector()
        }
        return
      }

      if (state.mode === 'fs') {
        setLeftPaneTab('fs')
        if (state.fs) {
          setFsHistory([state.fs])
          setFsHistoryIndex(0)
          setFsState(state.fs)
          fetchFsDir(state.fs.objsetId, state.fs.currentDir, state.fs.path, {
            baseState: state.fs,
            history: 'none',
            browser: 'none',
          })
        } else {
          setFsHistory([])
          setFsHistoryIndex(-1)
          setFsState(null)
          setFsEntries([])
          setFsSelected(null)
          setFsStat(null)
        }
      }
    },
    [selectedPool, fetchInspector, fetchFsDir]
  )

  const pinnedObjects = selectedPool ? pinnedByPool[selectedPool] ?? [] : []
  const isPinned =
    selectedObject !== null && pinnedObjects.some(entry => entry.objid === selectedObject)

  const navigateTo = useCallback(
    (
      objid: number,
      opts?: {
        reset?: boolean
        replace?: boolean
        navAction?: 'back' | 'forward' | 'jump'
        jumpIndex?: number
      }
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
        commitBrowserState(
          { mode: 'mos', pool: selectedPool ?? null, objid },
          'replace'
        )
        return
      }

      if (opts?.replace) {
        setNavStack(prev => {
          if (prev.length === 0) return [objid]
          const newStack = [...prev.slice(0, navIndex), objid]
          return newStack
        })
        // Index stays the same
        commitBrowserState(
          { mode: 'mos', pool: selectedPool ?? null, objid },
          'replace'
        )
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
      commitBrowserState({ mode: 'mos', pool: selectedPool ?? null, objid })
    },
    [navIndex, selectedPool, commitBrowserState]
  )

  const isMosMode = leftPaneTab === 'mos'
  const isFsTab = leftPaneTab === 'fs'
  const isDatasetsTab = leftPaneTab === 'datasets'
  const isFsMode = leftPaneTab !== 'mos'
  const canGoBack =
    (isMosMode && navIndex > 0) || (isFsTab && fsHistoryIndex > 0)
  const canGoForward =
    (isMosMode && navIndex < navStack.length - 1) ||
    (isFsTab && fsHistoryIndex >= 0 && fsHistoryIndex < fsHistory.length - 1)

  useEffect(() => {
    fetchJson<string[]>(`${API_BASE}/api/pools`)
      .then(data => {
        setPools(data)
        setLoading(false)
      })
      .catch(err => {
        setError((err as Error).message)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    if (initialHistoryApplied.current) return
    const existing = history.state as BrowserNavState | null
    if (!existing) {
      initialHistoryApplied.current = true
      return
    }
    suppressBrowserHistory.current = true
    skipNextHistoryPush.current = true
    applyBrowserState(existing)
    lastBrowserState.current = JSON.stringify(existing)
    historyInitialized.current = true
    requestAnimationFrame(() => {
      suppressBrowserHistory.current = false
    })
    initialHistoryApplied.current = true
  }, [applyBrowserState])

  useEffect(() => {
    if (!pendingBrowserState.current) return
    const pending = pendingBrowserState.current
    if ((pending.pool ?? null) !== (selectedPool ?? null)) return
    pendingBrowserState.current = null
    applyBrowserState(pending)
  }, [selectedPool, applyBrowserState])

  useEffect(() => {
    const handler = (event: PopStateEvent) => {
      const state = event.state as BrowserNavState | null
      if (!state) return
      suppressBrowserHistory.current = true
      skipNextHistoryPush.current = true
      applyBrowserState(state)
      lastBrowserState.current = JSON.stringify(state)
      requestAnimationFrame(() => {
        suppressBrowserHistory.current = false
      })
    }

    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [applyBrowserState])

  function commitBrowserState(state: BrowserNavState, mode: 'push' | 'replace' = 'push') {
    if (suppressBrowserHistory.current) return
    if (skipNextHistoryPush.current) {
      skipNextHistoryPush.current = false
      return
    }
    const serialized = JSON.stringify(state)
    if (lastBrowserState.current === serialized) return
    lastBrowserState.current = serialized

    if (!historyInitialized.current || mode === 'replace') {
      history.replaceState(state, '', window.location.href)
      historyInitialized.current = true
      return
    }

    history.pushState(state, '', window.location.href)
  }

  useEffect(() => {
    fetchJson<DmuType[]>(`${API_BASE}/api/mos/types`)
      .then(data => {
        setDmuTypes(data)
      })
      .catch(err => {
        setTypesError((err as Error).message)
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
      const data = await fetchJson<DatasetTreeResponse>(
        `${API_BASE}/api/pools/${encodeURIComponent(pool)}/datasets/tree?${params.toString()}`
      )
      setDatasetTree(data)
      setDatasetExpanded({ [data.root.dsl_dir_obj]: true })
    } catch (err) {
      setDatasetError((err as Error).message)
    } finally {
      setDatasetLoading(false)
    }
  }

  const fetchDatasetCatalog = async (pool: string) => {
    try {
      const data = await fetchJson<DatasetCatalogEntry[]>(
        `${API_BASE}/api/pools/${encodeURIComponent(pool)}/datasets`
      )
      const next: Record<string, DatasetCatalogEntry> = {}
      data.forEach(entry => {
        next[entry.name] = entry
      })
      setDatasetCatalog(next)
    } catch (err) {
      console.warn('Failed to fetch dataset catalog:', err)
      setDatasetCatalog({})
    }
  }

  const toggleDatasetNode = (dirObj: number) => {
    setDatasetExpanded(prev => ({ ...prev, [dirObj]: !prev[dirObj] }))
  }

  const handlePoolSelect = (pool: string) => {
    if (!pool) return
    setSelectedPool(pool)
    setLeftPaneTab('datasets')
    setNavStack([])
    setNavIndex(-1)
    setFsHistory([])
    setFsHistoryIndex(-1)
    commitBrowserState({ mode: 'datasets', pool })
  }

  const setLeftPaneTabWithHistory = (mode: NavigatorMode) => {
    setLeftPaneTab(mode)
    if (mode === 'mos') {
      commitBrowserState({ mode: 'mos', pool: selectedPool ?? null, objid: selectedObject })
      return
    }
    if (mode === 'fs') {
      commitBrowserState({ mode: 'fs', pool: selectedPool ?? null, fs: fsState ?? null })
      return
    }
    commitBrowserState({ mode: 'datasets', pool: selectedPool ?? null })
  }

  const renderDatasetNode = (node: DatasetTreeNode, depth: number) => {
    const expanded = datasetExpanded[node.dsl_dir_obj] ?? depth === 0
    const children = node.children ?? []
    const hasChildren = children.length > 0
    const fullName =
      datasetIndex.fullNameById.get(node.dsl_dir_obj) ?? node.name
    const catalog = datasetCatalog[fullName]
    const mountHint = catalog?.mountpoint ? ` · ${catalog.mountpoint}` : ''

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
          <button
            className="dsl-name"
            onClick={() => enterFsFromDataset(node)}
            title={`Dataset ${fullName} (#${node.dsl_dir_obj})${mountHint}`}
          >
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
    if (entry.type_name === 'dir') {
      const currentNode = datasetIndex.nodeById.get(fsState.dslDirObj)
      const childDataset = currentNode?.children?.find(child => child.name === entry.name)
      if (childDataset) {
        enterFsFromDataset(childDataset)
        return
      }
    }
    if (entry.type_name !== 'dir') {
      setFsSelected(entry)
      fetchFsStat(fsState.objsetId, entry.objid)
      return
    }
    const nextPath = [
      ...fsState.path,
      { name: entry.name, objid: entry.objid, kind: entry.type_name },
    ]
    fetchFsDir(fsState.objsetId, entry.objid, nextPath)
  }

  const resolveFsPathSegments = async (objsetId: number, resolvedPath: string) => {
    if (!selectedPool || !fsState) return []
    const parts = resolvedPath.split('/').filter(Boolean)
    const segments = [{ name: fsState.datasetName, objid: fsState.rootObj, kind: 'dir' }]
    if (parts.length === 0) {
      return segments
    }
    let currentPath = ''
    for (const part of parts) {
      currentPath += `/${part}`
      try {
        const data = await fetchJson<{
          found?: boolean
          objid?: number
          type_name?: string
        }>(
          `${API_BASE}/api/pools/${encodeURIComponent(
            selectedPool
          )}/objset/${objsetId}/walk?path=${encodeURIComponent(currentPath)}`
        )
        if (!data.found) {
          segments.push({ name: part, objid: 0, kind: 'dir' })
          continue
        }
        const objid = Number(data.objid) || 0
        segments.push({
          name: part,
          objid,
          kind: typeof data.type_name === 'string' ? data.type_name : 'dir',
        })
      } catch {
        segments.push({ name: part, objid: 0, kind: 'dir' })
      }
    }
    return segments
  }

  const fetchFsStat = async (objsetId: number, objid: number) => {
    if (!selectedPool) return
    const key = `${objsetId}:${objid}`
    fsStatKey.current = key
    setFsStatLoading(true)
    setFsStatError(null)
    try {
      const data = await fetchJson<FsStat>(
        `${API_BASE}/api/pools/${encodeURIComponent(
          selectedPool
        )}/objset/${objsetId}/stat/${objid}`
      )
      if (fsStatKey.current !== key) return
      setFsStat(data)
    } catch (err) {
      if (fsStatKey.current === key) {
        setFsStatError((err as Error).message)
        setFsStat(null)
      }
    } finally {
      if (fsStatKey.current === key) {
        setFsStatLoading(false)
      }
    }
  }

  const fetchFsEntryStats = async (entries: FsEntry[]) => {
    if (!selectedPool || !fsState || entries.length === 0) return
    setFsEntryStatsLoading(true)
    setFsEntryStatsError(null)
    const pool = selectedPool
    const objsetId = fsState.objsetId
    const stats: Record<number, FsStat> = {}
    let cancelled = false

    const worker = async (queue: FsEntry[]) => {
      while (queue.length > 0 && !cancelled) {
        const entry = queue.shift()
        if (!entry) break
        try {
          const data = await fetchJson<FsStat>(
            `${API_BASE}/api/pools/${encodeURIComponent(
              pool
            )}/objset/${objsetId}/stat/${entry.objid}`
          )
          stats[entry.objid] = data
        } catch {
          // ignore per-entry errors
        }
      }
    }

    const queue = [...entries]
    const workers = Array.from({ length: 4 }, () => worker(queue))
    try {
      await Promise.all(workers)
      if (!cancelled) {
        setFsEntryStats(stats)
      }
    } catch (err) {
      if (!cancelled) {
        setFsEntryStatsError((err as Error).message)
      }
    } finally {
      if (!cancelled) {
        setFsEntryStatsLoading(false)
      }
    }

    return () => {
      cancelled = true
    }
  }

  const handleFsPathSubmit = async (pathOverride?: string) => {
    if (!selectedPool || !fsState) return
    const rawPath = (pathOverride ?? fsPathInput).trim()
    if (!rawPath) return
    const normalized = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    setFsPathLoading(true)
    setFsPathError(null)
    try {
      const data = await fetchJson<{
        found?: boolean
        error?: string
        remaining?: string
        resolved?: string
        objid?: number
        type_name?: string
      }>(
        `${API_BASE}/api/pools/${encodeURIComponent(
          selectedPool
        )}/objset/${fsState.objsetId}/walk?path=${encodeURIComponent(normalized)}`
      )
      if (!data.found) {
        const remaining = data.remaining ?? ''
        const message =
          data.error === 'not_dir'
            ? `Not a directory: ${data.resolved}`
            : `Not found: ${remaining}`
        throw new Error(message)
      }
      const objid = Number(data.objid)
      const typeName = String(data.type_name ?? '')
      const resolved = String(data.resolved ?? normalized)

      if (typeName === 'dir') {
        const segments = await resolveFsPathSegments(fsState.objsetId, resolved)
        if (segments.length === 0) {
          const fallbackPath = [
            { name: fsState.datasetName, objid: fsState.rootObj, kind: 'dir' },
            { name: resolved, objid, kind: 'dir' },
          ]
          await fetchFsDir(fsState.objsetId, objid, fallbackPath)
        } else {
          const last = segments[segments.length - 1]
          if (last.objid === 0) {
            last.objid = objid
          }
          if (!last.kind) {
            last.kind = 'dir'
          }
          await fetchFsDir(fsState.objsetId, objid, segments)
        }
      } else {
        setFsSelected({ name: resolved, objid, type_name: typeName })
        setFsPathInput(resolved.startsWith('/') ? resolved : `/${resolved}`)
        fetchFsStat(fsState.objsetId, objid)
      }
    } catch (err) {
      setFsPathError((err as Error).message)
    } finally {
      setFsPathLoading(false)
    }
  }

  const handleFsGraphSelect = (entry: FsEntry) => {
    if (!fsState) return
    if (entry.type_name === 'dir') {
      const currentNode = datasetIndex.nodeById.get(fsState.dslDirObj)
      const childDataset = currentNode?.children?.find(child => child.name === entry.name)
      if (childDataset) {
        enterFsFromDataset(childDataset)
        return
      }
      const nextPath = [...fsState.path, { name: entry.name, objid: entry.objid }]
      fetchFsDir(fsState.objsetId, entry.objid, nextPath)
    } else {
      setFsSelected(entry)
      fetchFsStat(fsState.objsetId, entry.objid)
    }
  }

  const openFsSelectionAsObject = () => {
    if (!fsSelected) return
    setLeftPaneTab('mos')
    navigateTo(fsSelected.objid, { reset: true })
  }

  async function fetchFsDir(
    objsetId: number,
    dirObj: number,
    path: FsPathSegment[],
    opts?: {
      baseState?: FsLocation | null
      history?: 'push' | 'replace' | 'reset' | 'none'
      browser?: 'push' | 'replace' | 'none'
    }
  ) {
    if (!selectedPool) return
    setFsLoading(true)
    setFsError(null)
    try {
      const params = new URLSearchParams()
      params.set('cursor', '0')
      params.set('limit', '500')
      const data = await fetchJson<FsDirResponse>(
        `${API_BASE}/api/pools/${encodeURIComponent(
          selectedPool
        )}/objset/${objsetId}/dir/${dirObj}/entries?${params.toString()}`
      )
      setFsEntries(data.entries ?? [])
      setFsEntryStats({})
      setFsEntryStatsError(null)
      const currentName = path[path.length - 1]?.name ?? 'dir'
      setFsSelected({ name: currentName, objid: dirObj, type_name: 'dir' })
      fetchFsStat(objsetId, dirObj)
      if (path.length > 1) {
        const rest = path.slice(1).map(seg => seg.name)
        setFsPathInput(`/${rest.join('/')}`)
      } else {
        setFsPathInput('/')
      }
      const baseState = opts?.baseState ?? fsState
      if (baseState) {
        const nextState: FsLocation = {
          ...baseState,
          currentDir: dirObj,
          path,
        }
        setFsState(nextState)
        const mode = opts?.history ?? 'push'
        if (mode === 'reset') {
          updateFsHistory(nextState, { reset: true })
        } else if (mode === 'replace') {
          updateFsHistory(nextState, { replace: true })
        } else if (mode !== 'none') {
          updateFsHistory(nextState)
        }

        const browserMode = opts?.browser ?? 'push'
        if (browserMode !== 'none') {
          commitBrowserState(
            { mode: 'fs', pool: selectedPool ?? null, fs: nextState },
            browserMode === 'replace' ? 'replace' : 'push'
          )
        }
      }
    } catch (err) {
      setFsError((err as Error).message)
    } finally {
      setFsLoading(false)
    }
  }

  const goBack = useCallback(() => {
    if (isMosMode && navIndex > 0) {
      skipNextHistoryPush.current = true
      const newIndex = navIndex - 1
      const objid = navStack[newIndex]
      setNavIndex(newIndex)
      setSelectedObject(objid)
      fetchInspector(objid)
      return
    }

    if (isFsTab && fsHistoryIndex > 0) {
      skipNextHistoryPush.current = true
      const newIndex = fsHistoryIndex - 1
      const location = fsHistory[newIndex]
      setFsHistoryIndex(newIndex)
      setFsState(location)
      fetchFsDir(location.objsetId, location.currentDir, location.path, {
        baseState: location,
        history: 'none',
        browser: 'none',
      })
    }
  }, [
    isMosMode,
    isFsTab,
    navIndex,
    navStack,
    fsHistory,
    fsHistoryIndex,
    fetchInspector,
    fetchFsDir,
  ])

  const goForward = useCallback(() => {
    if (isMosMode && navIndex < navStack.length - 1) {
      skipNextHistoryPush.current = true
      const newIndex = navIndex + 1
      const objid = navStack[newIndex]
      setNavIndex(newIndex)
      setSelectedObject(objid)
      fetchInspector(objid)
      return
    }

    if (isFsTab && fsHistoryIndex >= 0 && fsHistoryIndex < fsHistory.length - 1) {
      skipNextHistoryPush.current = true
      const newIndex = fsHistoryIndex + 1
      const location = fsHistory[newIndex]
      setFsHistoryIndex(newIndex)
      setFsState(location)
      fetchFsDir(location.objsetId, location.currentDir, location.path, {
        baseState: location,
        history: 'none',
        browser: 'none',
      })
    }
  }, [
    isMosMode,
    isFsTab,
    navIndex,
    navStack,
    fsHistory,
    fsHistoryIndex,
    fetchInspector,
    fetchFsDir,
  ])

  const enterFsFromDataset = async (node: DatasetTreeNode) => {
    if (!selectedPool) return
    setLeftPaneTab('fs')
    resetInspector()
    setFsLoading(true)
    setFsError(null)
    setFsSelected(null)
    setFsStat(null)
    setFsStatError(null)
    setFsPathInput('/')
    setFsCenterView('list')
    setFsSearch('')
    setFsHistory([])
    setFsHistoryIndex(-1)
    try {
      const headData = await fetchJson<{
        objset_id?: number
        head_dataset_obj?: number
      }>(
        `${API_BASE}/api/pools/${encodeURIComponent(
          selectedPool
        )}/dataset/${node.dsl_dir_obj}/head`
      )
      const objsetId = Number(headData.objset_id)
      const headDatasetObj = Number(headData.head_dataset_obj)
      if (!objsetId) {
        throw new Error('Missing objset_id from dataset head')
      }

      const rootData = await fetchJson<{ root_obj?: number }>(
        `${API_BASE}/api/pools/${encodeURIComponent(
          selectedPool
        )}/objset/${objsetId}/root`
      )
      const rootObj = Number(rootData.root_obj)
      if (!rootObj) {
        throw new Error('Missing root_obj from objset root')
      }

      const fullName =
        datasetIndex.fullNameById.get(node.dsl_dir_obj) ?? node.name
      const catalog = datasetCatalog[fullName]
      const baseState: FsLocation = {
        datasetName: fullName,
        mountpoint: catalog?.mountpoint ?? null,
        mounted: catalog?.mounted ?? null,
        dslDirObj: node.dsl_dir_obj,
        headDatasetObj,
        objsetId,
        rootObj,
        currentDir: rootObj,
        path: [{ name: fullName, objid: rootObj, kind: 'dir' }],
      }
      setFsState(baseState)

      await fetchFsDir(objsetId, rootObj, baseState.path, {
        baseState,
        history: 'reset',
        browser: 'replace',
      })
    } catch (err) {
      setFsError((err as Error).message)
    } finally {
      setFsLoading(false)
    }
  }

  const openFsFromMos = () => {
    if (!datasetForMos) return
    enterFsFromDataset(datasetForMos)
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
      const data = await fetchJson<MosListResponse>(
        `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/mos/objects?${params.toString()}`
      )
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
      setDatasetCatalog({})
      setDatasetExpanded({})
      setFsState(null)
      setFsHistory([])
      setFsHistoryIndex(-1)
      setFsEntries([])
      setFsLoading(false)
      setFsError(null)
      setFsSelected(null)
      setFsStat(null)
      setFsStatLoading(false)
      setFsStatError(null)
      setFsEntryStats({})
      setFsEntryStatsLoading(false)
      setFsEntryStatsError(null)
      setFsPathInput('')
      setFsPathView('zpl')
      setFsPathError(null)
      setFsPathLoading(false)
      setFsCenterView('list')
      setFsSearch('')
      setFsSort({ key: 'name', dir: 'asc' })
      setNavStack([])
      setNavIndex(-1)
      setShowBlkptrDetails(false)
      return
    }
    resetInspector()
    setNavStack([])
    setNavIndex(-1)
    setFsHistory([])
    setFsHistoryIndex(-1)
    setShowBlkptrDetails(false)
    fetchMosObjects(0, false)
  }, [selectedPool, typeFilter])

  useEffect(() => {
    if (!selectedPool) {
      return
    }
    fetchDatasetTree(selectedPool)
    fetchDatasetCatalog(selectedPool)
  }, [selectedPool])

  const fetchZapInfo = async (objid: number) => {
    if (!selectedPool) return
    const data = await fetchJson<ZapInfo>(
      `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/obj/${objid}/zap/info`
    )
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
      const data = await fetchJson<ZapResponse>(
        `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/obj/${objid}/zap?${params.toString()}`
      )
      setZapEntries(prev => (append ? [...prev, ...data.entries] : data.entries))
      setZapNext(data.next)
    } catch (err) {
      setZapError((err as Error).message)
    } finally {
      setZapLoading(false)
    }
  }

  async function fetchInspector(objid: number) {
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
      const [infoData, blkData] = await Promise.all([
        fetchJson<DnodeInfo>(
          `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/obj/${objid}`
        ),
        fetchJson<BlkptrResponse>(
          `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/obj/${objid}/blkptrs`
        ),
      ])
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

  useEffect(() => {
    if (!isFsTab) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== '/') return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return
      event.preventDefault()
      setFsCenterView('list')
      fsFilterRef.current?.focus()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isFsTab])

  useEffect(() => {
    if (!isFsTab || !fsState) return
    if (!['size', 'mtime'].includes(fsSort.key)) return
    if (fsEntryStatsLoading) return
    const missing = sortedFsEntries.some(entry => fsEntryStats[entry.objid] === undefined)
    if (!missing) return
    const key = `${fsState.currentDir}:${fsSort.key}:${fsSearch}:${sortedFsEntries.length}`
    if (fsAutoMetaKey.current === key) return
    fsAutoMetaKey.current = key
    fetchFsEntryStats(sortedFsEntries)
  }, [
    fsEntryStats,
    fsEntryStatsLoading,
    fsSearch,
    fsSort.key,
    fsState,
    isFsTab,
    sortedFsEntries,
  ])

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

    fetchJson<RawBlockResponse>(
      `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/block?${params}`
    )
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
          return fetchJson<GraphResponse>(
            `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/graph/from/${objid}?include=semantic,zap`
          )
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
      return []
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
              if (selectedPool) {
                handlePoolSelect(selectedPool)
              } else {
                setLeftPaneTabWithHistory('datasets')
              }
            }}
            title={`Pool ${selectedPool}`}
          >
            Pool {selectedPool}
          </button>
        ) : (
          <span className="crumb muted">No pool selected</span>
        )}
        <span className="crumb-sep">→</span>
        {isDatasetsTab && (
          <span className="crumb active">Datasets</span>
        )}
        {isFsTab && (
          <>
            <button
              className="crumb"
              onClick={() => setLeftPaneTabWithHistory('datasets')}
              title="Datasets"
            >
              Datasets
            </button>
            <span className="crumb-sep">→</span>
            <span className="crumb active" title="Filesystem view">
              FS
            </span>
            {fsState?.path.map((seg, idx) => (
              <span key={`${seg.objid}-${idx}`} className="crumb-group">
                <span className="crumb-sep">→</span>
                <button
                  className={`crumb ${idx === fsState.path.length - 1 ? 'active' : ''}`}
                  onClick={() => handleFsPathClick(idx)}
                  title={
                    seg.objid
                      ? `FS ${seg.kind ?? 'object'} #${seg.objid}`
                      : 'Unresolved path'
                  }
                >
                  {seg.name}
                </button>
              </span>
            ))}
          </>
        )}
        {leftPaneTab === 'mos' && (
          <>
            <button
              className="crumb"
              onClick={() => {
                resetInspector()
                setNavStack([])
                setNavIndex(-1)
                setLeftPaneTabWithHistory('mos')
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
          </>
        )}
      </div>

      <PanelGroup
        className="main-grid"
        direction={isNarrow ? 'vertical' : 'horizontal'}
      >
        <Panel defaultSize={isNarrow ? 32 : 22} minSize={isNarrow ? 22 : 16}>
          <aside className="panel pane-left">
          <div className="panel-header">
            <h2>Navigator</h2>
          </div>

          <div className="left-pane-tabs">
            <button
              className={`tab ${leftPaneTab !== 'mos' ? 'active' : ''}`}
              onClick={() => setLeftPaneTabWithHistory('datasets')}
            >
              Datasets
            </button>
            <button
              className={`tab ${isMosMode ? 'active' : ''}`}
              onClick={() => setLeftPaneTabWithHistory('mos')}
            >
              MOS
            </button>
          </div>

          {leftPaneTab !== 'mos' && (
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
                    onChange={e => handlePoolSelect(e.target.value)}
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
              {/* Filesystem navigation lives in the center pane now */}
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
                    onChange={e => handlePoolSelect(e.target.value)}
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

                    <div className="pane-scroll mos-objects-scroll">
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
                  </div>
                </>
              )}
            </div>
          )}
          </aside>
        </Panel>

        <PanelResizeHandle
          className={`resize-handle ${isNarrow ? 'vertical' : 'horizontal'}`}
        />

        <Panel defaultSize={isNarrow ? 40 : 56} minSize={isNarrow ? 26 : 32}>
          <section className="panel pane-center">
          {leftPaneTab !== 'mos' ? (
            <>
              <div className="panel-header graph-header">
                <div>
                  <h2>Filesystem</h2>
                  <span className="muted">
                    {fsState
                      ? `${fsState.datasetName}${fsState.mountpoint ? ` (${fsState.mountpoint})` : ''} · ${fsPathInput || '/'} · ${sortedFsEntries.length} entries`
                      : 'Select a dataset'}
                  </span>
                </div>
                <div className="graph-controls">
                  <div className="graph-view-toggle">
                    <button
                      className={`graph-btn ${fsCenterView === 'list' ? 'active' : ''}`}
                      type="button"
                      onClick={() => setFsCenterView('list')}
                    >
                      List
                    </button>
                    <button
                      className={`graph-btn ${fsCenterView === 'graph' ? 'active' : ''}`}
                      type="button"
                      onClick={() => setFsCenterView('graph')}
                    >
                      Graph
                    </button>
                  </div>
                  <input
                    className="graph-search"
                    placeholder="Filter by name or object id"
                    value={fsSearch}
                    ref={fsFilterRef}
                    onChange={e => setFsSearch(e.target.value)}
                  />
                  <select
                    className="graph-select"
                    value={fsSort.key}
                    onChange={e =>
                      setFsSort(prev => ({
                        ...prev,
                        key: e.target.value as 'name' | 'type' | 'size' | 'mtime',
                      }))
                    }
                  >
                    <option value="name">Name</option>
                    <option value="type">Type</option>
                    <option value="size">Size</option>
                    <option value="mtime">MTime</option>
                  </select>
                  <button
                    className="graph-btn"
                    type="button"
                    onClick={() =>
                      setFsSort(prev => ({
                        ...prev,
                        dir: prev.dir === 'asc' ? 'desc' : 'asc',
                      }))
                    }
                    title={`Sort ${fsSort.dir === 'asc' ? 'descending' : 'ascending'}`}
                  >
                    {fsSort.dir === 'asc' ? '↑' : '↓'}
                  </button>
                  {fsSearch && (
                    <button className="graph-btn" type="button" onClick={() => setFsSearch('')}>
                      Clear
                    </button>
                  )}
                  <button
                    className="graph-btn"
                    type="button"
                    onClick={() => fetchFsEntryStats(sortedFsEntries)}
                    disabled={fsEntryStatsLoading || sortedFsEntries.length === 0}
                  >
                    {fsEntryStatsLoading ? 'Loading…' : 'Load metadata'}
                  </button>
                </div>
              </div>
              {fsState && (
                <div className="fs-pathbar">
                  <div className="fs-path">
                    {fsState.path.map((seg, idx) => (
                      <button
                        key={`${seg.objid}-${idx}`}
                        className={`fs-path-seg ${idx === fsState.path.length - 1 ? 'active' : ''}`}
                        onClick={() => {
                          if (idx === fsState.path.length - 1) return
                          if (seg.objid === 0) {
                            const derived =
                              idx === 0
                                ? '/'
                                : `/${fsState.path
                                    .slice(1, idx + 1)
                                    .map(part => part.name)
                                    .filter(Boolean)
                                    .join('/')}`
                            handleFsPathSubmit(derived)
                          } else {
                            handleFsPathClick(idx)
                          }
                        }}
                      >
                        {seg.name}
                      </button>
                    ))}
                  </div>

                  <div className="fs-actions">
                    <div className="fs-path-input">
                      <input
                        type="text"
                        value={fsPathInput}
                        onChange={e => setFsPathInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            handleFsPathSubmit()
                          }
                        }}
                        placeholder="/path/to/dir"
                      />
                      <button
                        type="button"
                        onClick={() => handleFsPathSubmit()}
                        disabled={fsPathLoading}
                      >
                        {fsPathLoading ? '…' : 'Go'}
                      </button>
                    </div>
                    {fsPathError && <span className="fs-path-error">Error: {fsPathError}</span>}
                    <div className="fs-path-view">
                      <div className="fs-path-view-toggle">
                        <button
                          type="button"
                          className={`graph-btn ${fsPathView === 'zpl' ? 'active' : ''}`}
                          onClick={() => setFsPathView('zpl')}
                        >
                          ZPL
                        </button>
                        <button
                          type="button"
                          className={`graph-btn ${fsPathView === 'mount' ? 'active' : ''}`}
                          onClick={() => setFsPathView('mount')}
                          disabled={!fsState.mountpoint}
                        >
                          Mount
                        </button>
                      </div>
                      <code className="fs-path-view-value">{fsDisplayPath}</code>
                    </div>
                  </div>

                  <div className="fs-meta">
                    <span>objset {fsState.objsetId}</span>
                    <span>dir {fsState.currentDir}</span>
                    {fsEntryStatsError && <span>Error: {fsEntryStatsError}</span>}
                  </div>
                </div>
              )}
              {fsLoading && <p className="muted">Loading filesystem…</p>}
              {fsError && (
                <div className="error">
                  <strong>Error:</strong> {fsError}
                </div>
              )}
              <div className="graph">
                {fsCenterView === 'graph' && fsState ? (
                  <FsGraph
                    dirObj={fsState.currentDir}
                    dirName={fsState.path[fsState.path.length - 1]?.name ?? 'dir'}
                    entries={sortedFsEntries}
                    selectedObjid={fsSelected?.objid ?? null}
                    onSelectEntry={handleFsGraphSelect}
                  />
                ) : (
                  <div className="fs-center-list">
                    {!fsState && <p className="muted">Select a dataset to browse.</p>}
                    {fsState && (
                      <div className="fs-table">
                        <div className="fs-row fs-header">
                          <button
                            type="button"
                            className={`fs-header-btn ${fsSort.key === 'name' ? 'active' : ''}`}
                            onClick={() => toggleFsSort('name')}
                          >
                            Name {fsSort.key === 'name' ? (fsSort.dir === 'asc' ? '↑' : '↓') : ''}
                          </button>
                          <button
                            type="button"
                            className={`fs-header-btn ${fsSort.key === 'type' ? 'active' : ''}`}
                            onClick={() => toggleFsSort('type')}
                          >
                            Type {fsSort.key === 'type' ? (fsSort.dir === 'asc' ? '↑' : '↓') : ''}
                          </button>
                          <div>Object</div>
                          <button
                            type="button"
                            className={`fs-header-btn align-right ${
                              fsSort.key === 'size' ? 'active' : ''
                            }`}
                            onClick={() => toggleFsSort('size')}
                          >
                            Size {fsSort.key === 'size' ? (fsSort.dir === 'asc' ? '↑' : '↓') : ''}
                          </button>
                          <button
                            type="button"
                            className={`fs-header-btn ${fsSort.key === 'mtime' ? 'active' : ''}`}
                            onClick={() => toggleFsSort('mtime')}
                          >
                            MTime {fsSort.key === 'mtime' ? (fsSort.dir === 'asc' ? '↑' : '↓') : ''}
                          </button>
                        </div>
                        {sortedFsEntries.map(entry => {
                          const stat = fsEntryStats[entry.objid]
                          return (
                            <div
                              key={`${entry.name}-${entry.objid}`}
                              className={`fs-row ${
                                entry.type_name === 'dir' ? 'clickable' : 'selectable'
                              } ${fsSelected?.objid === entry.objid ? 'selected' : ''}`}
                              onClick={() => handleFsEntryClick(entry)}
                            >
                              <div className="fs-name">{entry.name}</div>
                              <div className="fs-type">{entry.type_name}</div>
                              <div className="fs-obj">#{entry.objid}</div>
                              <div className="fs-size">
                                {stat ? formatBytes(stat.size) : '—'}
                              </div>
                              <div className="fs-mtime">
                                {stat ? formatTimestamp(stat.mtime) : '—'}
                              </div>
                            </div>
                          )
                        })}
                        {sortedFsEntries.length === 0 && (
                          <div className="fs-empty">No entries match this filter.</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
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
                  {effectiveCenterView === 'map' ? (
                    <>
                      <input
                        className="graph-search"
                        placeholder="Filter ZAP keys"
                        value={zapMapFilter}
                        onChange={e => setZapMapFilter(e.target.value)}
                      />
                      {zapMapFilter && (
                        <button
                          className="graph-btn"
                          type="button"
                          onClick={() => setZapMapFilter('')}
                        >
                          Clear
                        </button>
                      )}
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
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
                    filter={zapMapFilter}
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
                    objTypeMap={mosTypeMap}
                  />
                )}
                {graphExpandError && <div className="graph-error">{graphExpandError}</div>}
              </div>
            </>
          )}
          </section>
        </Panel>

        <PanelResizeHandle
          className={`resize-handle ${isNarrow ? 'vertical' : 'horizontal'}`}
        />

        <Panel defaultSize={isNarrow ? 28 : 22} minSize={isNarrow ? 22 : 16}>
          <section className="panel pane-right">
          <div className="panel-header">
            <h2>Inspector</h2>
            <div className="panel-actions">
              {isFsMode && fsStatLoading && <span className="muted">Loading…</span>}
              {!isFsMode && inspectorLoading && <span className="muted">Loading…</span>}
              {!isFsMode && selectedObject !== null && (
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

          {isFsMode && fsState && (
            <div className="inspector-content">
              <div className="inspector-section">
                <h3>Filesystem Context</h3>
                <dl className="info-grid">
                  <div>
                    <dt>Dataset</dt>
                    <dd>{fsState.datasetName}</dd>
                  </div>
                  <div>
                    <dt>Mountpoint</dt>
                    <dd>{fsState.mountpoint ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Objset</dt>
                    <dd>{fsState.objsetId}</dd>
                  </div>
                  <div>
                    <dt>Mounted</dt>
                    <dd>
                      {fsState.mounted === null || fsState.mounted === undefined
                        ? 'unknown'
                        : fsState.mounted
                        ? 'yes'
                        : 'no'}
                    </dd>
                  </div>
                  <div>
                    <dt>Dir Obj</dt>
                    <dd>{fsState.currentDir}</dd>
                  </div>
                  <div>
                    <dt>Root Obj</dt>
                    <dd>{fsState.rootObj}</dd>
                  </div>
                </dl>
              </div>

              {fsSelected && (
                <div className="inspector-section">
                  <h3>Selection</h3>
                  <dl className="info-grid">
                    <div>
                      <dt>Name</dt>
                      <dd>{fsSelected.name}</dd>
                    </div>
                    <div>
                      <dt>Object</dt>
                      <dd>
                        <button
                          type="button"
                          className="fs-object-link"
                          onClick={openFsSelectionAsObject}
                          title="Open as MOS object"
                        >
                          #{fsSelected.objid}
                        </button>
                      </dd>
                    </div>
                    <div>
                      <dt>Type</dt>
                      <dd>{fsSelected.type_name}</dd>
                    </div>
                  </dl>
                  <div className="fs-actions">
                    <button
                      type="button"
                      className="fs-action-btn"
                      onClick={openFsSelectionAsObject}
                    >
                      Open as object
                    </button>
                  </div>
                </div>
              )}

              {fsStatError && (
                <div className="error">
                  <strong>Error:</strong> {fsStatError}
                </div>
              )}

              {fsStat && (
                <div className="inspector-section">
                  <h3>Metadata</h3>
                  <dl className="info-grid">
                    <div>
                      <dt>Mode</dt>
                      <dd>{formatModeOctal(fsStat.mode)}</dd>
                    </div>
                    <div>
                      <dt>UID</dt>
                      <dd>{fsStat.uid}</dd>
                    </div>
                    <div>
                      <dt>GID</dt>
                      <dd>{fsStat.gid}</dd>
                    </div>
                    <div>
                      <dt>Size</dt>
                      <dd>{fsStat.size} B</dd>
                    </div>
                    <div>
                      <dt>Links</dt>
                      <dd>{fsStat.links}</dd>
                    </div>
                    <div>
                      <dt>Parent</dt>
                      <dd>{fsStat.parent}</dd>
                    </div>
                    <div>
                      <dt>Flags</dt>
                      <dd>{fsStat.flags}</dd>
                    </div>
                    <div>
                      <dt>Gen</dt>
                      <dd>{fsStat.gen}</dd>
                    </div>
                    <div>
                      <dt>ATime</dt>
                      <dd>{formatTimestamp(fsStat.atime)}</dd>
                    </div>
                    <div>
                      <dt>MTime</dt>
                      <dd>{formatTimestamp(fsStat.mtime)}</dd>
                    </div>
                    <div>
                      <dt>CTime</dt>
                      <dd>{formatTimestamp(fsStat.ctime)}</dd>
                    </div>
                    <div>
                      <dt>CrTime</dt>
                      <dd>{formatTimestamp(fsStat.crtime)}</dd>
                    </div>
                  </dl>
                  {fsStat.partial && (
                    <p className="muted">Partial metadata: some attributes were unavailable.</p>
                  )}
                </div>
              )}

              {!fsStat && !fsStatLoading && !fsStatError && (
                <p className="muted">Select a file or directory to view metadata.</p>
              )}
            </div>
          )}

          {isFsMode && !fsState && (
            <p className="muted">Select a dataset to view filesystem metadata.</p>
          )}

          {!isFsMode && selectedPool && selectedObject !== null && (
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

          {!isFsMode && inspectorError && (
            <div className="error">
              <strong>Error:</strong> {inspectorError}
            </div>
          )}

          {!isFsMode && !selectedObject && !inspectorLoading && (
            <p className="muted">Select a MOS object to inspect its dnode.</p>
          )}

          {!isFsMode && selectedObject !== null && objectInfo && (
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

                    {datasetForMos && (
                      <div className="inspector-section">
                        <h3>Dataset Link</h3>
                        <div className="fs-actions">
                          <span className="muted">
                            {datasetIndex.fullNameById.get(
                              datasetForMos.dsl_dir_obj
                            ) ?? datasetForMos.name}
                          </span>
                          <button
                            type="button"
                            className="fs-action-btn"
                            onClick={openFsFromMos}
                          >
                            Open in FS
                          </button>
                        </div>
                      </div>
                    )}

                    {dslDatasetBonus && (
                      <div className="inspector-section">
                        <h3>DSL Dataset</h3>
                        <dl className="info-grid">
                          <div>
                            <dt>Dir Obj</dt>
                            <dd>
                              {dslDatasetBonus.dir_obj !== 0 ? (
                                <button
                                  className="zap-entry-link"
                                  onClick={() => navigateTo(dslDatasetBonus.dir_obj)}
                                >
                                  Object {dslDatasetBonus.dir_obj}
                                </button>
                              ) : (
                                <code>0</code>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Prev Snap</dt>
                            <dd>
                              {dslDatasetBonus.prev_snap_obj !== 0 ? (
                                <button
                                  className="zap-entry-link"
                                  onClick={() => navigateTo(dslDatasetBonus.prev_snap_obj)}
                                >
                                  Object {dslDatasetBonus.prev_snap_obj}
                                </button>
                              ) : (
                                <code>0</code>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Next Snap</dt>
                            <dd>
                              {dslDatasetBonus.next_snap_obj !== 0 ? (
                                <button
                                  className="zap-entry-link"
                                  onClick={() => navigateTo(dslDatasetBonus.next_snap_obj)}
                                >
                                  Object {dslDatasetBonus.next_snap_obj}
                                </button>
                              ) : (
                                <code>0</code>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Snapnames ZAP</dt>
                            <dd>
                              {dslDatasetBonus.snapnames_zapobj !== 0 ? (
                                <button
                                  className="zap-entry-link"
                                  onClick={() => navigateTo(dslDatasetBonus.snapnames_zapobj)}
                                >
                                  Object {dslDatasetBonus.snapnames_zapobj}
                                </button>
                              ) : (
                                <code>0</code>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Deadlist Obj</dt>
                            <dd>
                              {dslDatasetBonus.deadlist_obj !== 0 ? (
                                <button
                                  className="zap-entry-link"
                                  onClick={() => navigateTo(dslDatasetBonus.deadlist_obj)}
                                >
                                  Object {dslDatasetBonus.deadlist_obj}
                                </button>
                              ) : (
                                <code>0</code>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Props Obj</dt>
                            <dd>
                              {dslDatasetBonus.props_obj !== 0 ? (
                                <button
                                  className="zap-entry-link"
                                  onClick={() => navigateTo(dslDatasetBonus.props_obj)}
                                >
                                  Object {dslDatasetBonus.props_obj}
                                </button>
                              ) : (
                                <code>0</code>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Userrefs Obj</dt>
                            <dd>
                              {dslDatasetBonus.userrefs_obj !== 0 ? (
                                <button
                                  className="zap-entry-link"
                                  onClick={() => navigateTo(dslDatasetBonus.userrefs_obj)}
                                >
                                  Object {dslDatasetBonus.userrefs_obj}
                                </button>
                              ) : (
                                <code>0</code>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Next Clones Obj</dt>
                            <dd>
                              {dslDatasetBonus.next_clones_obj !== 0 ? (
                                <button
                                  className="zap-entry-link"
                                  onClick={() => navigateTo(dslDatasetBonus.next_clones_obj)}
                                >
                                  Object {dslDatasetBonus.next_clones_obj}
                                </button>
                              ) : (
                                <code>0</code>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>Children</dt>
                            <dd>{dslDatasetBonus.num_children}</dd>
                          </div>
                          <div>
                            <dt>Creation TXG</dt>
                            <dd>{dslDatasetBonus.creation_txg}</dd>
                          </div>
                          <div>
                            <dt>Creation Time</dt>
                            <dd>{new Date(dslDatasetBonus.creation_time * 1000).toLocaleString()}</dd>
                          </div>
                          <div>
                            <dt>Referenced</dt>
                            <dd>{dslDatasetBonus.referenced_bytes} B</dd>
                          </div>
                          <div>
                            <dt>Compressed</dt>
                            <dd>{dslDatasetBonus.compressed_bytes} B</dd>
                          </div>
                          <div>
                            <dt>Uncompressed</dt>
                            <dd>{dslDatasetBonus.uncompressed_bytes} B</dd>
                          </div>
                          <div>
                            <dt>Unique</dt>
                            <dd>{dslDatasetBonus.unique_bytes} B</dd>
                          </div>
                          <div>
                            <dt>FSID GUID</dt>
                            <dd>{dslDatasetBonus.fsid_guid}</dd>
                          </div>
                          <div>
                            <dt>GUID</dt>
                            <dd>{dslDatasetBonus.guid}</dd>
                          </div>
                          <div>
                            <dt>Flags</dt>
                            <dd>{dslDatasetBonus.flags}</dd>
                          </div>
                        </dl>

                        {dslDatasetNode && (
                          <div className="fs-actions">
                            <span className="muted">
                              {datasetIndex.fullNameById.get(dslDatasetNode.dsl_dir_obj) ??
                                dslDatasetNode.name}
                            </span>
                            <button
                              type="button"
                              className="fs-action-btn"
                              onClick={() => enterFsFromDataset(dslDatasetNode)}
                            >
                              Open Dataset in FS
                            </button>
                          </div>
                        )}
                      </div>
                    )}

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
        </Panel>
      </PanelGroup>

      <footer>
        <p>v0.01, OpenZFS commit: 21bbe7cb6</p>
      </footer>
    </div>
  )
}

export default App
