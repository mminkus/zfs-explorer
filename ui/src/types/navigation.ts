export type NavigatorMode = 'datasets' | 'mos' | 'fs'

export type FsPathSegment = {
  name: string
  objid: number
  kind?: string
}

export type FsLocation = {
  datasetName: string
  mountpoint?: string | null
  mounted?: boolean | null
  dslDirObj: number
  headDatasetObj: number
  objsetId: number
  rootObj: number
  currentDir: number
  path: FsPathSegment[]
}

export type BrowserNavState =
  | { mode: 'datasets'; pool: string | null }
  | { mode: 'mos'; pool: string | null; objid: number | null }
  | { mode: 'fs'; pool: string | null; fs: FsLocation | null }
