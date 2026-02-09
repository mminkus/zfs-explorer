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
  filter?: string
  onNavigate: (objid: number) => void
}

export function ZapMapView({ entries, mosObjectMap, filter, onNavigate }: Props) {
  const term = (filter ?? '').trim().toLowerCase()
  const filtered = term
    ? entries.filter(entry => {
        const value = entry.value_preview?.toLowerCase() ?? ''
        const target = entry.target_obj?.toString() ?? ''
        return (
          entry.name.toLowerCase().includes(term) ||
          value.includes(term) ||
          target.includes(term)
        )
      })
    : entries

  if (!filtered || filtered.length === 0) {
    return (
      <div className="zap-map-empty">
        <p className="muted">{entries.length ? 'No matches.' : 'No ZAP entries loaded.'}</p>
      </div>
    )
  }

  return (
    <div className="zap-map">
      <div className="zap-map-row zap-map-header">
        <div>Key</div>
        <div>Target</div>
      </div>
      {filtered.map(entry => {
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
