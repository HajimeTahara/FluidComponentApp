'use client'

import dynamic from 'next/dynamic'
import { useMemo, useState } from 'react'
import {
  calcPressureDrop, fetchProperties,
  type PressureDropRequest, type PressureDropResult,
} from '@/app/lib/api'

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false })

type PipeType = 'circular' | 'rectangular' | 'annulus'
type FrictionMethod = 'colebrook' | 'blasius'

const SUPPORTED_FLUIDS = [
  'Water', 'Methane', 'Nitrogen', 'Oxygen', 'Hydrogen',
  'CarbonDioxide', 'Propane', 'Ammonia', 'R134a', 'Ethane',
]

const REGIME_COLOR: Record<string, string> = {
  laminar: '#3b82f6',
  transitional: '#f97316',
  turbulent: '#ef4444',
}

const REGIME_LABEL: Record<string, string> = {
  laminar: '層流 (Re < 2300)',
  transitional: '遷移域 (2300 ≤ Re < 4000)',
  turbulent: '乱流 (Re ≥ 4000)',
}

const REGIME_SHORT: Record<string, string> = {
  laminar: '層流',
  transitional: '遷移',
  turbulent: '乱流',
}

const REGIME_CLASS: Record<string, string> = {
  laminar: 'text-blue-600',
  transitional: 'text-orange-500',
  turbulent: 'text-red-500',
}

const X_AXIS_LABEL: Record<string, string> = {
  q:  '流量 Q [m³/h]',
  v:  '流速 v [m/s]',
  re: 'レイノルズ数 Re [-]',
}

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

function StatItem({ label, value, color = 'text-gray-900' }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  )
}

// ── Pipe cross-section diagram ─────────────────────────────────────

function PipeDiagram({ pipeType }: { pipeType: PipeType }) {
  const cls = "w-full rounded bg-slate-50 border border-slate-200 mt-1 mb-1"

  if (pipeType === 'circular') return (
    <svg viewBox="0 0 160 88" className={cls} overflow="visible">
      <circle cx="80" cy="46" r="34" fill="#dbeafe" stroke="#2563eb" strokeWidth="2" />
      {/* centerline */}
      <line x1="46" y1="46" x2="114" y2="46" stroke="#1e40af" strokeWidth="1" strokeDasharray="5 3" />
      {/* ticks */}
      <line x1="46" y1="40" x2="46" y2="52" stroke="#1e40af" strokeWidth="1.5" />
      <line x1="114" y1="40" x2="114" y2="52" stroke="#1e40af" strokeWidth="1.5" />
      {/* label */}
      <text x="80" y="37" textAnchor="middle" dominantBaseline="middle" fontSize="14" fontWeight="bold" fill="#1e40af">D</text>
    </svg>
  )

  if (pipeType === 'rectangular') return (
    <svg viewBox="0 0 180 96" className={cls} overflow="visible">
      <rect x="28" y="24" width="124" height="52" fill="#dbeafe" stroke="#2563eb" strokeWidth="2" />
      {/* W dim line above */}
      <line x1="28" y1="13" x2="152" y2="13" stroke="#1e40af" strokeWidth="1.5" />
      <line x1="28" y1="8"  x2="28"  y2="18" stroke="#1e40af" strokeWidth="1.5" />
      <line x1="152" y1="8" x2="152" y2="18" stroke="#1e40af" strokeWidth="1.5" />
      <text x="90" y="12" textAnchor="middle" dominantBaseline="middle" fontSize="13" fontWeight="bold" fill="#1e40af">W</text>
      {/* H dim line right */}
      <line x1="164" y1="24" x2="164" y2="76" stroke="#1e40af" strokeWidth="1.5" />
      <line x1="159" y1="24" x2="169" y2="24" stroke="#1e40af" strokeWidth="1.5" />
      <line x1="159" y1="76" x2="169" y2="76" stroke="#1e40af" strokeWidth="1.5" />
      <text x="175" y="50" textAnchor="middle" dominantBaseline="middle" fontSize="13" fontWeight="bold" fill="#1e40af">H</text>
    </svg>
  )

  // annulus
  return (
    <svg viewBox="0 0 200 112" className={cls} overflow="visible">
      {/* outer circle */}
      <circle cx="100" cy="58" r="42" fill="#dbeafe" stroke="#2563eb" strokeWidth="2" />
      {/* inner circle (bore) */}
      <circle cx="100" cy="58" r="20" fill="#f1f5f9" stroke="#475569" strokeWidth="2" />
      {/* D_o dim line below */}
      <line x1="58"  y1="106" x2="142" y2="106" stroke="#1e40af" strokeWidth="1.5" />
      <line x1="58"  y1="101" x2="58"  y2="111" stroke="#1e40af" strokeWidth="1.5" />
      <line x1="142" y1="101" x2="142" y2="111" stroke="#1e40af" strokeWidth="1.5" />
      <line x1="58"  y1="100" x2="58"  y2="106" stroke="#1e40af" strokeWidth="0.8" strokeDasharray="2 2" />
      <line x1="142" y1="100" x2="142" y2="106" stroke="#1e40af" strokeWidth="0.8" strokeDasharray="2 2" />
      <text x="100" y="110" textAnchor="middle" dominantBaseline="hanging" fontSize="12" fontWeight="bold" fill="#1e40af">D_o</text>
      {/* D_i dim line above */}
      <line x1="80"  y1="10" x2="120" y2="10" stroke="#475569" strokeWidth="1.5" />
      <line x1="80"  y1="5"  x2="80"  y2="15" stroke="#475569" strokeWidth="1.5" />
      <line x1="120" y1="5"  x2="120" y2="15" stroke="#475569" strokeWidth="1.5" />
      <line x1="80"  y1="15" x2="80"  y2="38" stroke="#475569" strokeWidth="0.8" strokeDasharray="2 2" />
      <line x1="120" y1="15" x2="120" y2="38" stroke="#475569" strokeWidth="0.8" strokeDasharray="2 2" />
      <text x="100" y="7" textAnchor="middle" dominantBaseline="middle" fontSize="12" fontWeight="bold" fill="#475569">D_i</text>
    </svg>
  )
}

