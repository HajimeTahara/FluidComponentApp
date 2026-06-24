'use client'

import dynamic from 'next/dynamic'
import { useMemo, useState } from 'react'
import { calcRocketCdCurve, type RocketCdRequest, type RocketCdResult } from '@/app/lib/api'

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false })

const NOSE_TYPES: RocketCdRequest['nose_type'][] = [
  'Conical', 'Tangent ogive', 'Elliptical', 'Parabolic', 'Von Karman / Haack',
]
const SURFACE_FINISHES: RocketCdRequest['surface_finish'][] = [
  'Polished', 'Smooth paint', 'Regular paint', 'Unfinished', 'Rough',
]

// ── Small reusable components ──────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
      {children}
    </h3>
  )
}

function Field({
  label, unit, value, onChange, disabled = false,
}: {
  label: string
  unit: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5 mb-2">
      <label className="text-xs text-gray-500">
        {label} <span className="text-gray-400">[{unit}]</span>
      </label>
      <input
        type="number"
        value={value}
        step="any"
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-400"
      />
    </div>
  )
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-gray-900">{value}</span>
    </div>
  )
}

// ── Form state ─────────────────────────────────────────────────────

interface FormState {
  diameter: string
  noseType: RocketCdRequest['nose_type']
  noseLengthD: string
  bodyLengthD: string
  baseType: RocketCdRequest['base_type']
  boatTailLengthD: string
  baseDiameterD: string
  nozzleExitDiameterD: string
  finEnabled: boolean
  finCount: string
  finRootChordD: string
  finTipChordD: string
  finSpanD: string
  finSweepD: string
  finThicknessD: string
  surfaceFinish: RocketCdRequest['surface_finish']
  powerOn: boolean
  aoaDeg: string
  reynoldsDAtM1: string
  airDensity: string
  soundSpeed: string
  machMin: string
  machMax: string
  points: string
}

const DEFAULT_FORM: FormState = {
  diameter: '0.10',
  noseType: 'Von Karman / Haack',
  noseLengthD: '4.0',
  bodyLengthD: '10.0',
  baseType: 'Flat base',
  boatTailLengthD: '1.5',
  baseDiameterD: '0.65',
  nozzleExitDiameterD: '0.35',
  finEnabled: true,
  finCount: '4',
  finRootChordD: '1.5',
  finTipChordD: '0.7',
  finSpanD: '0.6',
  finSweepD: '0.6',
  finThicknessD: '0.02',
  surfaceFinish: 'Smooth paint',
  powerOn: false,
  aoaDeg: '0',
  reynoldsDAtM1: '3.0e6',
  airDensity: '1.225',
  soundSpeed: '340.3',
  machMin: '0.05',
  machMax: '3.0',
  points: '300',
}

function toCSV(result: RocketCdResult): string {
  const header = [
    'Mach', 'Cd_total', 'Cd_friction_body', 'Cd_friction_fins', 'Cd_nose_wave_pressure',
    'Cd_base', 'Cd_boattail_sep', 'Cd_fin_pressure_wave', 'Cd_AoA', 'Drag_N',
  ]
  const rows = result.mach.map((m, i) => [
    m, result.cd.total[i], result.cd.friction_body[i], result.cd.friction_fins[i],
    result.cd.nose_wave_pressure[i], result.cd.base[i], result.cd.boattail_sep[i],
    result.cd.fin_pressure_wave[i], result.cd.aoa[i],
    result.drag_n[i],
  ].join(','))
  return [header.join(','), ...rows].join('\n')
}

// ── Live shape geometry (client-side, no backend round-trip) ───────

type LiveShapeFin = {
  root_chord_d: number
  tip_chord_d: number
  span_d: number          // 投影後（このビューで見える）スパン
  sweep_d: number
  le_x_over_d: number
  te_x_over_d: number
  mirrored: boolean       // false: 下/右側に描画、true: 上/左側に描画
}

type EndViewPolygon = { x: number[]; y: number[] }

type LiveShape = {
  x_over_d: number[]
  r_over_d: number[]
  base_radius_over_d: number
  nozzle_radius_over_d: number
  total_length_over_d: number
  // フィンはN枚を円周上に等間隔配置したと仮定し、側面図はそのまま正投影した見え方
  sideFins: LiveShapeFin[]
  // 先端（ノーズ側）から見た端面図用：胴体円とフィンが放射状に並んだ見え方
  endFins: EndViewPolygon[]
}

