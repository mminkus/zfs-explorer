import { useEffect, useRef, useMemo } from 'react'
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
  onNavigate: (objid: number) => void
}

export function ObjectGraph({
  selectedObject,
  objectTypeName,
  semanticEdges,
  zapEntries,
  blkptrs,
  onNavigate,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)

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
      },
    })
    addedNodes.add(`obj-${selectedObject}`)

    // Semantic edges from bonus
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

    // ZAP entry refs
    const zapRefs = zapEntries.filter(e => e.maybe_object_ref && e.target_obj !== null)
    zapRefs.forEach(entry => {
      const targetId = `obj-${entry.target_obj}`
      if (!addedNodes.has(targetId)) {
        nodes.push({
          data: {
            id: targetId,
            label: `#${entry.target_obj}`,
            sublabel: entry.name,
            type: 'zap',
            objid: entry.target_obj,
          },
        })
        addedNodes.add(targetId)
      }
      edges.push({
        data: {
          id: `edge-zap-${entry.name}-${entry.target_obj}`,
          source: `obj-${selectedObject}`,
          target: targetId,
          label: entry.name,
          edgeType: 'zap',
        },
      })
    })

    // Collapsed blkptr node
    const validBlkptrs = blkptrs.filter(bp => !bp.is_hole)
    if (validBlkptrs.length > 0) {
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

    return [...nodes, ...edges]
  }, [selectedObject, objectTypeName, semanticEdges, zapEntries, blkptrs])

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
          selector: 'edge',
          style: {
            width: 2,
            'line-color': '#4dd0e1',
            'target-arrow-color': '#4dd0e1',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': '9px',
            color: '#9aa3b2',
            'text-rotation': 'autorotate',
            'text-margin-y': -10,
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
      ],
      layout: {
        name: 'cose',
        animate: false,
        padding: 30,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 120,
        nodeOverlap: 20,
      },
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

  return <div ref={containerRef} className="cytoscape-container" />
}
