'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPart, deletePart, fetchParts, type Part } from '@/app/lib/api'

type ComponentCategory =
  | 'pipe'
  | 'valve'
  | 'pump'
  | 'structure'
  | 'tank'
  | 'combustor'
  | 'nozzle'
  | 'fairing'
  | 'fixed_mass'

type ComponentRecord = {
  id: number
  code: string
  name: string
  category: ComponentCategory
  maker: string
  model: string
  note: string
  params: Record<string, string>
}

function partToRecord(part: Part): ComponentRecord {
  return { ...part, category: part.category as ComponentCategory }
}

type FieldDef = {
  key: string
  label: string
  unit?: string
  placeholder?: string
}

const CATEGORY_LABEL: Record<ComponentCategory, string> = {
  pipe: '配管',
  valve: 'バルブ',
  pump: 'ポンプ',
  structure: '外壁構造材',
  tank: 'タンク',
  combustor: '燃焼器',
  nozzle: 'ノズル',
  fairing: 'フェアリング',
  fixed_mass: '固定質量',
}

const CATEGORY_BADGE: Record<ComponentCategory, string> = {
  pipe: 'bg-sky-50 text-sky-700 border-sky-200',
  valve: 'bg-amber-50 text-amber-700 border-amber-200',
  pump: 'bg-violet-50 text-violet-700 border-violet-200',
  structure: 'bg-slate-50 text-slate-700 border-slate-200',
  tank: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  combustor: 'bg-rose-50 text-rose-700 border-rose-200',
  nozzle: 'bg-orange-50 text-orange-700 border-orange-200',
  fairing: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  fixed_mass: 'bg-stone-50 text-stone-700 border-stone-200',
}

