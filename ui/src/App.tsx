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
const SPACEMAP_PAGE_LIMIT = 200

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

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
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

type ApiVersionResponse = {
  project: string
  backend: {
    name: string
    version: string
    git_sha: string
  }
  openzfs: {
    commit: string
  }
  runtime: {
    os: string
    arch: string
  }
  pool_open?: {
    mode?: string
    offline_search_paths?: string | null
    offline_pools?: string[]
  }
}

type PoolModeResponse = {
  mode: 'live' | 'offline'
  offline_search_paths?: string | null
  offline_pools?: string[]
}

type PoolSummaryPool = {
  name: string
  guid: number
  state: number
  txg: number
  version: number
  hostid: number
  hostname: string | null
  errata: number
}

type PoolSummaryRootBpDva = {
  vdev: number
  offset: number
  asize: number
  is_gang: boolean
}

type PoolSummaryRootBp = {
  is_hole: boolean
  level: number
  type: number
  lsize: number
  psize: number
  asize: number
  birth_txg: number
  dvas: PoolSummaryRootBpDva[]
}

type PoolSummaryResponse = {
  pool: PoolSummaryPool
  features_for_read: string[]
  vdev_tree: Record<string, unknown> | null
  uberblock: {
    txg: number
    timestamp: number
    rootbp: PoolSummaryRootBp | null
  }
}

type PoolErrorEntry = {
  source: string
  dataset_obj: number
  object: number
  level: number
  blkid: number
  birth: number | null
  path: string | null
}

type PoolErrorsResponse = {
  pool: string
  error_count: number
  approx_entries: number
  head_errlog: boolean
  errlog_last_obj: number
  errlog_scrub_obj: number
  cursor: number
  limit: number
  count: number
  next: number | null
  entries: PoolErrorEntry[]
}

type SpacemapHistogramBucket = {
  bucket: number
  min_length: number
  max_length: number | null
  alloc_count: number
  free_count: number
}

type SpacemapSummaryResponse = {
  object: number
  start: number
  size: number
  shift: number
  length: number
  allocated: number
  smp_length: number
  smp_alloc: number
  range_entries: number
  alloc_entries: number
  free_entries: number
  alloc_bytes: number
  free_bytes: number
  net_bytes: number
  txg_min: number | null
  txg_max: number | null
  histogram: SpacemapHistogramBucket[]
}

type SpacemapRange = {
  index: number
  op: 'alloc' | 'free' | string
  offset: number
  length: number
  txg: number | null
  sync_pass: number | null
  vdev: number | null
}

type SpacemapRangesFilters = {
  op: 'all' | 'alloc' | 'free'
  min_length: number
  txg_min: number | null
  txg_max: number | null
}

type SpacemapRangesResponse = {
  object: number
  start: number
  size: number
  shift: number
  cursor: number
  limit: number
  count: number
  next: number | null
  filters?: SpacemapRangesFilters
  ranges: SpacemapRange[]
}

type SpacemapTopWindow = {
  window_start: number
  window_end: number
  ops: number
  alloc_bytes: number
  free_bytes: number
}

type DatasetTreeNode = {
  name: string
  dsl_dir_obj: number
  head_dataset_obj: number | null
  child_dir_zapobj: number | null
  children: DatasetTreeNode[]
}

const INTERNAL_DSL_DATASET_NAMES = new Set(['$FREE', '$MOS', '$ORIGIN'])

const isInternalDslDatasetName = (name: string): boolean =>
  INTERNAL_DSL_DATASET_NAMES.has(name.trim().toUpperCase())

const isBrowsableDatasetNode = (node: DatasetTreeNode | null | undefined): node is DatasetTreeNode =>
  !!node &&
  !isInternalDslDatasetName(node.name) &&
  node.head_dataset_obj !== null &&
  node.head_dataset_obj !== undefined &&
  node.head_dataset_obj !== 0

type DatasetTreeResponse = {
  root: DatasetTreeNode
  depth: number
  limit: number
  truncated: boolean
  count: number
}

type DatasetSnapshotRef = {
  name: string
  dsobj: number
}

type DatasetSnapshotsResponse = {
  dsl_dir_obj: number
  head_dataset_obj: number
  snapnames_zapobj: number
  count: number
  entries: DatasetSnapshotRef[]
}

type DatasetSnapshotCountResponse = {
  dsl_dir_obj: number
  head_dataset_obj: number
  snapnames_zapobj: number
  count: number
}

type SnapshotRecord = {
  name: string
  dsobj: number
  creation_txg: number | null
  creation_time: number | null
  referenced_bytes: number | null
  unique_bytes: number | null
  deadlist_obj: number | null
}

type SnapshotLineageEntry = {
  dsobj: number
  dir_obj: number
  prev_snap_obj: number
  next_snap_obj: number
  deadlist_obj: number
  snapnames_zapobj: number
  next_clones_obj: number
  creation_txg: number
  creation_time: number
  referenced_bytes: number
  unique_bytes: number
  is_start: boolean
}

