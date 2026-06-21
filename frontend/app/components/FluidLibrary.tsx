'use client'

import { useEffect, useState } from 'react'
import { createFluidLibraryEntry, deleteFluidLibraryEntry, fetchFluidLibrary, updateFluidLibraryEntry, type FluidLibraryEntry, type FluidLibrarySpec } from '@/app/lib/api'

const PHASE_LABEL: Record<string, string> = {
  gas: '気体',
  liquid: '液体',
}

const DEFAULT_NEW_FLUID: FluidLibrarySpec = {
  name: '',
  phase: 'liquid',
  is_oxidizer: false,
  is_fuel: false,
  density_kg_m3: 1000,
  viscosity_pa_s: 0.001,
  thermal_conductivity_w_m_k: 0.6,
  specific_heat_j_kg_k: 4186,
  reference_temperature_k: 293.15,
  reference_pressure_pa: 101325,
  note: '',
}

const NUMBER_FIELDS: { key: keyof FluidLibrarySpec; label: string }[] = [
  { key: 'density_kg_m3', label: '密度 [kg/m3]' },
  { key: 'viscosity_pa_s', label: '粘度 [Pa·s]' },
  { key: 'thermal_conductivity_w_m_k', label: '熱伝導率 [W/(m·K)]' },
  { key: 'specific_heat_j_kg_k', label: '定圧比熱 [J/(kg·K)]' },
  { key: 'reference_temperature_k', label: '参照温度 [K]' },
  { key: 'reference_pressure_pa', label: '参照圧力 [Pa]' },
]

export default function FluidLibrary() {
  const [fluids, setFluids] = useState<FluidLibraryEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<FluidLibrarySpec>(DEFAULT_NEW_FLUID)
  const [editingId, setEditingId] = useState<number | null>(null)

  function reload() {
    fetchFluidLibrary()
      .then(setFluids)
      .catch(e => setError(e instanceof Error ? e.message : '流体ライブラリの取得に失敗しました'))
  }

  useEffect(() => { reload() }, [])

  function startEdit(fluid: FluidLibraryEntry) {
    const { id, ...spec } = fluid
    void id
    setDraft(spec)
    setEditingId(fluid.id)
  }

  function cancelEdit() {
    setDraft(DEFAULT_NEW_FLUID)
    setEditingId(null)
  }

  async function handleSubmit() {
    if (!draft.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      if (editingId !== null) {
        await updateFluidLibraryEntry(editingId, draft)
      } else {
        await createFluidLibraryEntry(draft)
      }
      setDraft(DEFAULT_NEW_FLUID)
      setEditingId(null)
      reload()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '流体の保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    setError(null)
    try {
      await deleteFluidLibraryEntry(id)
      if (editingId === id) cancelEdit()
      reload()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '流体の削除に失敗しました')
    }
  }

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div className="rounded-lg border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">流体ライブラリ</h2>
        <p className="mt-1 text-sm text-gray-500">
          配管エッジで選択する推進剤（酸化剤・燃料）や、水などの汎用流体の物性値を管理します。固体材料の材料DBとは別のテーブルです
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(720px,1fr)_360px]">
        <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-gray-700">登録済み流体</h3>
            <span className="text-xs text-gray-400">{fluids.length} 件</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500">
                  <th className="px-4 py-2 text-left font-medium">流体名</th>
                  <th className="px-4 py-2 text-left font-medium">状態</th>
                  <th className="px-4 py-2 text-center font-medium">酸化剤</th>
                  <th className="px-4 py-2 text-center font-medium">燃料</th>
                  <th className="px-4 py-2 text-left font-medium">密度<br />[kg/m3]</th>
                  <th className="px-4 py-2 text-left font-medium">粘度<br />[Pa·s]</th>
                  <th className="px-4 py-2 text-left font-medium">熱伝導率<br />[W/(m·K)]</th>
                  <th className="px-4 py-2 text-left font-medium">定圧比熱<br />[J/(kg·K)]</th>
                  <th className="px-4 py-2 text-left font-medium">参照T<br />[K]</th>
                  <th className="px-4 py-2 text-left font-medium">参照P<br />[Pa]</th>
                  <th className="px-4 py-2 text-left font-medium">メモ</th>
                  <th className="px-4 py-2 text-left font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {fluids.map(f => (
                  <tr key={f.id} className={`border-b border-gray-50 hover:bg-blue-50/50 ${editingId === f.id ? 'bg-blue-50' : ''}`}>
                    <td className="px-4 py-3 font-medium text-gray-900">{f.name}</td>
                    <td className="px-4 py-3 text-gray-600">{PHASE_LABEL[f.phase] ?? f.phase}</td>
                    <td className="px-4 py-3 text-center">{f.is_oxidizer ? '✓' : ''}</td>
                    <td className="px-4 py-3 text-center">{f.is_fuel ? '✓' : ''}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{f.density_kg_m3.toLocaleString()}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{f.viscosity_pa_s}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{f.thermal_conductivity_w_m_k}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{f.specific_heat_j_kg_k.toLocaleString()}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{f.reference_temperature_k}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{f.reference_pressure_pa.toLocaleString()}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs max-w-48 truncate" title={f.note}>{f.note || '-'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => startEdit(f)}
                        className="mr-2 text-xs text-gray-400 hover:text-blue-600 transition-colors"
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(f.id)}
                        className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
                {fluids.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-4 py-6 text-center text-sm text-gray-400">登録済みの流体はありません</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 border-b border-gray-100 pb-3 text-sm font-semibold text-gray-700">
            {editingId !== null ? '流体を編集' : '新規登録'}
          </h3>
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">流体名</label>
              <input
                value={draft.name}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                placeholder="例: Water、推進剤なら LCH4 等"
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">状態</label>
              <select
                value={draft.phase}
                onChange={e => setDraft(d => ({ ...d, phase: e.target.value }))}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="liquid">液体</option>
                <option value="gas">気体</option>
              </select>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={draft.is_oxidizer}
                  onChange={e => setDraft(d => ({ ...d, is_oxidizer: e.target.checked }))}
                  className="accent-blue-500"
                />
                酸化剤
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={draft.is_fuel}
                  onChange={e => setDraft(d => ({ ...d, is_fuel: e.target.checked }))}
                  className="accent-blue-500"
                />
                燃料
              </label>
            </div>
            {NUMBER_FIELDS.map(field => (
              <div key={field.key}>
                <label className="mb-1 block text-xs font-medium text-gray-500">{field.label}</label>
                <input
                  type="number"
                  step="any"
                  value={draft[field.key] as number}
                  onChange={e => setDraft(d => ({ ...d, [field.key]: Number(e.target.value) || 0 }))}
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            ))}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">メモ・出典</label>
              <textarea
                value={draft.note}
                onChange={e => setDraft(d => ({ ...d, note: e.target.value }))}
                rows={2}
                className="w-full resize-none rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={saving || !draft.name.trim()}
                className="mt-2 flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? '保存中...' : editingId !== null ? '流体を更新' : '流体を登録'}
              </button>
              {editingId !== null && (
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="mt-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50"
                >
                  キャンセル
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
