import { useEffect, useRef, useMemo, useState } from 'react'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'

type SemanticEdge = {
  source_obj: number
  target_obj: number
  label: string
  kind: string
}

type ZapEntry = {
  name: string
  maybe_object_ref: boolean
  target_obj: number | null
}

type BlkptrInfo = {
  index: number
  is_spill: boolean
  is_hole: boolean
  ndvas: number
}

type Props = {
  selectedObject: number | null
  objectTypeName: string
  semanticEdges: SemanticEdge[]
  zapEntries: ZapEntry[]
  blkptrs: BlkptrInfo[]
  extraEdges: SemanticEdge[]
  extraNodes: number[]
  showSemantic: boolean
  showZap: boolean
  showPhysical: boolean
  showBlkptrDetails: boolean
  onNavigate: (objid: number) => void
  objTypeMap?: Map<number, string>
}

export function ObjectGraph({
  selectedObject,
  objectTypeName,
  semanticEdges,
  zapEntries,
  blkptrs,
  extraEdges,
  extraNodes,
  showSemantic,
  showZap,
  showPhysical,
  showBlkptrDetails,
  onNavigate,
  objTypeMap,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const [zapLimit, setZapLimit] = useState(25)
  const [hoverInfo, setHoverInfo] = useState<{
    title: string
    subtitle?: string
    kind?: string
    detail?: string
  } | null>(null)

  useEffect(() => {
    setZapLimit(25)
  }, [selectedObject, zapEntries])

  // Build graph elements
  const elements = useMemo(() => {
    if (selectedObject === null) return []

    const nodes: ElementDefinition[] = []
    const edges: ElementDefinition[] = []
    const addedNodes = new Set<string>()

    // Center node
    nodes.push({
      data: {
        id: `obj-${selectedObject}`,
        label: `#${selectedObject}`,
        sublabel: objectTypeName,
        type: 'center',
        typeName: objectTypeName,
      },
    })
    addedNodes.add(`obj-${selectedObject}`)

    // Semantic edges from bonus
    if (showSemantic) {
      semanticEdges.forEach(edge => {
        const targetId = `obj-${edge.target_obj}`
        if (!addedNodes.has(targetId)) {
          nodes.push({
            data: {
              id: targetId,
              label: `#${edge.target_obj}`,
              sublabel: edge.label,
              type: 'semantic',
              objid: edge.target_obj,
              typeName: objTypeMap?.get(edge.target_obj),
            },
          })
          addedNodes.add(targetId)
        }
        edges.push({
          data: {
            id: `edge-bonus-${edge.label}-${edge.target_obj}`,
            source: `obj-${selectedObject}`,
            target: targetId,
            label: edge.label,
            edgeType: 'bonus',
          },
        })
      })
    }

    // Extra nodes (expanded graph)
    if (showSemantic || showZap) {
      extraNodes.forEach(objid => {
        const nodeId = `obj-${objid}`
      if (!addedNodes.has(nodeId)) {
        nodes.push({
          data: {
            id: nodeId,
            label: `#${objid}`,
            sublabel: 'expanded',
            type: 'expanded',
            objid,
            typeName: objTypeMap?.get(objid),
          },
        })
        addedNodes.add(nodeId)
      }
      })
    }

    // Extra edges (expanded graph)
    extraEdges.forEach(edge => {
      const edgeType =
        edge.kind === 'zap' ? 'zap' : edge.kind === 'blkptr' ? 'physical' : 'bonus'
      if (edgeType === 'zap' && !showZap) return
      if (edgeType === 'bonus' && !showSemantic) return
      if (edgeType === 'physical' && !showPhysical) return

      const sourceId = `obj-${edge.source_obj}`
      const targetId = `obj-${edge.target_obj}`
      if (!addedNodes.has(sourceId)) {
        nodes.push({
          data: {
            id: sourceId,
            label: `#${edge.source_obj}`,
            sublabel: 'expanded',
            type: 'expanded',
            objid: edge.source_obj,
            typeName: objTypeMap?.get(edge.source_obj),
          },
        })
        addedNodes.add(sourceId)
      }
      if (!addedNodes.has(targetId)) {
        nodes.push({
          data: {
            id: targetId,
            label: `#${edge.target_obj}`,
            sublabel: 'expanded',
            type: 'expanded',
            objid: edge.target_obj,
            typeName: objTypeMap?.get(edge.target_obj),
          },
        })
        addedNodes.add(targetId)
      }

      edges.push({
        data: {
          id: `edge-extra-${edge.kind}-${edge.label}-${edge.source_obj}-${edge.target_obj}`,
          source: sourceId,
          target: targetId,
          label: edge.label,
          edgeType,
        },
      })
    })

    // ZAP entry refs
    if (showZap) {
      const zapRefs = zapEntries.filter(
        (e): e is ZapEntry & { target_obj: number } =>
          e.maybe_object_ref && typeof e.target_obj === 'number'
      )
      const visibleZapRefs = zapRefs.slice(0, zapLimit)
      const remaining = zapRefs.length - visibleZapRefs.length

      visibleZapRefs.forEach(entry => {
        const targetId = `obj-${entry.target_obj}`
        if (!addedNodes.has(targetId)) {
          nodes.push({
            data: {
              id: targetId,
              label: `${entry.name}\n#${entry.target_obj}`,
              sublabel: entry.name,
              type: 'zap',
              objid: entry.target_obj,
              typeName: objTypeMap?.get(entry.target_obj),
            },
          })
          addedNodes.add(targetId)
        }
        edges.push({
          data: {
            id: `edge-zap-${entry.name}-${entry.target_obj}`,
            source: `obj-${selectedObject}`,
            target: targetId,
            label: '',
            edgeType: 'zap',
          },
        })
      })

      if (remaining > 0) {
        const moreId = `zap-more-${selectedObject}`
        nodes.push({
          data: {
            id: moreId,
            label: `+${remaining} more`,
            type: 'zap-more',
          },
        })
        edges.push({
          data: {
            id: `edge-zap-more-${selectedObject}`,
            source: `obj-${selectedObject}`,
            target: moreId,
            label: '',
            edgeType: 'zap',
          },
        })
      }
    }

    // Physical edges (collapsed or expanded)
    if (showPhysical) {
      const validBlkptrs = blkptrs.filter(bp => !bp.is_hole)
      if (validBlkptrs.length > 0) {
        if (showBlkptrDetails) {
          validBlkptrs.forEach(bp => {
            const blkptrId = `blkptr-${selectedObject}-${bp.index}`
            nodes.push({
              data: {
                id: blkptrId,
                label: bp.is_spill ? 'spill' : `blkptr ${bp.index}`,
                sublabel: `${bp.ndvas} DVA${bp.ndvas === 1 ? '' : 's'}`,
                type: 'physical-detail',
              },
            })
            edges.push({
              data: {
                id: `edge-blkptr-${selectedObject}-${bp.index}`,
                source: `obj-${selectedObject}`,
                target: blkptrId,
                label: bp.is_spill ? 'spill' : `blkptr ${bp.index}`,
                edgeType: 'physical',
              },
            })
          })
        } else {
          const blkptrId = `blkptrs-${selectedObject}`
          nodes.push({
            data: {
              id: blkptrId,
              label: `blkptrs (${validBlkptrs.length})`,
              sublabel: `${validBlkptrs.reduce((sum, bp) => sum + bp.ndvas, 0)} DVAs`,
              type: 'physical',
            },
          })
          edges.push({
            data: {
              id: `edge-blkptr-${selectedObject}`,
              source: `obj-${selectedObject}`,
              target: blkptrId,
              label: 'data',
              edgeType: 'physical',
            },
          })
        }
      }
    }

    return [...nodes, ...edges]
  }, [
    selectedObject,
    objectTypeName,
    semanticEdges,
    zapEntries,
    blkptrs,
    extraEdges,
    extraNodes,
    showSemantic,
    showZap,
    showPhysical,
    showBlkptrDetails,
    zapLimit,
    objTypeMap,
  ])

  // Initialize/update cytoscape
  useEffect(() => {
    if (!containerRef.current) return

    // Destroy existing instance
    if (cyRef.current) {
      cyRef.current.destroy()
      cyRef.current = null
    }

    if (elements.length === 0) return

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': '#1a1f2a',
            'border-width': 2,
            'border-color': '#4dd0e1',
            label: 'data(label)',
            color: '#e7e9ee',
            'font-size': '11px',
            'text-valign': 'center',
            'text-halign': 'center',
            width: 70,
            height: 70,
            'text-wrap': 'wrap',
            'text-max-width': '60px',
          },
        },
        {
          selector: 'node[type="center"]',
          style: {
            'background-color': 'rgba(77, 208, 225, 0.2)',
            'border-color': '#4dd0e1',
            'border-width': 3,
            width: 90,
            height: 90,
            'font-weight': 'bold',
          },
        },
        {
          selector: 'node[type="semantic"]',
          style: {
            'background-color': 'rgba(255, 140, 66, 0.15)',
            'border-color': '#ff8c42',
          },
        },
        {
          selector: 'node[type="zap"]',
          style: {
            'background-color': 'rgba(129, 199, 132, 0.15)',
            'border-color': '#81c784',
          },
        },
        {
          selector: 'node[type="zap-more"]',
          style: {
            'background-color': 'rgba(255, 255, 255, 0.05)',
            'border-color': 'rgba(255, 255, 255, 0.2)',
            'border-style': 'dashed',
            shape: 'rectangle',
            width: 70,
            height: 36,
            'font-size': '10px',
            color: '#9aa3b2',
          },
        },
        {
          selector: 'node[type="physical"]',
          style: {
            'background-color': 'rgba(149, 117, 205, 0.15)',
            'border-color': '#9575cd',
            shape: 'rectangle',
            width: 80,
            height: 50,
          },
        },
        {
          selector: 'node[type="expanded"]',
          style: {
            'background-color': 'rgba(77, 208, 225, 0.08)',
            'border-color': '#4dd0e1',
            width: 70,
            height: 70,
          },
        },
        {
          selector: 'node[type="physical-detail"]',
          style: {
            'background-color': 'rgba(149, 117, 205, 0.08)',
            'border-color': '#9575cd',
            shape: 'rectangle',
            width: 70,
            height: 44,
            'font-size': '9px',
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': 4,
            'border-color': '#ffd166',
            'shadow-blur': 12,
            'shadow-color': '#ffd166',
            'shadow-opacity': 0.6,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 2,
            'line-color': '#4dd0e1',
            'target-arrow-color': '#4dd0e1',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: '',
            'font-size': '9px',
            color: '#9aa3b2',
            'text-rotation': 'autorotate',
            'text-margin-y': -10,
          },
        },
        {
          selector: 'edge:selected, edge:hover',
          style: {
            label: 'data(label)',
          },
        },
        {
          selector: 'edge[edgeType="bonus"]',
          style: {
            'line-color': '#ff8c42',
            'target-arrow-color': '#ff8c42',
          },
        },
        {
          selector: 'edge[edgeType="zap"]',
          style: {
            'line-color': '#81c784',
            'target-arrow-color': '#81c784',
          },
        },
        {
          selector: 'edge[edgeType="physical"]',
          style: {
            'line-color': '#9575cd',
            'target-arrow-color': '#9575cd',
            'line-style': 'dashed',
          },
        },
      ] as any,
      layout: (() => {
        const physicalOnly = showPhysical && !showSemantic && !showZap
        if (physicalOnly) {
          return {
            name: 'concentric',
            padding: 40,
            minNodeSpacing: 30,
            startAngle: (3 / 2) * Math.PI,
          }
        }
        const normalized = objectTypeName.toLowerCase()
        if (normalized.includes('child map')) {
          return {
            name: 'breadthfirst',
            directed: true,
            spacingFactor: 1.3,
            padding: 40,
          }
        }
        if (normalized.includes('zap')) {
          return {
            name: 'circle',
            padding: 40,
          }
        }
        return {
          name: 'cose',
          animate: false,
          padding: 30,
          nodeRepulsion: () => 8000,
          idealEdgeLength: () => 120,
          nodeOverlap: 20,
        }
      })(),
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
    })

    // Click handler for navigation
    cy.on('tap', 'node[objid]', evt => {
      const objid = evt.target.data('objid')
      if (objid !== undefined) {
        onNavigate(objid)
      }
    })

    cy.on('tap', 'node[type="zap-more"]', () => {
      setZapLimit(prev => prev + 25)
    })

    // Hover cursor
    cy.on('mouseover', 'node[objid]', () => {
      if (containerRef.current) {
        containerRef.current.style.cursor = 'pointer'
      }
    })
    cy.on('mouseout', 'node[objid]', () => {
      if (containerRef.current) {
        containerRef.current.style.cursor = 'default'
      }
    })

    const typeLabels: Record<string, string> = {
      center: 'Selected object',
      semantic: 'Semantic edge',
      zap: 'ZAP reference',
      physical: 'Physical block',
      'physical-detail': 'Block pointer',
      expanded: 'Expanded node',
      'zap-more': 'More ZAP refs',
    }

    cy.on('mouseover', 'node', evt => {
      const data = evt.target.data()
      const rawLabel = typeof data.label === 'string' ? data.label : ''
      const labelFirst = rawLabel.split('\n')[0] || rawLabel
      const objid = data.objid as number | undefined
      const kind = data.type ? typeLabels[data.type] ?? data.type : undefined

      const rawTypeName = typeof data.typeName === 'string' ? data.typeName : undefined
      const typeName =
        rawTypeName && rawTypeName !== data.sublabel && rawTypeName !== labelFirst
          ? rawTypeName
          : undefined
      setHoverInfo({
        title: objid !== undefined ? `Object ${objid}` : labelFirst,
        subtitle:
          objid !== undefined && labelFirst && labelFirst !== `#${objid}`
            ? labelFirst
            : data.sublabel,
        detail: typeName,
        kind,
      })
    })

    cy.on('mouseout', 'node', () => {
      setHoverInfo(null)
    })

    cyRef.current = cy

    return () => {
      cy.destroy()
    }
  }, [elements, onNavigate])

  if (selectedObject === null) {
    return (
      <div className="graph-empty">
        <p className="muted">Select an object to visualize its neighborhood.</p>
      </div>
    )
  }

  return (
    <div className="graph-canvas">
      <div ref={containerRef} className="cytoscape-container" />
      {hoverInfo && (
        <div className="graph-tooltip">
          <div className="graph-tooltip-title">{hoverInfo.title}</div>
          {hoverInfo.subtitle && <div className="graph-tooltip-sub">{hoverInfo.subtitle}</div>}
          {hoverInfo.detail && <div className="graph-tooltip-detail">{hoverInfo.detail}</div>}
          {hoverInfo.kind && <div className="graph-tooltip-kind">{hoverInfo.kind}</div>}
        </div>
      )}
      <div className="graph-legend">
        <div className="legend-row">
          <span className="legend-swatch legend-center" />
          Selected
        </div>
        <div className="legend-row">
          <span className="legend-swatch legend-semantic" />
          Semantic
        </div>
        <div className="legend-row">
          <span className="legend-swatch legend-zap" />
          ZAP ref
        </div>
        <div className="legend-row">
          <span className="legend-swatch legend-physical" />
          Physical
        </div>
        <div className="legend-row">
          <span className="legend-line legend-physical-line" />
          Physical edge
        </div>
      </div>
    </div>
  )
}