function noseProfileXR(noseType: string, length: number, radius: number, n = 60): { x: number[]; r: number[] } {
  const L = Math.max(length, 1e-9)
  const x = Array.from({ length: n }, (_, i) => (length * i) / (n - 1))
  const r = x.map(xi => {
    const t = Math.min(Math.max(xi / L, 0), 1)
    switch (noseType) {
      case 'Conical':
        return radius * t
      case 'Tangent ogive': {
        const rho = (radius ** 2 + length ** 2) / (2.0 * radius)
        const inside = Math.max(rho ** 2 - (length - xi) ** 2, 0)
        return Math.sqrt(inside) + radius - rho
      }
      case 'Elliptical': {
        const term = 1.0 - ((xi - length) / L) ** 2
        return radius * Math.sqrt(Math.max(term, 0))
      }
      case 'Parabolic':
        return radius * (2.0 * t - t * t)
      case 'Von Karman / Haack': {
        const theta = Math.acos(Math.min(Math.max(1.0 - 2.0 * t, -1), 1))
        const term = theta - 0.5 * Math.sin(2.0 * theta)
        return radius * Math.sqrt(Math.max(term / Math.PI, 0))
      }
      default:
        return radius * t
    }
  })
  r[0] = 0
  r[r.length - 1] = radius
  return { x, r }
}

function computeLiveShape(form: FormState): LiveShape | null {
  const D = parseFloat(form.diameter)
  const noseLengthD = parseFloat(form.noseLengthD)
  const bodyLengthD = parseFloat(form.bodyLengthD)
  if (!Number.isFinite(D) || D <= 0 || !Number.isFinite(noseLengthD) || !Number.isFinite(bodyLengthD)) return null

  const R = 0.5 * D
  const noseLength = noseLengthD * D
  const bodyLength = bodyLengthD * D

  const boatTailLengthD = parseFloat(form.boatTailLengthD)
  const baseDiameterD = parseFloat(form.baseDiameterD)
  const isBoatTail = form.baseType === 'Boat tail' && Number.isFinite(boatTailLengthD) && boatTailLengthD > 0
  const boatTailLength = isBoatTail ? boatTailLengthD * D : 0
  const baseRadius = isBoatTail && Number.isFinite(baseDiameterD) ? 0.5 * baseDiameterD * D : R
  const totalLength = noseLength + bodyLength + boatTailLength

  const nozzleExitDiameterD = parseFloat(form.nozzleExitDiameterD)
  const nozzleRadius = 0.5 * (Number.isFinite(nozzleExitDiameterD) ? nozzleExitDiameterD : 0) * D

  const { x: xNose, r: rNose } = noseProfileXR(form.noseType, noseLength, R)
  const xs = [...xNose, noseLength + bodyLength]
  const rs = [...rNose, R]
  if (isBoatTail) {
    xs.push(totalLength)
    rs.push(baseRadius)
  }

  const finRootChordD = parseFloat(form.finRootChordD)
  const finTipChordD = parseFloat(form.finTipChordD)
  const finSpanD = parseFloat(form.finSpanD)
  const finSweepD = parseFloat(form.finSweepD)
  const finThicknessD = parseFloat(form.finThicknessD)
  const finCount = parseInt(form.finCount, 10)
  const finValid = [finRootChordD, finTipChordD, finSpanD, finSweepD, finThicknessD].every(Number.isFinite) && finCount >= 1

  const sideFins: LiveShapeFin[] = []
  const endFins: EndViewPolygon[] = []
  const bodyHalfWidth = 0.5 // r/D（フィン取り付け位置の基準。胴体半径=0.5D）

  if (form.finEnabled && finValid) {
    const leXOverD = Math.max(noseLengthD, noseLengthD + bodyLengthD - finRootChordD)
    const teXOverD = noseLengthD + bodyLengthD
    const EPS = 0.03 // この投影スケール未満のフィンは側面から見て幅ゼロ＝描画してもほぼ見えないため省略
    const halfThickness = Math.max(finThicknessD, 0.02) / 2

    // N枚を円周上に等間隔配置（フィン0=側面図の下側、既存挙動と一致）したと仮定する。
    // 側面図はcosで正投影（軸に直交するフィンは見えない＝EPS未満は省略）。
    // 端面図（ノーズ側から見た図）はどのフィンも全スパンが見えるので、角度だけ変えて放射状に配置する。
    for (let i = 0; i < finCount; i++) {
      const phi = (2 * Math.PI * i) / finCount
      const cosScale = Math.cos(phi)

      if (Math.abs(cosScale) > EPS) {
        sideFins.push({
          root_chord_d: finRootChordD, tip_chord_d: finTipChordD, sweep_d: finSweepD,
          le_x_over_d: leXOverD, te_x_over_d: teXOverD,
          span_d: finSpanD * Math.abs(cosScale), mirrored: cosScale < 0,
        })
      }

      // フィン0=真下を基準に、時計回りに角度を振った放射方向の単位ベクトル
      const dirU = -Math.sin(phi)
      const dirV = -Math.cos(phi)
      const perpU = dirV
      const perpV = -dirU
      const rootR = bodyHalfWidth
      const tipR = bodyHalfWidth + finSpanD
      endFins.push({
        x: [
          rootR * dirU + halfThickness * perpU, tipR * dirU + halfThickness * perpU,
          tipR * dirU - halfThickness * perpU, rootR * dirU - halfThickness * perpU,
        ],
        y: [
          rootR * dirV + halfThickness * perpV, tipR * dirV + halfThickness * perpV,
          tipR * dirV - halfThickness * perpV, rootR * dirV - halfThickness * perpV,
        ],
      })
    }
  }

  return {
    x_over_d: xs.map(v => v / D),
    r_over_d: rs.map(v => v / D),
    base_radius_over_d: baseRadius / D,
    nozzle_radius_over_d: nozzleRadius / D,
    total_length_over_d: totalLength / D,
    sideFins,
    endFins,
  }
}

