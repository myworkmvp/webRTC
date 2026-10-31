import React, { useState } from 'react'
import HostView from './components/HostView'
import ReceiverView from './components/ReceiverView'

export default function App() {
  const [mode, setMode] = useState(null)
  return (
    <div className="app">
      <header>
        <h1>📡 WebRTC Live Stream</h1>
        <nav>
          <button className={mode === 'host' ? 'on' : ''} onClick={() => setMode('host')}>Host</button>
          <button className={mode === 'receiver' ? 'on' : ''} onClick={() => setMode('receiver')}>Receiver</button>
        </nav>
      </header>
      <main>
        {!mode && (
          <div className="grid two-col">
            <button className="pick card" onClick={() => setMode('host')}><h2>🎥 Host</h2><p>Capture camera + mic and broadcast to many receivers. You get a secret stream key.</p></button>
            <button className="pick card" onClick={() => setMode('receiver')}><h2>👀 Receiver</h2><p>Enter the stream key to watch live. Auto-reconnects if the network drops.</p></button>
          </div>
        )}
        {/* key= remounts the view (and cleans up its connections) when switching modes */}
        {mode === 'host' && <HostView key="h" />}
        {mode === 'receiver' && <ReceiverView key="r" />}
      </main>
    </div>
  )
}
