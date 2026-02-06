type ZapEntry = {
  name: string
  value_preview: string
  maybe_object_ref: boolean
  target_obj: number | null
}

type MosObject = {
  id: number
  type_name: string
}

type Props = {
  entries: ZapEntry[]
  mosObjectMap: Map<number, MosObject>
  onNavigate: (objid: number) => void
}

export function ZapMapView({ entries, mosObjectMap, onNavigate }: Props) {
  if (!entries || entries.length === 0) {
    return (
      <div className="zap-map-empty">
        <p className="muted">No ZAP entries loaded.</p>
      </div>
    )
  }

  return (
    <div className="zap-map">
      <div className="zap-map-row zap-map-header">
        <div>Key</div>
        <div>Target</div>
      </div>
      {entries.map(entry => {
        const ref = entry.target_obj ?? 0
        const hint = mosObjectMap.get(ref)?.type_name
        return (
          <div key={`${entry.name}-${entry.target_obj ?? entry.value_preview}`} className="zap-map-row">
            <div className="zap-map-key">{entry.name}</div>
            <div className="zap-map-value">
              {entry.maybe_object_ref && entry.target_obj !== null ? (
                <button className="zap-entry-link" onClick={() => onNavigate(ref)}>
                  Object {ref}
                  {hint ? <span className="zap-hint">({hint})</span> : null}
                </button>
              ) : (
                <code>{entry.value_preview || '(empty)'}</code>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
