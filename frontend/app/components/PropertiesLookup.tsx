'use client'

import { useEffect, useState } from 'react'
import { fetchProperties, type Properties } from '@/app/lib/api'

type TempUnit = 'K' | 'C'
type PressUnit = 'MPa' | 'bar' | 'Pa'
type Props = {
  fluid: string
  externalT?: number  // K
  externalP?: number  // Pa
}

function fmt(v: number | null | undefined, scale = 1, digits = 4): string {
  return v != null ? (v * scale).toFixed(digits) : 'N/A'
}

function toKelvin(val: number, unit: TempUnit): number {
  return unit === 'C' ? val + 273.15 : val
}

function toPascal(val: number, unit: PressUnit): number {
  if (unit === 'MPa') return val * 1e6
  if (unit === 'bar') return val * 1e5
  return val
}

function convertTemp(val: number, from: TempUnit, to: TempUnit): string {
  const k = toKelvin(val, from)
  return (to === 'C' ? k - 273.15 : k).toFixed(2)
}

function convertPress(val: number, from: PressUnit, to: PressUnit): string {
  const pa = toPascal(val, from)
  if (to === 'MPa') return (pa / 1e6).toFixed(4)
  if (to === 'bar') return (pa / 1e5).toFixed(3)
  return pa.toFixed(0)
}

