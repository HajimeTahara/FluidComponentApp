'use client'

import { useMemo, useState } from 'react'

type ComponentCategory = 'pipe' | 'valve' | 'pump'

type ComponentRecord = {
  id: string
  code: string
  name: string
  category: ComponentCategory
  maker: string
  model: string
  note: string
  params: Record<string, string>
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
}

const CATEGORY_BADGE: Record<ComponentCategory, string> = {
  pipe: 'bg-sky-50 text-sky-700 border-sky-200',
  valve: 'bg-amber-50 text-amber-700 border-amber-200',
  pump: 'bg-violet-50 text-violet-700 border-violet-200',
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
}

const SAMPLE_COMPONENTS: ComponentRecord[] = [
  {
    id: 'sample-pipe-100a',
    code: 'PIPE-100A-SGP',
    name: 'SGP 100A 標準配管',
    category: 'pipe',
    maker: '標準',
    model: 'SGP-100A',
    note: '定常解析の配管ノード初期値用',
    params: {
      shape: '円管',
      diameterMm: '105.3',
      lengthM: '6',
      roughnessMm: '0.046',
      material: 'SGP',
      pressureClass: '10K',
    },
  },
  {
    id: 'sample-valve-50a',
    code: 'VALVE-GATE-50A',
    name: 'ゲートバルブ 50A',
    category: 'valve',
    maker: '標準',
    model: 'GV-50A',
    note: '開度100%の初期値',
    params: {
      diameterMm: '50',
      cv: '48',
      openingPct: '100',
      pressureClass: 'JIS 10K',
      connection: 'フランジ',
    },
  },
  {
    id: 'sample-pump-30m3h',
    code: 'PUMP-030-020',
    name: '遠心ポンプ 30m3/h 20m',
    category: 'pump',
    maker: '標準',
    model: 'CP-030',
    note: '二次PQ特性の初期登録例',
    params: {
      ratedFlowM3h: '30',
      ratedHeadM: '20',
      shutoffHeadM: '30',
      efficiencyPct: '75',
      ratedSpeedRpm: '1450',
    },
  },
]

const EMPTY_RECORD: Omit<ComponentRecord, 'id'> = {
  code: '',
  name: '',
  category: 'pipe',
  maker: '',
  model: '',
  note: '',
  params: {},
}

function makeId() {
  return `component-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function normalizeParams(category: ComponentCategory, params: Record<string, string>) {
  return Object.fromEntries(
    CATEGORY_FIELDS[category].map(field => [field.key, params[field.key] ?? '']),
  )
}

function categorySummary(record: ComponentRecord) {
  if (record.category === 'pipe') {
    return `${record.params.diameterMm || '-'} mm / L=${record.params.lengthM || '-'} m`
  }
  if (record.category === 'valve') {
    return `Cv ${record.params.cv || '-'} / ${record.params.diameterMm || '-'} mm`
  }
  return `${record.params.ratedFlowM3h || '-'} m3/h / H=${record.params.ratedHeadM || '-'} m`
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
  const [records, setRecords] = useState<ComponentRecord[]>(SAMPLE_COMPONENTS)
  const [filter, setFilter] = useState<ComponentCategory | 'all'>('all')
  const [selectedId, setSelectedId] = useState(SAMPLE_COMPONENTS[0]?.id ?? '')
  const [draft, setDraft] = useState<Omit<ComponentRecord, 'id'>>(EMPTY_RECORD)

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

  const registerComponent = () => {
    const category = draft.category
    const next: ComponentRecord = {
      ...draft,
      id: makeId(),
      code: draft.code.trim() || `COMP-${records.length + 1}`,
      name: draft.name.trim() || '新規部品',
      maker: draft.maker.trim(),
      model: draft.model.trim(),
      note: draft.note.trim(),
      params: normalizeParams(category, draft.params),
    }
    setRecords(prev => [next, ...prev])
    setSelectedId(next.id)
    setFilter(category)
    setDraft({ ...EMPTY_RECORD, category, params: normalizeParams(category, {}) })
  }

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <div>
          <h2 className="text-base font-semibold text-gray-900">部品管理</h2>
          <p className="mt-1 text-sm text-gray-500">配管、バルブ、ポンプの解析用マスタを登録します</p>
        </div>
        <div className="flex items-center gap-2">
          {(['all', 'pipe', 'valve', 'pump'] as const).map(item => (
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
                  </tr>
                ))}
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
                {(['pipe', 'valve', 'pump'] as ComponentCategory[]).map(category => (
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
            className="mt-5 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
          >
            部品を登録
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