type SnapshotLineageResponse = {
  start_dsobj: number
  count: number
  prev_truncated: boolean
  next_truncated: boolean
  entries: SnapshotLineageEntry[]
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

const isSpacemapDnode = (dnode: DnodeInfo | null | undefined): boolean =>
  !!dnode && dnode.type.name.toLowerCase().includes('space map')

const isSameFsLocation = (a: FsLocation, b: FsLocation) => {
  if (a.objsetId !== b.objsetId) return false
  if (a.currentDir !== b.currentDir) return false
  if (a.path.length !== b.path.length) return false
  return a.path.every((seg, idx) => {
    const other = b.path[idx]
    return seg.objid === other.objid && seg.name === other.name
  })
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const extractVdevChildren = (node: Record<string, unknown>): Record<string, unknown>[] => {
  const direct = node.children
  if (Array.isArray(direct)) {
    return direct.filter(item => asRecord(item) !== null) as Record<string, unknown>[]
  }

  return Object.entries(node)
    .filter(([key, value]) => /^children\[\d+\]$/.test(key) && asRecord(value) !== null)
    .sort((a, b) => {
      const idxA = Number.parseInt(a[0].slice(9, -1), 10)
      const idxB = Number.parseInt(b[0].slice(9, -1), 10)
      return idxA - idxB
    })
    .map(([, value]) => value as Record<string, unknown>)
}

const scalarToZdb = (value: unknown): string => {
  if (typeof value === 'string') return `'${value}'`
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value === null) return '(none)'
  if (Array.isArray(value)) return `[${value.map(scalarToZdb).join(', ')}]`
  if (typeof value === 'object') return '{...}'
  return String(value)
}

const vdevTreeToZdb = (node: Record<string, unknown>, indent = 1): string[] => {
  const pad = '    '.repeat(indent)
  const lines: string[] = []

  const preferredKeys = [
    'type',
    'id',
    'guid',
    'metaslab_array',
    'metaslab_shift',
    'ashift',
    'asize',
    'is_log',
    'create_txg',
    'path',
    'devid',
    'phys_path',
    'whole_disk',
    'vdev_enc_sysfs_path',
  ]

  preferredKeys.forEach(key => {
    if (key in node && key !== 'children') {
      lines.push(`${pad}${key}: ${scalarToZdb(node[key])}`)
    }
  })

  Object.entries(node).forEach(([key, value]) => {
    if (preferredKeys.includes(key) || key === 'children') return
    if (/^children\[\d+\]$/.test(key)) return
    lines.push(`${pad}${key}: ${scalarToZdb(value)}`)
  })

  const children = extractVdevChildren(node)
  children.forEach((child, idx) => {
    lines.push(`${pad}children[${idx}]:`)
    lines.push(...vdevTreeToZdb(child, indent + 1))
  })

  return lines
}

const rootbpToZdb = (rootbp: PoolSummaryRootBp | null): string => {
  if (!rootbp) return '(none)'
  if (rootbp.is_hole) return 'hole'
  if (!rootbp.dvas || rootbp.dvas.length === 0) {
    return `level=${rootbp.level} type=${rootbp.type} asize=${rootbp.asize}`
  }
  const dvas = rootbp.dvas
    .map(
      (dva, idx) => `DVA[${idx}]=<${dva.vdev}:${dva.offset.toString(16)}:${dva.asize.toString(16)}>`
    )
    .join(' ')
  return `${dvas} level=${rootbp.level} type=${rootbp.type} birth=${rootbp.birth_txg}`
}

const poolSummaryToZdb = (summary: PoolSummaryResponse): string => {
  const lines: string[] = []
  lines.push(`${summary.pool.name}:`)
  lines.push(`    version: ${summary.pool.version}`)
  lines.push(`    name: '${summary.pool.name}'`)
  lines.push(`    state: ${summary.pool.state}`)
  lines.push(`    txg: ${summary.pool.txg}`)
  lines.push(`    pool_guid: ${summary.pool.guid}`)
  lines.push(`    errata: ${summary.pool.errata}`)
  lines.push(`    hostid: ${summary.pool.hostid}`)
  lines.push(`    hostname: '${summary.pool.hostname ?? '(none)'}'`)
  lines.push(`    vdev_tree:`)
  if (summary.vdev_tree) {
    lines.push(...vdevTreeToZdb(summary.vdev_tree, 2))
  } else {
    lines.push(`        (none)`)
  }
  lines.push(`    features_for_read:`)
  if (summary.features_for_read.length === 0) {
    lines.push(`        (none)`)
  } else {
    summary.features_for_read.forEach(feature => {
      lines.push(`        ${feature}`)
    })
  }
  lines.push(`Uberblock:`)
  lines.push(`    txg: ${summary.uberblock.txg}`)
  lines.push(`    timestamp: ${summary.uberblock.timestamp}`)
  lines.push(`    rootbp: ${rootbpToZdb(summary.uberblock.rootbp)}`)
  return lines.join('\n')
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
  const [snapshotView, setSnapshotView] = useState<{
    dslDirObj: number
    datasetName: string
    headDatasetObj: number | null
  } | null>(null)
  const [snapshotRows, setSnapshotRows] = useState<SnapshotRecord[]>([])
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [snapshotSearch, setSnapshotSearch] = useState('')
  const [snapshotSort, setSnapshotSort] = useState<{
    key: 'name' | 'dsobj' | 'creation_txg' | 'creation_time' | 'referenced_bytes' | 'unique_bytes'
    dir: 'asc' | 'desc'
  }>({ key: 'name', dir: 'asc' })
  const [snapshotOpeningDsobj, setSnapshotOpeningDsobj] = useState<number | null>(null)
  const [snapshotViewMode, setSnapshotViewMode] = useState<'table' | 'lineage'>('table')
  const [snapshotLineageDsobj, setSnapshotLineageDsobj] = useState<number | null>(null)
  const [snapshotLineage, setSnapshotLineage] = useState<SnapshotLineageResponse | null>(null)
  const [snapshotLineageLoading, setSnapshotLineageLoading] = useState(false)
  const [snapshotLineageError, setSnapshotLineageError] = useState<string | null>(null)
  const [snapshotCountsByDir, setSnapshotCountsByDir] = useState<Record<number, number | null>>(
    {}
  )
  const [snapshotCountLoadingByDir, setSnapshotCountLoadingByDir] = useState<Record<number, boolean>>(
    {}
  )
  const [navStack, setNavStack] = useState<number[]>([])
  const [navIndex, setNavIndex] = useState(-1)
  const [inspectorTab, setInspectorTab] = useState<
    'summary' | 'zap' | 'blkptr' | 'spacemap' | 'raw'
  >('summary')
  const [rawView, setRawView] = useState<'json' | 'hex'>('json')
  const [hexDump, setHexDump] = useState<RawBlockResponse | null>(null)
  const [hexLoading, setHexLoading] = useState(false)
  const [hexError, setHexError] = useState<string | null>(null)
  const [zdbCopied, setZdbCopied] = useState(false)
  const [debugCopied, setDebugCopied] = useState(false)
  const [debugCopyError, setDebugCopyError] = useState<string | null>(null)
  const [apiVersionInfo, setApiVersionInfo] = useState<ApiVersionResponse | null>(null)
  const [modeSwitching, setModeSwitching] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)
  const [poolSummary, setPoolSummary] = useState<PoolSummaryResponse | null>(null)
  const [poolSummaryLoading, setPoolSummaryLoading] = useState(false)
  const [poolSummaryError, setPoolSummaryError] = useState<string | null>(null)
  const [poolSummaryCopied, setPoolSummaryCopied] = useState(false)
  const [poolErrors, setPoolErrors] = useState<PoolErrorsResponse | null>(null)
  const [poolErrorsLoading, setPoolErrorsLoading] = useState(false)
  const [poolErrorsError, setPoolErrorsError] = useState<string | null>(null)
  const [poolErrorsResolvePaths, setPoolErrorsResolvePaths] = useState(true)
  const [poolErrorsCursorInput, setPoolErrorsCursorInput] = useState('0')
  const [poolErrorsLimit, setPoolErrorsLimit] = useState(200)
  const [spacemapSummary, setSpacemapSummary] = useState<SpacemapSummaryResponse | null>(null)
  const [spacemapSummaryLoading, setSpacemapSummaryLoading] = useState(false)
  const [spacemapSummaryError, setSpacemapSummaryError] = useState<string | null>(null)
  const [spacemapRanges, setSpacemapRanges] = useState<SpacemapRange[]>([])
  const [spacemapRangesNext, setSpacemapRangesNext] = useState<number | null>(null)
  const [spacemapRangesLoading, setSpacemapRangesLoading] = useState(false)
  const [spacemapRangesError, setSpacemapRangesError] = useState<string | null>(null)
  const [spacemapOpFilter, setSpacemapOpFilter] = useState<'all' | 'alloc' | 'free'>('all')
  const [spacemapMinLengthInput, setSpacemapMinLengthInput] = useState('')
  const [spacemapTxgMinInput, setSpacemapTxgMinInput] = useState('')
  const [spacemapTxgMaxInput, setSpacemapTxgMaxInput] = useState('')
  const [poolDetailsOpen, setPoolDetailsOpen] = useState(false)
  const [poolTreeExpanded, setPoolTreeExpanded] = useState<Record<string, boolean>>({
    root: true,
  })
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
  const [centerView, setCenterView] = useState<'explore' | 'graph' | 'physical' | 'spacemap'>(
    'explore'
  )
  const [isNarrow, setIsNarrow] = useState(false)
  const hexRequestKey = useRef<string | null>(null)
  const fsStatKey = useRef<string | null>(null)
  const fsFilterRef = useRef<HTMLInputElement | null>(null)
  const fsAutoMetaKey = useRef<string | null>(null)
  const snapshotRequestKey = useRef<string | null>(null)
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
    const nodeByHeadDatasetObj = new Map<number, DatasetTreeNode>()
    if (!datasetTree) {
      return { nodeById, fullNameById, childZapToNode, nodeByHeadDatasetObj }
    }

    const walk = (node: DatasetTreeNode, prefix: string) => {
      const fullName = prefix ? `${prefix}/${node.name}` : node.name
      nodeById.set(node.dsl_dir_obj, node)
      fullNameById.set(node.dsl_dir_obj, fullName)
      if (node.child_dir_zapobj) {
        childZapToNode.set(node.child_dir_zapobj, node)
      }
      if (node.head_dataset_obj) {
        nodeByHeadDatasetObj.set(node.head_dataset_obj, node)
      }
      node.children?.forEach(child => walk(child, fullName))
    }

    walk(datasetTree.root, '')
    return { nodeById, fullNameById, childZapToNode, nodeByHeadDatasetObj }
  }, [datasetTree])

  const datasetForMos = useMemo(() => {
    if (selectedObject === null) return null
    return (
      datasetIndex.nodeById.get(selectedObject) ??
      datasetIndex.childZapToNode.get(selectedObject) ??
      null
    )
  }, [datasetIndex, selectedObject])

  const datasetForMosIsBrowsable = useMemo(
    () => isBrowsableDatasetNode(datasetForMos),
    [datasetForMos]
  )

  const visibleDatasetNodes = useMemo(() => {
    if (!datasetTree) return [] as DatasetTreeNode[]

    const visible: DatasetTreeNode[] = []
    const walk = (node: DatasetTreeNode, depth: number) => {
      visible.push(node)
      const expanded = datasetExpanded[node.dsl_dir_obj] ?? depth === 0
      if (!expanded) return
      node.children?.forEach(child => walk(child, depth + 1))
    }

    walk(datasetTree.root, 0)
    return visible
  }, [datasetTree, datasetExpanded])

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

  const filteredSnapshotRows = useMemo(() => {
    const term = snapshotSearch.trim().toLowerCase()
    if (!term) return snapshotRows
    return snapshotRows.filter(row => {
      if (row.name.toLowerCase().includes(term)) return true
      if (row.dsobj.toString().includes(term)) return true
      return false
    })
  }, [snapshotRows, snapshotSearch])

  const sortedSnapshotRows = useMemo(() => {
    const rows = [...filteredSnapshotRows]
    const dir = snapshotSort.dir === 'asc' ? 1 : -1
    const compareMaybeNumber = (a: number | null, b: number | null) => {
      if (a === null && b === null) return 0
      if (a === null) return 1
      if (b === null) return -1
      return a - b
    }
    rows.sort((a, b) => {
      switch (snapshotSort.key) {
        case 'dsobj':
          return (a.dsobj - b.dsobj) * dir
        case 'creation_txg': {
          const cmp = compareMaybeNumber(a.creation_txg, b.creation_txg)
          if (cmp !== 0) return cmp * dir
          return a.name.localeCompare(b.name) * dir
        }
        case 'creation_time': {
          const cmp = compareMaybeNumber(a.creation_time, b.creation_time)
          if (cmp !== 0) return cmp * dir
          return a.name.localeCompare(b.name) * dir
        }
        case 'referenced_bytes': {
          const cmp = compareMaybeNumber(a.referenced_bytes, b.referenced_bytes)
          if (cmp !== 0) return cmp * dir
          return a.name.localeCompare(b.name) * dir
        }
        case 'unique_bytes': {
          const cmp = compareMaybeNumber(a.unique_bytes, b.unique_bytes)
          if (cmp !== 0) return cmp * dir
          return a.name.localeCompare(b.name) * dir
        }
        case 'name':
        default:
          return a.name.localeCompare(b.name) * dir
      }
    })
    return rows
  }, [filteredSnapshotRows, snapshotSort])

  const snapshotNameByDsobj = useMemo(() => {
    const map = new Map<number, string>()
    snapshotRows.forEach(row => map.set(row.dsobj, row.name))
    return map
  }, [snapshotRows])

  const snapshotDatasetLabel = useCallback(
    (dsobj: number) => {
      if (!snapshotView) return `Object ${dsobj}`
      if (snapshotView.headDatasetObj !== null && dsobj === snapshotView.headDatasetObj) {
        return snapshotView.datasetName
      }
      const snapName = snapshotNameByDsobj.get(dsobj)
      if (snapName) return `${snapshotView.datasetName}@${snapName}`
      return `${snapshotView.datasetName}@#${dsobj}`
    },
    [snapshotView, snapshotNameByDsobj]
  )

  const snapshotLineageCandidates = useMemo(() => {
    const candidates: { dsobj: number; label: string }[] = []
    const seen = new Set<number>()

    if (snapshotView?.headDatasetObj !== null && snapshotView?.headDatasetObj !== undefined) {
      seen.add(snapshotView.headDatasetObj)
      candidates.push({
        dsobj: snapshotView.headDatasetObj,
        label: `${snapshotView.datasetName} (head)`,
      })
    }

    snapshotRows.forEach(row => {
      if (seen.has(row.dsobj)) return
      seen.add(row.dsobj)
      candidates.push({
        dsobj: row.dsobj,
        label: `${snapshotView?.datasetName ?? 'dataset'}@${row.name}`,
      })
    })

    return candidates
  }, [snapshotRows, snapshotView])

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
    setSpacemapSummary(null)
    setSpacemapSummaryLoading(false)
    setSpacemapSummaryError(null)
    setSpacemapRanges([])
    setSpacemapRangesNext(null)
    setSpacemapRangesLoading(false)
    setSpacemapRangesError(null)
    setSpacemapOpFilter('all')
    setSpacemapMinLengthInput('')
    setSpacemapTxgMinInput('')
    setSpacemapTxgMaxInput('')
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

      if (state.mode === 'pool') {
        setLeftPaneTab('pool')
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

  const isPoolTab = leftPaneTab === 'pool'
  const isMosMode = leftPaneTab === 'mos'
  const isFsTab = leftPaneTab === 'fs'
  const isDatasetsTab = leftPaneTab === 'datasets'
  const isSnapshotsView = isDatasetsTab && snapshotView !== null
  const isFsMode = leftPaneTab === 'datasets' || leftPaneTab === 'fs'
  const poolMode = apiVersionInfo?.pool_open?.mode === 'offline' ? 'offline' : 'live'
  const poolModeLabel = poolMode === 'offline' ? 'Offline' : 'Live'
  const offlinePoolNames = apiVersionInfo?.pool_open?.offline_pools ?? []
  const modeToggleDisabled = modeSwitching || !apiVersionInfo
  const canGoBack =
    (isMosMode && navIndex > 0) || (isFsTab && fsHistoryIndex > 0)
  const canGoForward =
    (isMosMode && navIndex < navStack.length - 1) ||
    (isFsTab && fsHistoryIndex >= 0 && fsHistoryIndex < fsHistory.length - 1)

  const applyModePayload = useCallback((modeData: PoolModeResponse) => {
    setApiVersionInfo(prev => {
      if (!prev) {
        return prev
      }
      return {
        ...prev,
        pool_open: {
          mode: modeData.mode,
          offline_search_paths: modeData.offline_search_paths ?? null,
          offline_pools: modeData.offline_pools ?? [],
        },
      }
    })
  }, [])

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
    fetchJson<ApiVersionResponse>(`${API_BASE}/api/version`)
      .then(data => setApiVersionInfo(data))
      .catch(() => {
        setApiVersionInfo(null)
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
    setSnapshotCountsByDir({})
    setSnapshotCountLoadingByDir({})
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

  useEffect(() => {
    if (!selectedPool || !datasetTree) return

    const pending = visibleDatasetNodes
      .filter(node => isBrowsableDatasetNode(node))
      .map(node => node.dsl_dir_obj)
      .filter(
        dirObj =>
          snapshotCountsByDir[dirObj] === undefined &&
          !snapshotCountLoadingByDir[dirObj]
      )

    if (pending.length === 0) return

    const batch = pending.slice(0, 24)
    let cancelled = false

    setSnapshotCountLoadingByDir(prev => {
      const next = { ...prev }
      batch.forEach(dirObj => {
        next[dirObj] = true
      })
      return next
    })

    const queue = [...batch]
    const workerCount = Math.min(4, queue.length)

    const worker = async () => {
      while (!cancelled && queue.length > 0) {
        const dirObj = queue.shift()
        if (dirObj === undefined) break

        try {
          const data = await fetchJson<DatasetSnapshotCountResponse>(
            `${API_BASE}/api/pools/${encodeURIComponent(
              selectedPool
            )}/dataset/${dirObj}/snapshot-count`
          )
          if (cancelled) return
          setSnapshotCountsByDir(prev => ({
            ...prev,
            [dirObj]: Number.isFinite(data.count) ? data.count : null,
          }))
        } catch {
          if (cancelled) return
          setSnapshotCountsByDir(prev => ({ ...prev, [dirObj]: null }))
        } finally {
          if (cancelled) return
          setSnapshotCountLoadingByDir(prev => {
            const next = { ...prev }
            delete next[dirObj]
            return next
          })
        }
      }
    }

    void Promise.all(Array.from({ length: workerCount }, () => worker()))

    return () => {
      cancelled = true
    }
  }, [
    datasetTree,
    selectedPool,
    snapshotCountLoadingByDir,
    snapshotCountsByDir,
    visibleDatasetNodes,
  ])

  const fetchPoolSummary = async (pool: string) => {
    setPoolSummaryLoading(true)
    setPoolSummaryError(null)
    try {
      const data = await fetchJson<PoolSummaryResponse>(
        `${API_BASE}/api/pools/${encodeURIComponent(pool)}/summary`
      )
      setPoolSummary(data)
      setPoolTreeExpanded({ root: true })
    } catch (err) {
      setPoolSummary(null)
      setPoolSummaryError((err as Error).message)
    } finally {
      setPoolSummaryLoading(false)
    }
  }

  const fetchPoolErrors = async (
    pool: string,
    cursor = 0,
    append = false,
    resolvePaths = poolErrorsResolvePaths,
    limit = poolErrorsLimit
  ) => {
    setPoolErrorsLoading(true)
    if (!append) {
      setPoolErrorsError(null)
    }

    try {
      const normalizedLimit = Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : 200
      const params = new URLSearchParams()
      params.set('cursor', String(cursor))
      params.set('limit', String(normalizedLimit))
      params.set('resolve_paths', resolvePaths ? 'true' : 'false')

      const data = await fetchJson<PoolErrorsResponse>(
        `${API_BASE}/api/pools/${encodeURIComponent(pool)}/errors?${params.toString()}`
      )

      if (append) {
        setPoolErrors(prev => {
          if (!prev) return data
          const entries = [...prev.entries, ...data.entries]
          return {
            ...data,
            cursor: prev.cursor,
            count: entries.length,
            entries,
          }
        })
      } else {
        setPoolErrors(data)
        setPoolErrorsCursorInput(String(data.cursor))
      }
    } catch (err) {
      setPoolErrorsError((err as Error).message)
      if (!append) {
        setPoolErrors(null)
      }
    } finally {
      setPoolErrorsLoading(false)
    }
  }

  const toggleDatasetNode = (dirObj: number) => {
    setDatasetExpanded(prev => ({ ...prev, [dirObj]: !prev[dirObj] }))
  }

  const handlePoolErrorsJump = () => {
    if (!selectedPool) return
    const parsed = Number.parseInt(poolErrorsCursorInput.trim(), 10)
    if (!Number.isFinite(parsed) || parsed < 0) {
      setPoolErrorsError('Cursor must be a non-negative integer.')
      return
    }
    fetchPoolErrors(selectedPool, parsed, false, poolErrorsResolvePaths, poolErrorsLimit)
  }

  const handlePoolSelect = (pool: string) => {
    if (!pool) return
    setSelectedPool(pool)
    setSnapshotView(null)
    setSnapshotRows([])
    setSnapshotError(null)
    setSnapshotSearch('')
    setSnapshotViewMode('table')
    setSnapshotLineageDsobj(null)
    setSnapshotLineage(null)
    setSnapshotLineageLoading(false)
    setSnapshotLineageError(null)
    setNavStack([])
    setNavIndex(-1)
    setFsHistory([])
    setFsHistoryIndex(-1)
    if (leftPaneTab === 'pool') {
      commitBrowserState({ mode: 'pool', pool })
    } else if (leftPaneTab === 'mos') {
      commitBrowserState({ mode: 'mos', pool, objid: null }, 'replace')
    } else {
      commitBrowserState({ mode: 'datasets', pool })
    }
  }

  const setLeftPaneTabWithHistory = (mode: NavigatorMode) => {
    setLeftPaneTab(mode)
    if (mode !== 'datasets') {
      setSnapshotView(null)
      setSnapshotViewMode('table')
      setSnapshotLineageDsobj(null)
      setSnapshotLineage(null)
      setSnapshotLineageLoading(false)
      setSnapshotLineageError(null)
    }
    if (mode === 'pool') {
      commitBrowserState({ mode: 'pool', pool: selectedPool ?? null })
      return
    }
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
    const hasHeadDataset = isBrowsableDatasetNode(node)
    const snapshotCount = snapshotCountsByDir[node.dsl_dir_obj]
    const snapshotCountLoading = snapshotCountLoadingByDir[node.dsl_dir_obj] ?? false

    return (
      <div
        key={`${node.dsl_dir_obj}-${node.name}`}
        className={`dsl-item ${depth === 0 ? 'dsl-root' : ''}`}
        style={{ marginLeft: depth * 14 }}
      >
        <div className={`dsl-node ${depth > 0 ? 'dsl-node-child' : ''}`}>
          <button
            className={`dsl-toggle ${hasChildren ? (expanded ? 'expanded' : 'collapsed') : 'leaf'}`}
            onClick={() => toggleDatasetNode(node.dsl_dir_obj)}
            disabled={!hasChildren}
            aria-label={
              hasChildren
                ? expanded
                  ? `Collapse ${node.name}`
                  : `Expand ${node.name}`
                : `${node.name} has no children`
            }
            title={hasChildren ? (expanded ? 'Collapse' : 'Expand') : 'Leaf'}
          >
            {hasChildren ? (
              <span className="tree-toggle-glyph" aria-hidden>
                ▸
              </span>
            ) : (
              <span className="tree-toggle-leaf" aria-hidden>
                •
              </span>
            )}
          </button>
          <button
            className="dsl-name"
            onClick={() => enterFsFromDataset(node)}
            disabled={!hasHeadDataset}
            title={
              hasHeadDataset
                ? `Dataset ${fullName} (#${node.dsl_dir_obj})${mountHint}`
                : `${fullName} is a special/internal DSL directory`
            }
          >
            {node.name}
          </button>
          <button
            className="dsl-snapshots-btn"
            onClick={() =>
              void openSnapshotBrowser(
                node.dsl_dir_obj,
                fullName,
                node.head_dataset_obj
              )
            }
            disabled={!hasHeadDataset}
            title={
              hasHeadDataset
                ? snapshotCount !== undefined && snapshotCount !== null
                  ? `Open ${snapshotCount} snapshots for ${fullName}`
                  : `Open snapshots for ${fullName}`
                : `Snapshots unavailable for ${fullName}`
            }
          >
            <span>Snapshots</span>
            {hasHeadDataset && (snapshotCountLoading || snapshotCount !== undefined) && (
              <span
                className={`dsl-snapshots-count ${snapshotCountLoading ? 'loading' : ''}`}
                aria-label={
                  snapshotCountLoading
                    ? 'Loading snapshot count'
                    : snapshotCount === null
                    ? 'Snapshot count unavailable'
                    : `${snapshotCount} snapshots`
                }
              >
                {snapshotCountLoading ? '…' : snapshotCount === null ? '?' : snapshotCount}
              </span>
            )}
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

  const loadSnapshotMetadata = useCallback(
    async (pool: string, refs: DatasetSnapshotRef[]): Promise<SnapshotRecord[]> => {
      if (refs.length === 0) return []

      const queue = refs.map((entry, idx) => ({ entry, idx }))
      const rows: SnapshotRecord[] = new Array(refs.length)

      const worker = async () => {
        while (queue.length > 0) {
          const item = queue.shift()
          if (!item) break
          const { entry, idx } = item

          let row: SnapshotRecord = {
            name: entry.name,
            dsobj: entry.dsobj,
            creation_txg: null,
            creation_time: null,
            referenced_bytes: null,
            unique_bytes: null,
            deadlist_obj: null,
          }

          try {
            const info = await fetchJson<DnodeInfo>(
              `${API_BASE}/api/pools/${encodeURIComponent(pool)}/obj/${entry.dsobj}`
            )
            const bonus = info.bonus_decoded
            if (bonus && 'kind' in bonus && bonus.kind === 'dsl_dataset') {
              const dsBonus = bonus as BonusDecodedDslDataset
              row = {
                ...row,
                creation_txg: dsBonus.creation_txg,
                creation_time: dsBonus.creation_time,
                referenced_bytes: dsBonus.referenced_bytes,
                unique_bytes: dsBonus.unique_bytes,
                deadlist_obj: dsBonus.deadlist_obj,
              }
            }
          } catch {
            // Best-effort metadata hydration; keep row with base fields only.
          }

          rows[idx] = row
        }
      }

      const workers = Array.from({ length: Math.min(6, refs.length) }, () => worker())
      await Promise.all(workers)
      return rows
    },
    []
  )

  const openSnapshotBrowser = useCallback(
    async (dslDirObj: number, datasetName: string, headDatasetObj: number | null = null) => {
      if (!selectedPool) return
      setLeftPaneTabWithHistory('datasets')
      setSnapshotView({ dslDirObj, datasetName, headDatasetObj })
      setSnapshotRows([])
      setSnapshotViewMode('table')
      setSnapshotLineageDsobj(null)
      setSnapshotLineage(null)
      setSnapshotLineageError(null)
      setSnapshotSearch('')
      setSnapshotSort({ key: 'name', dir: 'asc' })
      setSnapshotLoading(true)
      setSnapshotError(null)

      const requestKey = `${selectedPool}:${dslDirObj}:${Date.now()}`
      snapshotRequestKey.current = requestKey

      try {
        const data = await fetchJson<DatasetSnapshotsResponse>(
          `${API_BASE}/api/pools/${encodeURIComponent(
            selectedPool
          )}/dataset/${dslDirObj}/snapshots`
        )

        const rows = await loadSnapshotMetadata(selectedPool, data.entries ?? [])
        if (snapshotRequestKey.current !== requestKey) return
        setSnapshotRows(rows)
        const defaultDsobj = headDatasetObj ?? rows[0]?.dsobj ?? null
        setSnapshotLineageDsobj(defaultDsobj)
      } catch (err) {
        if (snapshotRequestKey.current !== requestKey) return
        setSnapshotError((err as Error).message)
      } finally {
        if (snapshotRequestKey.current === requestKey) {
          setSnapshotLoading(false)
        }
      }
    },
    [selectedPool, loadSnapshotMetadata]
  )

  const loadSnapshotLineage = useCallback(
    async (dsobj: number, opts?: { switchMode?: boolean }) => {
      if (!selectedPool || !snapshotView) return
      if (opts?.switchMode) {
        setSnapshotViewMode('lineage')
      }
      setSnapshotLineageDsobj(dsobj)
      setSnapshotLineageLoading(true)
      setSnapshotLineageError(null)
      try {
        const data = await fetchJson<SnapshotLineageResponse>(
          `${API_BASE}/api/pools/${encodeURIComponent(
            selectedPool
          )}/snapshot/${dsobj}/lineage?max_prev=128&max_next=128`
        )
        setSnapshotLineage(data)
      } catch (err) {
        setSnapshotLineageError((err as Error).message)
      } finally {
        setSnapshotLineageLoading(false)
      }
    },
    [selectedPool, snapshotView]
  )

  const openSnapshotAsObject = useCallback(
    (row: SnapshotRecord) => {
      setLeftPaneTabWithHistory('mos')
      setInspectorTab('summary')
      navigateTo(row.dsobj, { reset: true })
    },
    [navigateTo]
  )

  const openSnapshotDsobjInFs = useCallback(
    async (dsobj: number, datasetLabel?: string) => {
      if (!selectedPool) return
      setSnapshotOpeningDsobj(dsobj)
      setFsError(null)
      try {
        const objsetData = await fetchJson<{ objset_id?: number }>(
          `${API_BASE}/api/pools/${encodeURIComponent(
            selectedPool
          )}/snapshot/${dsobj}/objset`
        )
        const objsetId = Number(objsetData.objset_id)
        if (!objsetId) {
          throw new Error('Missing objset_id for snapshot')
        }

        const rootData = await fetchJson<{ root_obj?: number }>(
          `${API_BASE}/api/pools/${encodeURIComponent(
            selectedPool
          )}/objset/${objsetId}/root`
        )
        const rootObj = Number(rootData.root_obj)
        if (!rootObj) {
          throw new Error('Missing root_obj for snapshot objset')
        }

        const datasetName = datasetLabel ?? snapshotDatasetLabel(dsobj)
        const baseState: FsLocation = {
          datasetName,
          mountpoint: null,
          mounted: null,
          dslDirObj: snapshotView?.dslDirObj ?? dsobj,
          headDatasetObj: dsobj,
          objsetId,
          rootObj,
          currentDir: rootObj,
          path: [{ name: datasetName, objid: rootObj, kind: 'dir' }],
        }

        setSnapshotView(null)
        setSnapshotViewMode('table')
        setSnapshotLineageDsobj(null)
        setSnapshotLineage(null)
        setSnapshotLineageLoading(false)
        setSnapshotLineageError(null)
        setLeftPaneTab('fs')
        setFsState(baseState)
        setFsPathInput('/')
        setFsCenterView('list')
        await fetchFsDir(objsetId, rootObj, baseState.path, {
          baseState,
          history: 'reset',
          browser: 'replace',
        })
      } catch (err) {
        setSnapshotError((err as Error).message)
      } finally {
        setSnapshotOpeningDsobj(null)
      }
    },
    [selectedPool, snapshotDatasetLabel, snapshotView, fetchFsDir]
  )

  const openSnapshotInFs = useCallback(
    async (row: SnapshotRecord) => {
      const label = snapshotView ? `${snapshotView.datasetName}@${row.name}` : undefined
      await openSnapshotDsobjInFs(row.dsobj, label)
    },
    [openSnapshotDsobjInFs, snapshotView]
  )

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
    setSnapshotView(null)
    setSnapshotViewMode('table')
    setSnapshotLineageDsobj(null)
    setSnapshotLineage(null)
    setSnapshotLineageLoading(false)
    setSnapshotLineageError(null)
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
    if (!datasetForMosIsBrowsable || !datasetForMos) return
    enterFsFromDataset(datasetForMos)
  }

  const resolveErrorDatasetNode = useCallback(
    (entry: PoolErrorEntry) =>
      datasetIndex.nodeByHeadDatasetObj.get(entry.dataset_obj) ??
      datasetIndex.nodeById.get(entry.dataset_obj) ??
      null,
    [datasetIndex]
  )

  const openPoolErrorAsObject = useCallback(
    (entry: PoolErrorEntry) => {
      setLeftPaneTab('mos')
      setInspectorTab('summary')
      navigateTo(entry.object, { reset: true })
    },
    [navigateTo]
  )

  const openPoolErrorInFs = useCallback(
    async (entry: PoolErrorEntry) => {
      const node = resolveErrorDatasetNode(entry)
      if (!node) return

      await enterFsFromDataset(node)

      if (!selectedPool) return
      try {
        const headData = await fetchJson<{ objset_id?: number }>(
          `${API_BASE}/api/pools/${encodeURIComponent(
            selectedPool
          )}/dataset/${node.dsl_dir_obj}/head`
        )
        const objsetId = Number(headData.objset_id)
        if (!objsetId) return

        const looksResolvedPath =
          typeof entry.path === 'string' && entry.path.trim().startsWith('/')
        const selectedName = looksResolvedPath
          ? entry.path!.trim()
          : `object #${entry.object}`

        setFsSelected({
          name: selectedName,
          objid: entry.object,
          type_name: 'unknown',
        })
        if (looksResolvedPath) {
          setFsPathInput(entry.path!.trim())
        }
        fetchFsStat(objsetId, entry.object)
      } catch (err) {
        console.warn('Failed to preload filesystem stat from error entry:', err)
      }
    },
    [enterFsFromDataset, fetchFsStat, resolveErrorDatasetNode, selectedPool]
  )

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

  const switchPoolMode = async (nextMode: 'live' | 'offline') => {
    if (modeSwitching || nextMode === poolMode) return

    setModeError(null)
    setModeSwitching(true)

    try {
      const modeData = await fetchJson<PoolModeResponse>(`${API_BASE}/api/mode`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: nextMode }),
      })

      applyModePayload(modeData)

      const nextPools = await fetchJson<string[]>(`${API_BASE}/api/pools`)
      setPools(nextPools)
      setError(null)

      const activePool =
        selectedPool && nextPools.includes(selectedPool)
          ? selectedPool
          : nextPools.length > 0
          ? nextPools[0]
          : null

      if (!activePool) {
        setSelectedPool(null)
        setPoolSummary(null)
        setPoolSummaryError(null)
        setPoolErrors(null)
        setPoolErrorsError(null)
        setPoolErrorsCursorInput('0')
        setDatasetTree(null)
        setDatasetError(null)
        setDatasetCatalog({})
        setDatasetExpanded({})
        setMosObjects([])
        setMosNext(null)
        setFsHistory([])
        setFsHistoryIndex(-1)
        setFsState(null)
        setFsEntries([])
        setFsError(null)
        setFsSelected(null)
        setFsStat(null)
        setLeftPaneTab('pool')
        commitBrowserState({ mode: 'pool', pool: null }, 'replace')
        return
      }

      const shouldReplacePool = activePool !== selectedPool
      if (shouldReplacePool) {
        setSelectedPool(activePool)
        if (leftPaneTab === 'pool') {
          commitBrowserState({ mode: 'pool', pool: activePool }, 'replace')
        } else if (leftPaneTab === 'mos') {
          commitBrowserState({ mode: 'mos', pool: activePool, objid: null }, 'replace')
        } else {
          commitBrowserState({ mode: 'datasets', pool: activePool }, 'replace')
        }
      } else {
        resetInspector()
        setNavStack([])
        setNavIndex(-1)
        setFsHistory([])
        setFsHistoryIndex(-1)
        setFsState(null)
        setFsEntries([])
        setFsError(null)
        setFsSelected(null)
        setFsStat(null)
        setPoolDetailsOpen(false)

        await Promise.all([
          fetchPoolSummary(activePool),
          fetchPoolErrors(activePool, 0, false, poolErrorsResolvePaths, poolErrorsLimit),
          fetchDatasetTree(activePool),
          fetchDatasetCatalog(activePool),
        ])
        await fetchMosObjects(0, false)

        if (leftPaneTab === 'pool') {
          commitBrowserState({ mode: 'pool', pool: activePool }, 'replace')
        } else if (leftPaneTab === 'mos') {
          commitBrowserState({ mode: 'mos', pool: activePool, objid: null }, 'replace')
        } else {
          commitBrowserState({ mode: 'datasets', pool: activePool }, 'replace')
        }
      }

      try {
        const versionData = await fetchJson<ApiVersionResponse>(`${API_BASE}/api/version`)
        setApiVersionInfo(versionData)
      } catch {
        applyModePayload(modeData)
      }
    } catch (err) {
      setModeError((err as Error).message)
    } finally {
      setModeSwitching(false)
    }
  }

  useEffect(() => {
    if (!selectedPool) {
      setPoolSummary(null)
      setPoolSummaryLoading(false)
      setPoolSummaryError(null)
      setPoolErrors(null)
      setPoolErrorsLoading(false)
      setPoolErrorsError(null)
      setPoolErrorsCursorInput('0')
      setPoolDetailsOpen(false)
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
      setSnapshotView(null)
      setSnapshotRows([])
      setSnapshotLoading(false)
      setSnapshotError(null)
      setSnapshotSearch('')
      setSnapshotSort({ key: 'name', dir: 'asc' })
      setSnapshotViewMode('table')
      setSnapshotLineageDsobj(null)
      setSnapshotLineage(null)
      setSnapshotLineageLoading(false)
      setSnapshotLineageError(null)
      setSnapshotCountsByDir({})
      setSnapshotCountLoadingByDir({})
      snapshotRequestKey.current = null
      setNavStack([])
      setNavIndex(-1)
      setShowBlkptrDetails(false)
      return
    }
    setSnapshotView(null)
    setSnapshotRows([])
    setSnapshotLoading(false)
    setSnapshotError(null)
    setSnapshotSearch('')
    setSnapshotViewMode('table')
    setSnapshotLineageDsobj(null)
    setSnapshotLineage(null)
    setSnapshotLineageLoading(false)
    setSnapshotLineageError(null)
    setSnapshotCountsByDir({})
    setSnapshotCountLoadingByDir({})
    snapshotRequestKey.current = null
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
    fetchPoolSummary(selectedPool)
    fetchDatasetTree(selectedPool)
    fetchDatasetCatalog(selectedPool)
  }, [selectedPool])

  useEffect(() => {
    if (!selectedPool) {
      return
    }
    fetchPoolErrors(selectedPool, 0, false, poolErrorsResolvePaths, poolErrorsLimit)
  }, [selectedPool, poolErrorsResolvePaths, poolErrorsLimit])

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

  const parseOptionalUnsigned = (raw: string, label: string): number | null => {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      throw new Error(`${label} must be a non-negative integer`)
    }
    return parsed
  }

  const fetchSpacemapSummary = async (objid: number) => {
    if (!selectedPool) return
    setSpacemapSummaryLoading(true)
    setSpacemapSummaryError(null)
    try {
      const summary = await fetchJson<SpacemapSummaryResponse>(
        `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/spacemap/${objid}/summary`
      )
      setSpacemapSummary(summary)
    } catch (err) {
      setSpacemapSummary(null)
      setSpacemapSummaryError((err as Error).message)
    } finally {
      setSpacemapSummaryLoading(false)
    }
  }

  const fetchSpacemapRanges = async (
    objid: number,
    cursor: number,
    append: boolean,
    overrides?: {
      op?: 'all' | 'alloc' | 'free'
      minLengthInput?: string
      txgMinInput?: string
      txgMaxInput?: string
    }
  ) => {
    if (!selectedPool) return

    const op = overrides?.op ?? spacemapOpFilter
    const minLengthRaw = overrides?.minLengthInput ?? spacemapMinLengthInput
    const txgMinRaw = overrides?.txgMinInput ?? spacemapTxgMinInput
    const txgMaxRaw = overrides?.txgMaxInput ?? spacemapTxgMaxInput

    let minLength = 0
    let txgMin: number | null = null
    let txgMax: number | null = null
    try {
      minLength = parseOptionalUnsigned(minLengthRaw, 'min_length') ?? 0
      txgMin = parseOptionalUnsigned(txgMinRaw, 'txg_min')
      txgMax = parseOptionalUnsigned(txgMaxRaw, 'txg_max')
      if (txgMin !== null && txgMax !== null && txgMin > txgMax) {
        throw new Error('txg_min must be <= txg_max')
      }
    } catch (err) {
      setSpacemapRangesError((err as Error).message)
      return
    }

    setSpacemapRangesLoading(true)
    setSpacemapRangesError(null)
    try {
      const params = new URLSearchParams()
      params.set('cursor', String(cursor))
      params.set('limit', String(SPACEMAP_PAGE_LIMIT))
      params.set('op', op)
      if (minLength > 0) params.set('min_length', String(minLength))
      if (txgMin !== null) params.set('txg_min', String(txgMin))
      if (txgMax !== null) params.set('txg_max', String(txgMax))

      const data = await fetchJson<SpacemapRangesResponse>(
        `${API_BASE}/api/pools/${encodeURIComponent(selectedPool)}/spacemap/${objid}/ranges?${params.toString()}`
      )
      setSpacemapRanges(prev => (append ? [...prev, ...data.ranges] : data.ranges))
      setSpacemapRangesNext(data.next)
    } catch (err) {
      setSpacemapRangesError((err as Error).message)
    } finally {
      setSpacemapRangesLoading(false)
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
    setSpacemapSummary(null)
    setSpacemapSummaryLoading(false)
    setSpacemapSummaryError(null)
    setSpacemapRanges([])
    setSpacemapRangesNext(null)
    setSpacemapRangesLoading(false)
    setSpacemapRangesError(null)
    setSpacemapOpFilter('all')
    setSpacemapMinLengthInput('')
    setSpacemapTxgMinInput('')
    setSpacemapTxgMaxInput('')
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
      if (isSpacemapDnode(infoData)) {
        setCenterView('spacemap')
      }
      if (!isSpacemapDnode(infoData) && inspectorTab === 'spacemap') {
        setInspectorTab('summary')
      }

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

  const applySpacemapFilters = () => {
    if (selectedObject === null) return
    fetchSpacemapRanges(selectedObject, 0, false)
  }

  const clearSpacemapFilters = () => {
    setSpacemapOpFilter('all')
    setSpacemapMinLengthInput('')
    setSpacemapTxgMinInput('')
    setSpacemapTxgMaxInput('')
    if (selectedObject === null) return
    fetchSpacemapRanges(selectedObject, 0, false, {
      op: 'all',
      minLengthInput: '',
      txgMinInput: '',
      txgMaxInput: '',
    })
  }

  const refreshSpacemap = () => {
    if (selectedObject === null) return
    fetchSpacemapSummary(selectedObject)
    fetchSpacemapRanges(selectedObject, 0, false)
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
    if (centerView === 'spacemap') {
      return 'spacemap'
    }
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

  const isSpacemapObject = useMemo(() => isSpacemapDnode(objectInfo), [objectInfo])

  const spacemapHistogramMax = useMemo(() => {
    if (!spacemapSummary || spacemapSummary.histogram.length === 0) return 0
    return Math.max(
      ...spacemapSummary.histogram.map(bucket => bucket.alloc_count + bucket.free_count),
      0
    )
  }, [spacemapSummary])

  const spacemapLargestRanges = useMemo(() => {
    return [...spacemapRanges]
      .sort((a, b) => b.length - a.length)
      .slice(0, 8)
  }, [spacemapRanges])

  const spacemapSmallestRanges = useMemo(() => {
    return [...spacemapRanges]
      .filter(range => range.length > 0)
      .sort((a, b) => a.length - b.length)
      .slice(0, 8)
  }, [spacemapRanges])

  const spacemapTopWindows = useMemo<SpacemapTopWindow[]>(() => {
    if (!spacemapSummary || spacemapRanges.length === 0) return []
    const binCount = 64
    const size = Math.max(1, spacemapSummary.size)
    const windowSize = Math.max(1, Math.floor(size / binCount))
    const windows = new Map<number, SpacemapTopWindow>()

    spacemapRanges.forEach(range => {
      const relative = Math.max(0, range.offset - spacemapSummary.start)
      const bucket = Math.min(binCount - 1, Math.floor(relative / windowSize))
      const existing = windows.get(bucket)
      if (existing) {
        existing.ops += 1
        if (range.op === 'alloc') {
          existing.alloc_bytes += range.length
        } else {
          existing.free_bytes += range.length
        }
        return
      }

      windows.set(bucket, {
        window_start: spacemapSummary.start + bucket * windowSize,
        window_end: spacemapSummary.start + (bucket + 1) * windowSize - 1,
        ops: 1,
        alloc_bytes: range.op === 'alloc' ? range.length : 0,
        free_bytes: range.op === 'free' ? range.length : 0,
      })
    })

    return Array.from(windows.values())
      .sort((a, b) => b.ops - a.ops)
      .slice(0, 8)
  }, [spacemapRanges, spacemapSummary])

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
    if (
      !selectedPool ||
      selectedObject === null ||
      !isSpacemapObject
    ) {
      return
    }

    const spacemapRequested =
      inspectorTab === 'spacemap' || effectiveCenterView === 'spacemap'
    if (!spacemapRequested) {
      return
    }

    if (!spacemapSummary && !spacemapSummaryLoading && !spacemapSummaryError) {
      fetchSpacemapSummary(selectedObject)
    }

    if (
      spacemapRanges.length === 0 &&
      !spacemapRangesLoading &&
      !spacemapRangesError &&
      spacemapRangesNext === null
    ) {
      fetchSpacemapRanges(selectedObject, 0, false)
    }
  }, [
    effectiveCenterView,
    inspectorTab,
    isSpacemapObject,
    selectedObject,
    selectedPool,
    spacemapRanges.length,
    spacemapRangesError,
    spacemapRangesLoading,
    spacemapRangesNext,
    spacemapSummary,
    spacemapSummaryError,
    spacemapSummaryLoading,
  ])

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

  const renderSpacemapPanel = (mode: 'center' | 'inspector') => (
    <div className={mode === 'center' ? 'spacemap-center' : 'inspector-section spacemap-section'}>
      {mode === 'center' && (
        <div className="spacemap-center-header">
          <h3>Spacemap Activity</h3>
          <span className="muted">Address-range transaction log view</span>
        </div>
      )}

      <div className="spacemap-toolbar">
        <button
          type="button"
          className="fs-action-btn"
          onClick={refreshSpacemap}
          disabled={selectedObject === null || spacemapSummaryLoading}
        >
          {spacemapSummaryLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="spacemap-filters">
        <label>
          Op
          <select
            className="pool-select spacemap-select"
            value={spacemapOpFilter}
            onChange={event =>
              setSpacemapOpFilter(event.target.value as 'all' | 'alloc' | 'free')
            }
          >
            <option value="all">all</option>
            <option value="alloc">alloc</option>
            <option value="free">free</option>
          </select>
        </label>
        <label>
          Min length
          <input
            className="spacemap-input"
            type="text"
            placeholder="0 or 0x1000"
            value={spacemapMinLengthInput}
            onChange={event => setSpacemapMinLengthInput(event.target.value)}
          />
        </label>
        <label>
          TXG min
          <input
            className="spacemap-input"
            type="text"
            placeholder="optional"
            value={spacemapTxgMinInput}
            onChange={event => setSpacemapTxgMinInput(event.target.value)}
          />
        </label>
        <label>
          TXG max
          <input
            className="spacemap-input"
            type="text"
            placeholder="optional"
            value={spacemapTxgMaxInput}
            onChange={event => setSpacemapTxgMaxInput(event.target.value)}
          />
        </label>
        <div className="spacemap-filter-actions">
          <button type="button" className="fs-action-btn" onClick={applySpacemapFilters}>
            Apply
          </button>
          <button type="button" className="fs-action-btn" onClick={clearSpacemapFilters}>
            Clear
          </button>
        </div>
      </div>

      {spacemapSummaryError && (
        <div className="error">
          <strong>Summary:</strong> {spacemapSummaryError}
        </div>
      )}
      {spacemapRangesError && (
        <div className="error">
          <strong>Ranges:</strong> {spacemapRangesError}
        </div>
      )}

      {spacemapSummaryLoading && <p className="muted">Loading spacemap summary…</p>}
      {spacemapSummary && (
        <>
          <dl className="info-grid">
            <div>
              <dt>Object</dt>
              <dd>{spacemapSummary.object}</dd>
            </div>
            <div>
              <dt>Shift</dt>
              <dd>{spacemapSummary.shift}</dd>
            </div>
            <div>
              <dt>Start</dt>
              <dd>{formatAddr(spacemapSummary.start)}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatAddr(spacemapSummary.size)}</dd>
            </div>
            <div>
              <dt>Entries</dt>
              <dd>{spacemapSummary.range_entries}</dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>{formatAddr(spacemapSummary.length)}</dd>
            </div>
            <div>
              <dt>Alloc Bytes</dt>
              <dd>{formatAddr(spacemapSummary.alloc_bytes)}</dd>
            </div>
            <div>
              <dt>Free Bytes</dt>
              <dd>{formatAddr(spacemapSummary.free_bytes)}</dd>
            </div>
            <div>
              <dt>Net Bytes</dt>
              <dd>{formatAddr(spacemapSummary.net_bytes)}</dd>
            </div>
            <div>
              <dt>TXG Span</dt>
              <dd>
                {spacemapSummary.txg_min !== null && spacemapSummary.txg_max !== null
                  ? `${spacemapSummary.txg_min} – ${spacemapSummary.txg_max}`
                  : '—'}
              </dd>
            </div>
          </dl>

          <div className="spacemap-histogram">
            <h3>Distribution</h3>
            {spacemapSummary.histogram.length === 0 ? (
              <p className="muted">No histogram buckets.</p>
            ) : (
              <div className="spacemap-hist-list">
                {spacemapSummary.histogram.map(bucket => {
                  const total = bucket.alloc_count + bucket.free_count
                  const width =
                    spacemapHistogramMax > 0
                      ? `${(total / spacemapHistogramMax) * 100}%`
                      : '0%'
                  return (
                    <div
                      className="spacemap-hist-row"
                      key={`${bucket.bucket}-${bucket.min_length}`}
                    >
                      <div className="spacemap-hist-label">
                        {formatAddr(bucket.min_length)}
                        {' - '}
                        {bucket.max_length === null
                          ? '∞'
                          : formatAddr(bucket.max_length)}
                      </div>
                      <div className="spacemap-hist-bar-wrap">
                        <div className="spacemap-hist-bar" style={{ width }} />
                      </div>
                      <div className="spacemap-hist-count">
                        {bucket.alloc_count}/{bucket.free_count}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      <div className="spacemap-top-grid">
        <div className="spacemap-top-card">
          <h3>Largest ranges</h3>
          {spacemapLargestRanges.length === 0 ? (
            <p className="muted">No ranges loaded.</p>
          ) : (
            <ul>
              {spacemapLargestRanges.map(range => (
                <li key={`largest-${range.index}`}>
                  #{range.index} · {range.op} · len {formatAddr(range.length)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="spacemap-top-card">
          <h3>Smallest ranges</h3>
          {spacemapSmallestRanges.length === 0 ? (
            <p className="muted">No ranges loaded.</p>
          ) : (
            <ul>
              {spacemapSmallestRanges.map(range => (
                <li key={`smallest-${range.index}`}>
                  #{range.index} · {range.op} · len {formatAddr(range.length)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="spacemap-top-card">
          <h3>Highest-op windows</h3>
          {spacemapTopWindows.length === 0 ? (
            <p className="muted">No windows yet.</p>
          ) : (
            <ul>
              {spacemapTopWindows.map((window, idx) => (
                <li key={`window-${idx}`}>
                  {formatAddr(window.window_start)} - {formatAddr(window.window_end)}
                  {' · '}ops {window.ops}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="spacemap-ranges">
        <div className="spacemap-ranges-header">
          <span>#</span>
          <span>Op</span>
          <span>Offset</span>
          <span>Length</span>
          <span>TXG</span>
          <span>VDEV</span>
        </div>
        {spacemapRanges.length === 0 && !spacemapRangesLoading ? (
          <div className="spacemap-ranges-empty">No ranges for current filter.</div>
        ) : (
          spacemapRanges.map(range => (
            <div className="spacemap-ranges-row" key={`range-${range.index}`}>
              <span>{range.index}</span>
              <span>{range.op}</span>
              <span>{formatAddr(range.offset)}</span>
              <span>{formatAddr(range.length)}</span>
              <span>{range.txg ?? '—'}</span>
              <span>{range.vdev ?? '—'}</span>
            </div>
          ))
        )}
      </div>

      {spacemapRangesLoading && <p className="muted">Loading ranges…</p>}
      {spacemapRangesNext !== null && !spacemapRangesLoading && selectedObject !== null && (
        <button
          className="load-more"
          onClick={() => fetchSpacemapRanges(selectedObject, spacemapRangesNext, true)}
        >
          Load more ranges
        </button>
      )}
    </div>
  )

  const togglePoolTreeNode = (path: string) => {
    setPoolTreeExpanded(prev => ({ ...prev, [path]: !prev[path] }))
  }

  const handleCopyPoolSummary = async () => {
    if (!poolSummary) return
    try {
      await navigator.clipboard.writeText(poolSummaryToZdb(poolSummary))
      setPoolSummaryCopied(true)
      setTimeout(() => setPoolSummaryCopied(false), 2000)
    } catch (err) {
      setPoolSummaryError((err as Error).message)
    }
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

  const handleCopyDebugInfo = async () => {
    setDebugCopyError(null)
    try {
      const versionInfo = await fetchJson<ApiVersionResponse>(`${API_BASE}/api/version`)
      const payload = {
        captured_at_utc: new Date().toISOString(),
        backend: versionInfo,
        frontend: {
          api_base: API_BASE,
          user_agent: navigator.userAgent,
          left_pane_tab: leftPaneTab,
          format_mode: formatMode,
          selected_pool: selectedPool,
          selected_object: selectedObject,
          selected_object_type: objectInfo?.type?.name ?? null,
          inspector_tab: isPoolTab ? 'pool' : isFsMode ? 'filesystem' : inspectorTab,
          raw_view: rawView,
          fs_state: fsState
            ? {
                dataset_name: fsState.datasetName,
                mountpoint: fsState.mountpoint,
                mounted: fsState.mounted,
                dsl_dir_obj: fsState.dslDirObj,
                objset_id: fsState.objsetId,
                current_dir_obj: fsState.currentDir,
                path: fsState.path.map(seg => ({
                  name: seg.name,
                  objid: seg.objid,
                  kind: seg.kind ?? null,
                })),
              }
            : null,
        },
      }
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setDebugCopied(true)
      setTimeout(() => setDebugCopied(false), 2000)
    } catch (err) {
      setDebugCopyError((err as Error).message)
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

  const renderPoolVdevNode = (
    node: Record<string, unknown>,
    path: string,
    depth: number
  ) => {
    const children = extractVdevChildren(node)
    const hasChildren = children.length > 0
    const expanded = poolTreeExpanded[path] ?? depth === 0
    const typeName = typeof node.type === 'string' ? node.type : 'vdev'
    const idText =
      typeof node.id === 'number' || typeof node.id === 'string' ? ` #${node.id}` : ''
    const detailKeys = [
      'guid',
      'ashift',
      'asize',
      'metaslab_shift',
      'metaslab_array',
      'path',
      'devid',
      'phys_path',
      'vdev_enc_sysfs_path',
      'create_txg',
      'whole_disk',
      'is_log',
      'com.klarasystems:vdev_zap_root',
      'com.delphix:vdev_zap_top',
      'com.delphix:vdev_zap_leaf',
    ]
    const detailEntries = detailKeys
      .filter(key => key in node)
      .map(key => ({
        key,
        value: scalarToZdb(node[key]),
      }))

    return (
      <div
        key={path}
        className={`pool-vdev-node ${depth === 0 ? 'root' : 'child'}`}
        style={{ marginLeft: depth * 14 }}
      >
        <div className={`pool-vdev-head ${depth > 0 ? 'pool-vdev-head-child' : ''}`}>
          <button
            type="button"
            className={`pool-vdev-toggle ${hasChildren ? (expanded ? 'expanded' : 'collapsed') : 'leaf'}`}
            onClick={() => togglePoolTreeNode(path)}
            disabled={!hasChildren}
            title={hasChildren ? (expanded ? 'Collapse children' : 'Expand children') : 'Leaf'}
            aria-label={
              hasChildren
                ? expanded
                  ? `Collapse ${typeName}${idText}`
                  : `Expand ${typeName}${idText}`
                : `${typeName}${idText} is a leaf`
            }
          >
            {hasChildren ? (
              <span className="tree-toggle-glyph" aria-hidden>
                ▸
              </span>
            ) : (
              <span className="tree-toggle-leaf" aria-hidden>
                •
              </span>
            )}
          </button>
          <span className="pool-vdev-title">
            {typeName}
            {idText}
          </span>
        </div>

        {detailEntries.length > 0 && (
          <div className="pool-vdev-meta-table">
            {detailEntries.map(({ key, value }) => (
              <div key={`${path}:${key}`} className="pool-vdev-meta-row">
                <span className="pool-vdev-meta-key">{key}</span>
                <span className="pool-vdev-meta-value">{value}</span>
              </div>
            ))}
          </div>
        )}

        {expanded &&
          hasChildren &&
          children.map((child, idx) => renderPoolVdevNode(child, `${path}.${idx}`, depth + 1))}
      </div>
    )
  }

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
          <p className="subtitle">Milestone 7: Spacemap Visualizer</p>
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
            <span>Mode</span>
            <div className="format-toggle">
              <button
                type="button"
                className={poolMode === 'live' ? 'toggle active' : 'toggle'}
                onClick={() => switchPoolMode('live')}
                disabled={modeToggleDisabled}
                title="Use imported pools via libzfs"
              >
                Live
              </button>
              <button
                type="button"
                className={poolMode === 'offline' ? 'toggle active' : 'toggle'}
                onClick={() => switchPoolMode('offline')}
                disabled={modeToggleDisabled}
                title="Use exported pool files/devices (experimental)"
              >
                Offline
              </button>
            </div>
          </div>
          <div className="status-item">
            <span>Pool</span>
            {selectedPool ? (
              <button
                type="button"
                className="status-link"
                onClick={() => setPoolDetailsOpen(true)}
                title="Open pool details"
              >
                {selectedPool}
              </button>
            ) : (
              <strong>none</strong>
            )}
          </div>
        </div>
      </header>

      <div className="safety-banner" role="status" aria-live="polite">
        <strong>Read-only mode:</strong>{' '}
        {poolMode === 'offline'
          ? 'offline/exported pool analysis (experimental).'
          : 'live imported pools only.'}
        {poolMode === 'offline' && offlinePoolNames.length > 0 && (
          <> Configured pools: {offlinePoolNames.join(', ')}.</>
        )}
      </div>

      {modeError && (
        <div className="safety-banner error-banner" role="alert">
          <strong>Mode switch failed:</strong> {modeError}
        </div>
      )}

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
              setFsHistory([])
              setFsHistoryIndex(-1)
              setLeftPaneTabWithHistory('pool')
            }}
            title={`Pool ${selectedPool}`}
          >
            Pool {selectedPool}
          </button>
        ) : (
          <span className="crumb muted">No pool selected</span>
        )}
        <span className="crumb-sep">→</span>
        {isPoolTab && <span className="crumb active">Pool</span>}
        {isDatasetsTab && !isSnapshotsView && <span className="crumb active">Datasets</span>}
        {isSnapshotsView && snapshotView && (
          <>
            <button
              className="crumb"
              onClick={() => {
                setSnapshotView(null)
                setSnapshotRows([])
                setSnapshotError(null)
                setSnapshotSearch('')
                setSnapshotViewMode('table')
                setSnapshotLineageDsobj(null)
                setSnapshotLineage(null)
                setSnapshotLineageLoading(false)
                setSnapshotLineageError(null)
              }}
              title="Back to dataset tree"
            >
              Datasets
            </button>
            <span className="crumb-sep">→</span>
            <span className="crumb active">Snapshots</span>
            <span className="crumb-sep">→</span>
            <span className="crumb active" title={`DSL dir ${snapshotView.dslDirObj}`}>
              {snapshotView.datasetName}
            </span>
          </>
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
              className={`tab ${isPoolTab ? 'active' : ''}`}
              onClick={() => setLeftPaneTabWithHistory('pool')}
            >
              Pool
            </button>
            <button
              className={`tab ${isDatasetsTab || isFsTab ? 'active' : ''}`}
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
              {!isPoolTab && renderPinnedSection()}
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

              {isPoolTab && selectedPool && (
                <div className="pool-overview">
                  <h3>Pool Summary</h3>
                  {poolSummaryLoading && <p className="muted">Loading pool summary...</p>}
                  {poolSummaryError && <p className="muted">Error: {poolSummaryError}</p>}
                  {poolSummary && (
                    <>
                      <dl className="pool-overview-grid">
                        <div>
                          <dt>State</dt>
                          <dd>{poolSummary.pool.state}</dd>
                        </div>
                        <div>
                          <dt>TXG</dt>
                          <dd>{poolSummary.pool.txg}</dd>
                        </div>
                        <div>
                          <dt>Version</dt>
                          <dd>{poolSummary.pool.version}</dd>
                        </div>
                        <div>
                          <dt>GUID</dt>
                          <dd>{poolSummary.pool.guid}</dd>
                        </div>
                        <div>
                          <dt>Errata</dt>
                          <dd>{poolSummary.pool.errata}</dd>
                        </div>
                        <div>
                          <dt>Features</dt>
                          <dd>{poolSummary.features_for_read.length}</dd>
                        </div>
                      </dl>
                      <div className="pool-overview-errors">
                        <span>Persistent errors</span>
                        <strong>{poolErrors ? poolErrors.error_count.toLocaleString() : '—'}</strong>
                        {poolErrorsLoading && <span className="muted">loading…</span>}
                      </div>
                      {poolErrorsError && (
                        <p className="muted">Error log: {poolErrorsError}</p>
                      )}
                      <div className="pool-overview-actions">
                        <button
                          type="button"
                          className={`fs-action-btn ${poolSummaryCopied ? 'active' : ''}`}
                          onClick={handleCopyPoolSummary}
                        >
                          {poolSummaryCopied ? 'Copied' : 'Copy zdb-like'}
                        </button>
                        <button
                          type="button"
                          className="fs-action-btn"
                          onClick={() => setPoolDetailsOpen(true)}
                        >
                          Pool details
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {!isPoolTab && selectedPool && (
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
          {isPoolTab ? (
            <>
              <div className="panel-header graph-header">
                <div>
                  <h2>Pool Summary</h2>
                  <span className="muted">
                    {selectedPool ? `${selectedPool} · zdb-style config overview` : 'No pool selected'}
                  </span>
                </div>
                <div className="graph-controls">
                  <button
                    className="graph-btn"
                    type="button"
                    onClick={() => selectedPool && fetchPoolSummary(selectedPool)}
                    disabled={!selectedPool || poolSummaryLoading}
                  >
                    {poolSummaryLoading ? 'Refreshing…' : 'Refresh'}
                  </button>
                  <button
                    className={`graph-btn ${poolSummaryCopied ? 'active' : ''}`}
                    type="button"
                    onClick={handleCopyPoolSummary}
                    disabled={!poolSummary}
                  >
                    {poolSummaryCopied ? 'Copied' : 'Copy zdb-like'}
                  </button>
                  <button
                    className="graph-btn"
                    type="button"
                    onClick={() => setPoolDetailsOpen(true)}
                    disabled={!poolSummary}
                  >
                    Details
                  </button>
                </div>
              </div>

              {poolSummaryError && (
                <div className="error">
                  <strong>Error:</strong> {poolSummaryError}
                </div>
              )}

              {poolSummaryLoading && <p className="muted">Loading pool summary...</p>}

              {!poolSummaryLoading && !poolSummary && !poolSummaryError && (
                <p className="muted">Select a pool to inspect its configuration.</p>
              )}

              {poolSummary && (
                <div className="pool-summary-center">
                  <div className="pool-summary-table">
                    <div className="pool-summary-row">
                      <span className="pool-summary-key">Name</span>
                      <span className="pool-summary-value">{poolSummary.pool.name}</span>
                    </div>
                    <div className="pool-summary-row">
                      <span className="pool-summary-key">State</span>
                      <span className="pool-summary-value">{poolSummary.pool.state}</span>
                    </div>
                    <div className="pool-summary-row">
                      <span className="pool-summary-key">TXG</span>
                      <span className="pool-summary-value">{poolSummary.pool.txg}</span>
                    </div>
                    <div className="pool-summary-row">
                      <span className="pool-summary-key">Version</span>
                      <span className="pool-summary-value">{poolSummary.pool.version}</span>
                    </div>
                    <div className="pool-summary-row">
                      <span className="pool-summary-key">Features</span>
                      <span className="pool-summary-value">
                        {poolSummary.features_for_read.length}
                      </span>
                    </div>
                    <div className="pool-summary-row">
                      <span className="pool-summary-key">Host</span>
                      <span className="pool-summary-value">
                        {poolSummary.pool.hostname ?? '(none)'}
                      </span>
                    </div>
                    <div className="pool-summary-row pool-summary-row-wide">
                      <span className="pool-summary-key">GUID</span>
                      <span className="pool-summary-value">{poolSummary.pool.guid}</span>
                    </div>
                    <div className="pool-summary-row">
                      <span className="pool-summary-key">Errata</span>
                      <span className="pool-summary-value">{poolSummary.pool.errata}</span>
                    </div>
                  </div>

                  <div className="pool-vdev-tree">
                    <h3>Vdev Tree</h3>
                    {poolSummary.vdev_tree ? (
                      renderPoolVdevNode(poolSummary.vdev_tree, 'root', 0)
                    ) : (
                      <p className="muted">No vdev tree available.</p>
                    )}
                  </div>

                  {selectedPool && (
                    <div className="pool-errors">
                      <div className="pool-errors-header">
                        <h3>Persistent Errors</h3>
                        <div className="pool-errors-actions">
                          <label className="pool-errors-resolve">
                            <input
                              type="checkbox"
                              checked={poolErrorsResolvePaths}
                              onChange={e => setPoolErrorsResolvePaths(e.target.checked)}
                            />
                            Resolve paths
                          </label>
                          <label className="pool-errors-limit">
                            Limit
                            <select
                              value={poolErrorsLimit}
                              onChange={e => setPoolErrorsLimit(Number(e.target.value))}
                            >
                              {[50, 100, 200, 500, 1000].map(size => (
                                <option key={size} value={size}>
                                  {size}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="pool-errors-cursor">
                            Cursor
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={poolErrorsCursorInput}
                              onChange={e => setPoolErrorsCursorInput(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  handlePoolErrorsJump()
                                }
                              }}
                            />
                          </label>
                          <button
                            className="graph-btn"
                            type="button"
                            onClick={handlePoolErrorsJump}
                            disabled={poolErrorsLoading || !selectedPool}
                          >
                            Go
                          </button>
                          <button
                            className="graph-btn"
                            type="button"
                            onClick={() => {
                              setPoolErrorsCursorInput('0')
                              if (selectedPool) {
                                fetchPoolErrors(selectedPool, 0, false, poolErrorsResolvePaths, poolErrorsLimit)
                              }
                            }}
                            disabled={poolErrorsLoading || !selectedPool}
                          >
                            First
                          </button>
                          <button
                            className="graph-btn"
                            type="button"
                            onClick={() =>
                              fetchPoolErrors(
                                selectedPool,
                                Number.parseInt(poolErrorsCursorInput, 10) || 0,
                                false,
                                poolErrorsResolvePaths,
                                poolErrorsLimit
                              )
                            }
                            disabled={poolErrorsLoading}
                          >
                            {poolErrorsLoading ? 'Refreshing…' : 'Refresh errors'}
                          </button>
                        </div>
                      </div>

                      <div className="pool-errors-meta">
                        <span>
                          Error count: <strong>{poolErrors?.error_count.toLocaleString() ?? '—'}</strong>
                        </span>
                        <span>
                          Approx entries: <strong>{poolErrors?.approx_entries.toLocaleString() ?? '—'}</strong>
                        </span>
                        <span>
                          Range:{' '}
                          <strong>
                            {poolErrors
                              ? `${poolErrors.cursor.toLocaleString()}-${Math.max(
                                  poolErrors.cursor,
                                  poolErrors.cursor + Math.max(poolErrors.count - 1, 0)
                                ).toLocaleString()}`
                              : '—'}
                          </strong>
                        </span>
                        <span>
                          Next cursor: <strong>{poolErrors?.next ?? 'none'}</strong>
                        </span>
                      </div>

                      {poolErrorsError && (
                        <div className="error">
                          <strong>Error:</strong> {poolErrorsError}
                        </div>
                      )}

                      {poolErrors && poolErrors.entries.length > 0 ? (
                        <div className="pool-errors-table">
                          <div className="pool-errors-row pool-errors-head">
                            <span>Source</span>
                            <span>Dataset</span>
                            <span>Object</span>
                            <span>Level</span>
                            <span>Blkid</span>
                            <span>Path</span>
                            <span>Actions</span>
                          </div>
                          {poolErrors.entries.map((entry, idx) => {
                            const datasetNode = resolveErrorDatasetNode(entry)
                            const datasetName =
                              datasetNode &&
                              (datasetIndex.fullNameById.get(datasetNode.dsl_dir_obj) ??
                                datasetNode.name)
                            return (
                              <div
                                key={`${entry.source}-${entry.dataset_obj}-${entry.object}-${entry.level}-${entry.blkid}-${idx}`}
                                className="pool-errors-row"
                              >
                                <span>{entry.source}</span>
                                <span
                                  title={
                                    datasetName
                                      ? `${datasetName} (objset ${entry.dataset_obj})`
                                      : `objset ${entry.dataset_obj}`
                                  }
                                >
                                  {datasetName
                                    ? `${datasetName} #${entry.dataset_obj}`
                                    : `#${entry.dataset_obj}`}
                                </span>
                                <span>#{entry.object}</span>
                                <span>{entry.level}</span>
                                <span>{entry.blkid}</span>
                                <span className="pool-errors-path">
                                  {entry.path ?? '(unresolved)'}
                                </span>
                                <span className="pool-errors-row-actions">
                                  <button
                                    className="pool-errors-action-btn"
                                    type="button"
                                    onClick={() => openPoolErrorAsObject(entry)}
                                    title="Open object in MOS view"
                                  >
                                    MOS
                                  </button>
                                  <button
                                    className="pool-errors-action-btn"
                                    type="button"
                                    onClick={() => {
                                      void openPoolErrorInFs(entry)
                                    }}
                                    disabled={!datasetNode}
                                    title={
                                      datasetNode
                                        ? 'Open dataset in filesystem view and inspect object'
                                        : 'Dataset not available in dataset tree'
                                    }
                                  >
                                    FS
                                  </button>
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        !poolErrorsLoading && (
                          <p className="muted">No persistent error entries returned.</p>
                        )
                      )}

                      {poolErrors?.next !== null && (
                        <button
                          className="load-more"
                          onClick={() =>
                            fetchPoolErrors(
                              selectedPool,
                              poolErrors?.next ?? 0,
                              true,
                              poolErrorsResolvePaths,
                              poolErrorsLimit
                            )
                          }
                          disabled={poolErrorsLoading}
                        >
                          {poolErrorsLoading ? 'Loading…' : 'Load more errors'}
                        </button>
                      )}
                    </div>
                  )}

                  <div className="pool-summary-foot">
                    <span>Uberblock TXG {poolSummary.uberblock.txg}</span>
                    <span>
                      Timestamp{' '}
                      {poolSummary.uberblock.timestamp
                        ? new Date(poolSummary.uberblock.timestamp * 1000).toLocaleString()
                        : '(unknown)'}
                    </span>
                  </div>
                </div>
              )}
            </>
          ) : !isMosMode ? (
            isSnapshotsView && snapshotView ? (
              <>
                <div className="panel-header graph-header">
                  <div>
                    <h2>Snapshots</h2>
                    <span className="muted">
                      {snapshotView.datasetName} · {snapshotRows.length} snapshot
                      {snapshotRows.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="graph-controls">
                    <div className="graph-view-toggle">
                      <button
                        className={`graph-btn ${snapshotViewMode === 'table' ? 'active' : ''}`}
                        type="button"
                        onClick={() => setSnapshotViewMode('table')}
                      >
                        Table
                      </button>
                      <button
                        className={`graph-btn ${snapshotViewMode === 'lineage' ? 'active' : ''}`}
                        type="button"
                        onClick={() => {
                          const target = snapshotLineageDsobj ?? snapshotView.headDatasetObj
                          if (target) {
                            void loadSnapshotLineage(target, { switchMode: true })
                          } else {
                            setSnapshotViewMode('lineage')
                          }
                        }}
                        disabled={snapshotRows.length === 0 && snapshotView.headDatasetObj === null}
                      >
                        Lineage
                      </button>
                    </div>
                    {snapshotViewMode === 'table' ? (
                      <>
                        <input
                          className="graph-search"
                          placeholder="Filter by snapshot name or object id"
                          value={snapshotSearch}
                          onChange={e => setSnapshotSearch(e.target.value)}
                        />
                        <select
                          className="graph-select"
                          value={snapshotSort.key}
                          onChange={e =>
                            setSnapshotSort(prev => ({
                              ...prev,
                              key: e.target.value as
                                | 'name'
                                | 'dsobj'
                                | 'creation_txg'
                                | 'creation_time'
                                | 'referenced_bytes'
                                | 'unique_bytes',
                            }))
                          }
                        >
                          <option value="name">Name</option>
                          <option value="dsobj">Object</option>
                          <option value="creation_txg">Creation TXG</option>
                          <option value="creation_time">Creation Time</option>
                          <option value="referenced_bytes">Referenced</option>
                          <option value="unique_bytes">Unique</option>
                        </select>
                        <button
                          className="graph-btn"
                          type="button"
                          onClick={() =>
                            setSnapshotSort(prev => ({
                              ...prev,
                              dir: prev.dir === 'asc' ? 'desc' : 'asc',
                            }))
                          }
                        >
                          {snapshotSort.dir === 'asc' ? '↑' : '↓'}
                        </button>
                        {snapshotSearch && (
                          <button
                            className="graph-btn"
                            type="button"
                            onClick={() => setSnapshotSearch('')}
                          >
                            Clear
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <select
                          className="graph-select"
                          value={snapshotLineageDsobj ?? ''}
                          onChange={e => {
                            const next = Number(e.target.value)
                            if (next) {
                              void loadSnapshotLineage(next)
                            }
                          }}
                        >
                          <option value="" disabled>
                            Select snapshot object
                          </option>
                          {snapshotLineageCandidates.map(candidate => (
                            <option key={candidate.dsobj} value={candidate.dsobj}>
                              {candidate.label} (#{candidate.dsobj})
                            </option>
                          ))}
                        </select>
                        <button
                          className="graph-btn"
                          type="button"
                          onClick={() => {
                            if (snapshotLineageDsobj) {
                              void loadSnapshotLineage(snapshotLineageDsobj)
                            }
                          }}
                          disabled={!snapshotLineageDsobj || snapshotLineageLoading}
                        >
                          {snapshotLineageLoading ? 'Loading…' : 'Refresh lineage'}
                        </button>
                        <button
                          className="graph-btn"
                          type="button"
                          onClick={() => {
                            const oldest = snapshotLineage?.entries[0]
                            if (oldest) {
                              void loadSnapshotLineage(oldest.dsobj)
                            }
                          }}
                          disabled={!snapshotLineage || snapshotLineage.entries.length === 0}
                        >
                          Oldest
                        </button>
                        <button
                          className="graph-btn"
                          type="button"
                          onClick={() => {
                            const entries = snapshotLineage?.entries ?? []
                            const newest = entries.length ? entries[entries.length - 1] : null
                            if (newest) {
                              void loadSnapshotLineage(newest.dsobj)
                            }
                          }}
                          disabled={!snapshotLineage || snapshotLineage.entries.length === 0}
                        >
                          Newest
                        </button>
                        <button
                          className="graph-btn"
                          type="button"
                          onClick={() => {
                            if (snapshotView.headDatasetObj) {
                              void loadSnapshotLineage(snapshotView.headDatasetObj)
                            }
                          }}
                          disabled={snapshotView.headDatasetObj === null}
                        >
                          Parent
                        </button>
                      </>
                    )}
                    <button
                      className="graph-btn"
                      type="button"
                      onClick={() => {
                        if (snapshotViewMode === 'lineage' && snapshotLineageDsobj) {
                          void loadSnapshotLineage(snapshotLineageDsobj)
                        } else {
                          void openSnapshotBrowser(
                            snapshotView.dslDirObj,
                            snapshotView.datasetName,
                            snapshotView.headDatasetObj
                          )
                        }
                      }}
                      disabled={snapshotLoading || snapshotLineageLoading}
                    >
                      {snapshotViewMode === 'lineage'
                        ? snapshotLineageLoading
                          ? 'Refreshing…'
                          : 'Refresh'
                        : snapshotLoading
                        ? 'Refreshing…'
                        : 'Refresh'}
                    </button>
                    <button
                      className="graph-btn"
                      type="button"
                      onClick={() => {
                        setSnapshotView(null)
                        setSnapshotRows([])
                        setSnapshotError(null)
                        setSnapshotLineage(null)
                        setSnapshotLineageLoading(false)
                        setSnapshotLineageError(null)
                        setSnapshotLineageDsobj(null)
                        setSnapshotViewMode('table')
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>
                {snapshotLoading && <p className="muted">Loading snapshots...</p>}
                {snapshotError && (
                  <div className="error">
                    <strong>Error:</strong> {snapshotError}
                  </div>
                )}
                <div className="graph">
                  {snapshotViewMode === 'lineage' ? (
                    <div className="fs-center-list">
                      {snapshotLineageError && (
                        <div className="error">
                          <strong>Error:</strong> {snapshotLineageError}
                        </div>
                      )}
                      {snapshotLineageLoading && <p className="muted">Loading lineage...</p>}
                      {!snapshotLineageLoading && snapshotLineage && (
                        <div className="fs-table snapshot-table">
                          <div className="fs-row fs-header snapshot-header">
                            <div>Name</div>
                            <div>Snapshot Obj</div>
                            <div>Creation TXG</div>
                            <div>Creation Time</div>
                            <div className="align-right">Referenced</div>
                            <div className="align-right">Unique</div>
                            <div>Actions</div>
                          </div>
                          {snapshotLineage.entries.map(entry => {
                            const rowLike: SnapshotRecord = {
                              name: snapshotNameByDsobj.get(entry.dsobj) ?? `#${entry.dsobj}`,
                              dsobj: entry.dsobj,
                              creation_txg: entry.creation_txg,
                              creation_time: entry.creation_time,
                              referenced_bytes: entry.referenced_bytes,
                              unique_bytes: entry.unique_bytes,
                              deadlist_obj: entry.deadlist_obj,
                            }
                            return (
                              <div key={`lineage-${entry.dsobj}`} className="fs-row snapshot-row">
                                <div className="fs-name">
                                  {snapshotDatasetLabel(entry.dsobj)}
                                  {entry.is_start && <span className="muted"> (anchor)</span>}
                                </div>
                                <div className="fs-obj">#{entry.dsobj}</div>
                                <div>{entry.creation_txg}</div>
                                <div>
                                  {entry.creation_time
                                    ? new Date(entry.creation_time * 1000).toLocaleString()
                                    : '—'}
                                </div>
                                <div className="fs-size">{formatBytes(entry.referenced_bytes)}</div>
                                <div className="fs-size">{formatBytes(entry.unique_bytes)}</div>
                                <div className="snapshot-actions">
                                  <button
                                    type="button"
                                    className="pool-errors-action-btn"
                                    onClick={() => openSnapshotAsObject(rowLike)}
                                  >
                                    MOS
                                  </button>
                                  <button
                                    type="button"
                                    className="pool-errors-action-btn"
                                    onClick={() => {
                                      void openSnapshotDsobjInFs(
                                        entry.dsobj,
                                        snapshotDatasetLabel(entry.dsobj)
                                      )
                                    }}
                                    disabled={snapshotOpeningDsobj === entry.dsobj}
                                  >
                                    {snapshotOpeningDsobj === entry.dsobj ? 'Opening…' : 'Open in FS'}
                                  </button>
                                  <button
                                    type="button"
                                    className="pool-errors-action-btn"
                                    onClick={() => {
                                      void loadSnapshotLineage(entry.dsobj)
                                    }}
                                  >
                                    Anchor
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {!snapshotLineageLoading && !snapshotLineage && (
                        <div className="fs-empty">Select a snapshot object to load lineage.</div>
                      )}
                    </div>
                  ) : (
                    <div className="fs-center-list">
                      <div className="fs-table snapshot-table">
                        <div className="fs-row fs-header snapshot-header">
                          <div>Name</div>
                          <div>Snapshot Obj</div>
                          <div>Creation TXG</div>
                          <div>Creation Time</div>
                          <div className="align-right">Referenced</div>
                          <div className="align-right">Unique</div>
                          <div>Actions</div>
                        </div>
                        {sortedSnapshotRows.map(row => (
                          <div key={`${row.name}-${row.dsobj}`} className="fs-row snapshot-row">
                            <div className="fs-name">{row.name}</div>
                            <div className="fs-obj">#{row.dsobj}</div>
                            <div>{row.creation_txg ?? '—'}</div>
                            <div>
                              {row.creation_time
                                ? new Date(row.creation_time * 1000).toLocaleString()
                                : '—'}
                            </div>
                            <div className="fs-size">
                              {row.referenced_bytes === null ? '—' : formatBytes(row.referenced_bytes)}
                            </div>
                            <div className="fs-size">
                              {row.unique_bytes === null ? '—' : formatBytes(row.unique_bytes)}
                            </div>
                            <div className="snapshot-actions">
                              <button
                                type="button"
                                className="pool-errors-action-btn"
                                onClick={() => openSnapshotAsObject(row)}
                              >
                                MOS
                              </button>
                              <button
                                type="button"
                                className="pool-errors-action-btn"
                                onClick={() => {
                                  void openSnapshotInFs(row)
                                }}
                                disabled={snapshotOpeningDsobj === row.dsobj}
                              >
                                {snapshotOpeningDsobj === row.dsobj ? 'Opening…' : 'Open in FS'}
                              </button>
                              <button
                                type="button"
                                className="pool-errors-action-btn"
                                onClick={() => {
                                  void loadSnapshotLineage(row.dsobj, { switchMode: true })
                                }}
                              >
                                Lineage
                              </button>
                            </div>
                          </div>
                        ))}
                        {!snapshotLoading && sortedSnapshotRows.length === 0 && (
                          <div className="fs-empty">No snapshots match this filter.</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
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
            )
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
                    {isSpacemapObject && (
                      <button
                        className={`graph-btn ${centerView === 'spacemap' ? 'active' : ''}`}
                        type="button"
                        onClick={() => setCenterView('spacemap')}
                      >
                        Spacemap
                      </button>
                    )}
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
                  ) : effectiveCenterView === 'spacemap' ? (
                    <span className="muted">Address-range activity and distribution</span>
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
                  {effectiveCenterView !== 'map' && effectiveCenterView !== 'spacemap' && (
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
                ) : effectiveCenterView === 'spacemap' ? (
                  renderSpacemapPanel('center')
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
              {isMosMode && inspectorLoading && <span className="muted">Loading…</span>}
              <button
                type="button"
                className={`pin-btn ${debugCopied ? 'active' : ''}`}
                onClick={handleCopyDebugInfo}
                title="Copy backend and frontend debug context"
              >
                {debugCopied ? 'Debug copied' : 'Copy debug'}
              </button>
              {isMosMode && selectedObject !== null && (
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

          {debugCopyError && (
            <div className="error">
              <strong>Debug copy failed:</strong> {debugCopyError}
            </div>
          )}

          <div className="runtime-mode">
            <span className="runtime-mode-label">Pool mode</span>
            <span className={`mode-badge ${poolMode}`}>{poolModeLabel}</span>
            {modeSwitching && <span className="muted">switching…</span>}
          </div>

          {isSnapshotsView && snapshotView && (
            <div className="inspector-content">
              <div className="inspector-section">
                <h3>Snapshot Browser</h3>
                <dl className="info-grid">
                  <div>
                    <dt>Dataset</dt>
                    <dd>{snapshotView.datasetName}</dd>
                  </div>
                  <div>
                    <dt>DSL Dir Obj</dt>
                    <dd>{snapshotView.dslDirObj}</dd>
                  </div>
                  <div>
                    <dt>Head Dataset Obj</dt>
                    <dd>{snapshotView.headDatasetObj ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Rows</dt>
                    <dd>{snapshotRows.length}</dd>
                  </div>
                  <div>
                    <dt>View</dt>
                    <dd>{snapshotViewMode === 'lineage' ? 'lineage' : 'table'}</dd>
                  </div>
                  <div>
                    <dt>Anchor Obj</dt>
                    <dd>{snapshotLineageDsobj ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Lineage Rows</dt>
                    <dd>{snapshotLineage?.count ?? 0}</dd>
                  </div>
                </dl>
                {snapshotLoading && <p className="muted">Loading snapshot metadata...</p>}
                {snapshotError && <p className="muted">Error: {snapshotError}</p>}
                {snapshotLineageLoading && <p className="muted">Loading lineage...</p>}
                {snapshotLineageError && <p className="muted">Lineage error: {snapshotLineageError}</p>}
              </div>
            </div>
          )}

          {!isSnapshotsView && isFsMode && fsState && (
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
                <div className="fs-actions">
                  {fsState.headDatasetObj === null || fsState.headDatasetObj === 0 ? (
                    <span className="muted">
                      Snapshots unavailable for this special dataset.
                    </span>
                  ) : (
                  <button
                    type="button"
                    className="fs-action-btn"
                    onClick={() =>
                      void openSnapshotBrowser(
                        fsState.dslDirObj,
                        fsState.datasetName,
                        fsState.headDatasetObj
                      )
                    }
                  >
                    Snapshots
                  </button>
                  )}
                </div>
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

          {!isSnapshotsView && isFsMode && !fsState && (
            <p className="muted">Select a dataset to view filesystem metadata.</p>
          )}

          {isPoolTab && poolSummary && (
            <div className="inspector-content">
              <div className="inspector-section">
                <h3>Pool</h3>
                <dl className="info-grid">
                  <div>
                    <dt>Name</dt>
                    <dd>{poolSummary.pool.name}</dd>
                  </div>
                  <div>
                    <dt>GUID</dt>
                    <dd>{poolSummary.pool.guid}</dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>{poolSummary.pool.state}</dd>
                  </div>
                  <div>
                    <dt>TXG</dt>
                    <dd>{poolSummary.pool.txg}</dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>{poolSummary.pool.version}</dd>
                  </div>
                  <div>
                    <dt>Host</dt>
                    <dd>{poolSummary.pool.hostname ?? '(none)'}</dd>
                  </div>
                </dl>
              </div>

              <div className="inspector-section">
                <h3>Features For Read</h3>
                {poolSummary.features_for_read.length === 0 ? (
                  <p className="muted">No readonly features reported.</p>
                ) : (
                  <ul className="feature-list">
                    {poolSummary.features_for_read.map(feature => (
                      <li key={feature}>{feature}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="inspector-section">
                <h3>Persistent Errors</h3>
                {poolErrorsError && <p className="muted">Error: {poolErrorsError}</p>}
                <dl className="info-grid">
                  <div>
                    <dt>Error Count</dt>
                    <dd>{poolErrors ? poolErrors.error_count.toLocaleString() : '—'}</dd>
                  </div>
                  <div>
                    <dt>Approx Entries</dt>
                    <dd>{poolErrors ? poolErrors.approx_entries.toLocaleString() : '—'}</dd>
                  </div>
                  <div>
                    <dt>Last Obj</dt>
                    <dd>{poolErrors?.errlog_last_obj ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Scrub Obj</dt>
                    <dd>{poolErrors?.errlog_scrub_obj ?? '—'}</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}

          {isPoolTab && !poolSummary && !poolSummaryLoading && !poolSummaryError && (
            <p className="muted">Select a pool to view summary metadata.</p>
          )}

          {isMosMode && selectedPool && selectedObject !== null && (
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

          {isMosMode && inspectorError && (
            <div className="error">
              <strong>Error:</strong> {inspectorError}
            </div>
          )}

          {isMosMode && !selectedObject && !inspectorLoading && (
            <p className="muted">Select a MOS object to inspect its dnode.</p>
          )}

          {isMosMode && selectedObject !== null && objectInfo && (
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
                {isSpacemapObject && (
                  <button
                    className={`tab ${inspectorTab === 'spacemap' ? 'active' : ''}`}
                    onClick={() => setInspectorTab('spacemap')}
                  >
                    Spacemap
                  </button>
                )}
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
                            disabled={!datasetForMosIsBrowsable}
                            title={
                              datasetForMosIsBrowsable
                                ? 'Open dataset root in Filesystem view'
                                : 'Dataset is internal and not filesystem-browseable'
                            }
                          >
                            Open in FS
                          </button>
                          <button
                            type="button"
                            className="fs-action-btn"
                            onClick={() =>
                              openSnapshotBrowser(
                                datasetForMos.dsl_dir_obj,
                                datasetIndex.fullNameById.get(datasetForMos.dsl_dir_obj) ??
                                  datasetForMos.name,
                                datasetForMos.head_dataset_obj
                              )
                            }
                            disabled={
                              !datasetForMosIsBrowsable
                            }
                          >
                            Snapshots
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
                              onClick={() => {
                                if (isBrowsableDatasetNode(dslDatasetNode)) {
                                  enterFsFromDataset(dslDatasetNode)
                                }
                              }}
                              disabled={!isBrowsableDatasetNode(dslDatasetNode)}
                              title={
                                isBrowsableDatasetNode(dslDatasetNode)
                                  ? 'Open dataset root in Filesystem view'
                                  : 'Dataset is internal and not filesystem-browseable'
                              }
                            >
                              Open Dataset in FS
                            </button>
                            <button
                              type="button"
                              className="fs-action-btn"
                              onClick={() =>
                                openSnapshotBrowser(
                                  dslDatasetNode.dsl_dir_obj,
                                  datasetIndex.fullNameById.get(dslDatasetNode.dsl_dir_obj) ??
                                    dslDatasetNode.name,
                                  dslDatasetNode.head_dataset_obj
                                )
                              }
                              disabled={
                                !isBrowsableDatasetNode(dslDatasetNode)
                              }
                            >
                              Snapshots
                            </button>
                          </div>
                        )}

                        {!dslDatasetNode && dslDatasetBonus.dir_obj !== 0 && (
                          <div className="fs-actions">
                            <button
                              type="button"
                              className="fs-action-btn"
                              onClick={() =>
                                openSnapshotBrowser(
                                  dslDatasetBonus.dir_obj,
                                  datasetIndex.fullNameById.get(dslDatasetBonus.dir_obj) ??
                                    `dsl_dir_${dslDatasetBonus.dir_obj}`,
                                  selectedObject
                                )
                              }
                            >
                              Snapshots
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

                {inspectorTab === 'spacemap' && isSpacemapObject && renderSpacemapPanel('inspector')}

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

      {poolDetailsOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card">
            <div className="modal-header">
              <h3>Pool details</h3>
              <button
                type="button"
                className="pin-btn"
                onClick={() => setPoolDetailsOpen(false)}
              >
                Close
              </button>
            </div>
            {poolSummary ? (
              <div className="modal-body">
                <div className="pool-summary-cards">
                  <div className="pool-summary-card">
                    <span>Name</span>
                    <strong>{poolSummary.pool.name}</strong>
                  </div>
                  <div className="pool-summary-card">
                    <span>GUID</span>
                    <strong>{poolSummary.pool.guid}</strong>
                  </div>
                  <div className="pool-summary-card">
                    <span>State</span>
                    <strong>{poolSummary.pool.state}</strong>
                  </div>
                  <div className="pool-summary-card">
                    <span>TXG</span>
                    <strong>{poolSummary.pool.txg}</strong>
                  </div>
                </div>
                <div className="pool-vdev-tree modal-vdev-tree">
                  <h3>Vdev Tree</h3>
                  {poolSummary.vdev_tree ? (
                    renderPoolVdevNode(poolSummary.vdev_tree, 'modal.root', 0)
                  ) : (
                    <p className="muted">No vdev tree available.</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="muted">No pool summary loaded.</p>
            )}
          </div>
        </div>
      )}

      <footer>
        <p>v0.01, OpenZFS commit: 21bbe7cb6</p>
      </footer>
    </div>
  )
}

export default App
