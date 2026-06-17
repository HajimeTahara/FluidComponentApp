'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
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
  useUpdateNodeInternals,
  ReactFlowProvider,
  NodeToolbar,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getSmoothStepPath,
  type Node,
  type Edge,
  type Connection,
  type EdgeProps,
  type EdgeTypes,
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
type NodeRotation = 0 | 90 | 180 | 270
type PumpCurveMode = 'quadratic' | 'table'
type PumpCurvePoint = { q: number; h: number }
type PressureUnit = 'm' | 'Pa' | 'kPa' | 'MPa' | 'bar'

const PRESSURE_UNITS: PressureUnit[] = ['m', 'Pa', 'kPa', 'MPa', 'bar']
const G_ACCEL = 9.80665

function kpaToUnit(kpa: number, unit: PressureUnit, rho: number): number {
  switch (unit) {
    case 'Pa':  return kpa * 1000
    case 'MPa': return kpa / 1000
    case 'bar': return kpa / 100
    case 'm':   return (kpa * 1000) / ((rho > 0 ? rho : 1000) * G_ACCEL)
    default:    return kpa
  }
}

function pressureDecimals(unit: PressureUnit): number {
  switch (unit) {
    case 'Pa':  return 0
    case 'MPa': return 6
    case 'bar': return 4
    case 'm':   return 3
    default:    return 3
  }
}

function formatPressure(kpa: number, unit: PressureUnit, rho: number): string {
  return kpaToUnit(kpa, unit, rho).toFixed(pressureDecimals(unit))
}

type NetworkNodeData = {
  nodeType: 'boundary' | 'source' | 'pipe' | 'pump' | 'tee' | 'sink'
  label: string
  // boundary/source/sink: unified boundary condition
  // flow: Q is fixed input → P is computed result
  // pressure: P is fixed input → Q is computed result
  boundaryType?: 'flow' | 'pressure'
  flowRate?: number       // flow-type: m³/h
  pressure?: number       // pressure-type: kPa
  calcPressure?: number   // flow-type result: required pressure kPa
  calcFlow?: number       // pressure-type result: computed flow m³/h
  portLeftConnected?: boolean
  portRightConnected?: boolean
  portInConnected?: boolean
  portOutConnected?: boolean
  showPressureResults?: boolean
  pressureUnit?: PressureUnit
  rho?: number
  rotation?: NodeRotation
  flipped?: boolean
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
  // pump
  ratedFlow?: number      // m³/h
  ratedHead?: number      // m
  shutoffHead?: number    // m
  efficiency?: number     // %
  ratedSpeed?: number     // rpm: PQ特性(簡易曲線/テーブル)の基準回転数
  speed?: number          // rpm: 現在の回転数（相似則でPQ特性をスケーリング）
  pumpCurveMode?: PumpCurveMode
  pumpCurvePoints?: PumpCurvePoint[]
  // tee (flow split is physics-based; no manual parameter)
  // result
  result?: PipeSegmentResult
  [key: string]: unknown
}

const POSITION_VECTOR: Record<Position, { x: number; y: number }> = {
  [Position.Left]: { x: -1, y: 0 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 },
  [Position.Bottom]: { x: 0, y: 1 },
}

function vectorToPosition({ x, y }: { x: number; y: number }): Position {
  if (x < 0) return Position.Left
  if (x > 0) return Position.Right
  if (y < 0) return Position.Top
  return Position.Bottom
}

function orientPosition(base: Position, data: NetworkNodeData): Position {
  let { x, y } = POSITION_VECTOR[base]
  if (data.flipped) x *= -1
  const turns = ((data.rotation ?? 0) / 90) % 4
  for (let i = 0; i < turns; i += 1) {
    const nextX = -y
    y = x
    x = nextX
  }
  return vectorToPosition({ x, y })
}

function pressureBadgeClass(position: Position): string {
  const base = 'absolute rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 shadow-sm whitespace-nowrap tabular-nums z-10'
  if (position === Position.Left) return `${base} left-0 top-1/2 -translate-x-[calc(100%+10px)] -translate-y-1/2`
  if (position === Position.Right) return `${base} right-0 top-1/2 translate-x-[calc(100%+10px)] -translate-y-1/2`
  if (position === Position.Top) return `${base} left-1/2 top-0 -translate-x-1/2 -translate-y-[calc(100%+10px)]`
  return `${base} left-1/2 bottom-0 -translate-x-1/2 translate-y-[calc(100%+10px)]`
}

function portHandleStyle(color: string, role: 'in' | 'out'): CSSProperties {
  const base: CSSProperties = {
    width: 14,
    height: 14,
    borderRadius: '9999px',
    border: `3px solid ${color}`,
    zIndex: 12,
  }
  return role === 'in'
    ? { ...base, background: color }
    : { ...base, background: '#ffffff' }
}

function pumpCurvePointsFor(data: NetworkNodeData): PumpCurvePoint[] {
  const points = data.pumpCurvePoints
  if (points && points.length >= 2) return points
  return [
    { q: 0, h: data.shutoffHead ?? 30 },
    { q: data.ratedFlow ?? 30, h: data.ratedHead ?? 20 },
    { q: pumpZeroHeadFlow(data), h: 0 },
  ]
}

function pumpZeroHeadFlow(data: NetworkNodeData): number {
  // 基準回転数におけるH=0となる流量（相似則適用前）
  const ratedFlow = Math.max(data.ratedFlow ?? 30, 1e-9)
  const ratedHead = data.ratedHead ?? 20
  const shutoffHead = data.shutoffHead ?? Math.max(ratedHead, 0)
  const dropAtRated = shutoffHead - ratedHead
  if (shutoffHead <= 0 || dropAtRated <= 1e-9) return ratedFlow
  return ratedFlow * Math.sqrt(shutoffHead / dropAtRated)
}

function pumpSpeedRatio(data: NetworkNodeData): number {
  const ratedSpeed = data.ratedSpeed ?? 1450
  if (ratedSpeed <= 0) return 1
  const speed = data.speed ?? ratedSpeed
  return Math.max(speed, 0) / ratedSpeed
}

function pumpMaxFlow(data: NetworkNodeData): number {
  // 現在回転数におけるH=0となる流量（相似則適用後）
  const r = pumpSpeedRatio(data)
  if ((data.pumpCurveMode ?? 'quadratic') === 'table') {
    const points = pumpCurvePointsFor(data)
      .filter(p => Number.isFinite(p.q) && Number.isFinite(p.h) && p.q >= 0 && p.h >= 0)
      .sort((a, b) => a.q - b.q)
    const qAtRated = points.length >= 2 ? points[points.length - 1].q : pumpZeroHeadFlow(data)
    return qAtRated * r
  }
  return pumpZeroHeadFlow(data) * r
}

