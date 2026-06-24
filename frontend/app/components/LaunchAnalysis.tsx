'use client'

import dynamic from 'next/dynamic'
import { useCallback, useMemo, useState } from 'react'
import { simulateLaunch, type LaunchRequest, type LaunchResult, type StageSpec, type Vehicle } from '@/app/lib/api'
import RocketBuilder from './RocketBuilder'
import VehicleDatabase from './VehicleDatabase'

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false })

type SeriesKey = 'altitude' | 'speed' | 'mass'

const SERIES_LABEL: Record<SeriesKey, string> = {
  altitude: '高度 h [m]',
  speed: '速度 v [m/s]',
  mass: '質量 m [kg]',
}

const SERIES_COLOR: Record<SeriesKey, string> = {
  altitude: '#2563eb',
  speed: '#ef4444',
  mass: '#10b981',
}

// 環境カーブ（高度→重力加速度）上の到達高度の位置を線形補間で求める
function interpAt(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0) return 0
  if (x <= xs[0]) return ys[0]
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1]
  let i = 0
  while (i < xs.length - 1 && xs[i + 1] < x) i++
  const t = (x - xs[i]) / (xs[i + 1] - xs[i])
  return ys[i] + t * (ys[i + 1] - ys[i])
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

// ── Form state ─────────────────────────────────────────────────────

interface FormState {
  stages: StageSpec[]
  payloadMass: string
  launchAngle: string
  dragEnabled: boolean
  dragCoefficient: string
  crossSectionArea: string
  duration: string
  dt: string
}

const DEFAULT_FORM: FormState = {
  stages: [],
  payloadMass: '0',
  launchAngle: '90',
  dragEnabled: false,
  dragCoefficient: '0.5',
  crossSectionArea: '0.3',
  duration: '300',
  dt: '0.1',
}

// ── Main component ─────────────────────────────────────────────────

