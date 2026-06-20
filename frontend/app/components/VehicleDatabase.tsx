'use client'

import { useEffect, useState } from 'react'
import { createVehicle, deleteVehicle, fetchVehicles, type StageSpec, type Vehicle, type VehicleSpec } from '@/app/lib/api'
import { OXIDIZER_OPTIONS, FUEL_OPTIONS_BY_OXIDIZER } from '@/app/lib/propellants'

const DEFAULT_STAGE: StageSpec = {
  propellant_mass: 300,
  dry_mass: 150,
  oxidizer: 'LOX',
  fuel: 'LCH4',
  thrust: 12000,
  burn_time: 20,
}

const DEFAULT_NEW_VEHICLE: VehicleSpec = {
  name: '',
  stages: [{ ...DEFAULT_STAGE }],
  payload_mass: 50,
  length: 0,
  diameter: 0,
  launch_angle: 90,
  drag_enabled: false,
  drag_coefficient: 0.5,
  cross_section_area: 0.3,
  note: '',
}

function totalPropellantMass(v: VehicleSpec): number {
  return v.stages.reduce((sum, s) => sum + s.propellant_mass, 0)
}

function totalInitialMass(v: VehicleSpec): number {
  return v.stages.reduce((sum, s) => sum + s.propellant_mass + s.dry_mass, 0) + v.payload_mass
}

