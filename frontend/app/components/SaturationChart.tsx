'use client'

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { fetchSaturation, saturationCSVUrl, type SaturationData } from '@/app/lib/api'

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false })

type Props = {
  fluid: string
  onPointClick?: (T_K: number, P_Pa: number) => void
  selectedPoint?: { T: number; P: number } | null
}

export default function SaturationChart({ fluid, onPointClick, selectedPoint }: Props) {
  const [data, setData] = useState<SaturationData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gdRef = useRef<any>(null)
  const onPointClickRef = useRef(onPointClick)
  onPointClickRef.current = onPointClick

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchSaturation(fluid)
      .then(d => { setData(d); setLoading(false) })
      .catch((e: Error) => { setError(e.message); setLoading(false) })
  }, [fluid])

  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const cb = onPointClickRef.current
    const gd = gdRef.current
    if (!cb || !gd?._fullLayout) return

    const layout = gd._fullLayout
    const bb = gd.getBoundingClientRect()
    const xPx = e.clientX - bb.left - layout.margin.l
    const yPx = e.clientY - bb.top - layout.margin.t
    const pw = layout.width - layout.margin.l - layout.margin.r
    const ph = layout.height - layout.margin.t - layout.margin.b

    if (xPx < 0 || xPx > pw || yPx < 0 || yPx > ph) return

    const [xMin, xMax] = layout.xaxis.range
    const T_K = xMin + (xPx / pw) * (xMax - xMin)

    // y軸は log スケール（単位: MPa）
    const [logMin, logMax] = layout.yaxis.range
    const logP = logMax - (yPx / ph) * (logMax - logMin)
    const P_Pa = Math.pow(10, logP) * 1e6

    cb(T_K, P_Pa)
  }

  const handleExportImage = async () => {
    if (!gdRef.current) return
    const Plotly = (await import('plotly.js-dist-min')).default
    Plotly.downloadImage(gdRef.current as Parameters<typeof Plotly.downloadImage>[0], {
      format: 'png',
      width: 1200,
      height: 800,
      filename: `${fluid}_saturation`,
    })
  }

  if (loading) return <div className="text-gray-500 p-8 text-center">データを読み込み中...</div>
  if (error) return <div className="text-red-500 p-4 bg-red-50 rounded">{error}</div>
  if (!data) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traces: any[] = [
    {
      x: data.liquid.map(p => p.T),
      y: data.liquid.map(p => p.P / 1e6),
      name: '飽和蒸気圧',
      type: 'scatter',
      mode: 'lines',
      line: { color: '#2563eb', width: 2.5 },
      showlegend: false,
    },
  ]

  if (selectedPoint) {
    traces.push({
      x: [selectedPoint.T],
      y: [selectedPoint.P / 1e6],
      type: 'scatter',
      mode: 'markers',
      marker: { size: 12, color: '#dc2626', symbol: 'circle', line: { color: 'white', width: 2 } },
      showlegend: false,
      hovertemplate: 'T: %{x:.2f} K<br>P: %{y:.4f} MPa<extra></extra>',
    })
  }

  const layout = {
    title: { text: `${fluid}　飽和蒸気圧曲線`, font: { size: 16 } },
    xaxis: { title: { text: '温度 T [K]' }, gridcolor: '#e5e7eb', zeroline: false },
    yaxis: {
      title: { text: '圧力 P [MPa]' },
      type: 'log' as const,
      gridcolor: '#e5e7eb',
      zeroline: false,
    },
    showlegend: false,
    paper_bgcolor: 'white',
    plot_bgcolor: '#f9fafb',
    margin: { t: 60, r: 30, b: 70, l: 80 },
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      {onPointClick && (
        <p className="text-xs text-blue-500 mb-2">
          グラフ上の任意の点をクリックして温度・圧力を選択できます
        </p>
      )}
      <div
        onClick={handleContainerClick}
        style={{ cursor: onPointClick ? 'crosshair' : 'default' }}
      >
        <Plot
          data={traces}
          layout={layout}
          config={{ responsive: true, displayModeBar: true, displaylogo: false }}
          style={{ width: '100%', height: '500px' }}
          onInitialized={(_, gd) => { gdRef.current = gd }}
          onUpdate={(_, gd) => { gdRef.current = gd }}
        />
      </div>
      <div className="flex gap-3 mt-4 border-t border-gray-100 pt-4">
        <button
          onClick={handleExportImage}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors"
        >
          PNG画像を保存
        </button>
        <a
          href={saturationCSVUrl(fluid)}
          download={`${fluid}_saturation.csv`}
          className="px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition-colors"
        >
          CSVをダウンロード
        </a>
      </div>
    </div>
  )
}