function pumpHeadAtRated(data: NetworkNodeData, q: number): number {
  if ((data.pumpCurveMode ?? 'quadratic') === 'table') {
    const points = pumpCurvePointsFor(data)
      .filter(p => Number.isFinite(p.q) && Number.isFinite(p.h) && p.q >= 0 && p.h >= 0)
      .sort((a, b) => a.q - b.q)
    if (points.length >= 2) {
      if (q <= points[0].q) return points[0].h
      for (let i = 0; i < points.length - 1; i += 1) {
        const p0 = points[i]
        const p1 = points[i + 1]
        if (q <= p1.q) {
          const span = Math.max(p1.q - p0.q, 1e-9)
          const t = (q - p0.q) / span
          return Math.max(p0.h + (p1.h - p0.h) * t, 0)
        }
      }
      return points[points.length - 1].h
    }
  }

  const ratedFlow = Math.max(data.ratedFlow ?? 30, 1e-9)
  const ratedHead = data.ratedHead ?? 20
  const shutoffHead = data.shutoffHead ?? Math.max(ratedHead, 0)
  const curve = Math.max((shutoffHead - ratedHead) / (ratedFlow ** 2), 0)
  if (curve <= 1e-12) return Math.max(shutoffHead, ratedHead, 0)
  return Math.max(shutoffHead - curve * (Math.max(q, 0) ** 2), 0)
}

function pumpHeadAt(data: NetworkNodeData, q: number): number {
  // 相似則 (Q∝N, H∝N²) で基準回転数の特性を現在回転数に変換する
  const r = pumpSpeedRatio(data)
  if (r <= 1e-9) return 0
  const qAtRated = Math.max(q, 0) / r
  const hAtRated = pumpHeadAtRated(data, qAtRated)
  return Math.max(hAtRated * r * r, 0)
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

function SvgPump({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="7" />
      <path d="M5 12H2" />
      <path d="M22 12h-3" />
      <path d="M10 8l5 4-5 4V8z" />
    </svg>
  )
}

function SvgRotate({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}

function SvgFlip({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <path d="M4 7l5 5-5 5V7z" />
      <path d="M20 7l-5 5 5 5V7z" />
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

function BoundaryNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const isFlow = (d.boundaryType ?? 'flow') === 'flow'
  const inPosition = orientPosition(Position.Left, d)
  const outPosition = orientPosition(Position.Right, d)
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  const displayedPressure = d.calcPressure ?? d.result?.P_kpa ?? d.pressure
  const pressureLabel = displayedPressure !== undefined
    ? `${formatPressure(displayedPressure, unit, rho)} ${unit}`
    : null
  return (
    <div className={`relative px-3 py-2 rounded-xl border-2 bg-teal-50 min-w-[130px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-teal-500'}`}>
      <Handle type="target" position={inPosition} style={portHandleStyle('#14b8a6', 'in')} />
      {d.showPressureResults && pressureLabel && (d.portInConnected ?? d.portLeftConnected) && (
        <div className={pressureBadgeClass(inPosition)}>
          {pressureLabel}
        </div>
      )}
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgSource className="w-4 h-4 text-teal-600 shrink-0" />
        <span className="text-xs font-bold text-teal-700">{d.label}</span>
      </div>
      {isFlow ? (
        <>
          <div className="text-xs text-teal-600 pl-5">Q: {d.flowRate ?? 10} m³/h</div>
        </>
      ) : (
        <div className="text-xs text-teal-600 pl-5">圧力固定</div>
      )}
      {d.showPressureResults && pressureLabel && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {pressureLabel}
        </div>
      )}
      <Handle type="source" position={outPosition} style={portHandleStyle('#14b8a6', 'out')} />
    </div>
  )
}

const SourceNode = BoundaryNode

function PipeNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const inPosition = orientPosition(Position.Left, d)
  const outPosition = orientPosition(Position.Right, d)
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  const shapeLabel = d.pipeShape === 'annulus' ? '中空円' : d.pipeShape === 'rectangular' ? '矩形' : '円管'
  return (
    <div className={`relative px-3 py-2 rounded border-2 bg-sky-50 min-w-[140px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-sky-400'}`}>
      <Handle type="target" position={inPosition} style={portHandleStyle('#38bdf8', 'in')} />
      {d.showPressureResults && d.result?.P_from_kpa !== undefined && (d.portInConnected ?? d.portLeftConnected) && (
        <div className={pressureBadgeClass(inPosition)}>
          {formatPressure(d.result.P_from_kpa, unit, rho)} {unit}
        </div>
      )}
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgPipe className="w-4 h-4 text-sky-600 shrink-0" />
        <span className="text-xs font-bold text-sky-700">{d.label}</span>
      </div>
      <div className="text-xs text-sky-500 pl-5">{shapeLabel} · L={d.length ?? 50} m</div>
      {d.result && (
        <div className="text-xs font-bold text-red-500 mt-0.5 pl-5">ΔP: {formatPressure(d.result.dP_kpa, unit, rho)} {unit}</div>
      )}
      {d.showPressureResults && d.result?.P_to_kpa !== undefined && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {formatPressure(d.result.P_to_kpa, unit, rho)} {unit}
        </div>
      )}
      <Handle type="source" position={outPosition} style={portHandleStyle('#38bdf8', 'out')} />
    </div>
  )
}

function PumpNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const inPosition = orientPosition(Position.Left, d)
  const outPosition = orientPosition(Position.Right, d)
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  return (
    <div className={`relative px-3 py-2 rounded border-2 bg-violet-50 min-w-[150px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-violet-500'}`}>
      <Handle type="target" position={inPosition} style={portHandleStyle('#8b5cf6', 'in')} />
      {d.showPressureResults && d.result?.P_from_kpa !== undefined && (d.portInConnected ?? d.portLeftConnected) && (
        <div className={pressureBadgeClass(inPosition)}>
          {formatPressure(d.result.P_from_kpa, unit, rho)} {unit}
        </div>
      )}
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgPump className="w-4 h-4 text-violet-600 shrink-0" />
        <span className="text-xs font-bold text-violet-700">{d.label}</span>
      </div>
      <div className="text-xs text-violet-500 pl-5">
        {(d.pumpCurveMode ?? 'quadratic') === 'table'
          ? `テーブルPQ · ${d.pumpCurvePoints?.length ?? 0}点`
          : `H0=${d.shutoffHead ?? 30} m · Qr=${d.ratedFlow ?? 30} m³/h`}
      </div>
      {d.result?.boost_kpa !== undefined && (
        <div className="text-xs font-bold text-emerald-600 mt-0.5 pl-5">+ΔP: {formatPressure(d.result.boost_kpa, unit, rho)} {unit}</div>
      )}
      {d.showPressureResults && d.result?.P_to_kpa !== undefined && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {formatPressure(d.result.P_to_kpa, unit, rho)} {unit}
        </div>
      )}
      <Handle type="source" position={outPosition} style={portHandleStyle('#8b5cf6', 'out')} />
    </div>
  )
}

function TeeNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const r = d.result
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  const inPosition = orientPosition(Position.Left, d)
  const out1Position = orientPosition(Position.Right, d)
  const out2Position = orientPosition(Position.Bottom, d)
  return (
    <div className={`px-3 py-3 rounded border-2 bg-amber-50 min-w-[110px] text-center ${selected ? 'border-blue-500 shadow-lg' : 'border-amber-400'}`}>
      <Handle type="target" position={inPosition} id="in" style={portHandleStyle('#f59e0b', 'in')} />
      <div className="flex items-center justify-center gap-1.5 mb-0.5">
        <SvgTee className="w-4 h-4 text-amber-600 shrink-0" />
        <span className="text-xs font-bold text-amber-700">{d.label}</span>
      </div>
      {r?.regime === 'split' ? (
        <div className="text-xs text-amber-600 font-medium tabular-nums">
          {r.P_kpa !== undefined && <div>P: {formatPressure(r.P_kpa, unit, rho)} {unit}</div>}
          <div>{r.Q1_m3h?.toFixed(2)} / {r.Q2_m3h?.toFixed(2)} m³/h</div>
        </div>
      ) : r?.regime === 'junction' && r.P_kpa !== undefined ? (
        <div className="text-xs text-amber-600 font-medium tabular-nums">
          P: {formatPressure(r.P_kpa, unit, rho)} {unit}
        </div>
      ) : (
        <div className="text-xs text-amber-400">圧損バランス分配</div>
      )}
      <Handle type="source" position={out1Position} id="out-1" style={portHandleStyle('#f59e0b', 'out')} />
      <Handle type="source" position={out2Position} id="out-2" style={portHandleStyle('#f59e0b', 'out')} />
    </div>
  )
}

function SinkNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const isPressure = (d.boundaryType ?? 'pressure') === 'pressure'
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  const inPosition = orientPosition(Position.Left, d)
  return (
    <div className={`px-3 py-2 rounded-xl border-2 bg-rose-50 min-w-[110px] ${selected ? 'border-blue-500 shadow-lg' : 'border-rose-400'}`}>
      <Handle type="target" position={inPosition} style={portHandleStyle('#fb7185', 'in')} />
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgSink className="w-4 h-4 text-rose-500 shrink-0" />
        <span className="text-xs font-bold text-rose-700">{d.label}</span>
      </div>
      {isPressure ? (
        <>
          <div className="text-xs text-rose-400">P: {formatPressure(d.pressure ?? 0, unit, rho)} {unit}</div>
          {d.result && (
            <div className="text-xs font-bold text-blue-600">Q: {d.result.Q_m3h.toFixed(2)} m³/h</div>
          )}
        </>
      ) : (
        <>
          <div className="text-xs text-rose-400">自由出口 (P=0)</div>
          {d.result && (
            <div className="text-xs font-bold text-blue-600">Q: {d.result.Q_m3h.toFixed(2)} m³/h</div>
          )}
        </>
      )}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: Record<string, any> = {
  boundary: BoundaryNode,
  source: SourceNode,
  pipe: PipeNode,
  pump: PumpNode,
  tee: TeeNode,
  sink: SinkNode,
}

type FlowEdgeData = Record<string, unknown> & { flowLabel?: string; labelVisible?: boolean }
type FlowEdgeType = Edge<FlowEdgeData, 'flow'>

function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
}: EdgeProps<FlowEdgeType>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: '#94a3b8', strokeWidth: 2.5, ...style }}
      />
      {data?.flowLabel && data.labelVisible !== false && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan rounded bg-white/95 px-2 py-0.5 text-xs font-semibold text-slate-700 shadow-sm border border-slate-200"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY - 10}px)`,
              pointerEvents: 'all',
              whiteSpace: 'nowrap',
            }}
          >
            {data.flowLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

const edgeTypes = { flow: FlowEdge } satisfies EdgeTypes

// ── Palette ────────────────────────────────────────────────────────

const PALETTE = [
  { type: 'boundary', label: '境界',  sub: 'P / Q',  color: 'text-teal-300',    Icon: SvgSource },
  { type: 'pipe',   label: 'パイプ',  sub: '直管',  color: 'text-sky-300',    Icon: SvgPipe },
  { type: 'pump',   label: 'ポンプ',  sub: 'PQ',    color: 'text-violet-300', Icon: SvgPump },
  { type: 'tee',    label: 'T字管',   sub: '分岐',  color: 'text-amber-300',  Icon: SvgTee },
]

function defaultData(type: string, n: number): NetworkNodeData {
  switch (type) {
    case 'boundary': return { nodeType: 'boundary', label: `境界${n}`, boundaryType: 'pressure', pressure: 101.325, flowRate: 10 }
    case 'source': return { nodeType: 'source', label: `ソース${n}`, boundaryType: 'flow', flowRate: 10, pressure: 100 }
    case 'pipe':   return {
      nodeType: 'pipe', label: `パイプ${n}`,
      pipeShape: 'circular',
      diameter: 100, outerDiameter: 100, innerDiameter: 50,
      width: 100, ductHeight: 50,
      length: 50, roughness: 0.046,
      frictionMethod: 'colebrook',
    }
    case 'pump': return {
      nodeType: 'pump', label: `ポンプ${n}`,
      ratedFlow: 30, ratedHead: 20,
      shutoffHead: 30,
      efficiency: 70,
      ratedSpeed: 1450, speed: 1450,
      pumpCurveMode: 'quadratic',
      pumpCurvePoints: [
        { q: 0, h: 30 },
        { q: 30, h: 20 },
        { q: 51.96, h: 0 },
      ],
    }
    case 'tee':  return { nodeType: 'tee',  label: `T字管${n}` }
    case 'sink': return { nodeType: 'sink', label: `シンク${n}`, boundaryType: 'pressure', pressure: 101.325 }
    default:     return { nodeType: 'boundary', label: `${type}${n}`, boundaryType: 'pressure', pressure: 101.325, flowRate: 10 }
  }
}

const DEFAULT_NODE_COUNTER = 4

function createDefaultDiagram(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    {
      id: 'boundary-1', type: 'boundary', position: { x: 380, y: 20 },
      data: { ...defaultData('boundary', 1), flipped: true } as NetworkNodeData,
    },
    { id: 'pipe-2', type: 'pipe', position: { x: 700, y: 200 }, data: defaultData('pipe', 2) as NetworkNodeData },
    { id: 'pipe-3', type: 'pipe', position: { x: 60,  y: 200 }, data: defaultData('pipe', 3) as NetworkNodeData },
    { id: 'pump-4', type: 'pump', position: { x: 380, y: 360 }, data: defaultData('pump', 4) as NetworkNodeData },
  ]
  const edgeStyle = { stroke: '#94a3b8', strokeWidth: 2 }
  const edges: Edge[] = [
    { id: 'e-boundary-1-pipe-3', source: 'boundary-1', target: 'pipe-3', type: 'flow', style: edgeStyle },
    { id: 'e-pipe-3-pump-4',     source: 'pipe-3',     target: 'pump-4', type: 'flow', style: edgeStyle },
    { id: 'e-pump-4-pipe-2',     source: 'pump-4',     target: 'pipe-2', type: 'flow', style: edgeStyle },
    { id: 'e-pipe-2-boundary-1', source: 'pipe-2',     target: 'boundary-1', type: 'flow', style: edgeStyle },
  ]
  return { nodes, edges }
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

// ── Unified result table: 項目 / 記号 / 値 / 単位 ──────────────────

type ResultRow = { item: string; symbol: string; value: string; unit: string; highlight?: boolean }
type ResultTheme = 'sky' | 'violet' | 'amber' | 'blue'

const RESULT_THEME_CLASSES: Record<ResultTheme, { bg: string; border: string; title: string }> = {
  sky:    { bg: 'bg-sky-50',    border: 'border-sky-100',    title: 'text-sky-600' },
  violet: { bg: 'bg-violet-50', border: 'border-violet-100', title: 'text-violet-600' },
  amber:  { bg: 'bg-amber-50',  border: 'border-amber-100',  title: 'text-amber-600' },
  blue:   { bg: 'bg-blue-50',   border: 'border-blue-100',   title: 'text-blue-600' },
}

function ResultTable({ title, rows, theme = 'sky', note }: {
  title: string; rows: ResultRow[]; theme?: ResultTheme; note?: string
}) {
  const c = RESULT_THEME_CLASSES[theme]
  return (
    <div className={`rounded-lg p-3 border ${c.bg} ${c.border}`}>
      <div className={`text-xs font-semibold mb-2 ${c.title}`}>{title}</div>
      {note && <div className="text-xs text-gray-500 mb-2">{note}</div>}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-xs text-gray-400">
            <th className="text-left font-medium pb-1">項目</th>
            <th className="text-left font-medium pb-1">記号</th>
            <th className="text-right font-medium pb-1">値</th>
            <th className="text-left font-medium pb-1 pl-2">単位</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.item} className="border-t border-black/5">
              <td className="py-1 text-xs text-gray-500 whitespace-nowrap">{r.item}</td>
              <td className="py-1 text-xs text-gray-400 italic whitespace-nowrap">{r.symbol}</td>
              <td className={`py-1 text-right tabular-nums font-medium whitespace-nowrap ${r.highlight ? 'text-red-600 font-bold' : 'text-gray-800'}`}>
                {r.value}
              </td>
              <td className="py-1 pl-2 text-xs text-gray-400 whitespace-nowrap">{r.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function pipeResultRows(result: PipeSegmentResult, unit: PressureUnit, rho: number): ResultRow[] {
  return [
    { item: '流量',       symbol: 'Q',  value: result.Q_m3h.toFixed(3), unit: 'm³/h' },
    { item: '流速',       symbol: 'v',  value: result.v.toFixed(4),     unit: 'm/s' },
    { item: 'レイノルズ数', symbol: 'Re', value: result.Re.toFixed(1),    unit: '–' },
    { item: '摩擦係数',    symbol: 'f',  value: result.f.toFixed(6),     unit: '–' },
    { item: '圧力損失',    symbol: 'ΔP', value: formatPressure(result.dP_kpa, unit, rho), unit, highlight: true },
    ...(result.P_in_kpa  !== undefined ? [{ item: '上流圧', symbol: 'P_in',  value: formatPressure(result.P_in_kpa,  unit, rho), unit }] : []),
    ...(result.P_out_kpa !== undefined ? [{ item: '下流圧', symbol: 'P_out', value: formatPressure(result.P_out_kpa, unit, rho), unit }] : []),
  ]
}

function pumpResultRows(result: PipeSegmentResult, unit: PressureUnit, rho: number): ResultRow[] {
  return [
    { item: '流量',   symbol: 'Q',   value: result.Q_m3h.toFixed(3),                       unit: 'm³/h' },
    { item: '揚程',   symbol: 'H',   value: (result.head_m ?? 0).toFixed(3),               unit: 'm' },
    { item: '昇圧',   symbol: 'ΔP',  value: formatPressure(result.boost_kpa ?? 0, unit, rho), unit, highlight: true },
    { item: '理論動力', symbol: 'P_h', value: (result.hydraulic_power_kw ?? 0).toFixed(4), unit: 'kW' },
    { item: '消費動力', symbol: 'P_s', value: (result.shaft_power_kw ?? 0).toFixed(4),     unit: 'kW', highlight: true },
    ...(result.P_from_kpa !== undefined ? [{ item: '入口圧', symbol: 'P_in',  value: formatPressure(result.P_from_kpa, unit, rho), unit }] : []),
    ...(result.P_to_kpa   !== undefined ? [{ item: '出口圧', symbol: 'P_out', value: formatPressure(result.P_to_kpa,   unit, rho), unit }] : []),
  ]
}

function boundaryResultRows(d: NetworkNodeData, unit: PressureUnit, rho: number): ResultRow[] | null {
  const isFlow = (d.boundaryType ?? 'flow') === 'flow'
  if (isFlow && d.calcPressure !== undefined) {
    return [{ item: '境界圧力', symbol: 'P', value: formatPressure(d.calcPressure, unit, rho), unit, highlight: true }]
  }
  if (!isFlow && d.calcFlow !== undefined) {
    return [{ item: '境界流量', symbol: 'Q', value: d.calcFlow.toFixed(3), unit: 'm³/h', highlight: true }]
  }
  return null
}

function teeResultRows(d: NetworkNodeData, unit: PressureUnit, rho: number): ResultRow[] | null {
  const r = d.result
  if (r?.regime === 'junction') {
    return [
      { item: '圧力',   symbol: 'P', value: r.P_kpa !== undefined ? formatPressure(r.P_kpa, unit, rho) : '—', unit, highlight: true },
      { item: '通過流量', symbol: 'Q', value: r.Q_m3h.toFixed(3), unit: 'm³/h' },
    ]
  }
  if (r?.regime === 'split') {
    const q  = r.Q_m3h
    const q1 = r.Q1_m3h
    const q2 = r.Q2_m3h
    return [
      { item: '入口流量',  symbol: 'Q',  value: q.toFixed(3),                                          unit: 'm³/h' },
      { item: '出口流量1', symbol: 'Q₁', value: q1 !== undefined ? q1.toFixed(3) : '—',                 unit: 'm³/h', highlight: true },
      { item: '出口流量2', symbol: 'Q₂', value: q2 !== undefined ? q2.toFixed(3) : '—',                 unit: 'm³/h', highlight: true },
      { item: '分配率1',   symbol: 'η₁', value: (q1 !== undefined && q !== 0) ? (q1 / q * 100).toFixed(1) : '—', unit: '%' },
      { item: '分配率2',   symbol: 'η₂', value: (q2 !== undefined && q !== 0) ? (q2 / q * 100).toFixed(1) : '—', unit: '%' },
    ]
  }
  return null
}

function componentTypeLabel(nodeType: string): string {
  if (nodeType === 'pipe') return 'パイプ'
  if (nodeType === 'pump') return 'ポンプ'
  if (nodeType === 'tee')  return 'T字管'
  return '境界'
}

function componentResultRows(d: NetworkNodeData, unit: PressureUnit, rho: number): ResultRow[] | null {
  if (d.nodeType === 'pipe') return d.result ? pipeResultRows(d.result, unit, rho) : null
  if (d.nodeType === 'pump') return d.result ? pumpResultRows(d.result, unit, rho) : null
  if (d.nodeType === 'tee')  return teeResultRows(d, unit, rho)
  return boundaryResultRows(d, unit, rho)
}

function NodeParamPanel({ node, onChange }: {
  node: Node
  onChange: (u: Partial<NetworkNodeData>) => void
}) {
  const d = node.data as unknown as NetworkNodeData
  const pumpPoints = pumpCurvePointsFor(d)
  const updatePumpPoint = (index: number, updates: Partial<PumpCurvePoint>) => {
    onChange({
      pumpCurvePoints: pumpPoints.map((point, i) => i === index ? { ...point, ...updates } : point),
    })
  }
  const addPumpPoint = () => {
    const last = pumpPoints[pumpPoints.length - 1] ?? { q: 0, h: 0 }
    onChange({ pumpCurvePoints: [...pumpPoints, { q: last.q + 10, h: Math.max(last.h - 5, 0) }] })
  }
  const removePumpPoint = (index: number) => {
    if (pumpPoints.length <= 2) return
    onChange({ pumpCurvePoints: pumpPoints.filter((_, i) => i !== index) })
  }

  const isBoundaryNode = d.nodeType === 'boundary' || d.nodeType === 'source' || d.nodeType === 'sink'

  const Icon = isBoundaryNode ? SvgSource
    : d.nodeType === 'pipe' ? SvgPipe
    : d.nodeType === 'pump' ? SvgPump
    : SvgTee

  const iconColor = isBoundaryNode ? 'text-teal-600'
    : d.nodeType === 'pipe' ? 'text-sky-600'
    : d.nodeType === 'pump' ? 'text-violet-600'
    : 'text-amber-600'

  return (
    <div className="flex flex-col gap-4">
      {/* Node identity */}
      <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
        <Icon className={`w-5 h-5 ${iconColor} shrink-0`} />
        <span className="text-base font-semibold text-gray-800 min-w-0 flex-1 truncate">{d.label}</span>
      </div>

      {/* ── Boundary ── */}
      {isBoundaryNode && (<>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-600">境界条件</label>
          <div className="flex gap-4">
            {(['flow', 'pressure'] as const).map(t => (
              <label key={t} className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                <input
                  type="radio"
                  name={`boundaryType-${node.id}`}
                  value={t}
                  checked={(d.boundaryType ?? 'flow') === t}
                  onChange={() => onChange({ boundaryType: t })}
                />
                {t === 'flow' ? '流量固定' : '圧力固定'}
              </label>
            ))}
          </div>
        </div>

        {(d.boundaryType ?? 'flow') === 'flow' ? (
          <NumField label="流量 Q" unit="m³/h" value={d.flowRate ?? 10} onChange={v => onChange({ flowRate: v })} />
        ) : (
          <NumField label="圧力 P" unit="kPa" value={d.pressure ?? 100} onChange={v => onChange({ pressure: v })} />
        )}
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

      </>)}

      {/* ── Pump ── */}
      {d.nodeType === 'pump' && (<>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-600">PQ特性モード</label>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['quadratic', '簡易曲線'],
              ['table', 'テーブル'],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange({ pumpCurveMode: mode, ...(mode === 'table' ? { pumpCurvePoints: pumpPoints } : {}) })}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  (d.pumpCurveMode ?? 'quadratic') === mode
                    ? 'border-violet-400 bg-violet-50 text-violet-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-violet-100 bg-violet-50/60 p-3 flex flex-col gap-3">
          <div className="text-xs font-semibold text-violet-600">回転数（相似則）</div>
          <NumField label="基準回転数 Nr" unit="rpm" value={d.ratedSpeed ?? 1450} onChange={v => onChange({ ratedSpeed: v })} />
          <NumField label="現在回転数 N"  unit="rpm" value={d.speed ?? d.ratedSpeed ?? 1450} onChange={v => onChange({ speed: v })} />
          <p className="text-xs text-gray-400 leading-relaxed">
            PQ特性（簡易曲線・テーブルいずれも）は基準回転数Nrで定義されたものとして扱い、Q∝N、H∝N²でNに応じてスケーリングします。
          </p>
        </div>

        {(d.pumpCurveMode ?? 'quadratic') === 'quadratic' ? (<>
          <div className="rounded-lg border border-violet-100 bg-violet-50 p-3 text-xs leading-relaxed text-violet-700">
            H(Q) = H0 - aQ²、a = (H0 - Hr) / Qr² としてPQ曲線を作ります。QmaxはH=0となる流量として自動計算します。
          </div>
          <NumField label="定格流量 Qr" unit="m³/h" value={d.ratedFlow ?? 30} onChange={v => onChange({ ratedFlow: v })} />
          <NumField label="定格揚程 Hr" unit="m" value={d.ratedHead ?? 20} onChange={v => onChange({ ratedHead: v })} />
          <NumField label="閉止揚程 H0" unit="m" value={d.shutoffHead ?? 30} onChange={v => onChange({ shutoffHead: v })} />
          <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
            <div className="text-xs font-semibold text-gray-500 mb-1">自動計算（現在回転数）</div>
            <div className="flex justify-between items-baseline gap-2">
              <span className="text-xs text-gray-500">最大流量 Qmax</span>
              <span className="font-bold tabular-nums">{pumpMaxFlow(d).toFixed(2)} m³/h</span>
            </div>
          </div>
        </>) : (
          <div className="flex flex-col gap-2 rounded-lg border border-violet-100 bg-violet-50 p-3">
            <div className="grid grid-cols-[1fr_1fr_32px] gap-2 text-xs font-semibold text-violet-700">
              <span>Q [m³/h]</span>
              <span>H [m]</span>
              <span />
            </div>
            {pumpPoints.map((point, index) => (
              <div key={index} className="grid grid-cols-[1fr_1fr_32px] gap-2">
                <input
                  type="number"
                  step="any"
                  value={point.q}
                  onChange={e => updatePumpPoint(index, { q: parseFloat(e.target.value) || 0 })}
                  className="min-w-0 rounded-md border border-violet-200 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                />
                <input
                  type="number"
                  step="any"
                  value={point.h}
                  onChange={e => updatePumpPoint(index, { h: parseFloat(e.target.value) || 0 })}
                  className="min-w-0 rounded-md border border-violet-200 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                />
                <button
                  type="button"
                  title="行を削除"
                  onClick={() => removePumpPoint(index)}
                  disabled={pumpPoints.length <= 2}
                  className="rounded-md border border-violet-200 bg-white text-sm font-semibold text-violet-500 disabled:opacity-40"
                >
                  -
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addPumpPoint}
              className="rounded-md border border-violet-200 bg-white px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100"
            >
              行を追加
            </button>
            <p className="text-xs text-violet-400">表の値は基準回転数Nrにおける特性として入力してください。</p>
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
              <div className="text-xs font-semibold text-gray-500 mb-1">自動計算（現在回転数）</div>
              <div className="flex justify-between items-baseline gap-2">
                <span className="text-xs text-gray-500">最大流量 Qmax</span>
                <span className="font-bold tabular-nums">{pumpMaxFlow(d).toFixed(2)} m³/h</span>
              </div>
            </div>
          </div>
        )}

        <NumField label="効率 η" unit="%" value={d.efficiency ?? 70} onChange={v => onChange({ efficiency: v })} />
      </>)}
    </div>
  )
}

const REGIME_TEXT_LABEL: Record<string, string> = {
  laminar: '層流', transitional: '遷移域', turbulent: '乱流', junction: '節点',
}

function ResultsPanel({ node, pressureUnit, rho }: {
  node: Node | null
  pressureUnit: PressureUnit
  rho: number
}) {
  const empty = (
    <div className="flex flex-col items-center justify-center h-28 text-center gap-2">
      <p className="text-sm text-gray-400">「計算開始」を実行すると<br />結果が表示されます</p>
    </div>
  )

  if (!node) {
    return (
      <div className="flex flex-col items-center justify-center h-28 text-center gap-2">
        <p className="text-sm text-gray-400">ノードを選択してください</p>
      </div>
    )
  }

  const d = node.data as unknown as NetworkNodeData
  const isBoundaryNode = d.nodeType === 'boundary' || d.nodeType === 'source' || d.nodeType === 'sink'

  if (isBoundaryNode) {
    const isFlow = (d.boundaryType ?? 'flow') === 'flow'
    const rows = boundaryResultRows(d, pressureUnit, rho)
    if (rows) {
      return (
        <ResultTable
          theme="blue"
          title={isFlow ? '計算結果 — 境界圧力' : '計算結果 — 境界流量'}
          rows={rows}
        />
      )
    }
    return empty
  }

  if (d.nodeType === 'pipe') {
    if (!d.result) return empty
    return (
      <ResultTable
        theme="sky"
        title="計算結果 — パイプ"
        note={`流動域: ${REGIME_TEXT_LABEL[d.result.regime] ?? d.result.regime}`}
        rows={pipeResultRows(d.result, pressureUnit, rho)}
      />
    )
  }

  if (d.nodeType === 'pump') {
    if (!d.result) return empty
    return (
      <ResultTable
        theme="violet"
        title="計算結果 — ポンプ"
        rows={pumpResultRows(d.result, pressureUnit, rho)}
      />
    )
  }

  if (d.nodeType === 'tee') {
    const rows = teeResultRows(d, pressureUnit, rho)
    if (rows) {
      return (
        <ResultTable
          theme="amber"
          title={d.result?.regime === 'junction' ? '計算結果 — 節点圧' : '計算結果 — 圧損バランス分配'}
          rows={rows}
        />
      )
    }
    return (
      <div className="bg-amber-50 rounded-lg p-4 border border-amber-100 text-center flex flex-col items-center gap-2">
        <SvgTee className="w-8 h-8 text-amber-400" />
        <p className="text-sm font-medium text-amber-600">圧損バランス自動分配</p>
        <p className="text-xs text-gray-400 leading-relaxed">
          下流の配管抵抗が等しくなるよう流量を自動分配します。
          「計算開始」で分配結果を確認できます。
        </p>
      </div>
    )
  }

  return empty
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

function AnalysisPanel({ node, density, viscosity, pressureUnit, rho }: {
  node: Node | null
  density: string
  viscosity: string
  pressureUnit: PressureUnit
  rho: number
}) {
  const d = node?.data as unknown as NetworkNodeData | undefined
  const isPipe = d?.nodeType === 'pipe'
  const isPump = d?.nodeType === 'pump'

  const [chartData, setChartData] = useState<PressureDropResult | null>(null)
  const [fetching,  setFetching]  = useState(false)
  const [fetchErr,  setFetchErr]  = useState<string | null>(null)
  const pumpQMax = isPump && d ? pumpMaxFlow(d) : null

  // Fetch curve whenever the selected pipe's params or fluid props change (debounced)
  useEffect(() => {
    if (!isPipe || !d) return

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
    if (isPump && d) {
      const qMax = Math.max(pumpMaxFlow(d) * 1.12, 1)
      const flowRates = Array.from({ length: 100 }, (_, i) => qMax * i / 99)
      const out: object[] = [{
        x: flowRates,
        y: flowRates.map(q => pumpHeadAt(d, q)),
        type: 'scatter',
        mode: 'lines',
        name: 'PQ特性',
        line: { color: '#7c3aed', width: 2.8 },
        hovertemplate: 'Q: %{x:.2f} m³/h<br>H: %{y:.3f} m<extra></extra>',
      }]
      if (d.result) {
        out.push({
          x: [d.result.Q_m3h],
          y: [d.result.head_m ?? pumpHeadAt(d, d.result.Q_m3h)],
          type: 'scatter',
          mode: 'markers',
          name: '動作点',
          marker: { color: '#059669', size: 12, symbol: 'circle', line: { color: '#fff', width: 2 } },
          hovertemplate: 'Q: %{x:.2f} m³/h<br>H: %{y:.3f} m<extra>動作点</extra>',
        })
      }
      return out
    }

    if (!chartData) return []
    const segs: Record<string, { x: number[]; y: number[] }> = {
      laminar: { x: [], y: [] }, transitional: { x: [], y: [] }, turbulent: { x: [], y: [] },
    }
    chartData.flow_rates.forEach((q, i) => {
      const r = chartData.regimes[i]
      if (segs[r]) { segs[r].x.push(q); segs[r].y.push(kpaToUnit(chartData.pressure_drops[i] / 1000, pressureUnit, rho)) }
    })
    const out: object[] = Object.entries(segs)
      .filter(([, s]) => s.x.length > 0)
      .map(([regime, s]) => ({
        x: s.x, y: s.y,
        type: 'scatter', mode: 'lines',
        name: REGIME_LABEL[regime] ?? regime,
        line: { color: REGIME_COLOR[regime], width: 2.5 },
        hovertemplate: `Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} ${pressureUnit}<extra></extra>`,
      }))
    // Operating point marker (from network calc result)
    if (d?.result) {
      out.push({
        x: [d.result.Q_m3h], y: [kpaToUnit(d.result.dP_kpa, pressureUnit, rho)],
        type: 'scatter', mode: 'markers',
        name: '動作点',
        marker: { color: '#7c3aed', size: 12, symbol: 'circle', line: { color: '#fff', width: 2 } },
        hovertemplate: `Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} ${pressureUnit}<extra>動作点</extra>`,
      })
    }
    return out
  }, [chartData, d, isPump, pressureUnit, rho])

  if (!node || (!isPipe && !isPump)) {
    return (
      <div className="flex items-center justify-center h-48">
        <p className="text-sm text-gray-300">パイプまたはポンプを選択すると特性曲線を表示します</p>
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
      {(chartData || isPump) && !fetching && (
        <Plot
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data={traces as any}
          layout={{
            title: { text: isPump ? '流量–揚程特性（PQ）' : '流量–圧損特性（Darcy-Weisbach）', font: { size: 13 } },
            xaxis: { title: { text: '流量 Q [m³/h]' }, showgrid: true, gridcolor: '#f1f5f9', zeroline: false },
            yaxis: { title: { text: isPump ? '揚程 H [m]' : `ΔP [${pressureUnit}]` }, showgrid: true, gridcolor: '#f1f5f9', zeroline: false },
            annotations: pumpQMax !== null ? [{
              x: pumpQMax,
              y: 0,
              ax: 0,
              ay: -90,
              text: `Qmax:<br>${pumpQMax.toFixed(1)} m³/h`,
              showarrow: true,
              arrowhead: 2,
              bordercolor: '#64748b',
              borderwidth: 1,
              bgcolor: '#ffffff',
              font: { size: 13, color: '#0f172a' },
            }] : [],
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

// ── System results: all-component summary table with run history ──
// Reuses each component's own 結果表示 row generator (pipeResultRows /
// pumpResultRows / teeResultRows / boundaryResultRows) so the item list
// shown here always matches the per-node ResultsPanel exactly.

type CalcRunNode = { id: string; data: NetworkNodeData }
type CalcRun = { id: string; timestamp: number; nodes: CalcRunNode[] }

type SystemComponent = {
  id: string
  label: string
  typeLabel: string
  rows: ResultRow[]  // schema (item/symbol/unit) from the most recent run that has data
}

function buildSystemComponents(runHistory: CalcRun[], pressureUnit: PressureUnit, rho: number): SystemComponent[] {
  const byId = new Map<string, SystemComponent>()
  const order: string[] = []
  for (const run of runHistory) {
    for (const n of run.nodes) {
      const rows = componentResultRows(n.data, pressureUnit, rho)
      if (!rows) continue
      if (!byId.has(n.id)) order.push(n.id)
      byId.set(n.id, { id: n.id, label: n.data.label, typeLabel: componentTypeLabel(n.data.nodeType), rows })
    }
  }
  return order.map(id => byId.get(id)!)
}

function SystemResultsTable({ components, runHistory, pressureUnit, rho }: {
  components: SystemComponent[]
  runHistory: CalcRun[]
  pressureUnit: PressureUnit
  rho: number
}) {
  const cellValue = (run: CalcRun, componentId: string, symbol: string): string => {
    const nodeData = run.nodes.find(n => n.id === componentId)?.data
    const rows = nodeData ? componentResultRows(nodeData, pressureUnit, rho) : null
    const row = rows?.find(r => r.symbol === symbol)
    return row ? row.value : '—'
  }

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-xs text-gray-400 border-b border-gray-200">
          <th className="text-left font-medium py-2 pr-3">部品</th>
          <th className="text-left font-medium py-2 pr-3">種別</th>
          <th className="text-left font-medium py-2 pr-3">項目</th>
          <th className="text-left font-medium py-2 pr-3">単位</th>
          {runHistory.map((run, i) => (
            <th key={run.id} className="text-right font-medium py-2 pr-3 whitespace-nowrap">
              実行{i + 1}
              <div className="text-[10px] text-gray-300 font-normal">{new Date(run.timestamp).toLocaleTimeString('ja-JP')}</div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {components.map(comp => comp.rows.map((row, ri) => (
          <tr key={`${comp.id}-${row.symbol}`} className="border-b border-gray-100">
            {ri === 0 && (
              <td rowSpan={comp.rows.length} className="py-1.5 pr-3 text-gray-700 font-medium align-top whitespace-nowrap">
                {comp.label}
              </td>
            )}
            {ri === 0 && (
              <td rowSpan={comp.rows.length} className="py-1.5 pr-3 text-gray-500 align-top whitespace-nowrap">
                {comp.typeLabel}
              </td>
            )}
            <td className="py-1.5 pr-3 text-gray-600 whitespace-nowrap">{row.item}</td>
            <td className="py-1.5 pr-3 text-gray-400 whitespace-nowrap">{row.unit}</td>
            {runHistory.map(run => (
              <td
                key={run.id}
                className={`py-1.5 pr-3 text-right tabular-nums whitespace-nowrap ${row.highlight ? 'font-semibold text-gray-800' : 'text-gray-700'}`}
              >
                {cellValue(run, comp.id, row.symbol)}
              </td>
            ))}
          </tr>
        )))}
      </tbody>
    </table>
  )
}

// ── Inner component ────────────────────────────────────────────────

function PipeNetworkCalcInner() {
  const [defaultDiagram] = useState(() => createDefaultDiagram())
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(defaultDiagram.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(defaultDiagram.edges)
  const { screenToFlowPosition } = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()
  const nodeCounter = useRef(DEFAULT_NODE_COUNTER)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showPressureResults, setShowPressureResults] = useState(false)
  const [showLineResults, setShowLineResults] = useState(false)
  const [pressureUnit, setPressureUnit] = useState<PressureUnit>('kPa')
  const selectedNode: Node | null = nodes.find(n => n.id === selectedId) ?? null
  const selectedData = selectedNode?.data as unknown as NetworkNodeData | undefined

  const [density,   setDensity]   = useState('1000')
  const [viscosity, setViscosity] = useState('1.0')
  const rho = parseFloat(density) || 1000

  const displayNodes = useMemo(() => {
    const inConnected = new Set(edges.map(e => e.target))
    const outConnected = new Set(edges.map(e => e.source))
    return nodes.map(n => ({
      ...n,
      data: {
        ...n.data,
        portLeftConnected: inConnected.has(n.id),
        portRightConnected: outConnected.has(n.id),
        portInConnected: inConnected.has(n.id),
        portOutConnected: outConnected.has(n.id),
        showPressureResults,
        pressureUnit,
        rho,
      },
    }))
  }, [nodes, edges, showPressureResults, pressureUnit, rho])
  const displayEdges = useMemo(() => edges.map(e => ({
    ...e,
    data: {
      ...((e.data as Record<string, unknown> | undefined) ?? {}),
      labelVisible: showLineResults,
    },
  })), [edges, showLineResults])

  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [totalDp,   setTotalDp]   = useState<number | null>(null)
  const [runHistory, setRunHistory] = useState<CalcRun[]>([])
  const systemComponents = useMemo(
    () => buildSystemComponents(runHistory, pressureUnit, rho),
    [runHistory, pressureUnit, rho],
  )
  const clearRunHistory = () => setRunHistory([])

  const clearSketch = () => {
    if (!window.confirm('ダイアグラムをすべて削除します。よろしいですか？')) return
    setNodes([])
    setEdges([])
    setSelectedId(null)
    setTotalDp(null)
    setError(null)
    setRunHistory([])
  }

  // CoolProp auto-fill
  const [coolFluid,   setCoolFluid]   = useState('Water')
  const [coolT,       setCoolT]       = useState('293.15')
  const [coolP,       setCoolP]       = useState('101.325')
  const [coolLoading, setCoolLoading] = useState(false)
  const [coolError,   setCoolError]   = useState<string | null>(null)

  useEffect(() => {
    nodes.forEach(n => updateNodeInternals(n.id))
  }, [nodes, updateNodeInternals])

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
      type: 'flow',
      style: { stroke: '#94a3b8', strokeWidth: 2 },
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

  const flipSelectedNode = useCallback(() => {
    if (!selectedId) return
    setNodes(prev => prev.map(n => {
      if (n.id !== selectedId) return n
      const d = n.data as unknown as NetworkNodeData
      return { ...n, data: { ...d, flipped: !d.flipped } as NetworkNodeData }
    }))
  }, [selectedId, setNodes])

  const rotateSelectedNode = useCallback(() => {
    if (!selectedId) return
    setNodes(prev => prev.map(n => {
      if (n.id !== selectedId) return n
      const d = n.data as unknown as NetworkNodeData
      return { ...n, data: { ...d, rotation: ((((d.rotation ?? 0) + 90) % 360) as NodeRotation) } as NetworkNodeData }
    }))
  }, [selectedId, setNodes])

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

      const mergeResult = (d: NetworkNodeData, id: string): NetworkNodeData => {
        const nodeResult  = res.nodes[id]
        const srcPressure = res.source_pressures[id]
        const srcFlow     = res.source_flows[id]
        return {
          ...d,
          ...(nodeResult  !== undefined ? { result: nodeResult }        : {}),
          ...(srcPressure !== undefined ? { calcPressure: srcPressure } : {}),
          ...(srcFlow     !== undefined ? { calcFlow: srcFlow }         : {}),
        } as NetworkNodeData
      }

      setNodes(prev => prev.map(n => ({
        ...n,
        data: mergeResult(n.data as unknown as NetworkNodeData, n.id),
      })))

      const snapshotNodes: CalcRunNode[] = nodes.map(n => ({
        id: n.id,
        data: mergeResult(n.data as unknown as NetworkNodeData, n.id),
      }))
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setRunHistory(prev => [...prev, { id: runId, timestamp: Date.now(), nodes: snapshotNodes }])

      const nodeById = new Map(nodes.map(n => [n.id, n]))
      const nodeLabel = (id: string) => {
        const data = nodeById.get(id)?.data as unknown as NetworkNodeData | undefined
        return data?.label ?? id
      }
      const makeFlowLabel = (edge: Edge): string | undefined => {
        const sourceData = nodeById.get(edge.source)?.data as unknown as NetworkNodeData | undefined
        const targetData = nodeById.get(edge.target)?.data as unknown as NetworkNodeData | undefined
        const elementId =
          sourceData?.nodeType === 'pipe' || sourceData?.nodeType === 'pump' ? edge.source
          : targetData?.nodeType === 'pipe' || targetData?.nodeType === 'pump' ? edge.target
          : null
        if (!elementId) return undefined

        const result = res.nodes[elementId]
        if (!result || Math.abs(result.Q_m3h) < 1e-9) return undefined

        const followsDrawnDirection = result.Q_m3h >= 0
        const fromId = followsDrawnDirection ? edge.source : edge.target
        const toId = followsDrawnDirection ? edge.target : edge.source
        return `${Math.abs(result.Q_m3h).toFixed(2)} m³/h（${nodeLabel(fromId)}→${nodeLabel(toId)}）`
      }

      setEdges(prev => prev.map(e => ({
        ...e,
        type: 'flow',
        markerEnd: undefined,
        data: { ...((e.data as Record<string, unknown> | undefined) ?? {}), flowLabel: makeFlowLabel(e), labelVisible: showLineResults },
      })))

      const total = Object.values(res.nodes).reduce((s, r) => s + Math.max(r?.dP_kpa ?? 0, 0), 0)
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
      <div className="sticky top-0 z-20 bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4 flex flex-col gap-3">
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

          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              checked={showPressureResults}
              onChange={e => setShowPressureResults(e.target.checked)}
              className="h-4 w-4 accent-blue-600"
            />
            圧力表示
          </label>

          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              checked={showLineResults}
              onChange={e => setShowLineResults(e.target.checked)}
              className="h-4 w-4 accent-blue-600"
            />
            流量表示
          </label>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-sm text-gray-600">圧力単位</span>
            <select
              value={pressureUnit}
              onChange={e => setPressureUnit(e.target.value as PressureUnit)}
              className="border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PRESSURE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>

          <div className="w-px h-5 bg-gray-200 shrink-0" />

          <button
            onClick={handleCalc}
            disabled={loading || nodes.length === 0}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-5 py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {loading ? '計算中...' : '計算開始'}
          </button>

          <button
            onClick={clearSketch}
            disabled={nodes.length === 0 && edges.length === 0}
            className="border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm px-4 py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            スケッチをクリア
          </button>
          {error && <span className="text-sm text-red-500">{error}</span>}

          {totalDp !== null && (
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <span className="text-sm text-gray-500">合計 ΔP:</span>
              <span className="text-xl font-bold text-red-600 tabular-nums">{formatPressure(totalDp, pressureUnit, rho)}</span>
              <span className="text-sm text-gray-500">{pressureUnit}</span>
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
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              onPaneClick={() => setSelectedId(null)}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              deleteKeyCode={['Delete', 'Backspace']}
              fitView
            >
              <NodeToolbar
                nodeId={selectedId ?? undefined}
                isVisible={!!selectedId}
                position={Position.Top}
                align="end"
                offset={12}
                className="nodrag nopan"
              >
                <div className="flex items-center gap-2 rounded-md border border-slate-300 bg-white/95 px-2 py-2 shadow-lg">
                  <button
                    type="button"
                    title="左右反転"
                    onClick={flipSelectedNode}
                    className={`h-9 w-9 rounded border flex items-center justify-center transition-colors ${selectedData?.flipped ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-slate-300 bg-slate-50 text-blue-600 hover:bg-blue-50'}`}
                  >
                    <SvgFlip className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    title="90度回転"
                    onClick={rotateSelectedNode}
                    className="h-9 w-9 rounded border border-slate-300 bg-slate-50 text-blue-600 hover:bg-blue-50 flex items-center justify-center transition-colors"
                  >
                    <SvgRotate className="w-5 h-5" />
                  </button>
                </div>
              </NodeToolbar>
              <Background color="#e2e8f0" gap={20} />
              <Controls />
              <MiniMap nodeStrokeWidth={2} zoomable pannable />
            </ReactFlow>
          </div>
        </div>
      </div>

      {/* ── Section 3: パラメータ設定 + 結果表示 + 分析表示 ──── */}
      <div className="flex gap-5 items-start">

        {/* パラメータ設定 + 結果表示 */}
        <div className="w-72 shrink-0 flex flex-col gap-5">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
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

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <h3 className="text-sm font-semibold text-gray-600 mb-4 pb-3 border-b border-gray-100">
              結果表示
            </h3>
            <ResultsPanel node={selectedNode} pressureUnit={pressureUnit} rho={rho} />
          </div>
        </div>

        {/* コンポーネント特性 */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm p-5 min-h-[360px]">
          <h3 className="text-sm font-semibold text-gray-600 mb-4 pb-3 border-b border-gray-100">
            コンポーネント特性
          </h3>
          <AnalysisPanel
            node={selectedNode}
            density={density}
            viscosity={viscosity}
            pressureUnit={pressureUnit}
            rho={rho}
          />
        </div>

      </div>

      {/* ── Section 4: システム結果一覧 ─────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4 pb-3 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-600">システム結果一覧</h3>
          {runHistory.length > 0 && (
            <button
              type="button"
              onClick={clearRunHistory}
              className="px-3 py-1.5 rounded-md text-xs font-medium border border-rose-200 bg-white text-rose-600 hover:bg-rose-50"
            >
              結果をクリア
            </button>
          )}
        </div>

        {runHistory.length > 0 ? (
          <div className="overflow-x-auto">
            <SystemResultsTable components={systemComponents} runHistory={runHistory} pressureUnit={pressureUnit} rho={rho} />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-32 text-center gap-2">
            <p className="text-sm text-gray-400">「計算開始」を実行すると<br />全コンポーネントの結果一覧がここに表示されます</p>
          </div>
        )}
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