export default function LaunchAnalysis() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [result, setResult] = useState<LaunchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [series, setSeries] = useState<SeriesKey>('altitude')

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const handleStagesChange = useCallback((stages: StageSpec[]) => {
    setForm(prev => ({ ...prev, stages }))
  }, [])

  function loadVehicle(v: Vehicle) {
    setForm(prev => ({
      ...prev,
      stages: v.stages,
      payloadMass: String(v.payload_mass),
      launchAngle: String(v.launch_angle),
      dragEnabled: v.drag_enabled,
      dragCoefficient: String(v.drag_coefficient),
      crossSectionArea: String(v.cross_section_area),
    }))
  }

  async function handleCalc() {
    setError(null)
    setLoading(true)
    try {
      const payload: LaunchRequest = {
        stages: form.stages,
        payload_mass: parseFloat(form.payloadMass),
        launch_angle: parseFloat(form.launchAngle),
        drag_enabled: form.dragEnabled,
        drag_coefficient: parseFloat(form.dragCoefficient),
        cross_section_area: parseFloat(form.crossSectionArea),
        duration: parseFloat(form.duration),
        dt: parseFloat(form.dt),
      }
      setResult(await simulateLaunch(payload))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '計算に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const trajectoryTrace = useMemo(() => {
    if (!result) return []
    const separations = result.stats.stage_separations
    return [
      {
        x: result.x,
        y: result.altitude,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: '軌道',
        line: { color: '#2563eb', width: 2.5 },
        hovertemplate: 'x: %{x:.1f} m<br>h: %{y:.1f} m<extra></extra>',
      },
      ...(separations.length > 0 ? [{
        x: separations.map(s => s.x_m),
        y: separations.map(s => s.altitude_m),
        type: 'scatter' as const,
        mode: 'markers+text' as const,
        name: '段分離',
        text: separations.map(s => `第${s.stage_index}段分離`),
        textposition: 'top center' as const,
        textfont: { size: 10, color: '#dc2626' },
        marker: { color: '#dc2626', size: 10, symbol: 'x' },
        hovertemplate: '第%{customdata}段分離<br>x: %{x:.1f} m<br>h: %{y:.1f} m<extra></extra>',
        customdata: separations.map(s => s.stage_index),
      }] : []),
    ]
  }, [result])

  const seriesTrace = useMemo(() => {
    if (!result) return []
    return [{
      x: result.time,
      y: result[series],
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: SERIES_LABEL[series],
      line: { color: SERIES_COLOR[series], width: 2.5 },
      hovertemplate: `t: %{x:.1f} s<br>${SERIES_LABEL[series]}: %{y:.2f}<extra></extra>`,
    }]
  }, [result, series])

  const propellantTrace = useMemo(() => {
    if (!result) return []
    const colors = ['#2563eb', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#0ea5e9']
    return result.stage_propellant_remaining.map((s, i) => ({
      x: result.time,
      y: s.propellant_kg,
      type: 'scatter' as const,
      mode: 'lines' as const,
      name: `第${s.stage_index}段`,
      line: { color: colors[i % colors.length], width: 2.5 },
      hovertemplate: `第${s.stage_index}段<br>t: %{x:.1f} s<br>残量: %{y:.1f} kg<extra></extra>`,
    }))
  }, [result])

  const environmentTrace = useMemo(() => {
    if (!result) return []
    const env = result.environment
    const apogeeAltitude = result.stats.apogee_altitude_m
    return [
      {
        x: env.altitude_m,
        y: env.gravity_m_s2,
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: '重力加速度',
        line: { color: '#7c3aed', width: 2.5 },
        hovertemplate: 'h: %{x:.0f} m<br>g: %{y:.4f} m/s²<extra></extra>',
      },
      {
        x: [apogeeAltitude],
        y: [interpAt(env.altitude_m, env.gravity_m_s2, apogeeAltitude)],
        type: 'scatter' as const,
        mode: 'markers+text' as const,
        name: '最大到達高度',
        text: ['最大到達高度'],
        textposition: 'top center' as const,
        textfont: { size: 10, color: '#dc2626' },
        marker: { color: '#dc2626', size: 9, symbol: 'x' },
        hovertemplate: 'h: %{x:.0f} m<br>g: %{y:.4f} m/s²<extra></extra>',
      },
      {
        x: env.altitude_m,
        y: env.pressure_pa,
        yaxis: 'y2',
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: '外気圧',
        line: { color: '#0891b2', width: 2.5 },
        hovertemplate: 'h: %{x:.0f} m<br>P: %{y:.0f} Pa<extra></extra>',
      },
      {
        x: env.altitude_m,
        y: env.temperature_k,
        yaxis: 'y3',
        type: 'scatter' as const,
        mode: 'lines' as const,
        name: '外気温',
        line: { color: '#ea580c', width: 2.5 },
        hovertemplate: 'h: %{x:.0f} m<br>T: %{y:.1f} K<extra></extra>',
      },
    ]
  }, [result])

  return (
    <div className="flex flex-col gap-6">
      <RocketBuilder onStagesChange={handleStagesChange} />

      <div className="flex gap-6">

        {/* ─── Settings Panel ──────────────────────────────────── */}
        <div className="w-72 shrink-0 bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-3 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 160px)' }}>

          <div>
            <SectionHeader>機体（段数 {form.stages.length}）</SectionHeader>
            <p className="text-xs text-gray-400 -mt-1">上のキャンバスで各段を設計し「この段を計算」を押すと反映されます</p>
          </div>

          <hr className="border-gray-100" />

          <div>
            <SectionHeader>発射条件</SectionHeader>
            <Field label="発射角度（水平基準）" unit="deg" value={form.launchAngle} onChange={v => set('launchAngle', v)} />
            <p className="text-xs text-gray-400 -mt-1">90° = 垂直打ち上げ</p>
          </div>

          <hr className="border-gray-100" />

          <div>
            <SectionHeader>空気抵抗</SectionHeader>
            <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
              <input
                type="checkbox"
                checked={form.dragEnabled}
                onChange={e => set('dragEnabled', e.target.checked)}
                className="accent-blue-500"
              />
              <span className="text-sm">空気抵抗を考慮する</span>
            </label>
            <Field
              label="抗力係数 Cd"
              unit="-"
              value={form.dragCoefficient}
              onChange={v => set('dragCoefficient', v)}
              disabled={!form.dragEnabled}
            />
            <Field
              label="機体投影面積 A"
              unit="m²"
              value={form.crossSectionArea}
              onChange={v => set('crossSectionArea', v)}
              disabled={!form.dragEnabled}
            />
            {form.dragEnabled && (
              <p className="text-xs text-gray-400 -mt-1">指数大気モデル（海面ρ=1.225 kg/m³, スケール高度8.5km）</p>
            )}
          </div>

          <hr className="border-gray-100" />

          <div>
            <SectionHeader>シミュレーション設定</SectionHeader>
            <Field label="最大計算時間" unit="s" value={form.duration} onChange={v => set('duration', v)} />
            <Field label="刻み幅 dt" unit="s" value={form.dt} onChange={v => set('dt', v)} />
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
              <div className="flex gap-8 flex-wrap mb-3">
                <StatItem label="最大到達高度" value={`${result.stats.apogee_altitude_m.toFixed(1)} m`} color="text-blue-600" />
                <StatItem label="最高到達時刻" value={`${result.stats.apogee_time_s.toFixed(1)} s`} />
                <StatItem label="最大速度" value={`${result.stats.max_speed_ms.toFixed(1)} m/s`} color="text-red-500" />
                <StatItem
                  label={result.landed ? '飛行時間（着地）' : '飛行時間（計算終了）'}
                  value={`${result.stats.flight_time_s.toFixed(1)} s`}
                />
                <StatItem label="ダウンレンジ距離" value={`${result.stats.downrange_m.toFixed(1)} m`} />
                <StatItem label="推力重量比 T/W（第1段）" value={result.stats.thrust_to_weight.toFixed(2)} />
                <StatItem label="速度増分 Δv（全段）" value={`${result.stats.delta_v_ms.toFixed(1)} m/s`} />
              </div>
              {result.stats.stage_burnouts.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500 border-b border-gray-200">
                        <th className="py-1.5 pr-3">段</th>
                        <th className="py-1.5 pr-3">燃焼終了時刻</th>
                        <th className="py-1.5 pr-3">燃焼終了高度</th>
                        <th className="py-1.5 pr-3">燃焼終了速度</th>
                        <th className="py-1.5 pr-3">燃焼終了質量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.stats.stage_burnouts.map(b => (
                        <tr key={b.stage_index} className="border-b border-gray-100 last:border-0">
                          <td className="py-1.5 pr-3 font-medium text-gray-900">第{b.stage_index}段</td>
                          <td className="py-1.5 pr-3 tabular-nums">{b.time_s.toFixed(1)} s</td>
                          <td className="py-1.5 pr-3 tabular-nums">{b.altitude_m.toFixed(1)} m</td>
                          <td className="py-1.5 pr-3 tabular-nums">{b.speed_ms.toFixed(1)} m/s</td>
                          <td className="py-1.5 pr-3 tabular-nums">{b.mass_kg.toFixed(1)} kg</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Trajectory Chart */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <Plot
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                data={trajectoryTrace as any}
                layout={{
                  title: { text: '飛行軌道（ダウンレンジ–高度）', font: { size: 13 } },
                  xaxis: { title: { text: 'ダウンレンジ x [m]', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                  yaxis: { title: { text: '高度 h [m]', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                  margin: { t: 45, r: 20, b: 55, l: 70 },
                  autosize: true,
                  font: { family: 'system-ui, sans-serif', size: 12 },
                }}
                config={{ displayModeBar: true, responsive: true, displaylogo: false }}
                style={{ width: '100%', height: '360px' }}
              />
            </div>

            {/* Time-series Chart */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex gap-1.5 mb-3">
                <span className="text-xs text-gray-500 self-center mr-1">表示量:</span>
                {(['altitude', 'speed', 'mass'] as SeriesKey[]).map(s => (
                  <button
                    key={s}
                    onClick={() => setSeries(s)}
                    className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                      series === s
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
                    }`}
                  >
                    {s === 'altitude' ? '高度' : s === 'speed' ? '速度' : '質量'}
                  </button>
                ))}
              </div>
              <Plot
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                data={seriesTrace as any}
                layout={{
                  title: { text: `${SERIES_LABEL[series]} の時間変化`, font: { size: 13 } },
                  xaxis: { title: { text: '時刻 t [s]', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                  yaxis: { title: { text: SERIES_LABEL[series], standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                  margin: { t: 45, r: 20, b: 55, l: 70 },
                  autosize: true,
                  font: { family: 'system-ui, sans-serif', size: 12 },
                }}
                config={{ displayModeBar: true, responsive: true, displaylogo: false }}
                style={{ width: '100%', height: '320px' }}
              />
            </div>

            {/* Propellant Remaining Chart */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <Plot
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                data={propellantTrace as any}
                layout={{
                  title: { text: '各段の推進剤残量の時間変化', font: { size: 13 } },
                  xaxis: { title: { text: '時刻 t [s]', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                  yaxis: { title: { text: '推進剤残量 [kg]', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                  margin: { t: 45, r: 20, b: 55, l: 70 },
                  autosize: true,
                  font: { family: 'system-ui, sans-serif', size: 12 },
                }}
                config={{ displayModeBar: true, responsive: true, displaylogo: false }}
                style={{ width: '100%', height: '320px' }}
              />
            </div>

            {/* Environment Chart */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <Plot
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                data={environmentTrace as any}
                layout={{
                  title: { text: '環境（高度による重力加速度・外気圧・外気温の変化）', font: { size: 13 } },
                  xaxis: { title: { text: '高度 h [m]', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false, domain: [0, 0.82] },
                  yaxis: { title: { text: '重力加速度 g [m/s²]', standoff: 8 }, showgrid: true, gridcolor: '#f0f0f0', zeroline: false },
                  yaxis2: {
                    title: { text: '外気圧 P [Pa]', standoff: 8 },
                    overlaying: 'y',
                    anchor: 'free',
                    side: 'right',
                    position: 0.82,
                    showgrid: false,
                    zeroline: false,
                  },
                  yaxis3: {
                    title: { text: '外気温 T [K]', standoff: 8 },
                    overlaying: 'y',
                    anchor: 'free',
                    side: 'right',
                    position: 1,
                    showgrid: false,
                    zeroline: false,
                  },
                  margin: { t: 45, r: 70, b: 55, l: 70 },
                  autosize: true,
                  font: { family: 'system-ui, sans-serif', size: 12 },
                }}
                config={{ displayModeBar: true, responsive: true, displaylogo: false }}
                style={{ width: '100%', height: '320px' }}
              />
              <p className="mt-2 text-xs text-gray-400">g(h) = g₀ / (1 + h/R)²（g₀=9.80665 m/s², R=地球半径6371km の逆二乗則近似）。P(h) = P₀ × exp(-h/H)（P₀=101325 Pa, H=8500 m の指数大気近似、抗力計算と同じモデル）。T(h)は国際標準大気(ISA)の区分線形モデル（86km以上は86kmの値で一定）。軌道計算もこの高度依存重力を使用しますが、燃焼器の推力計算（外気圧パラメータ）や空気抵抗の密度計算（指数大気のみ）はこの気温分布を参照していません</p>
            </div>

          </>) : (
            <div className="flex-1 bg-white rounded-lg border border-gray-200 flex items-center justify-center min-h-64">
              <div className="text-center text-gray-400">
                <p className="text-sm mb-1">左パネルで条件を設定して「計算する」を押してください</p>
                <p className="text-xs">機体質量・推力をもとにした弾道軌道の簡易計算</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <VehicleDatabase onLoad={loadVehicle} />
    </div>
  )
}