function finPolygon(fin: LiveShapeFin, bodyHalfWidth: number): { x: number[]; y: number[] } {
  const { le_x_over_d, te_x_over_d, sweep_d, tip_chord_d, span_d, mirrored } = fin
  const root = mirrored ? bodyHalfWidth : -bodyHalfWidth
  const tip = mirrored ? root + span_d : root - span_d
  return {
    x: [le_x_over_d, te_x_over_d, le_x_over_d + sweep_d + tip_chord_d, le_x_over_d + sweep_d, le_x_over_d],
    y: [root, root, tip, tip, root],
  }
}

// ── Main component ─────────────────────────────────────────────────

export default function RocketCdCalculator() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [result, setResult] = useState<RocketCdResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function handleCalc() {
    setError(null)
    setLoading(true)
    try {
      const payload: RocketCdRequest = {
        diameter_m: parseFloat(form.diameter),
        nose_type: form.noseType,
        nose_length_d: parseFloat(form.noseLengthD),
        body_length_d: parseFloat(form.bodyLengthD),
        base_type: form.baseType,
        boat_tail_length_d: parseFloat(form.boatTailLengthD),
        base_diameter_d: parseFloat(form.baseDiameterD),
        nozzle_exit_diameter_d: parseFloat(form.nozzleExitDiameterD),
        fin_enabled: form.finEnabled,
        fin_count: parseInt(form.finCount, 10),
        fin_root_chord_d: parseFloat(form.finRootChordD),
        fin_tip_chord_d: parseFloat(form.finTipChordD),
        fin_span_d: parseFloat(form.finSpanD),
        fin_sweep_d: parseFloat(form.finSweepD),
        fin_thickness_d: parseFloat(form.finThicknessD),
        surface_finish: form.surfaceFinish,
        power_on: form.powerOn,
        aoa_deg: parseFloat(form.aoaDeg),
        reynolds_d_at_m1: parseFloat(form.reynoldsDAtM1),
        air_density_kg_m3: parseFloat(form.airDensity),
        sound_speed_m_s: parseFloat(form.soundSpeed),
        mach_min: parseFloat(form.machMin),
        mach_max: parseFloat(form.machMax),
        points: parseInt(form.points, 10),
      }
      setResult(await calcRocketCdCurve(payload))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '計算に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  function handleDownloadCSV() {
    if (!result) return
    const blob = new Blob(['﻿' + toCSV(result)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'rocket_cd_table.csv'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  // ── Shape outline traces (live, computed client-side from form) ──
  const liveShape = useMemo(() => computeLiveShape(form), [form])

  const shapeTraces = useMemo(() => {
    const shape = liveShape
    if (!shape) return []
    const xTop = shape.x_over_d
    const rTop = shape.r_over_d
    const xEnd = shape.total_length_over_d
    const baseRadiusOverD = shape.base_radius_over_d
    const nozzleRadiusOverD = shape.nozzle_radius_over_d
    const bodyHalfWidth = 0.5 // r/D（フィン取り付け位置の基準。胴体半径=0.5D）

    function bodyTraces(axis: 'x' | 'x2', ayis: 'y' | 'y2', axisLabel: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out: any[] = [
        {
          x: xTop, y: rTop, xaxis: axis, yaxis: ayis, type: 'scatter', mode: 'lines',
          name: axisLabel, line: { color: '#1e3a8a', width: 2 }, showlegend: false,
        },
        {
          x: xTop, y: rTop.map(r => -r), xaxis: axis, yaxis: ayis, type: 'scatter', mode: 'lines',
          name: axisLabel, line: { color: '#1e3a8a', width: 2 }, showlegend: false,
        },
        {
          x: [xEnd, xEnd], y: [-baseRadiusOverD, baseRadiusOverD], xaxis: axis, yaxis: ayis,
          type: 'scatter', mode: 'lines', name: 'ベース', line: { color: '#1e3a8a', width: 2 }, showlegend: false,
        },
      ]
      if (nozzleRadiusOverD > 0) {
        out.push({
          x: [xEnd, xEnd], y: [-nozzleRadiusOverD, nozzleRadiusOverD], xaxis: axis, yaxis: ayis,
          type: 'scatter', mode: 'lines', name: 'ノズル', line: { color: '#1e3a8a', width: 6 }, showlegend: false,
        })
      }
      return out
    }

    const traces = [...bodyTraces('x', 'y', '機体外形（側面）')]

    for (const fin of shape.sideFins) {
      const { x, y } = finPolygon(fin, bodyHalfWidth)
      traces.push({
        x, y, xaxis: 'x', yaxis: 'y', type: 'scatter', mode: 'lines', fill: 'toself',
        name: 'フィン（側面）', line: { color: '#2563eb', width: 1 }, fillcolor: 'rgba(37,99,235,0.35)', showlegend: false,
      })
    }

    // 端面図（ロケット先端から見た図）: 胴体円＋放射状のフィン
    const circleTheta = Array.from({ length: 73 }, (_, i) => (2 * Math.PI * i) / 72)
    traces.push({
      x: circleTheta.map(t => bodyHalfWidth * Math.sin(t)),
      y: circleTheta.map(t => bodyHalfWidth * Math.cos(t)),
      xaxis: 'x2', yaxis: 'y2', type: 'scatter', mode: 'lines',
      name: '機体外形（端面）', line: { color: '#1e3a8a', width: 2 }, showlegend: false,
    })
    for (const fin of shape.endFins) {
      traces.push({
        x: fin.x, y: fin.y, xaxis: 'x2', yaxis: 'y2', type: 'scatter', mode: 'lines', fill: 'toself',
        name: 'フィン（端面）', line: { color: '#0d9488', width: 1 }, fillcolor: 'rgba(13,148,136,0.35)', showlegend: false,
      })
    }

    return traces
  }, [liveShape])

  // ── Drag force traces ──────────────────────────────────────────────
  const dragTraces = useMemo(() => {
    if (!result) return []
    return [{
      x: result.mach, y: result.drag_n, type: 'scatter' as const, mode: 'lines' as const,
      name: '抗力 Fd', line: { color: '#dc2626', width: 2.5 },
    }]
  }, [result])

  // ── Cd(Mach) traces ───────────────────────────────────────────────
  const cdTraces = useMemo(() => {
    if (!result) return []
    const { mach, cd } = result
    const fins = cd.friction_fins.map((v, i) => v + cd.fin_pressure_wave[i])
    return [
      { x: mach, y: cd.total, name: 'Cd合計', line: { color: '#111827', width: 2.5 } },
      { x: mach, y: cd.friction_body, name: '摩擦抗力', line: { color: '#2563eb', width: 1.75 } },
      { x: mach, y: cd.nose_wave_pressure, name: 'ノーズ', line: { color: '#ef4444', width: 1.75 } },
      { x: mach, y: cd.base, name: 'ベース', line: { color: '#10b981', width: 1.75 } },
      { x: mach, y: fins, name: 'フィン', line: { color: '#f59e0b', width: 1.75 } },
      { x: mach, y: cd.boattail_sep, name: 'ボートテール剥離抵抗', line: { color: '#8b5cf6', width: 1.75 } },
      { x: mach, y: cd.aoa, name: '迎角抗力', line: { color: '#0891b2', width: 1.75 } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ].map(t => ({ ...t, type: 'scatter' as const, mode: 'lines' as const })) as any[]
  }, [result])

  // ── Table rows (sparse, ≤12) ──────────────────────────────────────
  const tableIndices = useMemo(() => {
    if (!result) return []
    const n = result.mach.length
    if (n <= 12) return Array.from({ length: n }, (_, i) => i)
    const step = Math.floor((n - 1) / 11)
    const idx = Array.from({ length: 12 }, (_, i) => Math.min(i * step, n - 1))
    if (idx[idx.length - 1] !== n - 1) idx[idx.length - 1] = n - 1
    return [...new Set(idx)]
  }, [result])

  return (
    <div className="flex gap-6">

      {/* ─── Settings Panel ──────────────────────────────────── */}
      <div className="w-72 shrink-0 bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-3 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 160px)' }}>

        <div>
          <SectionHeader>形状</SectionHeader>
          <Field label="代表直径 D" unit="m" value={form.diameter} onChange={v => set('diameter', v)} />
          <div className="flex flex-col gap-0.5 mb-2">
            <label className="text-xs text-gray-500">ノーズ形状</label>
            <select
              value={form.noseType}
              onChange={e => set('noseType', e.target.value as FormState['noseType'])}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {NOSE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <Field label="ノーズ長 Ln/D" unit="-" value={form.noseLengthD} onChange={v => set('noseLengthD', v)} />
          <Field label="胴体長 Lb/D" unit="-" value={form.bodyLengthD} onChange={v => set('bodyLengthD', v)} />
        </div>

        <hr className="border-gray-100" />

        <div>
          <SectionHeader>ベース・ノズル</SectionHeader>
          <div className="flex flex-col gap-0.5 mb-2">
            <label className="text-xs text-gray-500">ベース形状</label>
            <select
              value={form.baseType}
              onChange={e => set('baseType', e.target.value as FormState['baseType'])}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="Flat base">Flat base</option>
              <option value="Boat tail">Boat tail</option>
            </select>
          </div>
          <Field
            label="ボートテール長 Lbt/D" unit="-" value={form.boatTailLengthD}
            onChange={v => set('boatTailLengthD', v)} disabled={form.baseType !== 'Boat tail'}
          />
          <Field
            label="ボートテール後端直径 Db/D" unit="-" value={form.baseDiameterD}
            onChange={v => set('baseDiameterD', v)} disabled={form.baseType !== 'Boat tail'}
          />
          <Field label="ノズル出口直径 De/D" unit="-" value={form.nozzleExitDiameterD} onChange={v => set('nozzleExitDiameterD', v)} />
        </div>

        <hr className="border-gray-100" />

        <div>
          <SectionHeader>フィン</SectionHeader>
          <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
            <input
              type="checkbox" checked={form.finEnabled}
              onChange={e => set('finEnabled', e.target.checked)} className="accent-blue-500"
            />
            <span className="text-sm">フィンを有効にする</span>
          </label>
          <Field label="フィン枚数" unit="-" value={form.finCount} onChange={v => set('finCount', v)} disabled={!form.finEnabled} />
          <Field label="翼根長 cr/D" unit="-" value={form.finRootChordD} onChange={v => set('finRootChordD', v)} disabled={!form.finEnabled} />
          <Field label="翼端長 ct/D" unit="-" value={form.finTipChordD} onChange={v => set('finTipChordD', v)} disabled={!form.finEnabled} />
          <Field label="スパン s/D" unit="-" value={form.finSpanD} onChange={v => set('finSpanD', v)} disabled={!form.finEnabled} />
          <Field label="後退量 xs/D" unit="-" value={form.finSweepD} onChange={v => set('finSweepD', v)} disabled={!form.finEnabled} />
          <Field label="フィン厚 tf/D" unit="-" value={form.finThicknessD} onChange={v => set('finThicknessD', v)} disabled={!form.finEnabled} />
        </div>

        <hr className="border-gray-100" />

        <div>
          <SectionHeader>飛行・表面</SectionHeader>
          <div className="flex flex-col gap-0.5 mb-2">
            <label className="text-xs text-gray-500">表面仕上げ</label>
            <select
              value={form.surfaceFinish}
              onChange={e => set('surfaceFinish', e.target.value as FormState['surfaceFinish'])}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {SURFACE_FINISHES.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
            <input
              type="checkbox" checked={form.powerOn}
              onChange={e => set('powerOn', e.target.checked)} className="accent-blue-500"
            />
            <span className="text-sm">推力ON（排気プルームによるベース抵抗低減）</span>
          </label>
          <Field label="迎角" unit="deg" value={form.aoaDeg} onChange={v => set('aoaDeg', v)} />
          <Field label="Re_D（Mach 1時）" unit="-" value={form.reynoldsDAtM1} onChange={v => set('reynoldsDAtM1', v)} />
        </div>

        <hr className="border-gray-100" />

        <div>
          <SectionHeader>抗力計算用の大気条件</SectionHeader>
          <Field label="空気密度" unit="kg/m³" value={form.airDensity} onChange={v => set('airDensity', v)} />
          <Field label="音速" unit="m/s" value={form.soundSpeed} onChange={v => set('soundSpeed', v)} />
          <p className="text-xs text-gray-400 -mt-1">デフォルトはISA海面標準大気値（ρ=1.225 kg/m³, a=340.3 m/s）。V = Mach × 音速として抗力Fdを計算</p>
        </div>

        <hr className="border-gray-100" />

        <div>
          <SectionHeader>Mach範囲</SectionHeader>
          <Field label="Mach min" unit="-" value={form.machMin} onChange={v => set('machMin', v)} />
          <Field label="Mach max" unit="-" value={form.machMax} onChange={v => set('machMax', v)} />
          <Field label="計算点数" unit="-" value={form.points} onChange={v => set('points', v)} />
        </div>

        <button
          onClick={handleCalc}
          disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? '計算中...' : '計算する'}
        </button>
      </div>

      {/* ─── Results Panel ────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-4">
          {/* 機体形状: フォーム変更に対してシームレスに再描画（計算ボタン不要） */}
          <div className="flex-1 min-w-0 bg-white rounded-lg border border-gray-200 p-4">
            <Plot
              data={shapeTraces}
              layout={{
                title: { text: '機体形状', font: { size: 13 } },
                xaxis: { domain: [0, 0.72], anchor: 'y', title: { text: 'x / D', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                yaxis: {
                  domain: [0, 1], title: { text: 'r / D', standoff: 8 },
                  showgrid: true, gridcolor: '#f0f0f0', zeroline: false, scaleanchor: 'x', scaleratio: 1,
                },
                // 端面図（ノーズ側から見た図）: yaxis2をyaxisにmatchesさせ、r/Dの縦位置（胴体・フィン先端の高さ）を側面図と完全に揃える
                xaxis2: { domain: [0.8, 1], anchor: 'y2', scaleanchor: 'y2', scaleratio: 1, showgrid: false, zeroline: false, showticklabels: false },
                yaxis2: {
                  domain: [0, 1], matches: 'y', showgrid: false, zeroline: false, showticklabels: false,
                },
                margin: { t: 45, r: 20, b: 78, l: 55 },
                autosize: true,
                showlegend: false,
                annotations: [
                  {
                    text: 'D: 代表直径（パラメータ）<br>r: 各位置での半径<br>x: 先端(ノーズ先端)を0とした軸方向距離',
                    x: 0.01, y: 0.98, xref: 'paper', yref: 'paper', xanchor: 'left', yanchor: 'top',
                    align: 'left', showarrow: false, font: { size: 10, color: '#6b7280' },
                  },
                  {
                    text: '側面図', x: 0.36, y: -0.32, xref: 'paper', yref: 'paper',
                    showarrow: false, font: { size: 11, color: '#374151' },
                  },
                  {
                    text: '端面図', x: 0.9, y: -0.32, xref: 'paper', yref: 'paper',
                    showarrow: false, font: { size: 11, color: '#374151' },
                  },
                ],
                font: { family: 'system-ui, sans-serif', size: 12 },
              }}
              config={{ displayModeBar: true, responsive: true, displaylogo: false }}
              style={{ width: '100%', height: '320px' }}
            />
            {result && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <StatItem label="基準面積 Aref" value={`${result.summary.aref_m2.toFixed(4)} m²`} />
                <StatItem label="全長 / D" value={result.summary.total_length_over_d.toFixed(2)} />
                <StatItem label="ベース面積比" value={result.summary.base_area_ratio.toFixed(3)} />
                <StatItem label="濡れ面積 / Aref" value={result.summary.wetted_area_over_aref.toFixed(2)} />
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 bg-white rounded-lg border border-gray-200 p-4">
            {result ? (
              <Plot
                data={cdTraces}
                layout={{
                  title: { text: 'Cd(Mach) 簡易推定', font: { size: 13 } },
                  xaxis: { title: { text: 'Mach number', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                  yaxis: { title: { text: 'Cd [-]', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                  margin: { t: 45, r: 20, b: 45, l: 55 },
                  autosize: true,
                  legend: { font: { size: 10 } },
                  font: { family: 'system-ui, sans-serif', size: 12 },
                }}
                config={{ displayModeBar: true, responsive: true, displaylogo: false }}
                style={{ width: '100%', height: '260px' }}
              />
            ) : (
              <div className="h-[260px] flex items-center justify-center text-center text-gray-400">
                <div>
                  <p className="text-sm mb-1">「計算する」を押すとCd(Mach)を表示します</p>
                  <p className="text-xs">機体形状は左の形状プロットでリアルタイムに確認できます</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {result && (<>

          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <Plot
              data={dragTraces}
              layout={{
                title: { text: '抗力 Fd(Mach)', font: { size: 13 } },
                xaxis: { title: { text: 'Mach number', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                yaxis: { title: { text: 'Fd [N]', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                margin: { t: 45, r: 20, b: 45, l: 65 },
                autosize: true,
                showlegend: false,
                font: { family: 'system-ui, sans-serif', size: 12 },
              }}
              config={{ displayModeBar: true, responsive: true, displaylogo: false }}
              style={{ width: '100%', height: '240px' }}
            />
            <p className="mt-2 text-xs text-gray-400">
              指定した空気密度ρ={form.airDensity} kg/m³・音速a={form.soundSpeed} m/sを仮定し、V = Mach × a として Fd = (1/2)ρV²Cd・Aref で計算（高度による密度・音速変化は考慮しない簡易近似）
            </p>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <SectionHeader>Cdテーブル</SectionHeader>
              <button
                onClick={handleDownloadCSV}
                className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors"
              >
                CSVダウンロード
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="py-1.5 pr-3">Mach</th>
                    <th className="py-1.5 pr-3">Cd合計</th>
                    <th className="py-1.5 pr-3">摩擦抗力</th>
                    <th className="py-1.5 pr-3">ノーズ</th>
                    <th className="py-1.5 pr-3">ベース</th>
                    <th className="py-1.5 pr-3">フィン</th>
                    <th className="py-1.5 pr-3">ボートテール剥離抵抗</th>
                    <th className="py-1.5 pr-3">迎角抗力</th>
                    <th className="py-1.5 pr-3">抗力Fd</th>
                  </tr>
                  <tr className="text-left text-gray-400 border-b border-gray-200">
                    <th className="py-0.5 pr-3 font-normal">[-]</th>
                    <th className="py-0.5 pr-3 font-normal">[-]</th>
                    <th className="py-0.5 pr-3 font-normal">[-]</th>
                    <th className="py-0.5 pr-3 font-normal">[-]</th>
                    <th className="py-0.5 pr-3 font-normal">[-]</th>
                    <th className="py-0.5 pr-3 font-normal">[-]</th>
                    <th className="py-0.5 pr-3 font-normal">[-]</th>
                    <th className="py-0.5 pr-3 font-normal">[-]</th>
                    <th className="py-0.5 pr-3 font-normal">[N]</th>
                  </tr>
                </thead>
                <tbody>
                  {tableIndices.map(i => (
                    <tr key={i} className="border-b border-gray-100 last:border-0">
                      <td className="py-1.5 pr-3 font-medium text-gray-900 tabular-nums">{result.mach[i].toFixed(3)}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{result.cd.total[i].toFixed(4)}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{result.cd.friction_body[i].toFixed(4)}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{result.cd.nose_wave_pressure[i].toFixed(4)}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{result.cd.base[i].toFixed(4)}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{(result.cd.friction_fins[i] + result.cd.fin_pressure_wave[i]).toFixed(4)}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{result.cd.boattail_sep[i].toFixed(4)}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{result.cd.aoa[i].toFixed(4)}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{result.drag_n[i].toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </>)}
      </div>
    </div>
  )
}
