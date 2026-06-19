'use client'

import { useEffect, useState } from 'react'
import { fetchFluids, fetchProperties, type Properties } from '@/app/lib/api'
import SaturationChart from './SaturationChart'
import PHDiagramChart from './PHDiagramChart'
import PropertiesLookup from './PropertiesLookup'
import PIDDiagram from './PIDDiagram'
import PipeNetworkCalc from './PipeNetworkCalc'
import ComponentLibrary from './ComponentLibrary'
import LaunchAnalysis from './LaunchAnalysis'

type Tab = 'fluid-library' | 'component-library' | 'pid' | 'pressure-drop' | 'launch'

const TABS: { id: Tab; label: string }[] = [
  { id: 'fluid-library', label: '流体ライブラリ' },
  { id: 'component-library', label: '部品管理' },
  { id: 'pid', label: '非定常解析' },
  { id: 'pressure-drop', label: '定常流れ解析' },
  { id: 'launch', label: '打ち上げ解析' },
]

export default function Dashboard() {
  const [fluids, setFluids] = useState<string[]>([])
  const [fluid, setFluid] = useState('Methane')
  const [tab, setTab] = useState<Tab>('fluid-library')
  const [backendError, setBackendError] = useState<string | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<{ T: number; P: number } | null>(null)
  const [fluidMeta, setFluidMeta] = useState<Properties | null>(null)

  useEffect(() => {
    fetchFluids()
      .then(list => setFluids(list))
      .catch(() =>
        setBackendError('バックエンドに接続できません。localhost:8000 が起動しているか確認してください。'),
      )
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchProperties(fluid, 300, 101325)
      .then(result => {
        if (!cancelled) setFluidMeta(result)
      })
      .catch(() => {
        if (!cancelled) setFluidMeta(null)
      })
    return () => { cancelled = true }
  }, [fluid])

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6 shadow-sm">
        <h1 className="text-lg font-semibold text-gray-900 shrink-0">FluidLab</h1>

        {backendError && <span className="text-red-500 text-sm">{backendError}</span>}
      </header>

      <div className="flex min-h-[calc(100vh-53px)]">
        <aside className="w-56 shrink-0 border-r border-gray-200 bg-white px-3 py-4">
          <nav className="flex flex-col gap-1">
            {TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1 p-6">
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
              {tab === 'fluid-library' && (
                <div className="flex flex-col gap-6">
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4 flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-3">
                      <label htmlFor="fluid-select" className="text-sm font-medium text-gray-600 shrink-0">
                        液種
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

                    {fluidMeta && (
                      <>
                        <div className="h-6 w-px bg-gray-200" />
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-600">
                          <span className="font-semibold text-gray-500">臨界点</span>
                          <span>Tc: {(fluidMeta.T_crit - 273.15).toFixed(2)} °C</span>
                          <span>Pc: {(fluidMeta.P_crit / 1e6).toFixed(4)} MPa</span>
                          <span>ρc: {fluidMeta.D_crit.toFixed(3)} kg/m³</span>
                        </div>
                        <div className="h-6 w-px bg-gray-200" />
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-gray-600">
                          <span className="font-semibold text-gray-500">三重点</span>
                          <span>Tt: {(fluidMeta.T_triple - 273.15).toFixed(2)} °C</span>
                          <span>Pt: {(fluidMeta.P_triple / 1e6).toFixed(6)} MPa</span>
                        </div>
                      </>
                    )}
                  </div>

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

                  <PHDiagramChart fluid={fluid} />
                </div>
              )}
              {tab === 'component-library' && <ComponentLibrary />}
              {tab === 'pid' && <PIDDiagram />}
              {tab === 'pressure-drop' && <PipeNetworkCalc />}
              {tab === 'launch' && <LaunchAnalysis />}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
