import { useEffect, useMemo, useRef } from 'react'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'

type FsEntry = {
  name: string
  objid: number
  type_name: string
}

type Props = {
  dirObj: number
  dirName: string
  entries: FsEntry[]
  selectedObjid: number | null
  maxNodes?: number
  onSelectEntry: (entry: FsEntry) => void
}

export function FsGraph({
  dirObj,
  dirName,
  entries,
  selectedObjid,
  maxNodes = 200,
  onSelectEntry,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const entryMapRef = useRef<Map<number, FsEntry>>(new Map())

  const elements = useMemo(() => {
    const nodes: ElementDefinition[] = []
    const edges: ElementDefinition[] = []
    const entryMap = new Map<number, FsEntry>()

    const rootEntry: FsEntry = { name: dirName, objid: dirObj, type_name: 'dir' }
    entryMap.set(dirObj, rootEntry)

    nodes.push({
      data: {
        id: `dir-${dirObj}`,
        label: `${dirName}\n#${dirObj}`,
        objid: dirObj,
      },
      classes: `dir ${selectedObjid === dirObj ? 'selected' : ''}`,
    })

    const slice = entries.slice(0, maxNodes)
    slice.forEach(entry => {
      entryMap.set(entry.objid, entry)
      nodes.push({
        data: {
          id: `entry-${entry.objid}`,
          label: `${entry.name}\n#${entry.objid}`,
          objid: entry.objid,
        },
        classes: `${entry.type_name} ${selectedObjid === entry.objid ? 'selected' : ''}`,
      })
      edges.push({
        data: {
          id: `edge-${dirObj}-${entry.objid}`,
          source: `dir-${dirObj}`,
          target: `entry-${entry.objid}`,
        },
      })
    })

    const remaining = entries.length - slice.length
    if (remaining > 0) {
      nodes.push({
        data: {
          id: `more-${dirObj}`,
          label: `+${remaining} more`,
        },
        classes: 'more',
      })
      edges.push({
        data: {
          id: `edge-more-${dirObj}`,
          source: `dir-${dirObj}`,
          target: `more-${dirObj}`,
        },
      })
    }

    entryMapRef.current = entryMap
    return [...nodes, ...edges]
  }, [dirObj, dirName, entries, maxNodes, selectedObjid])

  useEffect(() => {
    if (!containerRef.current) return

    if (!cyRef.current) {
      cyRef.current = cytoscape({
        container: containerRef.current,
        elements,
        style: [
          {
            selector: 'node',
            style: {
              label: 'data(label)',
              'text-wrap': 'wrap',
              'text-max-width': 120,
              'text-valign': 'center',
              'text-halign': 'center',
              'font-size': 10,
              color: '#e7e9ee',
              'background-color': 'rgba(94, 102, 120, 0.5)',
              'border-width': 1,
              'border-color': 'rgba(255,255,255,0.2)',
            },
          },
          {
            selector: 'node.dir',
            style: {
              'background-color': 'rgba(77, 208, 225, 0.35)',
              'border-color': 'rgba(77, 208, 225, 0.8)',
            },
          },
          {
            selector: 'node.file',
            style: {
              'background-color': 'rgba(255, 140, 66, 0.28)',
            },
          },
          {
            selector: 'node.symlink',
            style: {
              'background-color': 'rgba(186, 104, 200, 0.28)',
            },
          },
          {
            selector: 'node.more',
            style: {
              'background-color': 'rgba(255,255,255,0.12)',
              shape: 'round-rectangle',
              'font-style': 'italic',
            },
          },
          {
            selector: 'node.selected',
            style: {
              'border-width': 2,
              'border-color': '#ff8c42',
            },
          },
          {
            selector: 'edge',
            style: {
              width: 1,
              'line-color': 'rgba(255,255,255,0.18)',
              'target-arrow-shape': 'triangle',
              'target-arrow-color': 'rgba(255,255,255,0.2)',
              'curve-style': 'bezier',
            },
          },
        ],
      })

      cyRef.current.on('tap', 'node', evt => {
        const objid = evt.target.data('objid')
        if (typeof objid !== 'number') return
        const entry = entryMapRef.current.get(objid)
        if (entry) {
          onSelectEntry(entry)
        }
      })
    } else {
      cyRef.current.json({ elements })
    }

    const layout = cyRef.current.layout({
      name: 'breadthfirst',
      directed: true,
      spacingFactor: 1.4,
      roots: [`dir-${dirObj}`],
    })
    layout.run()
  }, [elements, dirObj, onSelectEntry])

  return (
    <div className="graph-canvas">
      <div className="cytoscape-container" ref={containerRef} />
      <div className="fs-graph-legend">
        <div className="legend-row">
          <span className="legend-dot legend-dir" />
          Dir
        </div>
        <div className="legend-row">
          <span className="legend-dot legend-file" />
          File
        </div>
        <div className="legend-row">
          <span className="legend-dot legend-symlink" />
          Symlink
        </div>
        <div className="legend-row">
          <span className="legend-dot legend-more" />
          +N more
        </div>
      </div>
    </div>
  )
}
