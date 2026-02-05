import { useEffect, useState } from 'react'
import './App.css'

function App() {
  const [pools, setPools] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('http://localhost:9000/api/pools')
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

  return (
    <div className="container">
      <h1>ZFS Explorer</h1>
      <p className="subtitle">Milestone 0: Proof of Life</p>

      <div className="card">
        <h2>Imported Pools</h2>

        {loading && <p>Loading pools...</p>}

        {error && (
          <div className="error">
            <strong>Error:</strong> {error}
            <p className="hint">Make sure the API backend is running on localhost:9000</p>
          </div>
        )}

        {!loading && !error && pools.length === 0 && (
          <p>No pools found</p>
        )}

        {!loading && !error && pools.length > 0 && (
          <ul className="pool-list">
            {pools.map((pool, idx) => (
              <li key={idx} className="pool-item">
                <span className="pool-icon">🗄️</span>
                <span className="pool-name">{pool}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer>
        <p>Backend: <code>GET /api/pools</code></p>
        <p>OpenZFS commit: 21bbe7cb6</p>
      </footer>
    </div>
  )
}

export default App
