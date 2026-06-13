'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchSaturation, fetchPHDiagram, fetchStateFromHP,
  type SaturationData, type PHDiagramData,
} from '@/app/lib/api'

type Props = { fluid: string }
type PressUnit = 'MPa' | 'bar' | 'Pa'
type TempUnit = 'K' | 'C'
type CyclePoint = { label: string; H: string; P: string }
type CyclePVPoint = { label: string; V: number; P_display: number }
type ProcessInfo = {
  from: string; to: string
  deltaH: number   // [kJ/kg] エンタルピー変化
  wShaft: number   // [kJ/kg] 技術仕事（システムが行う仕事、負=入力）
  qHeat: number    // [kJ/kg] 熱量（正=入熱、負=放熱）
}

const ISO_T_COLORS = ['#6366f1', '#8b5cf6', '#7c3aed', '#4f46e5', '#4338ca', '#3730a3', '#312e81', '#1e1b4b']

function pConv(pPa: number, unit: PressUnit): number {
  if (unit === 'MPa') return pPa / 1e6
  if (unit === 'bar') return pPa / 1e5
  return pPa
}

function toPa(v: number, unit: PressUnit): number {
  if (unit === 'MPa') return v * 1e6
  if (unit === 'bar') return v * 1e5
  return v
}

function computeCycleWork(
  cyclePoints: CyclePoint[],
  cyclePVData: CyclePVPoint[],
  pressUnit: PressUnit,
): ProcessInfo[] {
  const validPts = cyclePoints.filter(
    p => p.H !== '' && p.P !== '' && !isNaN(parseFloat(p.H)) && !isNaN(parseFloat(p.P))
  )
  const pvMap = new Map(cyclePVData.map(p => [p.label, p]))
  const aligned = validPts.filter(p => pvMap.has(p.label))
  if (aligned.length < 2) return []

  return aligned.map((pt, i) => {
    const j = (i + 1) % aligned.length
    const ptJ = aligned[j]
    const pvI = pvMap.get(pt.label)!
    const pvJ = pvMap.get(ptJ.label)!

    const deltaH = parseFloat(ptJ.H) - parseFloat(pt.H)
    const P_i_Pa = toPa(pvI.P_display, pressUnit)
    const P_j_Pa = toPa(pvJ.P_display, pressUnit)
    // 技術仕事 w = -∫v dP (台形近似、可逆過程近似)
    const wShaft = -(pvI.V + pvJ.V) / 2 * (P_j_Pa - P_i_Pa) / 1000
    const qHeat = deltaH + wShaft

    return { from: pt.label, to: ptJ.label, deltaH, wShaft, qHeat }
  })
}

function convertPressDisplay(val: string, from: PressUnit, to: PressUnit): string {
  const v = parseFloat(val)
  if (!val || isNaN(v)) return val
  const pa = from === 'MPa' ? v * 1e6 : from === 'bar' ? v * 1e5 : v
  if (to === 'MPa') return (pa / 1e6).toFixed(4)
  if (to === 'bar') return (pa / 1e5).toFixed(3)
  return pa.toFixed(0)
}

function tDisplay(tK: number, unit: TempUnit): string {
  return unit === 'C' ? `${(tK - 273.15).toFixed(0)}°C` : `${tK.toFixed(0)}K`
}

const newCyclePoint = (i: number): CyclePoint => ({ label: String(i + 1), H: '', P: '' })

const selectClass = 'border border-gray-300 rounded px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500'
const inputClass = 'border border-gray-300 rounded px-2 py-1.5 w-24 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

