import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import axios from 'axios'
import './App.css'

const API_BASE = 'http://localhost:1315'

function App() {
  const [status, setStatus] = useState('checking...')
  const [points, setPoints] = useState([])

  useEffect(() => {
    axios
      .get(`${API_BASE}/api/health`)
      .then((res) => setStatus(res.data.status))
      .catch(() => setStatus('backend unreachable'))

    axios
      .get(`${API_BASE}/api/sample-points`)
      .then((res) => setPoints(res.data.points))
      .catch(() => setPoints([]))
  }, [])

  return (
    <div className="app">
      <header>
        <h1>AI For Vector — Starter</h1>
        <span className="status">backend: {status}</span>
      </header>
      <MapContainer center={[35, 105]} zoom={4} style={{ height: '80vh', width: '100%' }}>
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {points.map((p) => (
          <Marker key={p.id} position={[p.lat, p.lng]}>
            <Popup>{p.label}</Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  )
}

export default App