// ── Form state ─────────────────────────────────────────────────────

interface FormState {
  pipeType: PipeType
  diameter: string
  width: string
  ductHeight: string
  outerDiameter: string
  innerDiameter: string
  length: string
  roughness: string
  density: string
  viscosity: string
  frictionMethod: FrictionMethod
  flowRateMin: string
  flowRateMax: string
}

const DEFAULT_FORM: FormState = {
  pipeType: 'circular',
  diameter: '100',
  width: '200',
  ductHeight: '100',
  outerDiameter: '100',
  innerDiameter: '50',
  length: '100',
  roughness: '0.046',
  density: '1000',
  viscosity: '1.0',
  frictionMethod: 'colebrook',
  flowRateMin: '1',
  flowRateMax: '200',
}

// ── Main component ─────────────────────────────────────────────────

export default function PressureDropCalc() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [result, setResult] = useState<PressureDropResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [autoExpanded, setAutoExpanded] = useState(false)
  const [autoFluid, setAutoFluid] = useState('Water')
  const [autoT, setAutoT] = useState('293.15')
  const [autoP, setAutoP] = useState('101.325')
  const [autoLoading, setAutoLoading] = useState(false)
  const [xAxis, setXAxis] = useState<'q' | 'v' | 're'>('q')

  function set(field: keyof FormState, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function handleCalc() {
    setError(null)
    setLoading(true)
    try {
      const mm = (s: string) => parseFloat(s) / 1000
      const payload: PressureDropRequest = {
        pipe_type: form.pipeType,
        diameter: mm(form.diameter),
        width: mm(form.width),
        duct_height: mm(form.ductHeight),
        outer_diameter: mm(form.outerDiameter),
        inner_diameter: mm(form.innerDiameter),
        length: parseFloat(form.length),
        roughness: mm(form.roughness),
        density: parseFloat(form.density),
        viscosity: parseFloat(form.viscosity) / 1000,
        friction_method: form.frictionMethod,
        flow_rate_min: parseFloat(form.flowRateMin),
        flow_rate_max: parseFloat(form.flowRateMax),
        points: 80,
      }
      setResult(await calcPressureDrop(payload))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '計算に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  async function handleAutoFill() {
    setAutoLoading(true)
    try {
      const props = await fetchProperties(autoFluid, parseFloat(autoT), parseFloat(autoP) * 1000)
      if (props.D != null) set('density', props.D.toFixed(3))
      if (props.V != null) set('viscosity', (props.V * 1000).toFixed(4))
    } catch {
      // 取得失敗は無視（手動入力で対応）
    } finally {
      setAutoLoading(false)
    }
  }

  // ── Plotly traces split by regime ──────────────────────────────
  const traces = useMemo(() => {
    if (!result) return []

    const segments: Record<string, { x: number[]; y: number[]; cd: number[][] }> = {
      laminar: { x: [], y: [], cd: [] },
      transitional: { x: [], y: [], cd: [] },
      turbulent: { x: [], y: [], cd: [] },
    }

    result.flow_rates.forEach((_, i) => {
      const seg = segments[result.regimes[i]]
      if (!seg) return
      const xVal = xAxis === 'q' ? result.flow_rates[i]
                 : xAxis === 'v' ? result.velocities[i]
                 : result.reynolds[i]
      seg.x.push(xVal)
      seg.y.push(result.pressure_drops[i] / 1000)
      seg.cd.push([result.flow_rates[i], result.velocities[i], result.reynolds[i], result.friction_factors[i]])
    })

    return Object.entries(segments)
      .filter(([, s]) => s.x.length > 0)
      .map(([regime, s]) => ({
        x: s.x,
        y: s.y,
        customdata: s.cd,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: REGIME_LABEL[regime] ?? regime,
        line: { color: REGIME_COLOR[regime], width: 2.5 },
        hovertemplate:
          `${X_AXIS_LABEL[xAxis]}: %{x:.2f}<br>` +
          'ΔP: %{y:.3f} kPa<br>' +
          'Q: %{customdata[0]:.1f} m³/h<br>' +
          'v: %{customdata[1]:.3f} m/s<br>' +
          'Re: %{customdata[2]:.0f}<br>' +
          'f: %{customdata[3]:.5f}' +
          `<extra>${REGIME_LABEL[regime] ?? regime}</extra>`,
      }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, xAxis])

  // ── Table rows (sparse, ≤12) ────────────────────────────────────
  const tableIndices = useMemo(() => {
    if (!result) return []
    const n = result.flow_rates.length
    if (n <= 12) return Array.from({ length: n }, (_, i) => i)
    const step = Math.floor((n - 1) / 11)
    const idx = Array.from({ length: 12 }, (_, i) => Math.min(i * step, n - 1))
    if (idx[idx.length - 1] !== n - 1) idx[idx.length - 1] = n - 1
    return [...new Set(idx)]
  }, [result])

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="flex gap-6">

      {/* ─── Settings Panel ──────────────────────────────────── */}
      <div className="w-72 shrink-0 bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-3 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 160px)' }}>

        {/* Pipe Type */}
        <div>
          <SectionHeader>管タイプ</SectionHeader>
          <div className="flex flex-col gap-1.5">
            {([
              ['circular',    '円管'],
              ['rectangular', '矩形管（ダクト）'],
              ['annulus',     '中空円環管'],
            ] as [PipeType, string][]).map(([t, label]) => (
              <label key={t} className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="radio"
                  name="pipeType"
                  checked={form.pipeType === t}
                  onChange={() => set('pipeType', t)}
                  className="accent-blue-500"
                />
                <span className="text-sm">{label}</span>
              </label>
            ))}
          </div>
          <PipeDiagram pipeType={form.pipeType} />
        </div>

        <hr className="border-gray-100" />

        {/* Geometry */}
        <div>
          <SectionHeader>ジオメトリ</SectionHeader>
          {form.pipeType === 'circular' && (
            <Field label="内径 D" unit="mm" value={form.diameter} onChange={v => set('diameter', v)} />
          )}
          {form.pipeType === 'rectangular' && (<>
            <Field label="幅 W" unit="mm" value={form.width} onChange={v => set('width', v)} />
            <Field label="高さ H" unit="mm" value={form.ductHeight} onChange={v => set('ductHeight', v)} />
          </>)}
          {form.pipeType === 'annulus' && (<>
            <Field label="外径 D_o" unit="mm" value={form.outerDiameter} onChange={v => set('outerDiameter', v)} />
            <Field label="内径 D_i" unit="mm" value={form.innerDiameter} onChange={v => set('innerDiameter', v)} />
          </>)}
        </div>

        <hr className="border-gray-100" />

        {/* Pipe Parameters */}
        <div>
          <SectionHeader>配管パラメータ</SectionHeader>
          <Field label="配管長 L" unit="m" value={form.length} onChange={v => set('length', v)} />
          <Field
            label="表面粗さ ε"
            unit="mm"
            value={form.roughness}
            onChange={v => set('roughness', v)}
            disabled={form.frictionMethod === 'blasius'}
          />
          {form.frictionMethod === 'blasius' && (
            <p className="text-xs text-gray-400 -mt-1 mb-1">※ Blasius 式は水力滑面を仮定</p>
          )}
        </div>

        <hr className="border-gray-100" />

        {/* Fluid Properties */}
        <div>
          <SectionHeader>流体物性</SectionHeader>
          <Field label="密度 ρ" unit="kg/m³" value={form.density} onChange={v => set('density', v)} />
          <Field label="動粘度 μ" unit="mPa·s" value={form.viscosity} onChange={v => set('viscosity', v)} />

          <button
            className="text-xs text-blue-500 hover:text-blue-700 flex items-center gap-1 mt-1"
            onClick={() => setAutoExpanded(v => !v)}
          >
            <span>{autoExpanded ? '▲' : '▼'}</span>
            <span>流体データから自動取得</span>
          </button>
          {autoExpanded && (
            <div className="mt-2 bg-blue-50 rounded-lg p-3 flex flex-col gap-2">
              <div>
                <label className="text-xs text-gray-500 block mb-0.5">流体</label>
                <select
                  value={autoFluid}
                  onChange={e => setAutoFluid(e.target.value)}
                  className="w-full text-xs border border-gray-300 rounded px-2 py-1 bg-white"
                >
                  {SUPPORTED_FLUIDS.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-xs text-gray-500 block mb-0.5">T [K]</label>
                  <input type="number" value={autoT} onChange={e => setAutoT(e.target.value)}
                    className="w-full text-xs border border-gray-300 rounded px-2 py-1" />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-gray-500 block mb-0.5">P [kPa]</label>
                  <input type="number" value={autoP} onChange={e => setAutoP(e.target.value)}
                    className="w-full text-xs border border-gray-300 rounded px-2 py-1" />
                </div>
              </div>
              <button
                onClick={handleAutoFill}
                disabled={autoLoading}
                className="w-full text-xs bg-blue-500 hover:bg-blue-600 text-white rounded px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                {autoLoading ? '取得中...' : '物性値を取得 →'}
              </button>
            </div>
          )}
        </div>

        <hr className="border-gray-100" />

        {/* Friction Method */}
        <div>
          <SectionHeader>摩擦係数計算法</SectionHeader>
          <div className="flex gap-4">
            {(['colebrook', 'blasius'] as FrictionMethod[]).map(method => (
              <label key={method} className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="radio"
                  name="friction"
                  checked={form.frictionMethod === method}
                  onChange={() => set('frictionMethod', method)}
                  className="accent-blue-500"
                />
                <span className="text-sm font-medium">
                  {method === 'colebrook' ? 'Colebrook' : 'Blasius'}
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-1">
            {form.frictionMethod === 'colebrook'
              ? 'Colebrook-White 式（粗さ考慮、全乱流域対応）'
              : 'Blasius 式（水力滑面、Re < 10⁵ で精度高）'}
          </p>
        </div>

        <hr className="border-gray-100" />

        {/* Flow Range */}
        <div>
          <SectionHeader>流量範囲</SectionHeader>
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="最小" unit="m³/h" value={form.flowRateMin} onChange={v => set('flowRateMin', v)} />
            </div>
            <div className="flex-1">
              <Field label="最大" unit="m³/h" value={form.flowRateMax} onChange={v => set('flowRateMax', v)} />
            </div>
          </div>
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

        {result ? (<>

          {/* Summary */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex gap-8 flex-wrap">
              <StatItem label="水力直径 D_h" value={`${result.hydraulic_diameter_mm.toFixed(2)} mm`} />
              <StatItem label="流路断面積 A" value={`${result.cross_section_area_mm2.toFixed(1)} mm²`} />
              <StatItem
                label="層流 → 遷移域"
                value={`${result.q_lam_turb[0].toFixed(2)} m³/h`}
                color="text-blue-600"
              />
              <StatItem
                label="遷移域 → 乱流"
                value={`${result.q_lam_turb[1].toFixed(2)} m³/h`}
                color="text-orange-500"
              />
            </div>
          </div>

          {/* Chart */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            {/* X-axis switcher */}
            <div className="flex gap-1.5 mb-3">
              <span className="text-xs text-gray-500 self-center mr-1">横軸:</span>
              {(['q', 'v', 're'] as const).map(ax => (
                <button
                  key={ax}
                  onClick={() => setXAxis(ax)}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                    xAxis === ax
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
                  }`}
                >
                  {ax === 'q' ? '流量 Q' : ax === 'v' ? '流速 v' : 'Reynolds数 Re'}
                </button>
              ))}
            </div>
            <Plot
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data={traces as any}
              layout={{
                title: { text: '圧力損失特性（Darcy-Weisbach）', font: { size: 13 } },
                xaxis: {
                  title: { text: X_AXIS_LABEL[xAxis], standoff: 8 },
                  showgrid: true,
                  gridcolor: '#f0f0f0',
                  zeroline: false,
                },
                yaxis: {
                  title: { text: '圧力損失 ΔP [kPa]', standoff: 8 },
                  showgrid: true,
                  gridcolor: '#f0f0f0',
                  zeroline: false,
                },
                legend: {
                  x: 0.02, y: 0.98,
                  bgcolor: 'rgba(255,255,255,0.85)',
                  bordercolor: '#e5e7eb', borderwidth: 1,
                },
                hovermode: 'x unified',
                margin: { t: 45, r: 20, b: 60, l: 75 },
                autosize: true,
                font: { family: 'system-ui, sans-serif', size: 12 },
              }}
              config={{ displayModeBar: true, responsive: true, displaylogo: false }}
              style={{ width: '100%', height: '380px' }}
            />
          </div>

          {/* Table */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-200">
                  <th className="text-right py-2 pr-4 font-medium">Q [m³/h]</th>
                  <th className="text-right py-2 pr-4 font-medium">v [m/s]</th>
                  <th className="text-right py-2 pr-4 font-medium">Re [-]</th>
                  <th className="text-right py-2 pr-4 font-medium">f [-]</th>
                  <th className="text-right py-2 pr-4 font-medium">ΔP [kPa]</th>
                  <th className="text-left py-2 font-medium">流況</th>
                </tr>
              </thead>
              <tbody>
                {tableIndices.map(i => {
                  const regime = result.regimes[i]
                  return (
                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="text-right py-1.5 pr-4 tabular-nums">{result.flow_rates[i].toFixed(1)}</td>
                      <td className="text-right py-1.5 pr-4 tabular-nums">{result.velocities[i].toFixed(3)}</td>
                      <td className="text-right py-1.5 pr-4 tabular-nums">{result.reynolds[i].toFixed(0)}</td>
                      <td className="text-right py-1.5 pr-4 tabular-nums font-mono text-xs">{result.friction_factors[i].toFixed(5)}</td>
                      <td className="text-right py-1.5 pr-4 tabular-nums">{(result.pressure_drops[i] / 1000).toFixed(3)}</td>
                      <td className={`py-1.5 text-xs font-medium ${REGIME_CLASS[regime] ?? ''}`}>
                        {REGIME_SHORT[regime] ?? regime}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

        </>) : (
          <div className="flex-1 bg-white rounded-lg border border-gray-200 flex items-center justify-center min-h-64">
            <div className="text-center text-gray-400">
              <p className="text-sm mb-1">左パネルで条件を設定して「計算する」を押してください</p>
              <p className="text-xs">ダルシー–ワイズバッハ式による圧力損失計算</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
