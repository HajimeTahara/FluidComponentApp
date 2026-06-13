'use client'

import { useEffect, useState } from 'react'
import { fetchFluids } from '@/app/lib/api'
import SaturationChart from './SaturationChart'
import PHDiagramChart from './PHDiagramChart'
import PropertiesLookup from './PropertiesLookup'
import PIDDiagram from './PIDDiagram'

type Tab = 'data' | 'ph-diagram' | 'pid'

const TABS: { id: Tab; label: string }[] = [
  { id: 'data', label: '飽和特性・物性値' },
  { id: 'ph-diagram', label: 'pH線図' },
  { id: 'pid', label: 'P&ID' },
]

export default function Dashboard() {
  const [fluids, setFluids] = useState<string[]>([])
  const [fluid, setFluid] = useState('Methane')
  const [tab, setTab] = useState<Tab>('data')
  const [backendError, setBackendError] = useState<string | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<{ T: number; P: number } | null>(null)

  useEffect(() => {
    fetchFluids()
      .then(list => setFluids(list))
      .catch(() =>
        setBackendError('バックエンドに接続できません。localhost:8000 が起動しているか確認してください。'),
      )
  }, [])

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6 shadow-sm">
        <h1 className="text-lg font-semibold text-gray-900 shrink-0">流体物性ビューア</h1>

        {backendError ? (
          <span className="text-red-500 text-sm">{backendError}</span>
        ) : tab !== 'pid' ? (
          <div className="flex items-center gap-2">
            <label htmlFor="fluid-select" className="text-sm text-gray-500 shrink-0">
              液種:
            </label>
            {fluids.length === 0 ? (
              <span className="text-sm text-gray-400 px-3 py-1.5 min-w-40">読み込み中...</span>
            ) : (
              <select
                id="fluid-select"
                value={fluid}
                onChange={e => setFluid(e.target.value)}
                className="border border-gray-300 rounded px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-40"
              >
                {fluids.map(f => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            )}
          </div>
        ) : null}
      </header>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-6">
        <nav className="flex gap-0">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content */}
      <main className="p-6">
        {backendError ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-red-700 max-w-xl">
            <p className="font-medium mb-2">バックエンドに接続できません</p>
            <p className="text-sm">以下のコマンドでバックエンドを起動してください:</p>
            <pre className="mt-2 text-xs bg-red-100 rounded p-3 font-mono">
              cd backend{'\n'}
              pip install -r requirements.txt{'\n'}
              uvicorn main:app --reload
            </pre>
          </div>
        ) : (
          <>
            {tab === 'data' && (
              <div className="flex gap-6 items-start">
                <div className="flex-1 min-w-0">
                  <SaturationChart
                    fluid={fluid}
                    selectedPoint={selectedPoint}
                    onPointClick={(T, P) => setSelectedPoint({ T, P })}
                  />
                </div>
                <div className="shrink-0">
                  <PropertiesLookup
                    fluid={fluid}
                    externalT={selectedPoint?.T}
                    externalP={selectedPoint?.P}
                  />
                </div>
              </div>
            )}
            {tab === 'ph-diagram' && <PHDiagramChart fluid={fluid} />}
            {tab === 'pid' && <PIDDiagram />}
          </>
        )}
      </main>
    </div>
  )
}