const CATEGORY_FIELDS: Record<ComponentCategory, FieldDef[]> = {
  pipe: [
    { key: 'shape', label: '形状', placeholder: '円管' },
    { key: 'diameterMm', label: '内径', unit: 'mm', placeholder: '100' },
    { key: 'lengthM', label: '標準長さ', unit: 'm', placeholder: '6' },
    { key: 'roughnessMm', label: '粗さ', unit: 'mm', placeholder: '0.046' },
    { key: 'material', label: '材質', placeholder: 'SUS304' },
    { key: 'pressureClass', label: '定格圧力', placeholder: '10K' },
  ],
  valve: [
    { key: 'diameterMm', label: '口径', unit: 'mm', placeholder: '50' },
    { key: 'cv', label: 'Cv値', placeholder: '48' },
    { key: 'openingPct', label: '初期開度', unit: '%', placeholder: '100' },
    { key: 'pressureClass', label: '圧力クラス', placeholder: 'JIS 10K' },
    { key: 'connection', label: '接続形式', placeholder: 'フランジ' },
  ],
  pump: [
    { key: 'ratedFlowM3h', label: '定格流量', unit: 'm3/h', placeholder: '30' },
    { key: 'ratedHeadM', label: '定格揚程', unit: 'm', placeholder: '20' },
    { key: 'shutoffHeadM', label: '閉止揚程', unit: 'm', placeholder: '30' },
    { key: 'efficiencyPct', label: '効率', unit: '%', placeholder: '75' },
    { key: 'ratedSpeedRpm', label: '定格回転数', unit: 'rpm', placeholder: '1450' },
  ],
  structure: [
    { key: 'diameterMm', label: '外径', unit: 'mm', placeholder: '3700' },
    { key: 'lengthMm', label: '長さ', unit: 'mm', placeholder: '5000' },
    { key: 'thicknessMm', label: '肉厚', unit: 'mm', placeholder: '5' },
    { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3', placeholder: '2700' },
    { key: 'material', label: '材質', placeholder: 'Al-Li 2195' },
  ],
  tank: [
    { key: 'diameterMm', label: '外径', unit: 'mm', placeholder: '3700' },
    { key: 'lengthMm', label: '長さ', unit: 'mm', placeholder: '8000' },
    { key: 'designPressurePa', label: '設計圧力', unit: 'Pa', placeholder: '300000' },
    { key: 'yieldStrengthPa', label: '降伏強度', unit: 'Pa', placeholder: '430000000' },
    { key: 'safetyFactor', label: '安全係数', placeholder: '1.5' },
    { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3', placeholder: '2700' },
    { key: 'propellantDensityKgM3', label: '推進剤密度', unit: 'kg/m3', placeholder: '423' },
    { key: 'ullagePercent', label: 'アレージ', unit: '%', placeholder: '3' },
  ],
  combustor: [
    { key: 'diameterMm', label: '燃焼室外径', unit: 'mm', placeholder: '400' },
    { key: 'lengthMm', label: '燃焼室長さ', unit: 'mm', placeholder: '600' },
    { key: 'throatDiameterMm', label: 'スロート径', unit: 'mm', placeholder: '150' },
    { key: 'chamberPressurePa', label: '燃焼圧', unit: 'Pa', placeholder: '6000000' },
    { key: 'cStarMS', label: '特性排気速度 c*', unit: 'm/s', placeholder: '1800' },
    { key: 'gamma', label: '比熱比 γ', placeholder: '1.2' },
    { key: 'oxidizer', label: '酸化剤', placeholder: 'LOX' },
    { key: 'fuel', label: '燃料', placeholder: 'LCH4' },
    { key: 'ofRatio', label: 'O/F比', placeholder: '3.5' },
    { key: 'yieldStrengthPa', label: '降伏強度', unit: 'Pa', placeholder: '900000000' },
    { key: 'safetyFactor', label: '安全係数', placeholder: '1.5' },
    { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3', placeholder: '8400' },
  ],
  nozzle: [
    { key: 'exitDiameterMm', label: '出口径', unit: 'mm', placeholder: '900' },
    { key: 'lengthMm', label: '長さ', unit: 'mm', placeholder: '1200' },
    { key: 'expansionRatio', label: '拡大比 Ae/At', placeholder: '36' },
    { key: 'ambientPressurePa', label: '外気圧', unit: 'Pa', placeholder: '101325' },
    { key: 'thicknessMm', label: '肉厚', unit: 'mm', placeholder: '3' },
    { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3', placeholder: '8400' },
  ],
  fairing: [
    { key: 'diameterMm', label: '外径', unit: 'mm', placeholder: '4000' },
    { key: 'lengthMm', label: '長さ', unit: 'mm', placeholder: '9000' },
    { key: 'thicknessMm', label: '肉厚', unit: 'mm', placeholder: '4' },
    { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3', placeholder: '1600' },
    { key: 'material', label: '材質', placeholder: 'CFRP' },
  ],
  fixed_mass: [
    { key: 'massKg', label: '質量', unit: 'kg', placeholder: '50' },
    { key: 'description', label: '内容', placeholder: 'アビオニクス' },
  ],
}

const EMPTY_RECORD: Omit<ComponentRecord, 'id'> = {
  code: '',
  name: '',
  category: 'pipe',
  maker: '',
  model: '',
  note: '',
  params: {},
}

function normalizeParams(category: ComponentCategory, params: Record<string, string>) {
  return Object.fromEntries(
    CATEGORY_FIELDS[category].map(field => [field.key, params[field.key] ?? '']),
  )
}

function categorySummary(record: ComponentRecord) {
  switch (record.category) {
    case 'pipe':
      return `${record.params.diameterMm || '-'} mm / L=${record.params.lengthM || '-'} m`
    case 'valve':
      return `Cv ${record.params.cv || '-'} / ${record.params.diameterMm || '-'} mm`
    case 'pump':
      return `${record.params.ratedFlowM3h || '-'} m3/h / H=${record.params.ratedHeadM || '-'} m`
    case 'structure':
    case 'fairing':
      return `${record.params.diameterMm || '-'} mm / t=${record.params.thicknessMm || '-'} mm`
    case 'tank':
      return `${record.params.diameterMm || '-'} mm / P=${record.params.designPressurePa || '-'} Pa`
    case 'combustor':
      return `Pc=${record.params.chamberPressurePa || '-'} Pa / At径=${record.params.throatDiameterMm || '-'} mm`
    case 'nozzle':
      return `ε=${record.params.expansionRatio || '-'} / 出口径=${record.params.exitDiameterMm || '-'} mm`
    case 'fixed_mass':
      return `${record.params.massKg || '-'} kg`
    default:
      return '-'
  }
}

function ParamPreview({ record }: { record: ComponentRecord | null }) {
  if (!record) {
    return (
      <div className="flex h-full min-h-48 items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 text-sm text-gray-400">
        部品を選択すると解析用パラメータを確認できます
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${CATEGORY_BADGE[record.category]}`}>
            {CATEGORY_LABEL[record.category]}
          </span>
          <span className="text-sm font-semibold text-gray-900">{record.name}</span>
        </div>
        <div className="mt-1 text-xs text-gray-500">{record.code}</div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
        {CATEGORY_FIELDS[record.category].map(field => (
          <div key={field.key}>
            <dt className="text-xs text-gray-500">
              {field.label}{field.unit ? ` [${field.unit}]` : ''}
            </dt>
            <dd className="mt-0.5 text-sm font-semibold text-gray-900 tabular-nums">
              {record.params[field.key] || '-'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export default function ComponentLibrary() {
  const [records, setRecords] = useState<ComponentRecord[]>([])
  const [filter, setFilter] = useState<ComponentCategory | 'all'>('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Omit<ComponentRecord, 'id'>>(EMPTY_RECORD)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function reload() {
    fetchParts()
      .then(parts => setRecords(parts.map(partToRecord)))
      .catch(e => setError(e instanceof Error ? e.message : '部品データの取得に失敗しました'))
  }

  useEffect(() => { reload() }, [])

  const visibleRecords = useMemo(
    () => records.filter(record => filter === 'all' || record.category === filter),
    [filter, records],
  )

  const selectedRecord = records.find(record => record.id === selectedId) ?? visibleRecords[0] ?? null

  const updateDraft = (field: keyof Omit<ComponentRecord, 'id' | 'params'>, value: string) => {
    if (field === 'category') {
      const category = value as ComponentCategory
      setDraft(prev => ({ ...prev, category, params: normalizeParams(category, prev.params) }))
      return
    }
    setDraft(prev => ({ ...prev, [field]: value }))
  }

  const updateParam = (key: string, value: string) => {
    setDraft(prev => ({ ...prev, params: { ...prev.params, [key]: value } }))
  }

  const registerComponent = async () => {
    const category = draft.category
    setSaving(true)
    setError(null)
    try {
      const created = await createPart({
        code: draft.code.trim() || `COMP-${records.length + 1}`,
        name: draft.name.trim() || '新規部品',
        category,
        maker: draft.maker.trim(),
        model: draft.model.trim(),
        note: draft.note.trim(),
        params: normalizeParams(category, draft.params),
      })
      reload()
      setSelectedId(created.id)
      setFilter(category)
      setDraft({ ...EMPTY_RECORD, category, params: normalizeParams(category, {}) })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '部品の登録に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const removeComponent = async (id: number) => {
    setError(null)
    try {
      await deletePart(id)
      reload()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '部品の削除に失敗しました')
    }
  }

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <div>
          <h2 className="text-base font-semibold text-gray-900">部品管理</h2>
          <p className="mt-1 text-sm text-gray-500">配管、バルブ、ポンプの解析用マスタを登録します</p>
        </div>
        <div className="flex items-center gap-2">
          {(['all', 'pipe', 'valve', 'pump', 'structure', 'tank', 'combustor', 'nozzle', 'fairing', 'fixed_mass'] as const).map(item => (
            <button
              key={item}
              type="button"
              onClick={() => setFilter(item)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === item
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-gray-300 bg-white text-gray-600 hover:border-blue-300 hover:text-blue-700'
              }`}
            >
              {item === 'all' ? 'すべて' : CATEGORY_LABEL[item]}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(520px,1fr)_420px]">
        <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-gray-700">登録済み部品</h3>
            <span className="text-xs text-gray-400">{visibleRecords.length} 件</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500">
                  <th className="px-4 py-2 text-left font-medium">コード</th>
                  <th className="px-4 py-2 text-left font-medium">部品名</th>
                  <th className="px-4 py-2 text-left font-medium">カテゴリ</th>
                  <th className="px-4 py-2 text-left font-medium">型式</th>
                  <th className="px-4 py-2 text-left font-medium">主要パラメータ</th>
                  <th className="px-4 py-2 text-left font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {visibleRecords.map(record => (
                  <tr
                    key={record.id}
                    onClick={() => setSelectedId(record.id)}
                    className={`cursor-pointer border-b border-gray-50 hover:bg-blue-50/50 ${
                      selectedRecord?.id === record.id ? 'bg-blue-50' : ''
                    }`}
                  >
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-gray-700">{record.code}</td>
                    <td className="px-4 py-3 text-gray-900">{record.name}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${CATEGORY_BADGE[record.category]}`}>
                        {CATEGORY_LABEL[record.category]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{record.model || '-'}</td>
                    <td className="px-4 py-3 text-gray-600 tabular-nums">{categorySummary(record)}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); removeComponent(record.id) }}
                        className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
                {visibleRecords.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-sm text-gray-400">登録済みの部品はありません</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 border-b border-gray-100 pb-3 text-sm font-semibold text-gray-700">新規登録</h3>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-500">カテゴリ</label>
              <select
                value={draft.category}
                onChange={e => updateDraft('category', e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {(['pipe', 'valve', 'pump', 'structure', 'tank', 'combustor', 'nozzle', 'fairing', 'fixed_mass'] as ComponentCategory[]).map(category => (
                  <option key={category} value={category}>{CATEGORY_LABEL[category]}</option>
                ))}
              </select>
            </div>

            {[
              ['code', '部品コード'],
              ['name', '部品名'],
              ['maker', 'メーカー'],
              ['model', '型式'],
            ].map(([key, label]) => (
              <div key={key}>
                <label className="mb-1 block text-xs font-medium text-gray-500">{label}</label>
                <input
                  value={draft[key as keyof typeof draft] as string}
                  onChange={e => updateDraft(key as keyof Omit<ComponentRecord, 'id' | 'params'>, e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            ))}

            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-500">タグ/用途メモ</label>
              <textarea
                value={draft.note}
                onChange={e => updateDraft('note', e.target.value)}
                rows={2}
                className="w-full resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="mt-5 border-t border-gray-100 pt-4">
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
              {CATEGORY_LABEL[draft.category]}パラメータ
            </h4>
            <div className="grid grid-cols-2 gap-3">
              {CATEGORY_FIELDS[draft.category].map(field => (
                <div key={field.key}>
                  <label className="mb-1 block text-xs font-medium text-gray-500">
                    {field.label}{field.unit ? ` [${field.unit}]` : ''}
                  </label>
                  <input
                    value={draft.params[field.key] ?? ''}
                    placeholder={field.placeholder}
                    onChange={e => updateParam(field.key, e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={registerComponent}
            disabled={saving}
            className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? '登録中...' : '部品を登録'}
          </button>
        </section>
      </div>

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-[420px,1fr]">
        <ParamPreview record={selectedRecord} />
        <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 border-b border-gray-100 pb-3 text-sm font-semibold text-gray-700">解析連携メモ</h3>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              ['1', '部品コードを解析ノードに保持'],
              ['2', 'カテゴリ別パラメータを入力値へコピー'],
              ['3', '解析側で個別調整した値はマスタへ自動反映しない'],
            ].map(([step, text]) => (
              <div key={step} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white">
                  {step}
                </div>
                <p className="text-sm text-gray-600">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