export default function VehicleDatabase({ onLoad }: { onLoad: (vehicle: Vehicle) => void }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newVehicle, setNewVehicle] = useState<VehicleSpec>(DEFAULT_NEW_VEHICLE)
  const [saving, setSaving] = useState(false)

  function reload() {
    fetchVehicles()
      .then(setVehicles)
      .catch(e => setError(e instanceof Error ? e.message : '取得に失敗しました'))
  }

  useEffect(() => { reload() }, [])

  function setStage<K extends keyof StageSpec>(index: number, field: K, value: StageSpec[K]) {
    setNewVehicle(v => ({
      ...v,
      stages: v.stages.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    }))
  }

  function setStageOxidizer(index: number, oxidizer: string) {
    const firstFuel = FUEL_OPTIONS_BY_OXIDIZER[oxidizer][0].value
    setStage(index, 'oxidizer', oxidizer)
    setStage(index, 'fuel', firstFuel)
  }

  function addStage() {
    setNewVehicle(v => ({ ...v, stages: [...v.stages, { ...DEFAULT_STAGE }] }))
  }

  function removeStage(index: number) {
    setNewVehicle(v => ({ ...v, stages: v.stages.filter((_, i) => i !== index) }))
  }

  async function handleAdd() {
    setSaving(true)
    setError(null)
    try {
      await createVehicle(newVehicle)
      setNewVehicle(DEFAULT_NEW_VEHICLE)
      setShowAddForm(false)
      reload()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '登録に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    setError(null)
    try {
      await deleteVehicle(id)
      reload()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '削除に失敗しました')
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">機体データベース</h3>
        <button
          onClick={() => setShowAddForm(v => !v)}
          className="text-xs px-3 py-1.5 rounded-full border border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors"
        >
          {showAddForm ? '閉じる' : '+ 機体を追加'}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-red-700 text-xs mb-3">{error}</div>
      )}

      {showAddForm && (
        <div className="bg-gray-50 rounded-lg p-3 mb-3 flex flex-col gap-2">
          <div className="grid grid-cols-4 gap-2">
            <input
              placeholder="機体名"
              value={newVehicle.name}
              onChange={e => setNewVehicle(v => ({ ...v, name: e.target.value }))}
              className="col-span-2 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="number"
              placeholder="全長 [m]"
              value={newVehicle.length}
              onChange={e => setNewVehicle(v => ({ ...v, length: parseFloat(e.target.value) }))}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="number"
              placeholder="直径 [m]"
              value={newVehicle.diameter}
              onChange={e => setNewVehicle(v => ({ ...v, diameter: parseFloat(e.target.value) }))}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="number"
              placeholder="ペイロード質量 [kg]"
              value={newVehicle.payload_mass}
              onChange={e => setNewVehicle(v => ({ ...v, payload_mass: parseFloat(e.target.value) }))}
              className="col-span-2 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="number"
              placeholder="機体投影面積 [m²]"
              value={newVehicle.cross_section_area}
              onChange={e => setNewVehicle(v => ({ ...v, cross_section_area: parseFloat(e.target.value) }))}
              className="col-span-2 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center justify-between mt-1">
            <span className="text-xs font-semibold text-gray-500">段構成（段数 {newVehicle.stages.length}）</span>
            <button
              onClick={addStage}
              className="text-xs px-2 py-1 rounded-full border border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors"
            >
              + 段を追加
            </button>
          </div>

          {newVehicle.stages.map((stage, i) => (
            <div key={i} className="bg-white rounded-lg p-2 border border-gray-200">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-gray-600">第{i + 1}段</span>
                {newVehicle.stages.length > 1 && (
                  <button
                    onClick={() => removeStage(i)}
                    className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                  >
                    削除
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <select
                  value={stage.oxidizer}
                  onChange={e => setStageOxidizer(i, e.target.value)}
                  className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {OXIDIZER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <select
                  value={stage.fuel}
                  onChange={e => setStage(i, 'fuel', e.target.value)}
                  className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {FUEL_OPTIONS_BY_OXIDIZER[stage.oxidizer].map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <div />

                {([
                  ['propellant_mass', '推進剤質量 [kg]'],
                  ['dry_mass', '構造質量 [kg]'],
                  ['thrust', '推力 [N]'],
                  ['burn_time', '燃焼時間 [s]'],
                ] as [keyof StageSpec, string][]).map(([field, label]) => (
                  <input
                    key={field}
                    type="number"
                    placeholder={label}
                    value={stage[field] as number}
                    onChange={e => setStage(i, field, parseFloat(e.target.value))}
                    className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                ))}
              </div>
            </div>
          ))}

          <input
            placeholder="補足・出典"
            value={newVehicle.note}
            onChange={e => setNewVehicle(v => ({ ...v, note: e.target.value }))}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />

          <button
            onClick={handleAdd}
            disabled={saving || !newVehicle.name}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? '登録中...' : '登録する'}
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
              <th className="py-2 pr-3">機体名</th>
              <th className="py-2 pr-3">段数</th>
              <th className="py-2 pr-3">全長</th>
              <th className="py-2 pr-3">直径</th>
              <th className="py-2 pr-3">全備質量</th>
              <th className="py-2 pr-3">推進剤質量</th>
              <th className="py-2 pr-3">ペイロード</th>
              <th className="py-2 pr-3">第1段推力</th>
              <th className="py-2 pr-3">補足</th>
              <th className="py-2 pr-3"></th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map(v => (
              <tr key={v.id} className="border-b border-gray-100 last:border-0">
                <td className="py-2 pr-3 font-medium text-gray-900">{v.name}</td>
                <td className="py-2 pr-3 tabular-nums">{v.stages.length}</td>
                <td className="py-2 pr-3 tabular-nums">{v.length} m</td>
                <td className="py-2 pr-3 tabular-nums">{v.diameter} m</td>
                <td className="py-2 pr-3 tabular-nums">{totalInitialMass(v).toLocaleString()} kg</td>
                <td className="py-2 pr-3 tabular-nums">{totalPropellantMass(v).toLocaleString()} kg</td>
                <td className="py-2 pr-3 tabular-nums">{v.payload_mass.toLocaleString()} kg</td>
                <td className="py-2 pr-3 tabular-nums">{(v.stages[0].thrust / 1000).toLocaleString()} kN</td>
                <td className="py-2 pr-3 text-xs text-gray-400 max-w-64 truncate" title={v.note}>{v.note}</td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  <button
                    onClick={() => onLoad(v)}
                    className="text-xs px-2 py-1 rounded border border-blue-300 text-blue-600 hover:bg-blue-50 transition-colors mr-1"
                  >
                    設定に読み込む
                  </button>
                  <button
                    onClick={() => handleDelete(v.id)}
                    className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-500 hover:bg-gray-50 transition-colors"
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
            {vehicles.length === 0 && (
              <tr>
                <td colSpan={10} className="py-4 text-center text-gray-400 text-sm">登録済みの機体はありません</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
