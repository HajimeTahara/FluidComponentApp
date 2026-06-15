'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  calcPipeNetwork,
  calcPressureDrop,
  fetchProperties,
  type PipeSegmentResult,
  type PressureDropRequest,
  type PressureDropResult,
} from '@/app/lib/api'

const SUPPORTED_FLUIDS = [
  'Water', 'Methane', 'Nitrogen', 'Oxygen', 'Hydrogen',
  'CarbonDioxide', 'Propane', 'Ammonia', 'R134a', 'Ethane',
]

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false })

// ── Data types ─────────────────────────────────────────────────────

type PipeShape = 'circular' | 'annulus' | 'rectangular'

type NetworkNodeData = {
  nodeType: 'source' | 'pipe' | 'tee' | 'sink'
  label: string
  // source
  sourceType?: 'flow' | 'pressure'
  flowRate?: number
  calcPressure?: number   // flow-source after calc: required inlet pressure kPa
  calcFlow?: number       // pressure-source after calc: computed flow m³/h
  // pipe
  pipeShape?: PipeShape
  diameter?: number       // circular: mm
  outerDiameter?: number  // annulus: mm
  innerDiameter?: number  // annulus: mm
  width?: number          // rectangular: mm
  ductHeight?: number     // rectangular: mm
  length?: number         // m
  roughness?: number      // mm
  frictionMethod?: 'colebrook' | 'blasius'
  // tee (flow split is physics-based; no manual parameter)
  // sink
  sinkType?: 'pressure' | 'flow'
  pressure?: number       // pressure-sink: outlet back-pressure kPa; pressure-source: inlet pressure kPa
  // result
  result?: PipeSegmentResult
  [key: string]: unknown
}

// ── SVG icons ──────────────────────────────────────────────────────

function SvgSource({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="12" r="5" />
      <line x1="13" y1="12" x2="21" y2="12" />
      <polyline points="17 8 21 12 17 16" />
    </svg>
  )
}

function SvgPipe({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="1" y="7" width="22" height="10" rx="3" />
      <line x1="1" y1="12" x2="23" y2="12" strokeDasharray="4 2" strokeWidth="1.2" />
    </svg>
  )
}

function SvgTee({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="1" y1="9" x2="23" y2="9" />
      <line x1="12" y1="9" x2="12" y2="23" />
    </svg>
  )
}

function SvgSink({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="12" x2="11" y2="12" />
      <polyline points="7 8 3 12 7 16" />
      <circle cx="16" cy="12" r="5" />
    </svg>
  )
}

// ── Custom node components ─────────────────────────────────────────

function SourceNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const isFlow = (d.sourceType ?? 'flow') === 'flow'
  return (
    <div className={`px-3 py-2 rounded-xl border-2 bg-emerald-50 min-w-[120px] ${selected ? 'border-blue-500 shadow-lg' : 'border-emerald-500'}`}>
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgSource className="w-4 h-4 text-emerald-600 shrink-0" />
        <span className="text-xs font-bold text-emerald-700">{d.label}</span>
      </div>
      {isFlow ? (
        <>
          <div className="text-xs text-emerald-600 pl-5">Q: {d.flowRate ?? 10} m³/h</div>
          {d.calcPressure !== undefined && (
            <div className="text-xs font-bold text-blue-600 pl-5">P入口: {d.calcPressure.toFixed(1)} kPa</div>
          )}
        </>
      ) : (
        <>
          <div className="text-xs text-emerald-600 pl-5">P: {d.pressure ?? 100} kPa</div>
          {d.calcFlow !== undefined && (
            <div className="text-xs font-bold text-blue-600 pl-5">Q: {d.calcFlow.toFixed(2)} m³/h</div>
          )}
        </>
      )}
      <Handle type="source" position={Position.Right} style={{ background: '#10b981' }} />
    </div>
  )
}

function PipeNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const shapeLabel = d.pipeShape === 'annulus' ? '中空円' : d.pipeShape === 'rectangular' ? '矩形' : '円管'
  return (
    <div className={`px-3 py-2 rounded border-2 bg-sky-50 min-w-[140px] ${selected ? 'border-blue-500 shadow-lg' : 'border-sky-400'}`}>
      <Handle type="target" position={Position.Left} style={{ background: '#38bdf8' }} />
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgPipe className="w-4 h-4 text-sky-600 shrink-0" />
        <span className="text-xs font-bold text-sky-700">{d.label}</span>
      </div>
      <div className="text-xs text-sky-500 pl-5">{shapeLabel} · L={d.length ?? 50} m</div>
      {d.result && (
        <div className="text-xs font-bold text-red-500 mt-0.5 pl-5">ΔP: {d.result.dP_kpa.toFixed(2)} kPa</div>
      )}
      <Handle type="source" position={Position.Right} style={{ background: '#38bdf8' }} />
    </div>
  )
}

function TeeNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const r = d.result
  return (
    <div className={`px-3 py-3 rounded border-2 bg-amber-50 min-w-[110px] text-center ${selected ? 'border-blue-500 shadow-lg' : 'border-amber-400'}`}>
      <Handle type="target" position={Position.Left} id="in" style={{ background: '#f59e0b' }} />
      <div className="flex items-center justify-center gap-1.5 mb-0.5">
        <SvgTee className="w-4 h-4 text-amber-600 shrink-0" />
        <span className="text-xs font-bold text-amber-700">{d.label}</span>
      </div>
      {r?.regime === 'split' ? (
        <div className="text-xs text-amber-600 font-medium tabular-nums">
          {r.Q1_m3h?.toFixed(2)} / {r.Q2_m3h?.toFixed(2)} m³/h
        </div>
      ) : (
        <div className="text-xs text-amber-400">圧損バランス分配</div>
      )}
      <Handle type="source" position={Position.Right} id="out-1" style={{ background: '#f59e0b' }} />
      <Handle type="source" position={Position.Bottom} id="out-2" style={{ background: '#f59e0b', left: '50%' }} />
    </div>
  )
}

function SinkNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const isPressure = (d.sinkType ?? 'pressure') === 'pressure'
  return (
    <div className={`px-3 py-2 rounded-xl border-2 bg-rose-50 min-w-[110px] ${selected ? 'border-blue-500 shadow-lg' : 'border-rose-400'}`}>
      <Handle type="target" position={Position.Left} style={{ background: '#fb7185' }} />
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgSink className="w-4 h-4 text-rose-500 shrink-0" />
        <span className="text-xs font-bold text-rose-700">{d.label}</span>
      </div>
      {isPressure ? (
        <>
          <div className="text-xs text-rose-400">P出口: {d.pressure ?? 0} kPa</div>
          {d.result && (
            <div className="text-xs font-bold text-blue-600">Q: {d.result.Q_m3h.toFixed(2)} m³/h</div>
          )}
        </>
      ) : (
        <>
          <div className="text-xs text-rose-400">Q目標: {d.flowRate ?? 10} m³/h</div>
          {d.result && (
            <div className="text-xs font-bold text-blue-600">
              {d.result.P_kpa !== undefined
                ? `P入口: ${d.result.P_kpa.toFixed(1)} kPa`
                : `Q: ${d.result.Q_m3h.toFixed(2)} m³/h`}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: Record<string, any> = { source: SourceNode, pipe: PipeNode, tee: TeeNode, sink: SinkNode }

// ── Palette ────────────────────────────────────────────────────────

const PALETTE = [
  { type: 'source', label: 'ソース',  sub: '入口',  color: 'text-emerald-300', Icon: SvgSource },
  { type: 'pipe',   label: 'パイプ',  sub: '直管',  color: 'text-sky-300',    Icon: SvgPipe },
  { type: 'tee',    label: 'T字管',   sub: '分岐',  color: 'text-amber-300',  Icon: SvgTee },
  { type: 'sink',   label: 'シンク',  sub: '出口',  color: 'text-rose-300',   Icon: SvgSink },
]

function defaultData(type: string, n: number): NetworkNodeData {
  switch (type) {
    case 'source': return { nodeType: 'source', label: `ソース${n}`, sourceType: 'flow', flowRate: 10, pressure: 100 }
    case 'pipe':   return {
      nodeType: 'pipe', label: `パイプ${n}`,
      pipeShape: 'circular',
      diameter: 100, outerDiameter: 100, innerDiameter: 50,
      width: 100, ductHeight: 50,
      length: 50, roughness: 0.046,
      frictionMethod: 'colebrook',
    }
    case 'tee':  return { nodeType: 'tee',  label: `T字管${n}` }
    case 'sink': return { nodeType: 'sink', label: `シンク${n}`, sinkType: 'pressure', pressure: 0, flowRate: 10 }
    default:     return { nodeType: 'sink', label: `${type}${n}`, pressure: 0 }
  }
}

// ── Vertical parameter panel (left column of bottom section) ───────

function NumField({ label, unit, value, onChange }: {
  label: string; unit: string; value: number; onChange: (v: number) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-gray-600">
        {label} <span className="text-gray-400 font-normal">[{unit}]</span>
      </label>
      <input
        type="number" step="any" value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
    </div>
  )
}

function ResultGrid({ result }: { result: PipeSegmentResult }) {
  const regimeLabel = result.regime === 'laminar' ? '層流' : result.regime === 'turbulent' ? '乱流' : '遷移域'
  const rows = [
    { label: '流量 Q',     value: `${result.Q_m3h.toFixed(3)} m³/h` },
    { label: '流速 v',     value: `${result.v.toFixed(4)} m/s` },
    { label: 'Re数',       value: result.Re.toFixed(1) },
    { label: '摩擦係数 f', value: result.f.toFixed(6) },
    { label: '流動域',     value: regimeLabel },
    { label: '圧力損失 ΔP', value: `${result.dP_kpa.toFixed(4)} kPa`, highlight: true },
  ]
  return (
    <div className="bg-sky-50 rounded-lg p-3 border border-sky-100">
      <div className="text-xs font-semibold text-sky-600 mb-2">計算結果</div>
      <div className="flex flex-col gap-1.5">
        {rows.map(r => (
          <div key={r.label} className="flex justify-between items-baseline gap-2">
            <span className="text-xs text-gray-500 shrink-0">{r.label}</span>
            <span className={`text-sm tabular-nums font-medium ${r.highlight ? 'text-red-600 font-bold' : 'text-gray-800'}`}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function NodeParamPanel({ node, onChange }: {
  node: Node
  onChange: (u: Partial<NetworkNodeData>) => void
}) {
  const d = node.data as unknown as NetworkNodeData

  const Icon = d.nodeType === 'source' ? SvgSource
    : d.nodeType === 'pipe' ? SvgPipe
    : d.nodeType === 'tee'  ? SvgTee
    : SvgSink

  const iconColor = d.nodeType === 'source' ? 'text-emerald-600'
    : d.nodeType === 'pipe' ? 'text-sky-600'
    : d.nodeType === 'tee'  ? 'text-amber-600'
    : 'text-rose-500'

  return (
    <div className="flex flex-col gap-4">
      {/* Node identity */}
      <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
        <Icon className={`w-5 h-5 ${iconColor} shrink-0`} />
        <span className="text-base font-semibold text-gray-800">{d.label}</span>
      </div>

      {/* ── Source ── */}
      {d.nodeType === 'source' && (<>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-600">ソース種別</label>
          <div className="flex gap-4">
            {(['flow', 'pressure'] as const).map(t => (
              <label key={t} className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                <input
                  type="radio"
                  name={`sourceType-${node.id}`}
                  value={t}
                  checked={(d.sourceType ?? 'flow') === t}
                  onChange={() => onChange({ sourceType: t })}
                />
                {t === 'flow' ? '流量ソース' : '圧力ソース'}
              </label>
            ))}
          </div>
        </div>

        {(d.sourceType ?? 'flow') === 'flow' ? (<>
          <NumField label="流量 Q" unit="m³/h" value={d.flowRate ?? 10} onChange={v => onChange({ flowRate: v })} />
          {d.calcPressure !== undefined && (
            <div className="bg-blue-50 rounded-lg p-4 border border-blue-100">
              <div className="text-xs font-semibold text-blue-500 mb-1">計算結果 — 必要入口圧力</div>
              <div className="text-2xl font-bold text-blue-700 tabular-nums">
                {d.calcPressure.toFixed(2)}
                <span className="text-sm font-normal text-blue-500 ml-1">kPa</span>
              </div>
            </div>
          )}
        </>) : (<>
          <NumField label="ソース圧力 P" unit="kPa" value={d.pressure ?? 100} onChange={v => onChange({ pressure: v })} />
          {d.calcFlow !== undefined && (
            <div className="bg-blue-50 rounded-lg p-4 border border-blue-100">
              <div className="text-xs font-semibold text-blue-500 mb-1">計算結果 — 通過流量</div>
              <div className="text-2xl font-bold text-blue-700 tabular-nums">
                {d.calcFlow.toFixed(3)}
                <span className="text-sm font-normal text-blue-500 ml-1">m³/h</span>
              </div>
            </div>
          )}
        </>)}
      </>)}

      {/* ── Pipe ── */}
      {d.nodeType === 'pipe' && (<>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-600">断面形状</label>
          <select
            value={d.pipeShape ?? 'circular'}
            onChange={e => onChange({ pipeShape: e.target.value as PipeShape })}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="circular">円管</option>
            <option value="annulus">中空円環（アニュラス）</option>
            <option value="rectangular">矩形管</option>
          </select>
        </div>

        {(d.pipeShape ?? 'circular') === 'circular' && (
          <NumField label="内径 D" unit="mm" value={d.diameter ?? 100} onChange={v => onChange({ diameter: v })} />
        )}
        {d.pipeShape === 'annulus' && (<>
          <NumField label="外径 Do" unit="mm" value={d.outerDiameter ?? 100} onChange={v => onChange({ outerDiameter: v })} />
          <NumField label="内径 Di" unit="mm" value={d.innerDiameter ?? 50}  onChange={v => onChange({ innerDiameter: v })} />
        </>)}
        {d.pipeShape === 'rectangular' && (<>
          <NumField label="幅 W"   unit="mm" value={d.width ?? 100}     onChange={v => onChange({ width: v })} />
          <NumField label="高さ H" unit="mm" value={d.ductHeight ?? 50} onChange={v => onChange({ ductHeight: v })} />
        </>)}

        <NumField label="長さ L" unit="m"  value={d.length ?? 50}       onChange={v => onChange({ length: v })} />
        <NumField label="粗さ ε" unit="mm" value={d.roughness ?? 0.046} onChange={v => onChange({ roughness: v })} />

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-600">摩擦係数計算法</label>
          <div className="flex gap-4">
            {(['colebrook', 'blasius'] as const).map(m => (
              <label key={m} className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                <input
                  type="radio"
                  name={`friction-${node.id}`}
                  value={m}
                  checked={(d.frictionMethod ?? 'colebrook') === m}
                  onChange={() => onChange({ frictionMethod: m })}
                />
                {m === 'colebrook' ? 'Colebrook' : 'Blasius'}
              </label>
            ))}
          </div>
        </div>

        {d.result && <ResultGrid result={d.result} />}
      </>)}

      {/* ── Tee ── */}
      {d.nodeType === 'tee' && (
        d.result?.regime === 'split' ? (
          <div className="bg-amber-50 rounded-lg p-4 border border-amber-100 flex flex-col gap-2">
            <div className="text-xs font-semibold text-amber-600 mb-1">計算結果 — 圧損バランス分配</div>
            {[
              { label: '入口流量 Q',      value: d.result.Q_m3h.toFixed(3),             unit: 'm³/h' },
              { label: '右出口 Q₁',       value: d.result.Q1_m3h?.toFixed(3) ?? '—',    unit: 'm³/h', accent: true },
              { label: '下出口 Q₂',       value: d.result.Q2_m3h?.toFixed(3) ?? '—',    unit: 'm³/h', accent: true },
              { label: '分配比 Q₁ : Q₂',  value: (d.result.Q1_m3h != null && d.result.Q2_m3h != null)
                  ? `${(d.result.Q1_m3h / d.result.Q_m3h * 100).toFixed(1)} : ${(d.result.Q2_m3h / d.result.Q_m3h * 100).toFixed(1)} %`
                  : '—',
                unit: '' },
            ].map(row => (
              <div key={row.label} className="flex justify-between items-baseline gap-2">
                <span className="text-xs text-gray-500 shrink-0">{row.label}</span>
                <span className={`text-sm tabular-nums font-medium ${row.accent ? 'text-amber-700 font-bold' : 'text-gray-800'}`}>
                  {row.value}{row.unit ? ` ${row.unit}` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-amber-50 rounded-lg p-4 border border-amber-100 text-center flex flex-col items-center gap-2">
            <SvgTee className="w-8 h-8 text-amber-400" />
            <p className="text-sm font-medium text-amber-600">圧損バランス自動分配</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              下流の配管抵抗が等しくなるよう流量を自動分配します。
              「計算開始」で分配結果を確認できます。
            </p>
          </div>
        )
      )}

      {/* ── Sink ── */}
      {d.nodeType === 'sink' && (<>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-600">シンク種別</label>
          <div className="flex gap-4">
            {(['pressure', 'flow'] as const).map(t => (
              <label key={t} className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                <input
                  type="radio"
                  name={`sinkType-${node.id}`}
                  value={t}
                  checked={(d.sinkType ?? 'pressure') === t}
                  onChange={() => onChange({ sinkType: t })}
                />
                {t === 'pressure' ? '圧力シンク' : '流量シンク'}
              </label>
            ))}
          </div>
        </div>

        {(d.sinkType ?? 'pressure') === 'pressure' ? (<>
          <NumField label="出口圧力 P" unit="kPa" value={d.pressure ?? 0} onChange={v => onChange({ pressure: v })} />
          {d.result && (
            <div className="bg-rose-50 rounded-lg p-4 border border-rose-100">
              <div className="text-xs font-semibold text-rose-500 mb-1">計算結果 — 到達流量</div>
              <div className="text-2xl font-bold text-rose-700 tabular-nums">
                {d.result.Q_m3h.toFixed(3)}
                <span className="text-sm font-normal text-rose-500 ml-1">m³/h</span>
              </div>
            </div>
          )}
        </>) : (<>
          <NumField label="目標流量 Q" unit="m³/h" value={d.flowRate ?? 10} onChange={v => onChange({ flowRate: v })} />
          {d.result && (<>
            <div className="bg-rose-50 rounded-lg p-4 border border-rose-100">
              <div className="text-xs font-semibold text-rose-500 mb-1">計算結果 — 実際流量</div>
              <div className="text-2xl font-bold text-rose-700 tabular-nums">
                {d.result.Q_m3h.toFixed(3)}
                <span className="text-sm font-normal text-rose-500 ml-1">m³/h</span>
              </div>
            </div>
            {d.result.P_kpa !== undefined && (
              <div className="bg-blue-50 rounded-lg p-4 border border-blue-100">
                <div className="text-xs font-semibold text-blue-500 mb-1">計算結果 — 入口圧力</div>
                <div className="text-2xl font-bold text-blue-700 tabular-nums">
                  {d.result.P_kpa.toFixed(2)}
                  <span className="text-sm font-normal text-blue-500 ml-1">kPa</span>
                </div>
              </div>
            )}
          </>)}
        </>)}
      </>)}
    </div>
  )
}

// ── Analysis panel: flow-rate vs pressure-drop chart ──────────────

const REGIME_COLOR: Record<string, string> = {
  laminar: '#3b82f6',
  transitional: '#f97316',
  turbulent: '#ef4444',
}
const REGIME_LABEL: Record<string, string> = {
  laminar: '層流',
  transitional: '遷移域',
  turbulent: '乱流',
}

function AnalysisPanel({ node, density, viscosity }: {
  node: Node | null
  density: string
  viscosity: string
}) {
  const d = node?.data as unknown as NetworkNodeData | undefined
  const isPipe = d?.nodeType === 'pipe'

  const [chartData, setChartData] = useState<PressureDropResult | null>(null)
  const [fetching,  setFetching]  = useState(false)
  const [fetchErr,  setFetchErr]  = useState<string | null>(null)

  // Fetch curve whenever the selected pipe's params or fluid props change (debounced)
  useEffect(() => {
    if (!isPipe || !d) { setChartData(null); return }

    const rho  = parseFloat(density)  || 1000
    const mu   = (parseFloat(viscosity) || 1.0) / 1000
    const shape = d.pipeShape ?? 'circular'

    // Estimate cross-section area (m²) to compute a sensible flow range
    let A = 0
    if (shape === 'annulus') {
      const Do = (d.outerDiameter ?? 100) / 1000
      const Di = (d.innerDiameter ?? 50)  / 1000
      A = Math.PI * (Do ** 2 - Di ** 2) / 4
    } else if (shape === 'rectangular') {
      const W = (d.width      ?? 100) / 1000
      const H = (d.ductHeight ??  50) / 1000
      A = W * H
    } else {
      const D = (d.diameter ?? 100) / 1000
      A = Math.PI * D ** 2 / 4
    }
    const q_max = Math.max(1,    A * 5    * 3600)  // v_max = 5 m/s
    const q_min = Math.max(0.01, A * 0.02 * 3600)  // v_min = 0.02 m/s

    const req: PressureDropRequest = {
      pipe_type:      shape as 'circular' | 'rectangular' | 'annulus',
      diameter:       shape === 'circular'    ? (d.diameter      ?? 100) / 1000 : undefined,
      outer_diameter: shape === 'annulus'     ? (d.outerDiameter ?? 100) / 1000 : undefined,
      inner_diameter: shape === 'annulus'     ? (d.innerDiameter ??  50) / 1000 : undefined,
      width:          shape === 'rectangular' ? (d.width         ?? 100) / 1000 : undefined,
      duct_height:    shape === 'rectangular' ? (d.ductHeight    ??  50) / 1000 : undefined,
      length:           d.length   ?? 50,
      roughness:       (d.roughness ?? 0.046) / 1000,  // mm → m
      density:   rho,
      viscosity: mu,
      friction_method: d.frictionMethod ?? 'colebrook',
      flow_rate_min: q_min,
      flow_rate_max: q_max,
      points: 100,
    }

    const timer = setTimeout(() => {
      setFetching(true)
      setFetchErr(null)
      calcPressureDrop(req)
        .then(r  => { setChartData(r);        setFetching(false) })
        .catch(e => { setFetchErr(e.message); setFetching(false) })
    }, 400)

    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    node?.id, isPipe, d?.pipeShape,
    d?.diameter, d?.outerDiameter, d?.innerDiameter,
    d?.width, d?.ductHeight,
    d?.length, d?.roughness, d?.frictionMethod,
    density, viscosity,
  ])

  const traces = useMemo(() => {
    if (!chartData) return []
    const segs: Record<string, { x: number[]; y: number[] }> = {
      laminar: { x: [], y: [] }, transitional: { x: [], y: [] }, turbulent: { x: [], y: [] },
    }
    chartData.flow_rates.forEach((q, i) => {
      const r = chartData.regimes[i]
      if (segs[r]) { segs[r].x.push(q); segs[r].y.push(chartData.pressure_drops[i] / 1000) }
    })
    const out: object[] = Object.entries(segs)
      .filter(([, s]) => s.x.length > 0)
      .map(([regime, s]) => ({
        x: s.x, y: s.y,
        type: 'scatter', mode: 'lines',
        name: REGIME_LABEL[regime] ?? regime,
        line: { color: REGIME_COLOR[regime], width: 2.5 },
        hovertemplate: 'Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} kPa<extra></extra>',
      }))
    // Operating point marker (from network calc result)
    if (d?.result) {
      out.push({
        x: [d.result.Q_m3h], y: [d.result.dP_kpa],
        type: 'scatter', mode: 'markers',
        name: '動作点',
        marker: { color: '#7c3aed', size: 12, symbol: 'circle', line: { color: '#fff', width: 2 } },
        hovertemplate: 'Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} kPa<extra>動作点</extra>',
      })
    }
    return out
  }, [chartData, d?.result])

  if (!node || !isPipe) {
    return (
      <div className="flex items-center justify-center h-48">
        <p className="text-sm text-gray-300">パイプノードを選択すると流量–圧損特性を表示します</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {fetching && (
        <div className="text-sm text-gray-400 py-4 text-center">グラフ生成中...</div>
      )}
      {fetchErr && (
        <div className="text-sm text-red-500 py-2">{fetchErr}</div>
      )}
      {chartData && !fetching && (
        <Plot
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data={traces as any}
          layout={{
            title: { text: '流量–圧損特性（Darcy-Weisbach）', font: { size: 13 } },
            xaxis: { title: { text: '流量 Q [m³/h]' }, showgrid: true, gridcolor: '#f1f5f9', zeroline: false },
            yaxis: { title: { text: 'ΔP [kPa]' },       showgrid: true, gridcolor: '#f1f5f9', zeroline: false },
            legend: { orientation: 'h' as const, y: -0.22, x: 0 },
            margin: { l: 60, r: 24, t: 44, b: 70 },
            plot_bgcolor: '#f8fafc',
            paper_bgcolor: '#ffffff',
            autosize: true,
          }}
          useResizeHandler
          style={{ width: '100%', height: 380 }}
          config={{ displaylogo: false, responsive: true }}
        />
      )}
    </div>
  )
}

// ── Toolbar inline field (string-based for ρ, μ) ──────────────────

function InlineField({ label, unit, value, onChange, width = 'w-20' }: {
  label: string; unit: string; value: string; onChange: (v: string) => void; width?: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-sm text-gray-600 shrink-0">{label}</span>
      <input
        type="number" step="any" value={value}
        onChange={e => onChange(e.target.value)}
        className={`${width} border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500`}
      />
      <span className="text-xs text-gray-400 shrink-0">{unit}</span>
    </div>
  )
}

// ── Inner component ────────────────────────────────────────────────

function PipeNetworkCalcInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const { screenToFlowPosition } = useReactFlow()
  const nodeCounter = useRef(0)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedNode: Node | null = nodes.find(n => n.id === selectedId) ?? null

  const [density,   setDensity]   = useState('1000')
  const [viscosity, setViscosity] = useState('1.0')
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [totalDp,   setTotalDp]   = useState<number | null>(null)

  // CoolProp auto-fill
  const [coolFluid,   setCoolFluid]   = useState('Water')
  const [coolT,       setCoolT]       = useState('293.15')
  const [coolP,       setCoolP]       = useState('101.325')
  const [coolLoading, setCoolLoading] = useState(false)
  const [coolError,   setCoolError]   = useState<string | null>(null)

  const handleCoolProp = async () => {
    setCoolLoading(true)
    setCoolError(null)
    try {
      const props = await fetchProperties(coolFluid, parseFloat(coolT), parseFloat(coolP) * 1000)
      if (props.D != null) setDensity(props.D.toFixed(3))
      if (props.V != null) setViscosity((props.V * 1000).toFixed(4))
    } catch {
      setCoolError('物性値の取得に失敗しました')
    } finally {
      setCoolLoading(false)
    }
  }

  // ── Drag from palette ────────────────────────────────────────
  const onDragStart = (e: React.DragEvent, type: string) => {
    e.dataTransfer.setData('application/reactflow', type)
    e.dataTransfer.effectAllowed = 'move'
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/reactflow')
    if (!type) return
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    nodeCounter.current += 1
    const id = `${type}-${nodeCounter.current}`
    setNodes(prev => [...prev, {
      id, type, position: pos,
      data: defaultData(type, nodeCounter.current) as NetworkNodeData,
    }])
  }, [screenToFlowPosition, setNodes])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  // ── Connect ──────────────────────────────────────────────────
  const onConnect = useCallback((conn: Connection) => {
    setEdges(prev => addEdge({
      ...conn,
      type: 'smoothstep',
      style: { stroke: '#94a3b8', strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8', width: 16, height: 16 },
    }, prev))
  }, [setEdges])

  // ── Node click ───────────────────────────────────────────────
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId(node.id)
  }, [])

  const updateNode = useCallback((id: string, updates: Partial<NetworkNodeData>) => {
    setNodes(prev => prev.map(n => {
      if (n.id !== id) return n
      const d = n.data as unknown as NetworkNodeData
      return { ...n, data: { ...d, ...updates } as NetworkNodeData }
    }))
  }, [setNodes])

  // ── Calculate ────────────────────────────────────────────────
  const handleCalc = async () => {
    setError(null)
    setLoading(true)
    try {
      const res = await calcPipeNetwork({
        nodes: nodes.map(n => {
          const d = n.data as unknown as NetworkNodeData
          return { id: n.id, node_type: d.nodeType, params: n.data as Record<string, unknown> }
        }),
        edges: edges.map(e => ({
          id: e.id, source: e.source, target: e.target,
          source_handle: e.sourceHandle ?? null,
          target_handle: e.targetHandle ?? null,
        })),
        density:   parseFloat(density),
        viscosity: parseFloat(viscosity) / 1000,
      })

      setNodes(prev => prev.map(n => {
        const d = n.data as unknown as NetworkNodeData
        const nodeResult  = res.nodes[n.id]
        const srcPressure = res.source_pressures[n.id]
        const srcFlow     = res.source_flows[n.id]
        return {
          ...n,
          data: {
            ...d,
            ...(nodeResult  !== undefined ? { result: nodeResult }          : {}),
            ...(srcPressure !== undefined ? { calcPressure: srcPressure }   : {}),
            ...(srcFlow     !== undefined ? { calcFlow: srcFlow }           : {}),
          } as NetworkNodeData,
        }
      }))

      const total = Object.values(res.nodes).reduce((s, r) => s + (r?.dP_kpa ?? 0), 0)
      setTotalDp(total)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '計算に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-5 pb-8">

      {/* ── Section 1: 流体設定 ─────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4 flex flex-col gap-3">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-sm font-semibold text-gray-700 shrink-0">流体設定</span>
          <div className="w-px h-5 bg-gray-200 shrink-0" />

          {/* CoolProp lookup */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-gray-500 shrink-0">CoolProp</span>
            <select
              value={coolFluid}
              onChange={e => setCoolFluid(e.target.value)}
              className="border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {SUPPORTED_FLUIDS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <InlineField label="T" unit="K"   value={coolT} onChange={setCoolT} width="w-20" />
            <InlineField label="P" unit="kPa" value={coolP} onChange={setCoolP} width="w-20" />
            <button
              onClick={handleCoolProp}
              disabled={coolLoading}
              className="bg-teal-600 hover:bg-teal-700 text-white text-sm px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 shrink-0"
            >
              {coolLoading ? '取得中...' : '物性値を取得'}
            </button>
            {coolError && <span className="text-xs text-red-500">{coolError}</span>}
          </div>

          <div className="w-px h-5 bg-gray-200 shrink-0" />

          {/* Manual props (filled from CoolProp or manually) */}
          <InlineField label="密度 ρ"  unit="kg/m³" value={density}   onChange={setDensity}   width="w-24" />
          <InlineField label="粘度 μ"  unit="mPa·s" value={viscosity} onChange={setViscosity} width="w-20" />

          <div className="w-px h-5 bg-gray-200 shrink-0" />

          <button
            onClick={handleCalc}
            disabled={loading || nodes.length === 0}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-5 py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {loading ? '計算中...' : '計算開始'}
          </button>
          {error && <span className="text-sm text-red-500">{error}</span>}

          {totalDp !== null && (
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <span className="text-sm text-gray-500">合計 ΔP:</span>
              <span className="text-xl font-bold text-red-600 tabular-nums">{totalDp.toFixed(2)}</span>
              <span className="text-sm text-gray-500">kPa</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Section 2: ダイアグラム ──────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" style={{ height: 520 }}>
        <div className="flex h-full">

          {/* Palette */}
          <div className="w-28 shrink-0 bg-slate-800 text-white flex flex-col select-none">
            <div className="px-2 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide border-b border-slate-700 text-center">
              部品
            </div>
            {PALETTE.map(item => (
              <div
                key={item.type}
                draggable
                onDragStart={e => onDragStart(e, item.type)}
                className="py-3 px-2 border-b border-slate-700 cursor-grab active:cursor-grabbing hover:bg-slate-700 transition-colors flex flex-col items-center gap-1"
              >
                <item.Icon className={`w-8 h-8 ${item.color}`} />
                <div className={`text-xs font-medium ${item.color}`}>{item.label}</div>
                <div className="text-xs text-slate-500">{item.sub}</div>
              </div>
            ))}
            <div className="flex-1" />
            <div className="px-2 py-2 text-xs text-slate-600 border-t border-slate-700 text-center">
              Del/BS で削除
            </div>
          </div>

          {/* React Flow canvas */}
          <div className="flex-1 min-w-0" onDrop={onDrop} onDragOver={onDragOver}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onPaneClick={() => setSelectedId(null)}
              nodeTypes={nodeTypes}
              deleteKeyCode={['Delete', 'Backspace']}
              fitView
            >
              <Background color="#e2e8f0" gap={20} />
              <Controls />
              <MiniMap nodeStrokeWidth={2} zoomable pannable />
            </ReactFlow>
          </div>
        </div>
      </div>

      {/* ── Section 3: パラメータ設定 + 分析表示 ─────────────── */}
      <div className="flex gap-5 items-start">

        {/* パラメータ設定 */}
        <div className="w-72 shrink-0 bg-white rounded-xl border border-gray-200 shadow-sm p-5 min-h-[360px]">
          <h3 className="text-sm font-semibold text-gray-600 mb-4 pb-3 border-b border-gray-100">
            パラメータ設定
          </h3>
          {selectedNode ? (
            <NodeParamPanel
              node={selectedNode}
              onChange={u => updateNode(selectedNode.id, u)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-center gap-2">
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <p className="text-sm text-gray-400">ダイアグラムのノードを<br />クリックして選択</p>
            </div>
          )}
        </div>

        {/* 分析表示 */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm p-5 min-h-[360px]">
          <h3 className="text-sm font-semibold text-gray-600 mb-4 pb-3 border-b border-gray-100">
            分析表示
          </h3>
          <AnalysisPanel
            node={selectedNode}
            density={density}
            viscosity={viscosity}
          />
        </div>

      </div>
    </div>
  )
}

// ── Export ─────────────────────────────────────────────────────────

export default function PipeNetworkCalc() {
  return (
    <ReactFlowProvider>
      <PipeNetworkCalcInner />
    </ReactFlowProvider>
  )
}