export default function PHDiagramChart({ fluid }: Props) {
  const divRef = useRef<HTMLDivElement>(null)
  const pvDivRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [satData, setSatData] = useState<SaturationData | null>(null)
  const [phData, setPhData] = useState<PHDiagramData | null>(null)
  const [pressUnit, setPressUnit] = useState<PressUnit>('MPa')
  const [tempUnit, setTempUnit] = useState<TempUnit>('K')
  const [cyclePoints, setCyclePoints] = useState<CyclePoint[]>([0, 1, 2, 3].map(newCyclePoint))
  const [selectedCycleIdx, setSelectedCycleIdx] = useState<number | null>(null)
  const [cyclePVData, setCyclePVData] = useState<CyclePVPoint[]>([])
  const [pvLoading, setPvLoading] = useState(false)

  // stale closure 対策 ref
  const selectedCycleIdxRef = useRef<number | null>(null)
  const pressUnitRef = useRef<PressUnit>(pressUnit)
  const cyclePointsLenRef = useRef<number>(cyclePoints.length)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plotlyRef = useRef<any>(null)
  const cycleLineTraceIdxRef = useRef<number>(-1)
  const cycleMarkerTraceIdxRef = useRef<number>(-1)
  const cyclePointsDataRef = useRef<CyclePoint[]>(cyclePoints)
  const dragIdxRef = useRef<number | null>(null)
  const panStartRef = useRef<{ x: number; y: number } | null>(null)
  const wasDraggingRef = useRef<boolean>(false)

  useEffect(() => { selectedCycleIdxRef.current = selectedCycleIdx }, [selectedCycleIdx])
  useEffect(() => { pressUnitRef.current = pressUnit }, [pressUnit])
  useEffect(() => { cyclePointsLenRef.current = cyclePoints.length }, [cyclePoints])
  useEffect(() => { cyclePointsDataRef.current = cyclePoints }, [cyclePoints])

  // サイクル各過程の仕事・熱量
  const cycleWorkData = useMemo(
    () => computeCycleWork(cyclePoints, cyclePVData, pressUnit),
    [cyclePoints, cyclePVData, pressUnit]
  )

  // 有効なサイクル点の文字列キー（変化検知用）
  const validCycleKey = useMemo(() =>
    cyclePoints
      .filter(p => p.H !== '' && p.P !== '' && !isNaN(parseFloat(p.H)) && !isNaN(parseFloat(p.P)))
      .map(p => `${p.label}:${p.H}:${p.P}`)
      .join('|') + '|' + pressUnit,
    [cyclePoints, pressUnit]
  )

  // fluid が変わったらデータを再取得
  useEffect(() => {
    setLoading(true)
    setError(null)
    setReady(false)
    setSatData(null)
    setPhData(null)
    setSelectedCycleIdx(null)
    setCyclePVData([])

    Promise.all([fetchSaturation(fluid), fetchPHDiagram(fluid)])
      .then(([sat, ph]) => { setSatData(sat); setPhData(ph) })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [fluid])

  // データ・単位・サイクルが変わったら pH 線図を再描画
  useEffect(() => {
    if (satData && phData) renderChart(satData, phData, pressUnit, tempUnit, cyclePoints)
  }, [satData, phData, pressUnit, tempUnit, cyclePoints]) // eslint-disable-line react-hooks/exhaustive-deps

  // 有効なサイクル点が変わったら比体積を取得
  useEffect(() => {
    const validPts = cyclePoints.filter(
      p => p.H !== '' && p.P !== '' && !isNaN(parseFloat(p.H)) && !isNaN(parseFloat(p.P))
    )
    if (validPts.length < 2) { setCyclePVData([]); return }

    let cancelled = false
    setPvLoading(true)
    Promise.all(
      validPts.map(pt =>
        fetchStateFromHP(fluid, parseFloat(pt.H) * 1000, toPa(parseFloat(pt.P), pressUnit))
          .then(s => ({ label: pt.label, V: s.D ? 1 / s.D : NaN, P_display: parseFloat(pt.P) }))
          .catch(() => ({ label: pt.label, V: NaN, P_display: parseFloat(pt.P) }))
      )
    ).then(data => {
      if (!cancelled) setCyclePVData(data.filter(d => isFinite(d.V) && d.V > 0))
    }).finally(() => { if (!cancelled) setPvLoading(false) })

    return () => { cancelled = true }
  }, [validCycleKey, fluid]) // eslint-disable-line react-hooks/exhaustive-deps

  // サイクル pV データが揃ったら pV 線図を描画
  useEffect(() => {
    if (satData && cyclePVData.length >= 2) renderPVChart(satData, cyclePVData, pressUnit)
  }, [satData, cyclePVData, pressUnit]) // eslint-disable-line react-hooks/exhaustive-deps

  // グラフ ready 後にクリック・ドラッグイベントを設定
  useEffect(() => {
    if (!ready || !divRef.current) return
    const el = divRef.current

    // チャート内のピクセル座標を取得（clamp=trueで境界内にクランプ）
    const getChartPos = (clientX: number, clientY: number, clamp = false) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const layout = (el as any)?._fullLayout
      if (!layout) return null
      const bb = el.getBoundingClientRect()
      const pw = layout.width - layout.margin.l - layout.margin.r
      const ph = layout.height - layout.margin.t - layout.margin.b
      let xPx = clientX - bb.left - layout.margin.l
      let yPx = clientY - bb.top - layout.margin.t
      if (clamp) {
        xPx = Math.max(0, Math.min(pw, xPx))
        yPx = Math.max(0, Math.min(ph, yPx))
      } else if (xPx < 0 || xPx > pw || yPx < 0 || yPx > ph) {
        return null
      }
      const [xMin, xMax] = layout.xaxis.range
      const [logMin, logMax] = layout.yaxis.range
      return { xPx, yPx, pw, ph, xMin, xMax, logMin, logMax }
    }

    const pixelToData = (pos: NonNullable<ReturnType<typeof getChartPos>>) => {
      const { xPx, yPx, pw, ph, xMin, xMax, logMin, logMax } = pos
      const hKJkg = xMin + (xPx / pw) * (xMax - xMin)
      const logP = logMax - (yPx / ph) * (logMax - logMin)
      return { hKJkg, pInUnit: Math.pow(10, logP) }
    }

    const formatHP = (hKJkg: number, pInUnit: number) => {
      const pu = pressUnitRef.current
      return {
        h: hKJkg.toFixed(2),
        p: pu === 'MPa' ? pInUnit.toFixed(4) : pu === 'bar' ? pInUnit.toFixed(3) : pInUnit.toFixed(0),
      }
    }

    // 近くのサイクル点を探す（ピクセル閾値内）
    const findNearbyPoint = (clientX: number, clientY: number): number => {
      const pos = getChartPos(clientX, clientY)
      if (!pos) return -1
      const { xPx, yPx, pw, ph, xMin, xMax, logMin, logMax } = pos
      let closestIdx = -1
      let closestDist = 20
      cyclePointsDataRef.current.forEach((pt, i) => {
        if (pt.H === '' || pt.P === '') return
        const ptH = parseFloat(pt.H)
        const ptP = parseFloat(pt.P)
        if (isNaN(ptH) || isNaN(ptP) || ptP <= 0) return
        const ptXPx = (ptH - xMin) / (xMax - xMin) * pw
        const ptYPx = (logMax - Math.log10(ptP)) / (logMax - logMin) * ph
        const dist = Math.hypot(xPx - ptXPx, yPx - ptYPx)
        if (dist < closestDist) { closestDist = dist; closestIdx = i }
      })
      return closestIdx
    }

    // --- ドラッグ ---
    const mousedownHandler = (event: MouseEvent) => {
      panStartRef.current = { x: event.clientX, y: event.clientY }
      if (selectedCycleIdxRef.current !== null) return
      const nearbyIdx = findNearbyPoint(event.clientX, event.clientY)
      if (nearbyIdx < 0) return
      dragIdxRef.current = nearbyIdx
      wasDraggingRef.current = false
      panStartRef.current = null
      el.style.cursor = 'grabbing'
      event.stopPropagation()
      event.preventDefault()
    }

    const mousemoveHandler = (event: MouseEvent) => {
      const draggingIdx = dragIdxRef.current
      if (draggingIdx === null) {
        // ホバー時のカーソル切り替え
        if (selectedCycleIdxRef.current === null) {
          const nearbyIdx = findNearbyPoint(event.clientX, event.clientY)
          if (nearbyIdx >= 0) {
            el.style.cursor = 'grab'
          } else if (cyclePointsDataRef.current.some(p => p.H === '' || p.P === '')) {
            el.style.cursor = 'crosshair'
          } else {
            el.style.cursor = ''
          }
        }
        return
      }

      const pos = getChartPos(event.clientX, event.clientY, true)
      if (!pos) return
      const { hKJkg, pInUnit } = pixelToData(pos)
      const { h, p } = formatHP(hKJkg, pInUnit)

      // refを直接更新（React再レンダリングなし）
      cyclePointsDataRef.current = cyclePointsDataRef.current.map(
        (cp, j) => j === draggingIdx ? { ...cp, H: h, P: p } : cp
      )

      // Plotlyのトレースだけ高速更新
      const Plotly = plotlyRef.current
      const lineIdx = cycleLineTraceIdxRef.current
      const markerIdx = cycleMarkerTraceIdxRef.current
      if (Plotly && lineIdx >= 0 && markerIdx >= 0) {
        const validPts = cyclePointsDataRef.current.filter(
          pt => pt.H !== '' && pt.P !== '' && !isNaN(parseFloat(pt.H)) && !isNaN(parseFloat(pt.P))
        )
        if (validPts.length >= 2) {
          const cx = [...validPts.map(pt => parseFloat(pt.H)), parseFloat(validPts[0].H)]
          const cy = [...validPts.map(pt => parseFloat(pt.P)), parseFloat(validPts[0].P)]
          Plotly.restyle(el, { x: [cx], y: [cy] }, [lineIdx])
          Plotly.restyle(el, {
            x: [validPts.map(pt => parseFloat(pt.H))],
            y: [validPts.map(pt => parseFloat(pt.P))],
            text: [validPts.map(pt => pt.label)],
          }, [markerIdx])
        }
      }
    }

    const mouseupHandler = () => {
      if (dragIdxRef.current === null) return
      wasDraggingRef.current = true
      dragIdxRef.current = null
      el.style.cursor = ''
      setCyclePoints([...cyclePointsDataRef.current])
    }

    const mouseleaveHandler = () => {
      if (dragIdxRef.current === null) el.style.cursor = ''
    }

    // --- クリック入力 ---
    const clickHandler = (event: MouseEvent) => {
      if (wasDraggingRef.current) { wasDraggingRef.current = false; return }
      const start = panStartRef.current
      panStartRef.current = null
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return
      const pos = getChartPos(event.clientX, event.clientY)
      if (!pos) return
      const { hKJkg, pInUnit } = pixelToData(pos)
      const { h, p } = formatHP(hKJkg, pInUnit)
      if (selectedCycleIdxRef.current !== null) {
        // 点番号を選択した手動モード
        const idx = selectedCycleIdxRef.current
        setCyclePoints(pts => pts.map((cp, j) => j === idx ? { ...cp, H: h, P: p } : cp))
        const len = cyclePointsLenRef.current
        const next = idx + 1 < len ? idx + 1 : null
        setSelectedCycleIdx(next)
        selectedCycleIdxRef.current = next
      } else {
        // 自動モード: 最初の空きポイントに入力
        const idx = cyclePointsDataRef.current.findIndex(pt => pt.H === '' || pt.P === '')
        if (idx < 0) return
        const newPts = cyclePointsDataRef.current.map((cp, j) => j === idx ? { ...cp, H: h, P: p } : cp)
        cyclePointsDataRef.current = newPts
        setCyclePoints([...newPts])
      }
    }

    el.addEventListener('mousedown', mousedownHandler, { capture: true })
    document.addEventListener('mousemove', mousemoveHandler)
    document.addEventListener('mouseup', mouseupHandler)
    el.addEventListener('mouseleave', mouseleaveHandler)
    el.addEventListener('click', clickHandler)

    return () => {
      el.removeEventListener('mousedown', mousedownHandler, { capture: true })
      document.removeEventListener('mousemove', mousemoveHandler)
      document.removeEventListener('mouseup', mouseupHandler)
      el.removeEventListener('mouseleave', mouseleaveHandler)
      el.removeEventListener('click', clickHandler)
    }
  }, [ready]) // eslint-disable-line react-hooks/exhaustive-deps

  const handlePressUnitChange = (next: PressUnit) => {
    setCyclePoints(pts => pts.map(p => ({ ...p, P: convertPressDisplay(p.P, pressUnit, next) })))
    setPressUnit(next)
  }

  async function renderChart(
    sat: SaturationData,
    ph: PHDiagramData,
    pUnit: PressUnit,
    tUnit: TempUnit,
    cyclePts: CyclePoint[],
  ) {
    if (!divRef.current) return
    const { default: Plotly } = await import('plotly.js-dist-min')
    plotlyRef.current = Plotly

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = []

    // 飽和液線・蒸気線（同色、凡例なし）
    traces.push({
      x: sat.liquid.map(p => p.H / 1000),
      y: sat.liquid.map(p => pConv(p.P, pUnit)),
      name: '飽和液線', type: 'scatter', mode: 'lines',
      line: { color: '#1d4ed8', width: 2.5 },
      showlegend: false,
    })
    traces.push({
      x: sat.vapor.map(p => p.H / 1000),
      y: sat.vapor.map(p => pConv(p.P, pUnit)),
      name: '飽和蒸気線', type: 'scatter', mode: 'lines',
      line: { color: '#1d4ed8', width: 2.5 },
      showlegend: false,
    })

    // 等温線
    ph.iso_T.forEach((line, i) => {
      const pts = line.points
      const lastIdx = pts.length - 1
      traces.push({
        x: pts.map(p => p.H / 1000),
        y: pts.map(p => pConv(p.P, pUnit)),
        text: pts.map((_, j) => j === lastIdx ? tDisplay(line.T, tUnit) : ''),
        name: tDisplay(line.T, tUnit),
        type: 'scatter',
        mode: 'lines+text',
        textposition: 'top center' as const,
        textfont: { size: 9, color: ISO_T_COLORS[i % ISO_T_COLORS.length] },
        line: { color: ISO_T_COLORS[i % ISO_T_COLORS.length], width: 1, dash: 'dash' },
        showlegend: false,
      })
    })

    // 等エントロピー線
    ph.iso_S.forEach(line => {
      const pts = line.points
      const lastIdx = pts.length - 1
      const sLabel = `S=${(line.S / 1000).toFixed(2)}`
      traces.push({
        x: pts.map(p => p.H / 1000),
        y: pts.map(p => pConv(p.P, pUnit)),
        text: pts.map((_, j) => j === lastIdx ? sLabel : ''),
        name: sLabel,
        type: 'scatter',
        mode: 'lines+text',
        textposition: 'top right' as const,
        textfont: { size: 9, color: '#6b7280' },
        line: { color: '#9ca3af', width: 1, dash: 'dot' },
        showlegend: false,
      })
    })

    // サイクルプロット
    const validPts = cyclePts.filter(
      p => p.H !== '' && p.P !== '' && !isNaN(parseFloat(p.H)) && !isNaN(parseFloat(p.P))
    )
    if (validPts.length >= 2) {
      const cycleX = [...validPts.map(p => parseFloat(p.H)), parseFloat(validPts[0].H)]
      const cycleY = [...validPts.map(p => parseFloat(p.P)), parseFloat(validPts[0].P)]
      cycleLineTraceIdxRef.current = traces.length
      traces.push({
        x: cycleX, y: cycleY,
        name: 'サイクル', type: 'scatter', mode: 'lines',
        line: { color: '#dc2626', width: 2.5 },
        showlegend: false,
      })
      cycleMarkerTraceIdxRef.current = traces.length
      traces.push({
        x: validPts.map(p => parseFloat(p.H)),
        y: validPts.map(p => parseFloat(p.P)),
        text: validPts.map(p => p.label),
        name: 'サイクル点', type: 'scatter',
        mode: 'markers+text',
        textposition: 'top center' as const,
        textfont: { size: 12, color: '#dc2626' },
        marker: { size: 8, color: '#dc2626', symbol: 'circle' },
        showlegend: false,
      })
    } else {
      cycleLineTraceIdxRef.current = -1
      cycleMarkerTraceIdxRef.current = -1
    }

    const allP = [
      ...sat.liquid.map(p => pConv(p.P, pUnit)),
      ...sat.vapor.map(p => pConv(p.P, pUnit)),
      ...ph.iso_T.flatMap(l => l.points.map(p => pConv(p.P, pUnit))),
      ...(validPts.length >= 2 ? validPts.map(p => parseFloat(p.P)).filter(v => v > 0) : []),
    ].filter(v => v > 0)
    const pMin = Math.min(...allP)
    const pMax = Math.max(...allP)

    const layout = {
      title: { text: `${fluid}　pH線図（圧力-エンタルピー線図）`, font: { size: 16 } },
      xaxis: { title: { text: '比エンタルピー h [kJ/kg]' }, gridcolor: '#e5e7eb', zeroline: false },
      yaxis: {
        title: { text: `圧力 P [${pUnit}]` },
        type: 'log' as const,
        range: [Math.log10(pMin * 0.8), Math.log10(pMax * 1.5)],
        gridcolor: '#e5e7eb',
        zeroline: false,
      },
      showlegend: false,
      paper_bgcolor: 'white',
      plot_bgcolor: '#f9fafb',
      margin: { t: 60, r: 30, b: 70, l: 80 },
    }

    await Plotly.react(divRef.current, traces, layout, {
      responsive: true, displayModeBar: true, displaylogo: false,
    })
    setReady(true)
  }

  async function renderPVChart(
    sat: SaturationData,
    pvPts: CyclePVPoint[],
    pUnit: PressUnit,
  ) {
    if (!pvDivRef.current) return
    const { default: Plotly } = await import('plotly.js-dist-min')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = []

    // 飽和ドーム（液・気）
    traces.push({
      x: sat.liquid.map(p => 1 / p.D),
      y: sat.liquid.map(p => pConv(p.P, pUnit)),
      type: 'scatter', mode: 'lines',
      line: { color: '#1d4ed8', width: 2 },
      showlegend: false,
    })
    traces.push({
      x: sat.vapor.map(p => 1 / p.D),
      y: sat.vapor.map(p => pConv(p.P, pUnit)),
      type: 'scatter', mode: 'lines',
      line: { color: '#1d4ed8', width: 2 },
      showlegend: false,
    })

    // サイクル（閉じたループ）
    const cx = [...pvPts.map(p => p.V), pvPts[0].V]
    const cy = [...pvPts.map(p => p.P_display), pvPts[0].P_display]
    traces.push({
      x: cx, y: cy,
      type: 'scatter', mode: 'lines',
      line: { color: '#dc2626', width: 2.5 },
      showlegend: false,
    })

    // サイクル点マーカー
    traces.push({
      x: pvPts.map(p => p.V),
      y: pvPts.map(p => p.P_display),
      text: pvPts.map(p => p.label),
      type: 'scatter', mode: 'markers+text',
      textposition: 'top center' as const,
      textfont: { size: 12, color: '#dc2626' },
      marker: { size: 8, color: '#dc2626', symbol: 'circle' },
      showlegend: false,
    })

    const allV = [
      ...sat.liquid.map(p => 1 / p.D),
      ...sat.vapor.map(p => 1 / p.D),
      ...pvPts.map(p => p.V),
    ].filter(v => v > 0 && isFinite(v))
    const vMin = Math.min(...allV)
    const vMax = Math.max(...allV)

    const allP = [
      ...sat.liquid.map(p => pConv(p.P, pUnit)),
      ...sat.vapor.map(p => pConv(p.P, pUnit)),
      ...pvPts.map(p => p.P_display),
    ].filter(v => v > 0)
    const pMin = Math.min(...allP)
    const pMax = Math.max(...allP)

    const layout = {
      title: { text: `${fluid}　pV線図`, font: { size: 16 } },
      xaxis: {
        title: { text: '比体積 v [m³/kg]' },
        type: 'log' as const,
        range: [Math.log10(vMin * 0.8), Math.log10(vMax * 1.5)],
        gridcolor: '#e5e7eb',
        zeroline: false,
      },
      yaxis: {
        title: { text: `圧力 P [${pUnit}]` },
        type: 'log' as const,
        range: [Math.log10(pMin * 0.8), Math.log10(pMax * 1.5)],
        gridcolor: '#e5e7eb',
        zeroline: false,
      },
      showlegend: false,
      paper_bgcolor: 'white',
      plot_bgcolor: '#f9fafb',
      margin: { t: 60, r: 30, b: 70, l: 80 },
    }

    await Plotly.react(pvDivRef.current, traces, layout, {
      responsive: true, displayModeBar: true, displaylogo: false,
    })
  }

  const handleExportPHImage = async () => {
    if (!divRef.current) return
    const { default: Plotly } = await import('plotly.js-dist-min')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Plotly.downloadImage(divRef.current as any, {
      format: 'png', width: 1400, height: 900, filename: `${fluid}_ph_diagram`,
    })
  }

  const handleExportPVImage = async () => {
    if (!pvDivRef.current) return
    const { default: Plotly } = await import('plotly.js-dist-min')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Plotly.downloadImage(pvDivRef.current as any, {
      format: 'png', width: 1400, height: 900, filename: `${fluid}_pv_diagram`,
    })
  }

  const handleExportCSV = () => {
    if (!satData || !phData) return
    const rows: string[] = ['type,label_value,H_kJ_per_kg,P_MPa']
    satData.liquid.forEach(p => rows.push(`sat_liquid,,${(p.H / 1000).toFixed(3)},${(p.P / 1e6).toFixed(6)}`))
    satData.vapor.forEach(p => rows.push(`sat_vapor,,${(p.H / 1000).toFixed(3)},${(p.P / 1e6).toFixed(6)}`))
    phData.iso_T.forEach(l => l.points.forEach(p =>
      rows.push(`iso_T,${l.T.toFixed(1)},${(p.H / 1000).toFixed(3)},${(p.P / 1e6).toFixed(6)}`)))
    phData.iso_S.forEach(l => l.points.forEach(p =>
      rows.push(`iso_S,${l.S.toFixed(3)},${(p.H / 1000).toFixed(3)},${(p.P / 1e6).toFixed(6)}`)))
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${fluid}_ph_diagram.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  const updateCycle = (i: number, field: keyof CyclePoint, value: string) =>
    setCyclePoints(pts => pts.map((p, j) => j === i ? { ...p, [field]: value } : p))

  const addCyclePoint = () =>
    setCyclePoints(pts => [...pts, newCyclePoint(pts.length)])

  const removeCyclePoint = (i: number) => {
    if (selectedCycleIdx === i) setSelectedCycleIdx(null)
    else if (selectedCycleIdx !== null && selectedCycleIdx > i) setSelectedCycleIdx(selectedCycleIdx - 1)
    setCyclePoints(pts =>
      pts.filter((_, j) => j !== i).map((p, j) => ({ ...p, label: String(j + 1) }))
    )
  }

  const resetCycle = () => {
    setCyclePoints([0, 1, 2, 3].map(newCyclePoint))
    setSelectedCycleIdx(null)
  }

  // サイクル計算の共通ヘルパー（JSX内で再利用）
  const wNet    = cycleWorkData.reduce((s, p) => s + p.wShaft, 0)
  const qL      = cycleWorkData.reduce((s, p) => s + Math.max(0, p.qHeat), 0)
  const qH      = cycleWorkData.reduce((s, p) => s + Math.max(0, -p.qHeat), 0)
  const totalDH = cycleWorkData.reduce((s, p) => s + p.deltaH, 0)
  const isRefrig = wNet < -0.1
  const isPower  = wNet > 0.1
  const fmt = (v: number) => Math.abs(v) < 0.05 ? '≈ 0' : (v > 0 ? '+' : '') + v.toFixed(1)
  const cls = (v: number, pos: string, neg: string) =>
    Math.abs(v) < 0.05 ? 'text-gray-400' : v > 0 ? pos : neg

  // サイクル入力パネル（pH線図右・pV線図右で共用）
  const cycleInputPanel = (
    <div className="flex flex-col gap-0">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">サイクルをプロット</h3>
      <div className="overflow-x-auto">
        <table className="text-sm border-collapse w-auto">
          <thead>
            <tr className="text-xs text-gray-400 border-b border-gray-200">
              <th className="px-2 pb-1 text-center font-medium w-10">点</th>
              <th className="px-2 pb-1 text-left font-medium">H [kJ/kg]</th>
              <th className="px-2 pb-1 text-left font-medium">P [{pressUnit}]</th>
              <th className="px-2 pb-1 w-6" />
            </tr>
          </thead>
          <tbody>
            {cyclePoints.map((pt, i) => (
              <tr key={i} className={`border-b border-gray-100 transition-colors ${selectedCycleIdx === i ? 'bg-amber-50' : ''}`}>
                <td className="px-2 py-1.5 text-center">
                  <button
                    onClick={() => setSelectedCycleIdx(selectedCycleIdx === i ? null : i)}
                    title={selectedCycleIdx === i ? 'クリック入力を解除' : 'グラフをクリックしてこの点の座標を入力'}
                    className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold transition-colors
                      ${selectedCycleIdx === i
                        ? 'bg-amber-400 text-white ring-2 ring-amber-400 ring-offset-1'
                        : 'bg-red-100 text-red-700 hover:bg-amber-200 hover:text-amber-800'}`}
                  >
                    {pt.label}
                  </button>
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number" value={pt.H} step="any"
                    onChange={e => updateCycle(i, 'H', e.target.value)}
                    placeholder="例: 420"
                    className={inputClass}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number" value={pt.P} step="any" min="0"
                    onChange={e => updateCycle(i, 'P', e.target.value)}
                    placeholder={pressUnit === 'MPa' ? '例: 1.0' : pressUnit === 'bar' ? '例: 10' : '例: 1000000'}
                    className={inputClass}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <button onClick={() => removeCyclePoint(i)}
                    className="text-gray-300 hover:text-red-400 transition-colors text-lg leading-none px-1"
                    title="この点を削除">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <button onClick={addCyclePoint}
          className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 transition-colors text-gray-600">
          ＋ 点を追加
        </button>
        <button onClick={resetCycle}
          className="px-3 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-50 transition-colors text-gray-400">
          リセット
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-400">
        {ready ? 'グラフをクリックで空きポイントに順番入力 / 点番号ボタンで点を指定してクリック / マーカーをドラッグで微調整' : '有効な点が 2 つ以上あると自動的にプロットします'}
      </p>
    </div>
  )

  // サイクル計算結果パネル
  const cycleResultPanel = cycleWorkData.length >= 2 ? (
    <div className="flex flex-col gap-0">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">サイクル計算結果</h3>
      <div className="overflow-x-auto">
        <table className="text-sm border-collapse w-auto">
          <thead>
            <tr className="text-xs text-gray-400 border-b border-gray-200">
              <th className="px-3 pb-1 text-center font-medium">過程</th>
              <th className="px-3 pb-1 text-right font-medium">ΔH [kJ/kg]</th>
              <th className="px-3 pb-1 text-right font-medium">仕事 w [kJ/kg]</th>
              <th className="px-3 pb-1 text-right font-medium">熱量 q [kJ/kg]</th>
            </tr>
          </thead>
          <tbody>
            {cycleWorkData.map((p, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="px-3 py-1.5 text-center font-medium text-gray-600">{p.from} → {p.to}</td>
                <td className={`px-3 py-1.5 text-right font-mono ${cls(p.deltaH, 'text-red-600', 'text-blue-600')}`}>{fmt(p.deltaH)}</td>
                <td className={`px-3 py-1.5 text-right font-mono ${cls(p.wShaft, 'text-green-600', 'text-orange-600')}`}>{fmt(p.wShaft)}</td>
                <td className={`px-3 py-1.5 text-right font-mono ${cls(p.qHeat, 'text-red-500', 'text-blue-500')}`}>{fmt(p.qHeat)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-gray-300 text-xs text-gray-500 bg-gray-50 font-semibold">
              <td className="px-3 py-1.5 text-center">合計</td>
              <td className={`px-3 py-1.5 text-right font-mono ${cls(totalDH, 'text-red-600', 'text-blue-600')}`}>{fmt(totalDH)}</td>
              <td className={`px-3 py-1.5 text-right font-mono ${cls(wNet, 'text-green-600', 'text-orange-600')}`}>{fmt(wNet)}</td>
              <td className="px-3 py-1.5 text-right font-mono text-gray-400">—</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        <span className="text-gray-500">正味サイクル仕事</span>
        <span className={`font-mono font-semibold ${isRefrig ? 'text-orange-600' : isPower ? 'text-green-600' : 'text-gray-600'}`}>
          {wNet.toFixed(2)} kJ/kg
        </span>
        <span className="text-gray-500">吸熱量 Q<sub>L</sub></span>
        <span className="font-mono text-red-600">+{qL.toFixed(2)} kJ/kg</span>
        <span className="text-gray-500">放熱量 Q<sub>H</sub></span>
        <span className="font-mono text-blue-600">{qH.toFixed(2)} kJ/kg</span>
        {isRefrig && Math.abs(wNet) > 0.01 && <>
          <span className="text-gray-500">COP（冷凍）</span>
          <span className="font-mono font-semibold text-gray-800">{(qL / Math.abs(wNet)).toFixed(3)}</span>
          <span className="text-gray-500">COP（暖房）</span>
          <span className="font-mono font-semibold text-gray-800">{(qH / Math.abs(wNet)).toFixed(3)}</span>
        </>}
        {isPower && qH > 0.01 && <>
          <span className="text-gray-500">熱効率 η</span>
          <span className="font-mono font-semibold text-gray-800">{(wNet / qH * 100).toFixed(1)} %</span>
        </>}
      </div>
      <p className="mt-3 text-xs text-gray-400">w = −∫v dP（台形近似・可逆過程仮定）</p>
    </div>
  ) : null

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      {/* 軸単位切り替え */}
      <div className="flex gap-5 mb-3 items-center">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">圧力軸</span>
          <select value={pressUnit} onChange={e => handlePressUnitChange(e.target.value as PressUnit)} className={selectClass}>
            <option value="MPa">MPa</option>
            <option value="bar">bar</option>
            <option value="Pa">Pa</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500">等温線ラベル</span>
          <select value={tempUnit} onChange={e => setTempUnit(e.target.value as TempUnit)} className={selectClass}>
            <option value="K">K</option>
            <option value="C">°C</option>
          </select>
        </div>
      </div>

      {/* ── pH 線図（左）＋ サイクル入力（右）── */}
      <div className="flex gap-4 items-start">
        {/* 左: pH チャート */}
        <div className="flex-1 min-w-0">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="w-12 h-12 rounded-full border-4 border-blue-100 border-t-blue-600 animate-spin" />
              <p className="text-sm text-gray-600">データを計算中...</p>
              <p className="text-xs text-gray-400">初回は 20〜30 秒かかる場合があります</p>
            </div>
          )}
          {error && <div className="text-red-500 p-4 bg-red-50 rounded mb-4">{error}</div>}
          {selectedCycleIdx !== null && ready && (
            <div className="mb-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded text-xs text-amber-700 flex items-center justify-between">
              <span>点 {cyclePoints[selectedCycleIdx]?.label} を選択中 — グラフをクリックして H・P を入力</span>
              <button onClick={() => setSelectedCycleIdx(null)} className="ml-3 text-amber-500 hover:text-amber-700 font-medium">
                キャンセル
              </button>
            </div>
          )}
          <div
            ref={divRef}
            style={{
              width: '100%',
              height: '560px',
              display: loading || error ? 'none' : 'block',
              cursor: selectedCycleIdx !== null ? 'crosshair' : undefined,
            }}
          />
        </div>

        {/* 右: サイクル入力 */}
        <div className="w-72 shrink-0 border-l border-gray-100 pl-4 pt-1 max-h-145 overflow-y-auto">
          {cycleInputPanel}
        </div>
      </div>

      {/* pH エクスポートボタン */}
      {ready && (
        <div className="flex gap-3 mt-4 border-t border-gray-100 pt-4">
          <button onClick={handleExportPHImage}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors">
            pH線図をPNG保存
          </button>
          <button onClick={handleExportCSV}
            className="px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition-colors">
            CSVをダウンロード
          </button>
        </div>
      )}

      {/* ── pV 線図（左）＋ サイクル計算結果（右）── */}
      {ready && (
        <div className="mt-6 border-t border-gray-200 pt-5">
          <div className="flex gap-4 items-start">
            {/* 左: pV チャート */}
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">pV線図</h3>
              {pvLoading && (
                <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
                  <div className="w-5 h-5 rounded-full border-2 border-blue-100 border-t-blue-600 animate-spin" />
                  比体積を計算中...
                </div>
              )}
              {!pvLoading && cyclePVData.length < 2 && (
                <p className="text-xs text-gray-400 py-2">有効なサイクル点が 2 つ以上あると表示されます</p>
              )}
              <div
                ref={pvDivRef}
                style={{
                  width: '100%',
                  height: '450px',
                  display: !pvLoading && cyclePVData.length >= 2 ? 'block' : 'none',
                }}
              />
              {!pvLoading && cyclePVData.length >= 2 && (
                <div className="flex gap-3 mt-3">
                  <button onClick={handleExportPVImage}
                    className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors">
                    pV線図をPNG保存
                  </button>
                </div>
              )}
            </div>

            {/* 右: サイクル計算結果 */}
            {!pvLoading && cycleResultPanel && (
              <div className="w-80 shrink-0 border-l border-gray-100 pl-4 pt-1 max-h-125 overflow-y-auto">
                {cycleResultPanel}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
