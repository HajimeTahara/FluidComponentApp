'use client'

import { useEffect, useState } from 'react'
import { createMaterial, deleteMaterial, fetchMaterials, updateMaterial, type Material, type MaterialSpec } from '@/app/lib/api'

const DEFAULT_NEW_MATERIAL: MaterialSpec = {
  name: '',
  category: '',
  density_kg_m3: 2700,
  yield_strength_pa: 0,
  thermal_conductivity_w_m_k: 0,
  specific_heat_j_kg_k: 0,
  reference_temperature_k: 293.15,
  note: '',
}

const NUMBER_FIELDS: { key: keyof MaterialSpec; label: string }[] = [
  { key: 'density_kg_m3', label: '密度 [kg/m3]' },
  { key: 'yield_strength_pa', label: '降伏強度 [Pa]' },
  { key: 'thermal_conductivity_w_m_k', label: '熱伝導率 [W/(m·K)]' },
  { key: 'specific_heat_j_kg_k', label: '比熱 [J/(kg·K)]' },
  { key: 'reference_temperature_k', label: '参照温度 [K]' },
]

export default function MaterialDatabase() {
  const [materials, setMaterials] = useState<Material[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<MaterialSpec>(DEFAULT_NEW_MATERIAL)
  const [editingId, setEditingId] = useState<number | null>(null)

  function reload() {
    fetchMaterials()
      .then(setMaterials)
      .catch(e => setError(e instanceof Error ? e.message : '材料データベースの取得に失敗しました'))
  }

  useEffect(() => { reload() }, [])

  function startEdit(material: Material) {
    const { id, ...spec } = material
    void id
    setDraft(spec)
    setEditingId(material.id)
  }

  function cancelEdit() {
    setDraft(DEFAULT_NEW_MATERIAL)
    setEditingId(null)
  }

  async function handleSubmit() {
    if (!draft.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      if (editingId !== null) {
        await updateMaterial(editingId, draft)
      } else {
        await createMaterial(draft)
      }
      setDraft(DEFAULT_NEW_MATERIAL)
      setEditingId(null)
      reload()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '材料の保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    setError(null)
    try {
      await deleteMaterial(id)
      if (editingId === id) cancelEdit()
      reload()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '材料の削除に失敗しました')
    }
  }

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div className="rounded-lg border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">固体ライブラリ</h2>
        <p className="mt-1 text-sm text-gray-500">
          ロケット段デザイナーの部品パラメータで選択する材料（密度・降伏強度・熱伝導率・比熱）を管理します
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(640px,1fr)_360px]">
        <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-gray-700">登録済み材料</h3>
            <span className="text-xs text-gray-400">{materials.length} 件</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500">
                  <th className="px-4 py-2 text-left font-medium">材料名</th>
                  <th className="px-4 py-2 text-left font-medium">系統</th>
                  <th className="px-4 py-2 text-left font-medium">密度<br />[kg/m3]</th>
                  <th className="px-4 py-2 text-left font-medium">降伏強度<br />[MPa]</th>
                  <th className="px-4 py-2 text-left font-medium">熱伝導率<br />[W/(m·K)]</th>
                  <th className="px-4 py-2 text-left font-medium">比熱<br />[J/(kg·K)]</th>
                  <th className="px-4 py-2 text-left font-medium">参照T<br />[K]</th>
                  <th className="px-4 py-2 text-left font-medium">メモ</th>
                  <th className="px-4 py-2 text-left font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {materials.map(m => (
                  <tr key={m.id} className={`border-b border-gray-50 hover:bg-blue-50/50 ${editingId === m.id ? 'bg-blue-50' : ''}`}>
                    <td className="px-4 py-3 font-medium text-gray-900">{m.name}</td>
                    <td className="px-4 py-3 text-gray-600">{m.category || '-'}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{m.density_kg_m3.toLocaleString()}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{(m.yield_strength_pa / 1e6).toFixed(0)}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{m.thermal_conductivity_w_m_k}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{m.specific_heat_j_kg_k}</td>
                    <td className="px-4 py-3 tabular-nums text-gray-600">{m.reference_temperature_k}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs max-w-48 truncate" title={m.note}>{m.note || '-'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => startEdit(m)}
                        className="mr-2 text-xs text-gray-400 hover:text-blue-600 transition-colors"
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(m.id)}
                        className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
                {materials.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-6 text-center text-sm text-gray-400">登録済みの材料はありません</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 border-b border-gray-100 pb-3 text-sm font-semibold text-gray-700">
            {editingId !== null ? '材料を編集' : '新規登録'}
          </h3>
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">材料名</label>
              <input
                value={draft.name}
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                placeholder="例: SUS304"
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">系統</label>
              <input
                value={draft.category}
                onChange={e => setDraft(d => ({ ...d, category: e.target.value }))}
                placeholder="例: ステンレス鋼"
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
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
                {saving ? '保存中...' : editingId !== null ? '材料を更新' : '材料を登録'}
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