export default function PropertiesLookup({ fluid, externalT, externalP }: Props) {
  const [T, setT] = useState('300')
  const [P, setP] = useState('0.1013')
  const [tempUnit, setTempUnit] = useState<TempUnit>('K')
  const [pressUnit, setPressUnit] = useState<PressUnit>('MPa')
  const [props, setProps] = useState<Properties | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleTempUnitChange = (next: TempUnit) => {
    setT(convertTemp(parseFloat(T) || 0, tempUnit, next))
    setTempUnit(next)
  }

  const handlePressUnitChange = (next: PressUnit) => {
    setP(convertPress(parseFloat(P) || 0, pressUnit, next))
    setPressUnit(next)
  }

  // グラフから選択されたポイントを反映
  useEffect(() => {
    if (externalT === undefined || externalP === undefined) return
    const tStr = tempUnit === 'C' ? (externalT - 273.15).toFixed(2) : externalT.toFixed(2)
    const pStr = pressUnit === 'MPa' ? (externalP / 1e6).toFixed(4)
               : pressUnit === 'bar' ? (externalP / 1e5).toFixed(3)
               : externalP.toFixed(0)
    setT(tStr)
    setP(pStr)
  }, [externalT, externalP]) // eslint-disable-line react-hooks/exhaustive-deps

  // 入力値が変わったら自動計算（600ms デバウンス）
  useEffect(() => {
    const T_val = parseFloat(T)
    const P_val = parseFloat(P)
    if (isNaN(T_val) || isNaN(P_val) || T_val <= 0 || P_val <= 0) return

    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const result = await fetchProperties(fluid, toKelvin(T_val, tempUnit), toPascal(P_val, pressUnit))
        if (!cancelled) setProps(result)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 600)

    return () => { cancelled = true; clearTimeout(timer) }
  }, [T, P, tempUnit, pressUnit, fluid])

  const handleExportCSV = () => {
    if (!props) return
    const rows = [
      'property,value,unit',
      `温度,${props.T},K`,
      `圧力,${(props.P / 1e6).toFixed(4)},MPa`,
      `密度,${fmt(props.D, 1, 4)},kg/m³`,
      `比エンタルピー,${fmt(props.H, 1e-3, 3)},kJ/kg`,
      `比エントロピー,${fmt(props.S, 1e-3, 4)},kJ/kg·K`,
      `定圧比熱,${fmt(props.C, 1e-3, 4)},kJ/kg·K`,
      `粘度,${fmt(props.V, 1e6, 4)},μPa·s`,
      `熱伝導率,${fmt(props.L, 1, 4)},W/m·K`,
    ]
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fluid}_props_T${props.T.toFixed(1)}K_P${(props.P / 1e6).toFixed(2)}MPa.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="max-w-lg">
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-gray-800">物性値の計算</h2>
          {loading && (
            <div className="flex items-center gap-1.5 text-xs text-blue-500">
              <div className="w-3.5 h-3.5 rounded-full border-2 border-blue-200 border-t-blue-500 animate-spin" />
              計算中...
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-5 items-end mb-6">
          {/* 温度 */}
          <div>
            <label className="block text-xs text-gray-500 font-medium mb-1">温度</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                value={T}
                onChange={e => setT(e.target.value)}
                step="any"
                className="border border-gray-300 rounded px-3 py-2 w-28 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <select
                value={tempUnit}
                onChange={e => handleTempUnitChange(e.target.value as TempUnit)}
                className="border border-gray-300 rounded px-2 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="K">K</option>
                <option value="C">°C</option>
              </select>
            </div>
          </div>

          {/* 圧力 */}
          <div>
            <label className="block text-xs text-gray-500 font-medium mb-1">圧力</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                value={P}
                onChange={e => setP(e.target.value)}
                step="any"
                min="0"
                className="border border-gray-300 rounded px-3 py-2 w-28 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <select
                value={pressUnit}
                onChange={e => handlePressUnitChange(e.target.value as PressUnit)}
                className="border border-gray-300 rounded px-2 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="MPa">MPa</option>
                <option value="bar">bar</option>
                <option value="Pa">Pa</option>
              </select>
            </div>
          </div>
        </div>

        {error && (
          <div className="text-red-600 text-sm bg-red-50 rounded p-3 mb-4">{error}</div>
        )}

        {props && (
          <>
            <table className="w-full text-sm border border-gray-200 rounded overflow-hidden">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">物性</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">値</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {[
                  ['温度', `${props.T.toFixed(2)} K  (${(props.T - 273.15).toFixed(2)} °C)`],
                  ['圧力', `${(props.P / 1e6).toFixed(4)} MPa  (${(props.P / 1e5).toFixed(3)} bar)`],
                  ['密度', `${fmt(props.D, 1, 3)} kg/m³`],
                  ['比エンタルピー', `${fmt(props.H, 1e-3, 2)} kJ/kg`],
                  ['比エントロピー', `${fmt(props.S, 1e-3, 4)} kJ/kg·K`],
                  ['定圧比熱', `${fmt(props.C, 1e-3, 4)} kJ/kg·K`],
                  ['粘度', `${fmt(props.V, 1e6, 4)} μPa·s`],
                  ['熱伝導率', `${fmt(props.L, 1, 4)} W/m·K`],
                ].map(([label, value]) => (
                  <tr key={label} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-700">{label}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-gray-900 text-xs">{value}</td>
                  </tr>
                ))}

                <tr><td colSpan={2} className="px-4 py-1.5 text-xs font-semibold text-gray-400 bg-gray-50 uppercase tracking-wide">圧力 P₀ における飽和特性</td></tr>
                {[
                  ['飽和温度', props.T_sat_at_P != null
                    ? `${props.T_sat_at_P.toFixed(2)} K  (${(props.T_sat_at_P - 273.15).toFixed(2)} °C)`
                    : 'N/A (臨界圧力超過)'],
                  ['飽和液エンタルピー', props.H_sat_liq_at_P != null ? `${(props.H_sat_liq_at_P / 1000).toFixed(2)} kJ/kg` : 'N/A'],
                  ['飽和蒸気エンタルピー', props.H_sat_vap_at_P != null ? `${(props.H_sat_vap_at_P / 1000).toFixed(2)} kJ/kg` : 'N/A'],
                  ['蒸発潜熱', props.latent_heat_at_P != null ? `${(props.latent_heat_at_P / 1000).toFixed(2)} kJ/kg` : 'N/A'],
                ].map(([label, value]) => (
                  <tr key={label} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-700">{label}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-gray-900 text-xs">{value}</td>
                  </tr>
                ))}

                <tr><td colSpan={2} className="px-4 py-1.5 text-xs font-semibold text-gray-400 bg-gray-50 uppercase tracking-wide">温度 T₀ における飽和蒸気圧</td></tr>
                <tr className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 text-gray-700">飽和蒸気圧</td>
                  <td className="px-4 py-2.5 text-right font-mono text-gray-900 text-xs">
                    {props.P_sat_at_T != null
                      ? `${(props.P_sat_at_T / 1e6).toFixed(4)} MPa  (${(props.P_sat_at_T / 1e5).toFixed(3)} bar)`
                      : 'N/A (臨界温度超過)'}
                  </td>
                </tr>

                <tr><td colSpan={2} className="px-4 py-1.5 text-xs font-semibold text-gray-400 bg-gray-50 uppercase tracking-wide">臨界点</td></tr>
                {[
                  ['臨界温度', `${props.T_crit.toFixed(2)} K  (${(props.T_crit - 273.15).toFixed(2)} °C)`],
                  ['臨界圧力', `${(props.P_crit / 1e6).toFixed(4)} MPa  (${(props.P_crit / 1e5).toFixed(3)} bar)`],
                  ['臨界密度', `${props.D_crit.toFixed(3)} kg/m³`],
                ].map(([label, value]) => (
                  <tr key={label} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-700">{label}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-gray-900 text-xs">{value}</td>
                  </tr>
                ))}

                <tr><td colSpan={2} className="px-4 py-1.5 text-xs font-semibold text-gray-400 bg-gray-50 uppercase tracking-wide">三重点</td></tr>
                {[
                  ['三重点温度', `${props.T_triple.toFixed(2)} K  (${(props.T_triple - 273.15).toFixed(2)} °C)`],
                  ['三重点圧力', `${(props.P_triple / 1e6).toFixed(4)} MPa  (${(props.P_triple / 1e5).toFixed(4)} bar)`],
                ].map(([label, value]) => (
                  <tr key={label} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 text-gray-700">{label}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-gray-900 text-xs">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4">
              <button
                onClick={handleExportCSV}
                className="px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition-colors"
              >
                CSVをダウンロード
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
