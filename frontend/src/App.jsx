import { useState } from 'react'
import './App.css'
import TrainingEntryForm from './components/TrainingEntryForm'
import TrainingEntriesList from './components/TrainingEntriesList'

function App() {
  const [refreshKey, setRefreshKey] = useState(0)

  const handleEntryAdded = () => {
    setRefreshKey(prev => prev + 1)
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>PowerLog - Training Log</h1>
      </header>
      <main className="app-main">
        <TrainingEntryForm onEntryAdded={handleEntryAdded} />
        <TrainingEntriesList refresh={refreshKey} />
      </main>
    </div>
  )
}

export default App
