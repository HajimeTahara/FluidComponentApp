'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  NodeResizer,
  BaseEdge,
  addEdge,
  useReactFlow,
  useUpdateNodeInternals,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  fetchFluidLibrary,
  fetchMaterials,
  simulateTransientNetwork,
  type FluidLibraryEntry,
  type Material,
  type PipeNetworkEdgePayload,
  type PipeNetworkFluidSystemPayload,
  type PipeNetworkNodePayload,
  type TransientNetworkResult,
} from '@/app/lib/api'

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false })

type TransientNodeKind = 'fluid' | 'solid' | 'constantSignal' | 'fixedRotation' | 'fixedTorque' | 'fixedTemperature' | 'thermalMass' | 'heatBoundary' | 'pressureBoundary' | 'flowBoundary' | 'boundary' | 'volume' | 'tank' | 'resistor' | 'pipe' | 'pump' | 'heatExchanger' | 'reducer' | 'elbow' | 'valve' | 'turbine'

type TransientNodeData = {
  nodeType: TransientNodeKind | string
  label: string
  boundaryType?: 'pressure' | 'flow'
  pressure?: number
  flowRate?: number
  initialLevel?: number
  tankArea?: number
  maxLevel?: number
  portCount?: number
  resistance?: number
  pipeShape?: 'circular' | 'rectangular'
  diameter?: number
  width?: number
  ductHeight?: number
  length?: number
  roughness?: number
  heatEnabled?: boolean
  initialTemperature?: number
  heatTransferCoeff?: number
  outerHeatTransferCoeff?: number
  innerHeatTransferCoeff?: number
  heatArea?: number
  wallThickness?: number
  density?: number
  viscosity?: number
  specificHeat?: number
  thermalConductivity?: number
  temperature?: number
  propertyMode?: 'constantDensity' | 'state'
  coolPropFluid?: string
  fluidLibraryId?: number
  fluidRef?: string
  fluidSystemId?: string
  signalValue?: number
  heatTemperature?: number
  heatFlow?: number
  solidRef?: string
  materialId?: number
  mass?: number
  heatCapacity?: number
  ratedFlow?: number
  ratedHead?: number
  shutoffHead?: number
  ratedSpeed?: number
  speed?: number
  driveExternal?: boolean
  driveMode?: 'speed' | 'torque'
  fixedSpeed?: number
  fixedTorque?: number
  driveTorque?: number
  efficiency?: number
  pumpCurveMode?: 'simple' | 'table'
  pumpCurvePoints?: { q: number; h: number }[]
  valveOpening?: number
  valveCv?: number
  valveCharacteristic?: 'linear' | 'equalPercentage' | 'quickOpening'
  valveRangeability?: number
  externalInput?: boolean
  [key: string]: unknown
}

export type TransientNetworkSeed = {
  nodes: PipeNetworkNodePayload[]
  edges: PipeNetworkEdgePayload[]
  fluidSystems: PipeNetworkFluidSystemPayload[]
  density: number
  viscosity: number
}

type Props = {
  seed?: TransientNetworkSeed | null
}

type ResultSeriesSource =
  | { kind: 'time'; label: string; unit: string }
  | { kind: 'node'; nodeId: string; seriesKey: 'pressure_kpa' | 'flow_m3h' | 'level_m' | 'velocity_mps' | 'reynolds' | 'pressure_loss_kpa' | 'boost_kpa' | 'head_m' | 'shaft_power_kw' | 'speed_rpm' | 'shaft_torque_nm' | 'temperature_k' | 'wall_temperature_k' | 'heat_transfer_w' | 'heat_transfer_coefficient_w_m2k'; label: string; unit: string }
  | { kind: 'port'; nodeId: string; portId: string; seriesKey: 'pressure_kpa' | 'flow_m3h'; label: string; unit: string }

type ResultRow = {
  item: string
  unit: string
  value: string
  source: ResultSeriesSource
}

type InsertedGraph = {
  id: string
  title: string
  mode: 'time' | 'xy'
  xSource: ResultSeriesSource | null
  ySources: ResultSeriesSource[]
}

type SavedTransientSketch = {
  version: 1
  name: string
  savedAt: string
  transient: {
    duration: number
    dt: number
    nodes: Node<TransientNodeData>[]
    edges: Edge[]
    graphs: InsertedGraph[]
  }
}

const DEFAULT_FLUID_NODE_ID = 'fluid-1'
const DEFAULT_SOLID_NODE_ID = 'solid-1'
const DEFAULT_NODE_STYLE = { width: 96, height: 86 }
const DEFAULT_EDGE_TYPE = 'orthogonal'
const DEFAULT_SOLID_SPECIFIC_HEAT = 500
const COOLPROP_FLUIDS = [
  'Methane',
  'Nitrogen',
  'Oxygen',
  'Hydrogen',
  'CarbonDioxide',
  'Propane',
  'Water',
  'Ammonia',
  'R134a',
  'Ethane',
]
const PALETTE_GROUPS: {
  id: string
  label: string
  items: readonly [TransientNodeKind, string][]
}[] = [
  {
    id: 'flow',
    label: '流体',
    items: [
      ['tank', 'タンク'],
      ['pipe', '配管'],
      ['pump', 'ポンプ'],
      ['valve', 'バルブ'],
    ],
  },
  {
    id: 'boundary',
    label: '境界',
    items: [
      ['pressureBoundary', '圧力境界'],
      ['flowBoundary', '流量境界'],
    ],
  },
  {
    id: 'material',
    label: '物性',
    items: [
      ['fluid', '流体'],
      ['solid', '固体'],
    ],
  },
  {
    id: 'thermal',
    label: '熱',
    items: [
      ['fixedTemperature', '固定温度'],
      ['thermalMass', '熱質量'],
    ],
  },
  {
    id: 'control',
    label: '制御',
    items: [
      ['constantSignal', '一定値'],
      ['fixedRotation', '固定回転'],
      ['fixedTorque', '固定トルク'],
    ],
  },
]

const DEFAULT_FLUID_DATA: TransientNodeData = {
  nodeType: 'fluid',
  label: '水',
  density: 1000,
  viscosity: 0.001,
  specificHeat: 4184,
  thermalConductivity: 0.6,
  propertyMode: 'constantDensity',
  coolPropFluid: 'Water',
  fluidLibraryId: undefined,
}

const DEFAULT_SOLID_DATA: TransientNodeData = {
  nodeType: 'solid',
  label: '固体',
  materialId: undefined,
  density: 7800,
  specificHeat: DEFAULT_SOLID_SPECIFIC_HEAT,
  thermalConductivity: 16,
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function lastNumber(values?: number[]): number | null {
  if (!values || values.length === 0) return null
  const value = values[values.length - 1]
  return Number.isFinite(value) ? value : null
}

function formatResultValue(value: number | null, digits = 3): string {
  return value === null ? '-' : value.toFixed(digits)
}

function normalizePumpCurvePoints(value: unknown): { q: number; h: number }[] {
  if (!Array.isArray(value)) return []
  return value
    .map(point => {
      if (!point || typeof point !== 'object') return null
      const raw = point as Record<string, unknown>
      return { q: toNumber(raw.q ?? raw.flow, 0), h: toNumber(raw.h ?? raw.head, 0) }
    })
    .filter((point): point is { q: number; h: number } => point !== null)
}

function normalizeKind(kind: string): TransientNodeKind | string {
  if (kind === 'source' || kind === 'sink') return 'boundary'
  return kind
}

function boundaryKind(params: Record<string, unknown>, fallback: string): TransientNodeKind | string {
  if (fallback !== 'boundary') return fallback
  return params.boundaryType === 'flow' || params.sourceType === 'flow' || params.sinkType === 'flow'
    ? 'flowBoundary'
    : 'pressureBoundary'
}

function payloadNodeType(kind: string): string {
  if (kind === 'fluid') return 'fluid'
  if (kind === 'solid') return 'solid'
  if (kind === 'constantSignal') return 'constantSignal'
  if (kind === 'fixedRotation') return 'fixedRotation'
  if (kind === 'fixedTorque') return 'fixedTorque'
  if (kind === 'fixedTemperature') return 'fixedTemperature'
  if (kind === 'thermalMass') return 'thermalMass'
  if (kind === 'heatBoundary') return 'heatBoundary'
  if (kind === 'pressureBoundary' || kind === 'flowBoundary') return 'boundary'
  if (kind === 'elbow' || kind === 'reducer' || kind === 'heatExchanger') return 'resistor'
  return kind
}

function payloadBoundaryType(kind: string, data: TransientNodeData): 'pressure' | 'flow' | undefined {
  if (kind === 'pressureBoundary') return 'pressure'
  if (kind === 'flowBoundary') return 'flow'
  return data.boundaryType
}

function isOnePortKind(kind: string): boolean {
  return kind === 'pressureBoundary' || kind === 'flowBoundary' || kind === 'boundary' || kind === 'volume'
}

function isTwoPortKind(kind: string): boolean {
  return kind !== 'fluid' && kind !== 'solid' && kind !== 'constantSignal' && kind !== 'fixedRotation' && kind !== 'fixedTorque' && kind !== 'fixedTemperature' && kind !== 'thermalMass' && kind !== 'heatBoundary' && kind !== 'tank' && !isOnePortKind(kind)
}

function tankPortIds(data: TransientNodeData): string[] {
  const count = Math.max(1, Math.floor(toNumber(data.portCount, 1)))
  return Array.from({ length: count }, (_, index) => `port${index + 1}`)
}

function nodePorts(data: TransientNodeData): string[] {
  const kind = String(data.nodeType)
  if (kind === 'fluid' || kind === 'solid' || kind === 'constantSignal' || kind === 'fixedRotation' || kind === 'fixedTorque' || kind === 'fixedTemperature' || kind === 'thermalMass' || kind === 'heatBoundary') return []
  if (kind === 'tank') return tankPortIds(data)
  if (isTwoPortKind(kind)) return ['a', 'b']
  return ['port']
}

function needsFluidReference(kind: string): boolean {
  return kind !== 'fluid'
    && kind !== 'solid'
    && kind !== 'constantSignal'
    && kind !== 'fixedRotation'
    && kind !== 'fixedTorque'
    && kind !== 'fixedTemperature'
    && kind !== 'thermalMass'
    && kind !== 'heatBoundary'
}

function physicalHandleId(node: Node<TransientNodeData> | undefined, handleId: string | null | undefined, outgoing: boolean): string {
  if (!node) return handleId ?? ''
  const kind = String(node.data.nodeType)
  if (kind === 'constantSignal') return 'signalOut'
  if (kind === 'fixedRotation' || kind === 'fixedTorque') return 'rotationOut'
  if (kind === 'fixedTemperature') return 'heatOut'
  if (kind === 'thermalMass') return 'heatPort'
  if (kind === 'heatBoundary') return 'heatOut'
  if ((kind === 'pipe' || kind === 'tank') && handleId === 'heatIn') return 'heatIn'
  if (kind === 'pump' && handleId === 'rotationIn') return 'rotationIn'
  if ((kind === 'pressureBoundary' || kind === 'flowBoundary') && handleId === 'signalIn') return 'signalIn'
  if (kind === 'tank') {
    const ports = tankPortIds(node.data)
    return ports.includes(String(handleId)) ? String(handleId) : ports[0]
  }
  if (isTwoPortKind(kind)) {
    if (handleId === 'a' || handleId === 'b') return handleId
    if (handleId === 'in' || handleId === 'left') return 'a'
    if (handleId === 'out' || handleId === 'right') return 'b'
    return outgoing ? 'b' : 'a'
  }
  if (kind === 'fluid') return ''
  return 'port'
}

function OrthogonalEdge({
  id,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
}: EdgeProps) {
  const stub = 18
  const offsetPoint = (x: number, y: number, position: Position) => {
    if (position === Position.Left) return { x: x - stub, y }
    if (position === Position.Right) return { x: x + stub, y }
    if (position === Position.Top) return { x, y: y - stub }
    return { x, y: y + stub }
  }
  const sourceStub = offsetPoint(sourceX, sourceY, sourcePosition)
  const targetStub = offsetPoint(targetX, targetY, targetPosition)
  const sourceHorizontal = sourcePosition === Position.Left || sourcePosition === Position.Right
  const targetHorizontal = targetPosition === Position.Left || targetPosition === Position.Right
  const path = sourceHorizontal || targetHorizontal
    ? `M ${sourceX} ${sourceY} L ${sourceStub.x} ${sourceStub.y} H ${(sourceStub.x + targetStub.x) / 2} V ${targetStub.y} H ${targetStub.x} L ${targetX} ${targetY}`
    : `M ${sourceX} ${sourceY} L ${sourceStub.x} ${sourceStub.y} V ${(sourceStub.y + targetStub.y) / 2} H ${targetStub.x} V ${targetStub.y} L ${targetX} ${targetY}`

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke: (data as { lineType?: string } | undefined)?.lineType === 'signal'
          ? '#10b981'
          : (data as { lineType?: string } | undefined)?.lineType === 'heat'
            ? '#ef4444'
            : (data as { lineType?: string } | undefined)?.lineType === 'rotational'
              ? '#f59e0b'
              : '#0ea5e9',
        strokeWidth: 2.5,
        ...style,
      }}
    />
  )
}

function TransientNodeIcon({ kind }: { kind: string }) {
  if (kind === 'solid') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <path d="M12 17l12-7 12 7v14l-12 7-12-7z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M12 17l12 7 12-7M24 24v14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'thermalMass') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <rect x="13" y="12" width="22" height="24" rx="3" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M18 30h12M18 24h12M18 18h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'fixedTemperature' || kind === 'heatBoundary') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <path d="M21 8v18a8 8 0 1 0 6 0V8a3 3 0 0 0-6 0z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M24 30v-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M33 14h7M33 20h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'constantSignal') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <path d="M8 30h8l4-12 7 20 5-16h8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 10h28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'fixedRotation' || kind === 'fixedTorque') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <circle cx="24" cy="24" r="12" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M24 12a12 12 0 0 1 10 5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M35 12v7h-7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {kind === 'fixedTorque' ? (
          <path d="M24 24l8 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        ) : (
          <path d="M18 30h12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        )}
      </svg>
    )
  }
  if (kind === 'fluid') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <path d="M24 7c7 8 12 14 12 22a12 12 0 0 1-24 0C12 21 17 15 24 7z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M17 30c4 3 10 3 14 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'pressureBoundary') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <path d="M10 24h28" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M30 15l8 9-8 9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d="M12 34h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'flowBoundary') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <path d="M9 24h30" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M19 14l10 10-10 10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d="M12 15c8 0 16 18 24 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'volume') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <rect x="13" y="10" width="22" height="28" rx="3" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M16 28h16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M19 18h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'tank') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <path d="M13 12h22v26H13z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M16 27c4-3 8 3 12 0s6-1 8 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M13 18h22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'pipe') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <path d="M7 24h34" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
        <path d="M7 24h34" stroke="white" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'pump') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <circle cx="24" cy="24" r="12" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M18 30l13-13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M30 17v9h-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'valve') {
    return (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
        <path d="M8 24h10M30 24h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M18 15v18l12-9z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M30 15v18l-12-9z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M24 15V9M18 9h12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden="true">
      <path d="M8 24h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M30 24h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M18 15h12l4 9-4 9H18l-4-9 4-9z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  )
}

function TransientDiagramNode({ data, selected }: NodeProps<Node<TransientNodeData>>) {
  const kind = String(data.nodeType)
  const isControlConstant = kind === 'constantSignal'
  const isRotationalSource = kind === 'fixedRotation' || kind === 'fixedTorque'
  const isHeatBoundary = kind === 'fixedTemperature' || kind === 'heatBoundary'
  const isThermalMass = kind === 'thermalMass'
  const hasPorts = kind !== 'fluid' && kind !== 'solid'
  const hasTwoPorts = isTwoPortKind(kind)
  const isTank = kind === 'tank'
  const hasSignalInput = (kind === 'pressureBoundary' || kind === 'flowBoundary') && data.externalInput === true
  const hasHeatInput = (kind === 'pipe' || kind === 'tank') && data.heatEnabled === true
  const hasRotationInput = kind === 'pump' && data.driveExternal === true
  const tankPorts = isTank ? tankPortIds(data) : []
  const portClass = '!h-3.5 !w-3.5 !border-2 !border-blue-400 !bg-blue-400'
  const hiddenPortClass = '!h-3.5 !w-3.5 !border-0 !bg-transparent'
  return (
    <div className="relative flex h-full w-full min-w-[72px] min-h-[72px] flex-col items-center gap-1 text-blue-700">
      <NodeResizer isVisible={selected} minWidth={72} minHeight={72} lineClassName="!border-blue-400" handleClassName="!h-2 !w-2 !border-blue-400 !bg-white" />
      <div className="max-w-full truncate px-1 text-center text-xs font-semibold leading-4">{data.label}</div>
      <div className="relative flex min-h-0 w-full flex-1 items-center justify-center rounded-md border-2 border-blue-400 bg-blue-50 shadow-sm">
        {hasTwoPorts && (
          <>
            <span className="pointer-events-none absolute -left-1 top-0 -translate-y-full text-[11px] font-semibold leading-none text-blue-700">a</span>
            <span className="pointer-events-none absolute -right-1 top-0 -translate-y-full text-[11px] font-semibold leading-none text-blue-700">b</span>
            <svg className="pointer-events-none absolute -left-7 top-1/2 h-3 w-6 -translate-y-1/2 text-blue-500" viewBox="0 0 24 12" aria-hidden="true">
              <path d="M2 6h16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              <path d="M14 2l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <svg className="pointer-events-none absolute -right-7 top-1/2 h-3 w-6 -translate-y-1/2 text-blue-500" viewBox="0 0 24 12" aria-hidden="true">
              <path d="M2 6h16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              <path d="M14 2l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </>
        )}
        {hasTwoPorts && <Handle type="target" id="a" position={Position.Left} className={portClass} />}
        {hasHeatInput && (
          <>
            <span className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full text-[10px] font-semibold leading-none text-red-600">heat</span>
            <Handle type="target" id="heatIn" position={Position.Top} className="!h-3.5 !w-3.5 !border-2 !border-red-500 !bg-red-500" />
          </>
        )}
        {hasRotationInput && (
          <>
            <span className="pointer-events-none absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-full text-[10px] font-semibold leading-none text-amber-600">rot</span>
            <Handle type="target" id="rotationIn" position={Position.Bottom} className="!h-3.5 !w-3.5 !border-2 !border-amber-500 !bg-amber-500" />
          </>
        )}
        <TransientNodeIcon kind={kind} />
        {hasTwoPorts && <Handle type="source" id="b" position={Position.Right} className={portClass} />}
        {isControlConstant && <Handle type="source" id="signalOut" position={Position.Right} className="!h-3.5 !w-3.5 !border-2 !border-emerald-500 !bg-emerald-500" />}
        {isRotationalSource && <Handle type="source" id="rotationOut" position={Position.Right} className="!h-3.5 !w-3.5 !border-2 !border-amber-500 !bg-amber-500" />}
        {isHeatBoundary && <Handle type="source" id="heatOut" position={Position.Right} className="!h-3.5 !w-3.5 !border-2 !border-red-500 !bg-red-500" />}
        {isThermalMass && (
          <>
            <Handle type="target" id="heatPort" position={Position.Right} className="!h-3.5 !w-3.5 !border-2 !border-red-500 !bg-red-500" />
            <Handle type="source" id="heatPort" position={Position.Right} className="!h-3.5 !w-3.5 !border-2 !border-red-500 !bg-red-500" />
          </>
        )}
        {hasSignalInput && <Handle type="target" id="signalIn" position={Position.Left} className="!h-3.5 !w-3.5 !border-2 !border-emerald-500 !bg-emerald-500" />}
        {!hasTwoPorts && !isTank && hasPorts && !isControlConstant && !isRotationalSource && !isHeatBoundary && !isThermalMass && (
          <>
            <Handle type="target" id="port" position={Position.Bottom} className={hiddenPortClass} />
            <Handle type="source" id="port" position={Position.Bottom} className={portClass} />
          </>
        )}
      </div>
      {isTank && tankPorts.map((portId, index) => {
        const left = `${((index + 1) / (tankPorts.length + 1)) * 100}%`
        return (
          <div key={portId}>
            <span
              className="pointer-events-none absolute bottom-0 translate-y-full text-[10px] font-semibold leading-none text-blue-700"
              style={{ left, transform: 'translate(-50%, 100%)' }}
            >
              {portId}
            </span>
            <Handle type="target" id={portId} position={Position.Bottom} className={hiddenPortClass} style={{ left }} />
            <Handle type="source" id={portId} position={Position.Bottom} className={portClass} style={{ left }} />
          </div>
        )
      })}
    </div>
  )
}

const nodeTypes = { transientNode: TransientDiagramNode }
const edgeTypes = { [DEFAULT_EDGE_TYPE]: OrthogonalEdge }

function defaultNodes(): Node<TransientNodeData>[] {
  return [
    {
      id: DEFAULT_FLUID_NODE_ID,
      type: 'transientNode',
      position: { x: 120, y: 70 },
      style: DEFAULT_NODE_STYLE,
      data: { ...DEFAULT_FLUID_DATA },
    },
    {
      id: DEFAULT_SOLID_NODE_ID,
      type: 'transientNode',
      position: { x: 250, y: 70 },
      style: DEFAULT_NODE_STYLE,
      data: { ...DEFAULT_SOLID_DATA },
    },
    {
      id: 'tank-1',
      type: 'transientNode',
      position: { x: 120, y: 180 },
      style: DEFAULT_NODE_STYLE,
      data: { nodeType: 'tank', label: 'タンク1', initialLevel: 2, tankArea: 1, maxLevel: 3, portCount: 1, initialTemperature: 293.15, heatEnabled: false, solidRef: DEFAULT_SOLID_NODE_ID, wallThickness: 2, outerHeatTransferCoeff: 10, innerHeatTransferCoeff: 50, heatArea: 1, fluidRef: DEFAULT_FLUID_NODE_ID },
    },
    {
      id: 'pipe-1',
      type: 'transientNode',
      position: { x: 360, y: 180 },
      style: DEFAULT_NODE_STYLE,
      data: { nodeType: 'pipe', label: '配管', pipeShape: 'circular', diameter: 100, width: 100, ductHeight: 50, length: 10, roughness: 0.046, initialTemperature: 293.15, heatEnabled: false, fluidRef: DEFAULT_FLUID_NODE_ID },
    },
    {
      id: 'tank-2',
      type: 'transientNode',
      position: { x: 600, y: 180 },
      style: DEFAULT_NODE_STYLE,
      data: { nodeType: 'tank', label: 'タンク2', initialLevel: 0.5, tankArea: 1, maxLevel: 3, portCount: 1, initialTemperature: 293.15, heatEnabled: false, solidRef: DEFAULT_SOLID_NODE_ID, wallThickness: 2, outerHeatTransferCoeff: 10, innerHeatTransferCoeff: 50, heatArea: 1, fluidRef: DEFAULT_FLUID_NODE_ID },
    },
  ]
}

function defaultEdges(): Edge[] {
  return [
    { id: 'e-t1-pipe', type: DEFAULT_EDGE_TYPE, source: 'tank-1', target: 'pipe-1', sourceHandle: 'port1', targetHandle: 'a', data: { lineType: 'fluid' } },
    { id: 'e-pipe-t2', type: DEFAULT_EDGE_TYPE, source: 'pipe-1', target: 'tank-2', sourceHandle: 'b', targetHandle: 'port1', data: { lineType: 'fluid' } },
  ]
}

function InlineNumber({
  label,
  unit,
  value,
  onChange,
}: {
  label: string
  unit?: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-600">
      <span className="w-28 shrink-0">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={e => onChange(Number(e.target.value))}
        className="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {unit && <span className="text-xs text-gray-400">{unit}</span>}
    </label>
  )
}

function TransientNetworkCalcInner({ seed }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TransientNodeData>>(defaultNodes())
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(defaultEdges())
  const { screenToFlowPosition } = useReactFlow()
  const updateNodeInternals = useUpdateNodeInternals()
  const [duration, setDuration] = useState(20)
  const [dt, setDt] = useState(0.05)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [result, setResult] = useState<TransientNetworkResult | null>(null)
  const [graphs, setGraphs] = useState<InsertedGraph[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [calculationProgressTick, setCalculationProgressTick] = useState(0)
  const [activePaletteGroup, setActivePaletteGroup] = useState(PALETTE_GROUPS[0].id)
  const [activeToolbarTab, setActiveToolbarTab] = useState<'analysis' | 'file'>('analysis')
  const [fluidLibrary, setFluidLibrary] = useState<FluidLibraryEntry[]>([])
  const [materials, setMaterials] = useState<Material[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const seedVersionRef = useRef<TransientNetworkSeed | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchFluidLibrary()
      .then(entries => {
        if (!cancelled) setFluidLibrary(entries)
      })
      .catch(() => {
        if (!cancelled) setError('流体ライブラリの取得に失敗しました')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchMaterials()
      .then(entries => {
        if (!cancelled) setMaterials(entries)
      })
      .catch(() => {
        if (!cancelled) setError('材料DBの取得に失敗しました')
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!seed || seed === seedVersionRef.current) return
    seedVersionRef.current = seed
    const handle = window.setTimeout(() => {
      const fluidNode: Node<TransientNodeData> = {
        id: DEFAULT_FLUID_NODE_ID,
        type: 'transientNode',
        position: { x: 80, y: 40 },
        style: DEFAULT_NODE_STYLE,
        data: { ...DEFAULT_FLUID_DATA },
      }
      const solidNode: Node<TransientNodeData> = {
        id: DEFAULT_SOLID_NODE_ID,
        type: 'transientNode',
        position: { x: 200, y: 40 },
        style: DEFAULT_NODE_STYLE,
        data: { ...DEFAULT_SOLID_DATA },
      }
      const copiedNodes = seed.nodes.map((n, index) => {
        const params = n.params as Record<string, unknown>
        const position = params.position as { x?: number; y?: number } | undefined
        const kind = boundaryKind(params, normalizeKind(n.node_type))
        const needsFluid = needsFluidReference(String(kind))
        const isMaterialNode = kind === 'fluid' || kind === 'solid'
        return {
          id: n.id,
          type: 'transientNode',
          style: DEFAULT_NODE_STYLE,
          position: {
            x: toNumber(position?.x, 80 + index * 120),
            y: toNumber(position?.y, 120),
          },
          data: {
            ...params,
            nodeType: kind,
            label: String(params.label ?? n.id),
            boundaryType: kind === 'flowBoundary' ? 'flow' : kind === 'pressureBoundary' ? 'pressure' : undefined,
            pressure: toNumber(params.pressure, kind === 'pressureBoundary' ? 300 : 200),
            flowRate: toNumber(params.flowRate, 1),
            ratedFlow: toNumber(params.ratedFlow, 30),
            ratedHead: toNumber(params.ratedHead, 20),
            shutoffHead: toNumber(params.shutoffHead, 30),
            ratedSpeed: toNumber(params.ratedSpeed, 1450),
            speed: toNumber(params.speed, 1450),
            driveExternal: params.driveExternal === true,
            driveMode: params.driveMode === 'torque' ? 'torque' : 'speed',
            fixedSpeed: toNumber(params.fixedSpeed, 1450),
            fixedTorque: toNumber(params.fixedTorque, 10),
            driveTorque: toNumber(params.driveTorque, 10),
            efficiency: toNumber(params.efficiency, 70),
            pumpCurveMode: params.pumpCurveMode === 'table' ? 'table' : 'simple',
            pumpCurvePoints: normalizePumpCurvePoints(params.pumpCurvePoints),
            valveOpening: toNumber(params.valveOpening, 100),
            valveCv: toNumber(params.valveCv ?? params.cv, 50),
            valveCharacteristic: params.valveCharacteristic === 'equalPercentage' || params.valveCharacteristic === 'quickOpening' ? params.valveCharacteristic : 'linear',
            valveRangeability: toNumber(params.valveRangeability, 50),
            initialLevel: toNumber(params.initialLevel, 1),
            tankArea: toNumber(params.tankArea, 1),
            maxLevel: toNumber(params.maxLevel, 2),
            portCount: kind === 'tank' ? Math.max(1, Math.floor(toNumber(params.portCount, 1))) : undefined,
            resistance: toNumber(params.resistance, 100000),
            pipeShape: params.pipeShape === 'rectangular' ? 'rectangular' : 'circular',
            diameter: toNumber(params.diameter, 100),
            width: toNumber(params.width, 100),
            ductHeight: toNumber(params.ductHeight, 50),
            length: toNumber(params.length, 10),
            roughness: toNumber(params.roughness, 0.046),
            heatEnabled: params.heatEnabled === true,
            initialTemperature: kind === 'tank' || kind === 'pipe'
              ? toNumber(params.initialTemperature ?? params.temperature, 293.15)
              : undefined,
            heatTransferCoeff: kind === 'tank' ? toNumber(params.heatTransferCoeff, 10) : undefined,
            outerHeatTransferCoeff: kind === 'tank' ? toNumber(params.outerHeatTransferCoeff ?? params.heatTransferCoeff, 10) : undefined,
            innerHeatTransferCoeff: kind === 'tank' ? toNumber(params.innerHeatTransferCoeff ?? params.heatTransferCoeff, 10) : undefined,
            heatArea: kind === 'tank' ? toNumber(params.heatArea, 1) : undefined,
            wallThickness: kind === 'tank' ? toNumber(params.wallThickness, 2) : undefined,
            propertyMode: kind === 'fluid' && params.propertyMode === 'state' ? 'state' : kind === 'fluid' ? 'constantDensity' : undefined,
            coolPropFluid: kind === 'fluid' ? String(params.coolPropFluid ?? params.fluid ?? 'Water') : undefined,
            fluidLibraryId: kind === 'fluid' ? toNumber(params.fluidLibraryId, 0) || undefined : undefined,
            materialId: kind === 'solid' ? toNumber(params.materialId, 0) || undefined : undefined,
            density: isMaterialNode ? toNumber(params.density, kind === 'solid' ? 7800 : 1000) : undefined,
            viscosity: kind === 'fluid' ? toNumber(params.viscosity, 0.001) : undefined,
            specificHeat: isMaterialNode ? toNumber(params.specificHeat, kind === 'solid' ? DEFAULT_SOLID_SPECIFIC_HEAT : 4184) : undefined,
            thermalConductivity: isMaterialNode ? toNumber(params.thermalConductivity, kind === 'solid' ? 16 : 0.6) : undefined,
            temperature: kind === 'thermalMass' ? toNumber(params.temperature, 293.15) : undefined,
            fluidRef: needsFluid ? DEFAULT_FLUID_NODE_ID : undefined,
            solidRef: kind === 'thermalMass' ? DEFAULT_SOLID_NODE_ID : undefined,
            mass: kind === 'thermalMass' ? toNumber(params.mass, 1) : undefined,
          },
        }
      })
      const nextNodes = [fluidNode, solidNode, ...copiedNodes]
      const nodeById = new Map(nextNodes.map(node => [node.id, node]))
      setNodes(nextNodes)
      window.requestAnimationFrame(() => nextNodes.forEach(node => updateNodeInternals(node.id)))
      setEdges(seed.edges.filter(e => (e.line_type ?? 'fluid') === 'fluid').map(e => ({
        id: e.id,
        type: DEFAULT_EDGE_TYPE,
        source: e.source,
        target: e.target,
        sourceHandle: physicalHandleId(nodeById.get(e.source), e.source_handle, true),
        targetHandle: physicalHandleId(nodeById.get(e.target), e.target_handle, false),
        data: { lineType: 'fluid' },
      })))
      setSelectedId(null)
      setSelectedEdgeId(null)
      setResult(null)
      setError(null)
    }, 0)
    return () => window.clearTimeout(handle)
  }, [seed, setEdges, setNodes, updateNodeInternals])

  const selectedNode = nodes.find(n => n.id === selectedId) ?? null
  const selectedEdge = edges.find(e => e.id === selectedEdgeId) ?? null
  const selectedData = selectedNode?.data
  const fluidNodes = nodes.filter(n => String(n.data.nodeType) === 'fluid')
  const solidNodes = nodes.filter(n => String(n.data.nodeType) === 'solid')
  const defaultFluidRef = fluidNodes[0]?.id ?? DEFAULT_FLUID_NODE_ID
  const defaultSolidRef = solidNodes[0]?.id ?? DEFAULT_SOLID_NODE_ID
  const hasSelection = selectedNode !== null || selectedEdge !== null
  const heatCapacityForThermalMass = (data: TransientNodeData): number => {
    const solid = data.solidRef ? solidNodes.find(node => node.id === data.solidRef) : null
    return toNumber(data.mass, 1) * toNumber(solid?.data.specificHeat, DEFAULT_SOLID_SPECIFIC_HEAT)
  }
  const selectedHeatCapacity = selectedData?.nodeType === 'thermalMass'
    ? heatCapacityForThermalMass(selectedData)
    : null
  const activePalette = PALETTE_GROUPS.find(group => group.id === activePaletteGroup) ?? PALETTE_GROUPS[0]

  const updateSelected = useCallback((updates: Partial<TransientNodeData>) => {
    if (!selectedId) return
    setNodes(prev => prev.map(n => n.id === selectedId ? { ...n, data: { ...n.data, ...updates } } : n))
  }, [selectedId, setNodes])

  const applySelectedFluidLibrary = useCallback(() => {
    if (!selectedId) return
    const node = nodes.find(n => n.id === selectedId)
    const entry = fluidLibrary.find(item => item.id === Number(node?.data.fluidLibraryId))
    if (!entry) {
      setError('読み込む流体を選択してください')
      return
    }
    setNodes(prev => prev.map(n => n.id === selectedId
      ? {
        ...n,
        data: {
          ...n.data,
          label: n.data.label || entry.name,
          density: entry.density_kg_m3,
          viscosity: entry.viscosity_pa_s,
          thermalConductivity: entry.thermal_conductivity_w_m_k,
          specificHeat: entry.specific_heat_j_kg_k,
        },
      }
      : n))
    setError(null)
    setResult(null)
  }, [fluidLibrary, nodes, selectedId, setNodes])

  const applySelectedMaterial = useCallback(() => {
    if (!selectedId) return
    const node = nodes.find(n => n.id === selectedId)
    const material = materials.find(item => item.id === Number(node?.data.materialId))
    if (!material) {
      setError('読み込む材料を選択してください')
      return
    }
    setNodes(prev => prev.map(n => n.id === selectedId
      ? {
        ...n,
        data: {
          ...n.data,
          label: n.data.label || material.name,
          density: material.density_kg_m3,
          thermalConductivity: material.thermal_conductivity_w_m_k,
          specificHeat: material.specific_heat_j_kg_k,
        },
      }
      : n))
    setError(null)
    setResult(null)
  }, [materials, nodes, selectedId, setNodes])

  const updateSelectedTankPortCount = useCallback((value: number) => {
    if (!selectedId) return
    const nextCount = Math.max(1, Math.floor(value || 1))
    setNodes(prev => prev.map(n => n.id === selectedId ? { ...n, data: { ...n.data, portCount: nextCount } } : n))
    setEdges(prev => prev.filter(edge => {
      if (edge.source === selectedId && String(edge.sourceHandle ?? '').startsWith('port')) {
        return Number(String(edge.sourceHandle).replace('port', '')) <= nextCount
      }
      if (edge.target === selectedId && String(edge.targetHandle ?? '').startsWith('port')) {
        return Number(String(edge.targetHandle).replace('port', '')) <= nextCount
      }
      return true
    }))
    window.requestAnimationFrame(() => updateNodeInternals(selectedId))
    setResult(null)
  }, [selectedId, setEdges, setNodes, updateNodeInternals])

  const updateSelectedExternalInput = useCallback((enabled: boolean) => {
    if (!selectedId) return
    setNodes(prev => prev.map(n => n.id === selectedId ? { ...n, data: { ...n.data, externalInput: enabled } } : n))
    if (!enabled) {
      setEdges(prev => prev.filter(edge => !(edge.target === selectedId && edge.targetHandle === 'signalIn')))
    }
    window.requestAnimationFrame(() => updateNodeInternals(selectedId))
    setResult(null)
  }, [selectedId, setEdges, setNodes, updateNodeInternals])

  const updateSelectedPumpDriveExternal = useCallback((enabled: boolean) => {
    if (!selectedId) return
    setNodes(prev => prev.map(n => n.id === selectedId ? { ...n, data: { ...n.data, driveExternal: enabled } } : n))
    if (!enabled) {
      setEdges(prev => prev.filter(edge => !(edge.target === selectedId && edge.targetHandle === 'rotationIn')))
    }
    window.requestAnimationFrame(() => updateNodeInternals(selectedId))
    setResult(null)
  }, [selectedId, setEdges, setNodes, updateNodeInternals])

  const updateSelectedHeatEnabled = useCallback((enabled: boolean) => {
    if (!selectedId) return
    setNodes(prev => prev.map(n => n.id === selectedId ? { ...n, data: { ...n.data, heatEnabled: enabled } } : n))
    if (!enabled) {
      setEdges(prev => prev.filter(edge => !(edge.target === selectedId && edge.targetHandle === 'heatIn')))
    }
    window.requestAnimationFrame(() => updateNodeInternals(selectedId))
    setResult(null)
  }, [selectedId, setEdges, setNodes, updateNodeInternals])

  const updateSelectedPumpCurvePoint = useCallback((index: number, updates: Partial<{ q: number; h: number }>) => {
    if (!selectedId) return
    setNodes(prev => prev.map(n => {
      if (n.id !== selectedId) return n
      const points = normalizePumpCurvePoints(n.data.pumpCurvePoints)
      const fallbackPoint = { q: toNumber(n.data.ratedFlow, 30), h: toNumber(n.data.ratedHead, 20) }
      const next = points.length > 0 ? [...points] : [{ q: 0, h: toNumber(n.data.shutoffHead, 30) }, fallbackPoint]
      next[index] = { ...(next[index] ?? fallbackPoint), ...updates }
      return { ...n, data: { ...n.data, pumpCurvePoints: next } }
    }))
    setResult(null)
  }, [selectedId, setNodes])

  const addSelectedPumpCurvePoint = useCallback(() => {
    if (!selectedId) return
    setNodes(prev => prev.map(n => {
      if (n.id !== selectedId) return n
      const points = normalizePumpCurvePoints(n.data.pumpCurvePoints)
      const last = points[points.length - 1] ?? { q: toNumber(n.data.ratedFlow, 30), h: toNumber(n.data.ratedHead, 20) }
      return { ...n, data: { ...n.data, pumpCurvePoints: [...points, { q: last.q + 10, h: Math.max(last.h - 5, 0) }] } }
    }))
    setResult(null)
  }, [selectedId, setNodes])

  const removeSelectedPumpCurvePoint = useCallback((index: number) => {
    if (!selectedId) return
    setNodes(prev => prev.map(n => {
      if (n.id !== selectedId) return n
      const next = normalizePumpCurvePoints(n.data.pumpCurvePoints).filter((_, i) => i !== index)
      return { ...n, data: { ...n.data, pumpCurvePoints: next } }
    }))
    setResult(null)
  }, [selectedId, setNodes])

  const createNodeData = (kind: TransientNodeKind): TransientNodeData => (
    kind === 'fluid'
      ? { ...DEFAULT_FLUID_DATA, label: `流体${fluidNodes.length + 1}` }
      : kind === 'solid'
        ? { ...DEFAULT_SOLID_DATA, label: `固体${solidNodes.length + 1}` }
      : kind === 'constantSignal'
        ? { nodeType: 'constantSignal', label: '一定値', signalValue: 1 }
      : kind === 'fixedRotation'
        ? { nodeType: 'fixedRotation', label: '固定回転', fixedSpeed: 1450 }
      : kind === 'fixedTorque'
        ? { nodeType: 'fixedTorque', label: '固定トルク', fixedTorque: 10 }
      : kind === 'fixedTemperature'
        ? { nodeType: 'fixedTemperature', label: '固定温度', heatTemperature: 293.15 }
      : kind === 'thermalMass'
        ? { nodeType: 'thermalMass', label: '熱質量', solidRef: defaultSolidRef, mass: 1, temperature: 293.15 }
      : kind === 'heatBoundary'
        ? { nodeType: 'heatBoundary', label: '熱境界', heatTemperature: 293.15, heatFlow: 0 }
      : kind === 'volume'
      ? { nodeType: 'volume', label: '容量', pressure: 300, fluidRef: defaultFluidRef }
      : kind === 'tank'
        ? { nodeType: 'tank', label: 'タンク', initialLevel: 1, tankArea: 1, maxLevel: 2, portCount: 1, initialTemperature: 293.15, heatEnabled: false, solidRef: defaultSolidRef, wallThickness: 2, outerHeatTransferCoeff: 10, innerHeatTransferCoeff: 50, heatArea: 1, fluidRef: defaultFluidRef }
      : kind === 'pressureBoundary'
        ? { nodeType: 'pressureBoundary', label: '圧力境界', boundaryType: 'pressure', pressure: 300, fluidRef: defaultFluidRef }
        : kind === 'flowBoundary'
          ? { nodeType: 'flowBoundary', label: '流量境界', boundaryType: 'flow', flowRate: 1, fluidRef: defaultFluidRef }
          : kind === 'pipe'
            ? { nodeType: 'pipe', label: '配管', pipeShape: 'circular', diameter: 100, width: 100, ductHeight: 50, length: 10, roughness: 0.046, initialTemperature: 293.15, heatEnabled: false, fluidRef: defaultFluidRef }
          : kind === 'pump'
            ? {
              nodeType: 'pump',
              label: 'ポンプ',
              ratedFlow: 30,
              ratedHead: 20,
              shutoffHead: 30,
              ratedSpeed: 1450,
              speed: 1450,
              driveExternal: false,
              driveMode: 'speed',
              efficiency: 70,
              pumpCurveMode: 'simple',
              pumpCurvePoints: [{ q: 0, h: 30 }, { q: 30, h: 20 }, { q: 60, h: 0 }],
              fluidRef: defaultFluidRef,
            }
          : kind === 'valve'
            ? { nodeType: 'valve', label: 'バルブ', valveCv: 50, valveOpening: 100, valveCharacteristic: 'linear', valveRangeability: 50, fluidRef: defaultFluidRef }
            : { nodeType: 'resistor', label: '抵抗', resistance: 100000, fluidRef: defaultFluidRef }
  )

  const addNodeAt = (kind: TransientNodeKind, position: { x: number; y: number }) => {
    const id = `${kind}-${Date.now().toString(36)}`
    setNodes(prev => [...prev, { id, type: 'transientNode', position, style: DEFAULT_NODE_STYLE, data: createNodeData(kind) }])
    window.requestAnimationFrame(() => updateNodeInternals(id))
  }

  const onPaletteDragStart = useCallback((event: React.DragEvent, kind: TransientNodeKind) => {
    event.dataTransfer.setData('application/reactflow-transient', kind)
    event.dataTransfer.effectAllowed = 'move'
  }, [])

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const kind = event.dataTransfer.getData('application/reactflow-transient') as TransientNodeKind
    if (!kind) return
    addNodeAt(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
  }

  const onDragOver = (event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const onConnect = useCallback((connection: Connection) => {
    const sourceNode = nodes.find(node => node.id === connection.source)
    const targetNode = nodes.find(node => node.id === connection.target)
    const sourceKind = String(sourceNode?.data.nodeType)
    const targetKind = String(targetNode?.data.nodeType)
    const sourcePort = physicalHandleId(sourceNode, connection.sourceHandle, true)
    const targetPort = physicalHandleId(targetNode, connection.targetHandle, false)
    const lineType = sourceKind === 'constantSignal' || targetKind === 'constantSignal'
      ? 'signal'
      : sourceKind === 'fixedRotation' || sourceKind === 'fixedTorque' || targetKind === 'fixedRotation' || targetKind === 'fixedTorque' || targetPort === 'rotationIn'
        ? 'rotational'
        : sourceKind === 'fixedTemperature' || targetKind === 'fixedTemperature' || sourceKind === 'thermalMass' || targetKind === 'thermalMass' || sourceKind === 'heatBoundary' || targetKind === 'heatBoundary' || targetPort === 'heatIn'
          ? 'heat'
          : 'fluid'
    if (lineType === 'signal') {
      const sourceIsSignal = sourceKind === 'constantSignal' && sourcePort === 'signalOut'
      const targetAcceptsBoundarySignal = (
        (targetKind === 'pressureBoundary' || targetKind === 'flowBoundary') &&
        targetNode?.data.externalInput === true &&
        targetPort === 'signalIn'
      )
      if (!sourceIsSignal || !targetAcceptsBoundarySignal) {
        setError('実数値信号は、一定値ブロックから外部入力ONの境界ノードへ接続してください')
        return
      }
    }
    if (lineType === 'heat') {
      const sourceIsHeat = (
        ((sourceKind === 'fixedTemperature' || sourceKind === 'heatBoundary') && sourcePort === 'heatOut') ||
        (sourceKind === 'thermalMass' && sourcePort === 'heatPort')
      )
      const targetAcceptsHeat = (targetKind === 'pipe' || targetKind === 'tank') && targetNode?.data.heatEnabled === true && targetPort === 'heatIn'
      if (!sourceIsHeat || !targetAcceptsHeat) {
        setError('熱ポートは、固定温度または熱質量から熱考慮ONの配管またはタンクへ接続してください')
        return
      }
    }
    if (lineType === 'rotational') {
      const sourceIsRotational = (sourceKind === 'fixedRotation' || sourceKind === 'fixedTorque') && sourcePort === 'rotationOut'
      const targetAcceptsRotation = targetKind === 'pump' && targetNode?.data.driveExternal === true && targetPort === 'rotationIn'
      if (!sourceIsRotational || !targetAcceptsRotation) {
        setError('回転トルクポートは、固定回転または固定トルクから外部入力ONのポンプへ接続してください')
        return
      }
    }
    const portIsUsed = (edge: Edge, nodeId: string, portId: string) => {
      const edgeSource = nodes.find(node => node.id === edge.source)
      const edgeTarget = nodes.find(node => node.id === edge.target)
      return (
        (edge.source === nodeId && physicalHandleId(edgeSource, edge.sourceHandle, true) === portId) ||
        (edge.target === nodeId && physicalHandleId(edgeTarget, edge.targetHandle, false) === portId)
      )
    }
    setEdges(prev => {
      if (prev.some(edge => portIsUsed(edge, connection.source, sourcePort))) {
        setError(`${sourceNode?.data.label ?? connection.source} のポート ${sourcePort} は既に接続されています`)
        return prev
      }
      if (prev.some(edge => portIsUsed(edge, connection.target, targetPort))) {
        setError(`${targetNode?.data.label ?? connection.target} のポート ${targetPort} は既に接続されています`)
        return prev
      }
      setError(null)
      return addEdge({ ...connection, type: DEFAULT_EDGE_TYPE, sourceHandle: sourcePort, targetHandle: targetPort, data: { lineType } }, prev)
    })
  }, [nodes, setEdges])

  const deleteSelected = useCallback(() => {
    if (selectedId) {
      setNodes(prev => prev.filter(n => n.id !== selectedId))
      setEdges(prev => prev.filter(e => e.source !== selectedId && e.target !== selectedId))
      setSelectedId(null)
      setSelectedEdgeId(null)
      setResult(null)
      return
    }
    if (selectedEdgeId) {
      setEdges(prev => prev.filter(e => e.id !== selectedEdgeId))
      setSelectedEdgeId(null)
      setResult(null)
    }
  }, [selectedEdgeId, selectedId, setEdges, setNodes])

  const clearSketch = useCallback(() => {
    if (!window.confirm('スケッチをすべて削除します。よろしいですか？')) return
    setNodes([])
    setEdges([])
    setSelectedId(null)
    setSelectedEdgeId(null)
    setResult(null)
    setGraphs([])
    setError(null)
  }, [setEdges, setNodes])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName.toLowerCase()
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target?.isContentEditable) return
      if (!selectedId && !selectedEdgeId) return
      event.preventDefault()
      deleteSelected()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [deleteSelected, selectedEdgeId, selectedId])

  useEffect(() => {
    if (!loading) {
      return
    }
    const timer = window.setInterval(() => {
      setCalculationProgressTick(value => value + 1)
    }, 250)
    return () => window.clearInterval(timer)
  }, [loading])

  const run = async () => {
    setLoading(true)
    setCalculationProgressTick(0)
    setError(null)
    try {
      const fluidIds = new Set(fluidNodes.map(n => n.id))
      if (fluidNodes.length === 0) {
        throw new Error('非定常計算では、スケッチに流体ノードを配置してください')
      }
      const firstFluid = fluidNodes[0]?.data ?? DEFAULT_FLUID_DATA
      const missingFluid = nodes.find(n => {
        const kind = String(n.data.nodeType)
        return needsFluidReference(kind) && (!n.data.fluidRef || !fluidIds.has(String(n.data.fluidRef)))
      })
      if (missingFluid) {
        throw new Error(`${missingFluid.data.label} の流体を設定してください`)
      }
      const invalidFluid = fluidNodes.find(n => (
        (n.data.propertyMode !== 'state' && (
          toNumber(n.data.density, 0) <= 0 ||
          toNumber(n.data.viscosity, 0) <= 0 ||
          toNumber(n.data.thermalConductivity, 0) <= 0 ||
          toNumber(n.data.specificHeat, 0) <= 0
        )) ||
        (n.data.propertyMode === 'state' && !COOLPROP_FLUIDS.includes(String(n.data.coolPropFluid ?? '')))
      ))
      if (invalidFluid) {
        throw new Error(`${invalidFluid.data.label} の物性設定を確認してください`)
      }
      const solidIds = new Set(solidNodes.map(n => n.id))
      const invalidSolid = solidNodes.find(n => (
        toNumber(n.data.density, 0) <= 0 ||
        toNumber(n.data.thermalConductivity, 0) <= 0 ||
        toNumber(n.data.specificHeat, 0) <= 0
      ))
      if (invalidSolid) {
        throw new Error(`${invalidSolid.data.label} の密度、比熱、熱伝導率は0より大きくしてください`)
      }
      const solidById = new Map(solidNodes.map(node => [node.id, node]))
      const invalidTankHeat = nodes.find(n => {
        if (String(n.data.nodeType) !== 'tank' || n.data.heatEnabled !== true) return false
        const solid = n.data.solidRef ? solidById.get(String(n.data.solidRef)) : null
        return !solid ||
          toNumber(n.data.wallThickness, 0) <= 0 ||
          toNumber(n.data.heatArea, 0) <= 0 ||
          toNumber(n.data.outerHeatTransferCoeff, 0) < 0 ||
          toNumber(n.data.innerHeatTransferCoeff, 0) < 0
      })
      if (invalidTankHeat) {
        throw new Error(`${invalidTankHeat.data.label} の材質、板厚、熱伝達設定を確認してください`)
      }
      const invalidThermalMass = nodes.find(n => {
        const kind = String(n.data.nodeType)
        return kind === 'thermalMass' && (
          toNumber(n.data.mass, 0) <= 0 ||
          toNumber(n.data.temperature, 0) <= 0 ||
          !n.data.solidRef ||
          !solidIds.has(String(n.data.solidRef))
        )
      })
      if (invalidThermalMass) {
        throw new Error(`${invalidThermalMass.data.label} の固体、質量、初期温度を設定してください`)
      }
      const invalidTemperatureNode = nodes.find(n => {
        const kind = String(n.data.nodeType)
        return (kind === 'tank' || kind === 'pipe') && toNumber(n.data.initialTemperature, 0) <= 0
      })
      if (invalidTemperatureNode) {
        throw new Error(`${invalidTemperatureNode.data.label} の初期温度は0より大きくしてください`)
      }
      const nodeById = new Map(nodes.map(node => [node.id, node]))
      const signalValueForTarget = (node: Node<TransientNodeData>, handleId: string): number | null => {
        const signalEdge = edges.find(edge => (
          (edge.data as { lineType?: string } | undefined)?.lineType === 'signal' &&
          edge.target === node.id &&
          edge.targetHandle === handleId
        ))
        if (!signalEdge) return null
        const sourceNode = nodeById.get(signalEdge.source)
        if (!sourceNode || String(sourceNode.data.nodeType) !== 'constantSignal') return null
        return toNumber(sourceNode.data.signalValue, 0)
      }
      const externalValueForBoundary = (node: Node<TransientNodeData>): number | null => signalValueForTarget(node, 'signalIn')
      const rotationalDriveForPump = (node: Node<TransientNodeData>): Partial<TransientNodeData> | null => {
        const driveEdge = edges.find(edge => (
          (edge.data as { lineType?: string } | undefined)?.lineType === 'rotational' &&
          edge.target === node.id &&
          edge.targetHandle === 'rotationIn'
        ))
        if (!driveEdge) return null
        const sourceNode = nodeById.get(driveEdge.source)
        if (!sourceNode) return null
        const sourceKind = String(sourceNode.data.nodeType)
        if (sourceKind === 'fixedRotation') {
          return { driveMode: 'speed', speed: toNumber(sourceNode.data.fixedSpeed, 1450) }
        }
        if (sourceKind === 'fixedTorque') {
          return { driveMode: 'torque', driveTorque: toNumber(sourceNode.data.fixedTorque, 0) }
        }
        return null
      }
      const heatBoundaryForTarget = (node: Node<TransientNodeData>): Node<TransientNodeData> | null => {
        const heatEdge = edges.find(edge => (
          (edge.data as { lineType?: string } | undefined)?.lineType === 'heat' &&
          edge.target === node.id &&
          edge.targetHandle === 'heatIn'
        ))
        if (!heatEdge) return null
        const sourceNode = nodeById.get(heatEdge.source)
        return sourceNode && (String(sourceNode.data.nodeType) === 'fixedTemperature' || String(sourceNode.data.nodeType) === 'thermalMass' || String(sourceNode.data.nodeType) === 'heatBoundary') ? sourceNode : null
      }
      const externalMissing = nodes.find(node => {
        const kind = String(node.data.nodeType)
        return (kind === 'pressureBoundary' || kind === 'flowBoundary') && node.data.externalInput === true && externalValueForBoundary(node) === null
      })
      if (externalMissing) {
        throw new Error(`${externalMissing.data.label} の外部入力に一定値ブロックを接続してください`)
      }
      const rotationalMissing = nodes.find(node => (
        String(node.data.nodeType) === 'pump' &&
        node.data.driveExternal === true &&
        rotationalDriveForPump(node) === null
      ))
      if (rotationalMissing) {
        throw new Error(`${rotationalMissing.data.label} の回転トルクポートに固定回転または固定トルクを接続してください`)
      }
      const res = await simulateTransientNetwork({
        nodes: nodes.filter(n => {
          const kind = String(n.data.nodeType)
          return kind !== 'solid' && kind !== 'constantSignal' && kind !== 'fixedRotation' && kind !== 'fixedTorque' && kind !== 'fixedTemperature' && kind !== 'heatBoundary'
        }).map(n => ({
          id: n.id,
          node_type: payloadNodeType(String(n.data.nodeType)),
          params: {
            ...n.data,
            ...(String(n.data.nodeType) === 'thermalMass'
              ? { heatCapacity: heatCapacityForThermalMass(n.data) }
              : {}),
            ...(n.data.driveExternal === true && String(n.data.nodeType) === 'pump' && rotationalDriveForPump(n)
              ? rotationalDriveForPump(n)
              : {}),
            ...(n.data.externalInput === true && String(n.data.nodeType) === 'pressureBoundary'
              ? { pressure: externalValueForBoundary(n) ?? n.data.pressure }
              : {}),
            ...(n.data.externalInput === true && String(n.data.nodeType) === 'flowBoundary'
              ? { flowRate: externalValueForBoundary(n) ?? n.data.flowRate }
              : {}),
            ...(n.data.heatEnabled === true && (String(n.data.nodeType) === 'pipe' || String(n.data.nodeType) === 'tank') && heatBoundaryForTarget(n)
              ? {
                heatTemperature: toNumber(heatBoundaryForTarget(n)?.data.heatTemperature ?? heatBoundaryForTarget(n)?.data.temperature, 293.15),
              }
              : {}),
            ...(n.data.heatEnabled === true && String(n.data.nodeType) === 'tank' && n.data.solidRef && solidById.get(String(n.data.solidRef))
              ? {
                wallDensity: toNumber(solidById.get(String(n.data.solidRef))?.data.density, 7800),
                wallSpecificHeat: toNumber(solidById.get(String(n.data.solidRef))?.data.specificHeat, DEFAULT_SOLID_SPECIFIC_HEAT),
                wallThermalConductivity: toNumber(solidById.get(String(n.data.solidRef))?.data.thermalConductivity, 16),
              }
              : {}),
            boundaryType: payloadBoundaryType(String(n.data.nodeType), n.data),
            ports: nodePorts(n.data).map(id => ({ id, domain: 'fluid' })),
          },
        })),
        edges: edges.filter(e => {
          const lineType = (e.data as { lineType?: string } | undefined)?.lineType
          return lineType !== 'signal' && lineType !== 'rotational'
        }).map(e => ({
          id: e.id,
          source: e.source,
          target: e.target,
          source_handle: e.sourceHandle ?? null,
          target_handle: e.targetHandle ?? null,
          line_type: ((e.data as { lineType?: string } | undefined)?.lineType === 'heat') ? 'heat' : 'fluid',
        })),
        fluidSystems: [],
        density: toNumber(firstFluid.density, 1000),
        viscosity: toNumber(firstFluid.viscosity, 0.001),
        duration,
        dt,
      })
      setResult(res)
      setGraphs(prev => prev.map(graph => ({ ...graph, xSource: graph.xSource, ySources: graph.ySources })))
    } catch (e) {
      setError(e instanceof Error ? e.message : '非定常計算に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const selectedResultRows = (() => {
    if (!result || !selectedNode) return []
    const rows: ResultRow[] = []
    const nodeResult = result.nodes[selectedNode.id]
    const finalTime = lastNumber(result.time)

    if (finalTime !== null) {
      rows.push({ item: '時間', unit: 's', value: formatResultValue(finalTime, 3), source: { kind: 'time', label: '時間', unit: 's' } })
    }
    if (nodeResult?.pressure_kpa) {
      rows.push({
        item: 'ノード圧力',
        unit: 'kPa',
        value: formatResultValue(lastNumber(nodeResult.pressure_kpa), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'pressure_kpa', label: `${selectedNode.data.label} ノード圧力`, unit: 'kPa' },
      })
    }
    if (nodeResult?.flow_m3h) {
      rows.push({
        item: 'ノード流量',
        unit: 'm3/h',
        value: formatResultValue(lastNumber(nodeResult.flow_m3h), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'flow_m3h', label: `${selectedNode.data.label} ノード流量`, unit: 'm3/h' },
      })
    }
    if (nodeResult?.level_m) {
      rows.push({
        item: '水位',
        unit: 'm',
        value: formatResultValue(lastNumber(nodeResult.level_m), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'level_m', label: `${selectedNode.data.label} 水位`, unit: 'm' },
      })
    }
    if (nodeResult?.velocity_mps) {
      rows.push({
        item: '流速',
        unit: 'm/s',
        value: formatResultValue(lastNumber(nodeResult.velocity_mps), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'velocity_mps', label: `${selectedNode.data.label} 流速`, unit: 'm/s' },
      })
    }
    if (nodeResult?.reynolds) {
      rows.push({
        item: 'レイノルズ数',
        unit: '-',
        value: formatResultValue(lastNumber(nodeResult.reynolds), 0),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'reynolds', label: `${selectedNode.data.label} レイノルズ数`, unit: '-' },
      })
    }
    if (nodeResult?.pressure_loss_kpa) {
      rows.push({
        item: '圧力損失',
        unit: 'kPa',
        value: formatResultValue(lastNumber(nodeResult.pressure_loss_kpa), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'pressure_loss_kpa', label: `${selectedNode.data.label} 圧力損失`, unit: 'kPa' },
      })
    }
    if (nodeResult?.boost_kpa) {
      rows.push({
        item: '昇圧',
        unit: 'kPa',
        value: formatResultValue(lastNumber(nodeResult.boost_kpa), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'boost_kpa', label: `${selectedNode.data.label} 昇圧`, unit: 'kPa' },
      })
    }
    if (nodeResult?.head_m) {
      rows.push({
        item: '揚程',
        unit: 'm',
        value: formatResultValue(lastNumber(nodeResult.head_m), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'head_m', label: `${selectedNode.data.label} 揚程`, unit: 'm' },
      })
    }
    if (nodeResult?.shaft_power_kw) {
      rows.push({
        item: '軸動力',
        unit: 'kW',
        value: formatResultValue(lastNumber(nodeResult.shaft_power_kw), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'shaft_power_kw', label: `${selectedNode.data.label} 軸動力`, unit: 'kW' },
      })
    }
    if (nodeResult?.speed_rpm) {
      rows.push({
        item: '回転数',
        unit: 'rpm',
        value: formatResultValue(lastNumber(nodeResult.speed_rpm), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'speed_rpm', label: `${selectedNode.data.label} 回転数`, unit: 'rpm' },
      })
    }
    if (nodeResult?.shaft_torque_nm) {
      rows.push({
        item: '軸トルク',
        unit: 'N m',
        value: formatResultValue(lastNumber(nodeResult.shaft_torque_nm), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'shaft_torque_nm', label: `${selectedNode.data.label} 軸トルク`, unit: 'N m' },
      })
    }
    if (nodeResult?.temperature_k) {
      rows.push({
        item: '温度',
        unit: 'K',
        value: formatResultValue(lastNumber(nodeResult.temperature_k), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'temperature_k', label: `${selectedNode.data.label} 温度`, unit: 'K' },
      })
    }
    if (nodeResult?.wall_temperature_k) {
      rows.push({
        item: '壁温度',
        unit: 'K',
        value: formatResultValue(lastNumber(nodeResult.wall_temperature_k), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'wall_temperature_k', label: `${selectedNode.data.label} 壁温度`, unit: 'K' },
      })
    }
    if (nodeResult?.heat_transfer_w) {
      rows.push({
        item: '熱交換量',
        unit: 'W',
        value: formatResultValue(lastNumber(nodeResult.heat_transfer_w), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'heat_transfer_w', label: `${selectedNode.data.label} 熱交換量`, unit: 'W' },
      })
    }
    if (nodeResult?.heat_transfer_coefficient_w_m2k) {
      rows.push({
        item: '熱伝達率',
        unit: 'W/(m2 K)',
        value: formatResultValue(lastNumber(nodeResult.heat_transfer_coefficient_w_m2k), 3),
        source: { kind: 'node', nodeId: selectedNode.id, seriesKey: 'heat_transfer_coefficient_w_m2k', label: `${selectedNode.data.label} 熱伝達率`, unit: 'W/(m2 K)' },
      })
    }

    const ports = result.ports?.[selectedNode.id] ?? {}
    Object.entries(ports).forEach(([portId, series]) => {
      const p = lastNumber(series.pressure_kpa)
      const q = lastNumber(series.flow_m3h)
      rows.push({
        item: `ポート${portId} 圧力`,
        unit: 'kPa',
        value: formatResultValue(p, 3),
        source: { kind: 'port', nodeId: selectedNode.id, portId, seriesKey: 'pressure_kpa', label: `${selectedNode.data.label} port ${portId} 圧力`, unit: 'kPa' },
      })
      rows.push({
        item: `ポート${portId} 流量`,
        unit: 'm3/h',
        value: formatResultValue(q, 3),
        source: { kind: 'port', nodeId: selectedNode.id, portId, seriesKey: 'flow_m3h', label: `${selectedNode.data.label} port ${portId} 流量`, unit: 'm3/h' },
      })
    })

    return rows
  })()

  const addGraph = useCallback(() => {
    setGraphs(prev => [...prev, {
      id: `graph-${Date.now().toString(36)}`,
      title: `グラフ ${prev.length + 1}`,
      mode: 'time',
      xSource: null,
      ySources: [],
    }])
  }, [])

  const onResultDragStart = useCallback((event: React.DragEvent, source: ResultSeriesSource) => {
    event.dataTransfer.setData('application/transient-result-series', JSON.stringify(source))
    event.dataTransfer.effectAllowed = 'copy'
  }, [])

  const readDraggedSeries = (event: React.DragEvent): ResultSeriesSource | null => {
    const raw = event.dataTransfer.getData('application/transient-result-series')
    if (!raw) return null
    try {
      return JSON.parse(raw) as ResultSeriesSource
    } catch {
      return null
    }
  }

  const onGraphDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onGraphDrop = useCallback((event: React.DragEvent, graphId: string) => {
    event.preventDefault()
    const source = readDraggedSeries(event)
    if (!source) return
    setGraphs(prev => prev.map(graph => {
      if (graph.id !== graphId) return graph
      if (graph.mode === 'time') {
        if (source.kind === 'time') return graph
        const exists = graph.ySources.some(item => JSON.stringify(item) === JSON.stringify(source))
        return exists ? graph : { ...graph, ySources: [...graph.ySources, source] }
      }
      if (source.kind === 'time') return graph
      if (!graph.xSource) return { ...graph, xSource: source }
      const exists = graph.ySources.some(item => JSON.stringify(item) === JSON.stringify(source))
      return exists ? graph : { ...graph, ySources: [...graph.ySources, source] }
    }))
  }, [])

  const removeGraph = useCallback((graphId: string) => {
    setGraphs(prev => prev.filter(graph => graph.id !== graphId))
  }, [])

  const removeGraphSeries = useCallback((graphId: string, source: ResultSeriesSource) => {
    setGraphs(prev => prev.map(graph => (
      graph.id === graphId
        ? { ...graph, ySources: graph.ySources.filter(item => JSON.stringify(item) !== JSON.stringify(source)) }
        : graph
    )))
  }, [])

  const clearGraphXSource = useCallback((graphId: string) => {
    setGraphs(prev => prev.map(graph => (
      graph.id === graphId ? { ...graph, xSource: null } : graph
    )))
  }, [])

  const setGraphMode = useCallback((graphId: string, mode: 'time' | 'xy') => {
    setGraphs(prev => prev.map(graph => (
      graph.id === graphId
        ? { ...graph, mode, xSource: mode === 'time' ? null : graph.xSource }
        : graph
    )))
  }, [])

  const swapGraphAxes = useCallback((graphId: string) => {
    setGraphs(prev => prev.map(graph => {
      if (graph.id !== graphId || graph.mode !== 'xy' || !graph.xSource || graph.ySources.length === 0) return graph
      const [firstY, ...restY] = graph.ySources
      return { ...graph, xSource: firstY, ySources: [graph.xSource, ...restY] }
    }))
  }, [])

  const sourceValues = (source: ResultSeriesSource): number[] => {
    if (!result) return []
    if (source.kind === 'time') return result.time
    if (source.kind === 'node') return result.nodes[source.nodeId]?.[source.seriesKey] ?? []
    return result.ports?.[source.nodeId]?.[source.portId]?.[source.seriesKey] ?? []
  }

  const internalStepCount = Math.max(1, Math.floor(duration / Math.max(dt, 1e-12)) + 1)
  const estimatedProgressPercent = loading
    ? Math.min(95, Math.max(4, Math.round((1 - Math.exp(-calculationProgressTick / 28)) * 95)))
    : 0

  const buildSketchJson = useCallback((name: string): SavedTransientSketch => ({
    version: 1,
    name,
    savedAt: new Date().toISOString(),
    transient: {
      duration,
      dt,
      nodes: nodes.map(node => ({
        id: node.id,
        type: node.type,
        position: node.position,
        style: node.style,
        data: node.data,
      })),
      edges: edges.map(edge => ({
        id: edge.id,
        type: edge.type,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        data: edge.data,
      })),
      graphs,
    },
  }), [dt, duration, edges, graphs, nodes])

  const saveSketchJson = useCallback(() => {
    const fallbackName = `transient-sketch-${new Date().toISOString().slice(0, 10)}`
    const name = window.prompt('保存するスケッチ名', fallbackName) || fallbackName
    const sketch = buildSketchJson(name)
    const blob = new Blob([JSON.stringify(sketch, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${name.replace(/[\\/:*?"<>|]/g, '_')}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setError(null)
  }, [buildSketchJson])

  const loadSketch = useCallback((sketch: SavedTransientSketch) => {
    if (sketch.version !== 1 || !sketch.transient || !Array.isArray(sketch.transient.nodes) || !Array.isArray(sketch.transient.edges)) {
      throw new Error('非定常スケッチJSONとして読み込めません')
    }
    const loadedNodes = sketch.transient.nodes.map(node => ({
      ...node,
      type: node.type ?? 'transientNode',
      style: node.style ?? DEFAULT_NODE_STYLE,
      data: node.data,
    })) as Node<TransientNodeData>[]
    const loadedEdges = sketch.transient.edges.map(edge => ({
      ...edge,
      type: edge.type ?? DEFAULT_EDGE_TYPE,
    })) as Edge[]
    setDuration(toNumber(sketch.transient.duration, 20))
    setDt(toNumber(sketch.transient.dt, 0.05))
    setNodes(loadedNodes)
    setEdges(loadedEdges)
    setGraphs(Array.isArray(sketch.transient.graphs) ? sketch.transient.graphs : [])
    setSelectedId(null)
    setSelectedEdgeId(null)
    setResult(null)
    setError(null)
    window.requestAnimationFrame(() => loadedNodes.forEach(node => updateNodeInternals(node.id)))
  }, [setEdges, setNodes, updateNodeInternals])

  const loadSketchJsonFile = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        loadSketch(JSON.parse(String(reader.result)) as SavedTransientSketch)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'スケッチJSONを読み込めませんでした')
      }
    }
    reader.onerror = () => setError('スケッチJSONを読み込めませんでした')
    reader.readAsText(file)
  }, [loadSketch])

  return (
    <div className="flex flex-col gap-5 pb-8">
      <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-gray-700">非定常流れ解析</span>
          <div className="h-5 w-px bg-gray-200" />
          {([
            ['analysis', '解析'],
            ['file', 'ファイル'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveToolbarTab(id)}
              className={[
                'rounded-md border px-3 py-1.5 text-sm font-medium',
                activeToolbarTab === id
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
          {error && <span className="text-sm text-red-500">{error}</span>}
        </div>
        {activeToolbarTab === 'analysis' ? (
          <div className="flex flex-wrap items-center gap-3">
            <InlineNumber label="計算時間" unit="s" value={duration} onChange={setDuration} />
            <InlineNumber label="時間刻み" unit="s" value={dt} onChange={setDt} />
            <button
              type="button"
              onClick={run}
              disabled={loading || nodes.length === 0}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? '計算中...' : '計算開始'}
            </button>
            <button
              type="button"
              onClick={deleteSelected}
              disabled={!hasSelection}
              className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              選択を削除
            </button>
            <button
              type="button"
              onClick={addGraph}
              disabled={!result}
              className="rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              グラフを挿入
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={loadSketchJsonFile}
              className="hidden"
            />
            <button
              type="button"
              onClick={saveSketchJson}
              disabled={nodes.length === 0 && edges.length === 0}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              JSON保存
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50"
            >
              JSON読み込み
            </button>
            <button
              type="button"
              onClick={clearSketch}
              disabled={nodes.length === 0 && edges.length === 0}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              スケッチをクリア
            </button>
            <span className="text-xs text-gray-400">ノード位置、サイズ、部品パラメータ、エッジ、計算設定、グラフ設定を保存します。</span>
          </div>
        )}
        {loading && (
          <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2">
            <div className="mb-1 flex items-center justify-between gap-3 text-xs text-blue-700">
              <span className="font-medium">計算タスク</span>
              <span>内部ステップ数 {internalStepCount.toLocaleString()} / 推定 {estimatedProgressPercent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white">
              <div
                className="h-full rounded-full bg-blue-600 transition-all duration-300"
                style={{ width: `${estimatedProgressPercent}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-blue-500">
              同期計算の完了待ちです。厳密なステップ進捗はジョブ化後に取得できます。
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm" style={{ height: 560 }}>
          <div className="flex h-full min-h-0">
            <aside className="flex h-full w-36 shrink-0 flex-col border-r border-slate-700 bg-slate-800 p-2 text-white">
              <div className="mb-2 text-center text-xs font-semibold text-slate-400">部品</div>
              <div className="mb-2 grid grid-cols-2 gap-1">
                {PALETTE_GROUPS.map(group => (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setActivePaletteGroup(group.id)}
                    className={[
                      'rounded border px-1.5 py-1 text-[11px] font-medium',
                      activePalette.id === group.id
                        ? 'border-blue-300 bg-blue-500 text-white'
                        : 'border-slate-600 bg-slate-900 text-slate-300 hover:bg-slate-700',
                    ].join(' ')}
                  >
                    {group.label}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <div className="flex flex-col gap-2">
                  {activePalette.items.map(([kind, label]) => (
                    <div
                      key={kind}
                      draggable
                      onDragStart={event => onPaletteDragStart(event, kind)}
                      className="flex cursor-grab items-center gap-2 rounded border border-slate-600 px-2 py-2 text-xs hover:bg-slate-700 active:cursor-grabbing"
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-blue-300 [&_svg]:h-5 [&_svg]:w-5">
                        <TransientNodeIcon kind={kind} />
                      </span>
                      <span className="min-w-0 truncate">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </aside>
            <div className="min-w-0 flex-1">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, node) => {
                  setSelectedId(node.id)
                  setSelectedEdgeId(null)
                }}
                onEdgeClick={(_, edge) => {
                  setSelectedEdgeId(edge.id)
                  setSelectedId(null)
                }}
                onPaneClick={() => {
                  setSelectedId(null)
                  setSelectedEdgeId(null)
                }}
                onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
                  setSelectedId(selectedNodes[0]?.id ?? null)
                  setSelectedEdgeId(selectedNodes.length > 0 ? null : selectedEdges[0]?.id ?? null)
                }}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                deleteKeyCode={['Backspace', 'Delete']}
                onDrop={onDrop}
                onDragOver={onDragOver}
                fitView
              >
                <Background gap={18} size={1} />
                <Controls />
                <MiniMap />
              </ReactFlow>
            </div>
          </div>
        </div>

        <aside className="flex flex-col gap-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div>
            <h2 className="mb-3 text-sm font-semibold text-gray-700">パラメータ</h2>
            {!selectedData ? (
              selectedEdge ? (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
                  <div className="font-medium text-gray-700">選択中のエッジ</div>
                  <div className="mt-1 text-xs">{selectedEdge.source} → {selectedEdge.target}</div>
                </div>
              ) : (
                <p className="text-sm text-gray-400">ノードまたはエッジを選択してください</p>
              )
            ) : (
              <div className="flex flex-col gap-3">
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <span className="w-28 shrink-0">名前</span>
                  <input
                    type="text"
                    value={selectedData.label}
                    onChange={e => updateSelected({ label: e.target.value })}
                    className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </label>
                {((selectedData.nodeType === 'pressureBoundary' && selectedData.externalInput !== true) || selectedData.nodeType === 'volume') && (
                  <InlineNumber label={selectedData.nodeType === 'volume' ? '初期圧力' : '圧力'} unit="kPa" value={toNumber(selectedData.pressure, 300)} onChange={value => updateSelected({ pressure: value })} />
                )}
                {(selectedData.nodeType === 'pressureBoundary' || selectedData.nodeType === 'flowBoundary') && (
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    <span className="w-28 shrink-0">外部入力</span>
                    <input
                      type="checkbox"
                      checked={selectedData.externalInput === true}
                      onChange={e => updateSelectedExternalInput(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </label>
                )}
                {selectedData.nodeType === 'fluid' && (
                  <>
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <span className="w-28 shrink-0">物性モード</span>
                      <select
                        value={String(selectedData.propertyMode ?? 'constantDensity')}
                        onChange={e => updateSelected({ propertyMode: e.target.value as 'constantDensity' | 'state' })}
                        className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="constantDensity">密度一定</option>
                        <option value="state">状態変化</option>
                      </select>
                    </label>
                    {selectedData.propertyMode === 'state' ? (
                      <label className="flex items-center gap-2 text-sm text-gray-600">
                        <span className="w-28 shrink-0">CoolProp</span>
                        <select
                          value={String(selectedData.coolPropFluid ?? 'Water')}
                          onChange={e => updateSelected({ coolPropFluid: e.target.value })}
                          className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          {COOLPROP_FLUIDS.map(fluid => (
                            <option key={fluid} value={fluid}>{fluid}</option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <>
                        <label className="flex items-center gap-2 text-sm text-gray-600">
                          <span className="w-28 shrink-0">ライブラリ</span>
                          <select
                            value={String(selectedData.fluidLibraryId ?? '')}
                            onChange={e => updateSelected({ fluidLibraryId: Number(e.target.value) || undefined })}
                            className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">選択</option>
                            {fluidLibrary.map(fluid => (
                              <option key={fluid.id} value={fluid.id}>{fluid.name}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={applySelectedFluidLibrary}
                            disabled={!selectedData.fluidLibraryId}
                            className="rounded-md border border-blue-200 bg-white px-2 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            読込
                          </button>
                        </label>
                        <InlineNumber label="密度" unit="kg/m3" value={toNumber(selectedData.density, 1000)} onChange={value => updateSelected({ density: value })} />
                        <InlineNumber label="粘度" unit="Pa s" value={toNumber(selectedData.viscosity, 0.001)} onChange={value => updateSelected({ viscosity: value })} />
                        <InlineNumber label="比熱" unit="J/(kg K)" value={toNumber(selectedData.specificHeat, 4184)} onChange={value => updateSelected({ specificHeat: value })} />
                        <InlineNumber label="熱伝導率" unit="W/(m K)" value={toNumber(selectedData.thermalConductivity, 0.6)} onChange={value => updateSelected({ thermalConductivity: value })} />
                      </>
                    )}
                  </>
                )}
                {selectedData.nodeType === 'solid' && (
                  <>
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <span className="w-28 shrink-0">材料DB</span>
                      <select
                        value={String(selectedData.materialId ?? '')}
                        onChange={e => updateSelected({ materialId: Number(e.target.value) || undefined })}
                        className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">選択</option>
                        {materials.map(material => (
                          <option key={material.id} value={material.id}>{material.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={applySelectedMaterial}
                        disabled={!selectedData.materialId}
                        className="rounded-md border border-blue-200 bg-white px-2 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        読込
                      </button>
                    </label>
                    <InlineNumber label="密度" unit="kg/m3" value={toNumber(selectedData.density, 7800)} onChange={value => updateSelected({ density: value })} />
                    <InlineNumber label="比熱" unit="J/(kg K)" value={toNumber(selectedData.specificHeat, 500)} onChange={value => updateSelected({ specificHeat: value })} />
                    <InlineNumber label="熱伝導率" unit="W/(m K)" value={toNumber(selectedData.thermalConductivity, 16)} onChange={value => updateSelected({ thermalConductivity: value })} />
                  </>
                )}
                {selectedData.nodeType !== 'fluid' && selectedData.nodeType !== 'solid' && selectedData.nodeType !== 'constantSignal' && selectedData.nodeType !== 'fixedRotation' && selectedData.nodeType !== 'fixedTorque' && selectedData.nodeType !== 'fixedTemperature' && selectedData.nodeType !== 'thermalMass' && selectedData.nodeType !== 'heatBoundary' && (
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    <span className="w-28 shrink-0">流体</span>
                    <select
                      value={String(selectedData.fluidRef ?? '')}
                      onChange={e => updateSelected({ fluidRef: e.target.value })}
                      className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">未設定</option>
                      {fluidNodes.map(node => (
                        <option key={node.id} value={node.id}>{node.data.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {selectedData.nodeType === 'thermalMass' && (
                  <>
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <span className="w-28 shrink-0">固体</span>
                      <select
                        value={String(selectedData.solidRef ?? '')}
                        onChange={e => updateSelected({ solidRef: e.target.value })}
                        className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">未設定</option>
                        {solidNodes.map(node => (
                          <option key={node.id} value={node.id}>{node.data.label}</option>
                        ))}
                      </select>
                    </label>
                    <InlineNumber label="質量" unit="kg" value={toNumber(selectedData.mass, 1)} onChange={value => updateSelected({ mass: value })} />
                    <InlineNumber label="初期温度" unit="K" value={toNumber(selectedData.temperature, 293.15)} onChange={value => updateSelected({ temperature: value })} />
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                      熱容量 {formatResultValue(selectedHeatCapacity, 3)} J/K
                    </div>
                  </>
                )}
                {selectedData.nodeType === 'tank' && (
                  <>
                    <InlineNumber label="初期水位" unit="m" value={toNumber(selectedData.initialLevel, 1)} onChange={value => updateSelected({ initialLevel: value })} />
                    <InlineNumber label="最大水位" unit="m" value={toNumber(selectedData.maxLevel, 2)} onChange={value => updateSelected({ maxLevel: value })} />
                    <InlineNumber label="断面積" unit="m2" value={toNumber(selectedData.tankArea, 1)} onChange={value => updateSelected({ tankArea: value })} />
                    <InlineNumber label="初期温度" unit="K" value={toNumber(selectedData.initialTemperature, 293.15)} onChange={value => updateSelected({ initialTemperature: value })} />
                    <InlineNumber label="ポート数" value={Math.max(1, Math.floor(toNumber(selectedData.portCount, 1)))} onChange={updateSelectedTankPortCount} />
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <span className="w-28 shrink-0">熱考慮</span>
                      <input
                        type="checkbox"
                        checked={selectedData.heatEnabled === true}
                        onChange={e => updateSelectedHeatEnabled(e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </label>
                    {selectedData.heatEnabled === true && (
                      <>
                        <label className="flex items-center gap-2 text-sm text-gray-600">
                          <span className="w-28 shrink-0">材質</span>
                          <select
                            value={String(selectedData.solidRef ?? '')}
                            onChange={e => updateSelected({ solidRef: e.target.value })}
                            className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">未設定</option>
                            {solidNodes.map(node => (
                              <option key={node.id} value={node.id}>{node.data.label}</option>
                            ))}
                          </select>
                        </label>
                        <InlineNumber label="板厚" unit="mm" value={toNumber(selectedData.wallThickness, 2)} onChange={value => updateSelected({ wallThickness: value })} />
                        <InlineNumber label="外側熱伝達率" unit="W/(m2 K)" value={toNumber(selectedData.outerHeatTransferCoeff, 10)} onChange={value => updateSelected({ outerHeatTransferCoeff: value })} />
                        <InlineNumber label="内側熱伝達率" unit="W/(m2 K)" value={toNumber(selectedData.innerHeatTransferCoeff, 50)} onChange={value => updateSelected({ innerHeatTransferCoeff: value })} />
                        <InlineNumber label="伝熱面積" unit="m2" value={toNumber(selectedData.heatArea, 1)} onChange={value => updateSelected({ heatArea: value })} />
                      </>
                    )}
                  </>
                )}
                {selectedData.nodeType === 'flowBoundary' && selectedData.externalInput !== true && (
                  <InlineNumber label="流量" unit="m3/h" value={toNumber(selectedData.flowRate, 1)} onChange={value => updateSelected({ flowRate: value })} />
                )}
                {selectedData.nodeType === 'constantSignal' && (
                  <InlineNumber label="出力値" value={toNumber(selectedData.signalValue, 1)} onChange={value => updateSelected({ signalValue: value })} />
                )}
                {selectedData.nodeType === 'fixedRotation' && (
                  <InlineNumber label="固定回転数" unit="rpm" value={toNumber(selectedData.fixedSpeed, 1450)} onChange={value => updateSelected({ fixedSpeed: value })} />
                )}
                {selectedData.nodeType === 'fixedTorque' && (
                  <InlineNumber label="固定トルク" unit="N m" value={toNumber(selectedData.fixedTorque, 10)} onChange={value => updateSelected({ fixedTorque: value })} />
                )}
                {(selectedData.nodeType === 'fixedTemperature' || selectedData.nodeType === 'heatBoundary') && (
                  <InlineNumber label="温度" unit="K" value={toNumber(selectedData.heatTemperature, 293.15)} onChange={value => updateSelected({ heatTemperature: value })} />
                )}
                {selectedData.nodeType === 'volume' && (
                  <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                    容量のコンプライアンスは現在は既定値で計算します。
                  </p>
                )}
                {selectedData.nodeType === 'pipe' && (
                  <>
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <span className="w-28 shrink-0">配管タイプ</span>
                      <select
                        value={selectedData.pipeShape === 'rectangular' ? 'rectangular' : 'circular'}
                        onChange={e => updateSelected({ pipeShape: e.target.value as 'circular' | 'rectangular' })}
                        className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="circular">円形</option>
                        <option value="rectangular">矩形</option>
                      </select>
                    </label>
                    {selectedData.pipeShape === 'rectangular' ? (
                      <>
                        <InlineNumber label="幅" unit="mm" value={toNumber(selectedData.width, 100)} onChange={value => updateSelected({ width: value })} />
                        <InlineNumber label="高さ" unit="mm" value={toNumber(selectedData.ductHeight, 50)} onChange={value => updateSelected({ ductHeight: value })} />
                      </>
                    ) : (
                      <InlineNumber label="内径" unit="mm" value={toNumber(selectedData.diameter, 100)} onChange={value => updateSelected({ diameter: value })} />
                    )}
                    <InlineNumber label="長さ" unit="m" value={toNumber(selectedData.length, 10)} onChange={value => updateSelected({ length: value })} />
                    <InlineNumber label="粗さ" unit="mm" value={toNumber(selectedData.roughness, 0.046)} onChange={value => updateSelected({ roughness: value })} />
                    <InlineNumber label="初期温度" unit="K" value={toNumber(selectedData.initialTemperature, 293.15)} onChange={value => updateSelected({ initialTemperature: value })} />
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <span className="w-28 shrink-0">熱考慮</span>
                      <input
                        type="checkbox"
                        checked={selectedData.heatEnabled === true}
                        onChange={e => updateSelectedHeatEnabled(e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </label>
                    <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                      摩擦係数はブラジウス式で計算します。
                    </p>
                  </>
                )}
                {selectedData.nodeType === 'pump' && (
                  <>
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <span className="w-28 shrink-0">PQ入力</span>
                      <select
                        value={String(selectedData.pumpCurveMode ?? 'simple')}
                        onChange={e => {
                          const mode = e.target.value as 'simple' | 'table'
                          updateSelected({
                            pumpCurveMode: mode,
                            ...(mode === 'table' && normalizePumpCurvePoints(selectedData.pumpCurvePoints).length === 0
                              ? { pumpCurvePoints: [{ q: 0, h: toNumber(selectedData.shutoffHead, 30) }, { q: toNumber(selectedData.ratedFlow, 30), h: toNumber(selectedData.ratedHead, 20) }] }
                              : {}),
                          })
                        }}
                        className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="simple">簡易曲線</option>
                        <option value="table">テーブル</option>
                      </select>
                    </label>
                    {selectedData.pumpCurveMode !== 'table' && (
                      <>
                        <InlineNumber label="定格流量" unit="m3/h" value={toNumber(selectedData.ratedFlow, 30)} onChange={value => updateSelected({ ratedFlow: value })} />
                        <InlineNumber label="定格揚程" unit="m" value={toNumber(selectedData.ratedHead, 20)} onChange={value => updateSelected({ ratedHead: value })} />
                        <InlineNumber label="締切揚程" unit="m" value={toNumber(selectedData.shutoffHead, 30)} onChange={value => updateSelected({ shutoffHead: value })} />
                      </>
                    )}
                    {selectedData.pumpCurveMode === 'table' && (
                      <div className="rounded-lg border border-gray-200 bg-gray-50 p-2">
                        <div className="mb-2 grid grid-cols-[1fr_1fr_44px] gap-2 text-[11px] font-semibold text-gray-500">
                          <span>流量 [m3/h]</span>
                          <span>揚程 [m]</span>
                          <span />
                        </div>
                        <div className="flex flex-col gap-2">
                          {(normalizePumpCurvePoints(selectedData.pumpCurvePoints).length > 0
                            ? normalizePumpCurvePoints(selectedData.pumpCurvePoints)
                            : [{ q: 0, h: toNumber(selectedData.shutoffHead, 30) }, { q: toNumber(selectedData.ratedFlow, 30), h: toNumber(selectedData.ratedHead, 20) }]
                          ).map((point, index) => (
                            <div key={index} className="grid grid-cols-[1fr_1fr_44px] gap-2">
                              <input
                                type="number"
                                value={Number.isFinite(point.q) ? point.q : 0}
                                onChange={e => updateSelectedPumpCurvePoint(index, { q: Number(e.target.value) })}
                                className="min-w-0 rounded-md border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                              <input
                                type="number"
                                value={Number.isFinite(point.h) ? point.h : 0}
                                onChange={e => updateSelectedPumpCurvePoint(index, { h: Number(e.target.value) })}
                                className="min-w-0 rounded-md border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                              <button
                                type="button"
                                onClick={() => removeSelectedPumpCurvePoint(index)}
                                className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
                              >
                                削除
                              </button>
                            </div>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={addSelectedPumpCurvePoint}
                          className="mt-2 w-full rounded-md border border-blue-200 bg-white px-2 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50"
                        >
                          点を追加
                        </button>
                      </div>
                    )}
                    <InlineNumber label="基準回転数" unit="rpm" value={toNumber(selectedData.ratedSpeed, 1450)} onChange={value => updateSelected({ ratedSpeed: value })} />
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <span className="w-28 shrink-0">外部駆動</span>
                      <input
                        type="checkbox"
                        checked={selectedData.driveExternal === true}
                        onChange={e => updateSelectedPumpDriveExternal(e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    </label>
                    {selectedData.driveExternal !== true && (
                      <InlineNumber label="回転数" unit="rpm" value={toNumber(selectedData.speed, 1450)} onChange={value => updateSelected({ speed: value })} />
                    )}
                    <InlineNumber label="効率" unit="%" value={toNumber(selectedData.efficiency, 70)} onChange={value => updateSelected({ efficiency: value })} />
                    <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                      テーブル入力では流量順に並べた点を線形補間し、回転数は相似則で換算します。
                    </p>
                  </>
                )}
                {selectedData.nodeType === 'valve' && (
                  <>
                    <InlineNumber label="全開Cv" value={toNumber(selectedData.valveCv, 50)} onChange={value => updateSelected({ valveCv: value })} />
                    <InlineNumber label="開度" unit="%" value={toNumber(selectedData.valveOpening, 100)} onChange={value => updateSelected({ valveOpening: value })} />
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <span className="w-28 shrink-0">開度特性</span>
                      <select
                        value={String(selectedData.valveCharacteristic ?? 'linear')}
                        onChange={e => updateSelected({ valveCharacteristic: e.target.value as 'linear' | 'equalPercentage' | 'quickOpening' })}
                        className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="linear">リニア</option>
                        <option value="equalPercentage">イコール%</option>
                        <option value="quickOpening">クイック</option>
                      </select>
                    </label>
                    {selectedData.valveCharacteristic === 'equalPercentage' && (
                      <InlineNumber label="レンジアビリティ" value={toNumber(selectedData.valveRangeability, 50)} onChange={value => updateSelected({ valveRangeability: value })} />
                    )}
                    <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                      有効Cv = 全開Cv x 開度特性として、Cv式から圧力損失を計算します。
                    </p>
                  </>
                )}
                {selectedData.nodeType !== 'fluid' && selectedData.nodeType !== 'solid' && selectedData.nodeType !== 'constantSignal' && selectedData.nodeType !== 'fixedRotation' && selectedData.nodeType !== 'fixedTorque' && selectedData.nodeType !== 'fixedTemperature' && selectedData.nodeType !== 'thermalMass' && selectedData.nodeType !== 'heatBoundary' && selectedData.nodeType !== 'pressureBoundary' && selectedData.nodeType !== 'flowBoundary' && selectedData.nodeType !== 'volume' && selectedData.nodeType !== 'tank' && selectedData.nodeType !== 'pipe' && selectedData.nodeType !== 'pump' && selectedData.nodeType !== 'valve' && (
                  <InlineNumber label="抵抗係数" unit="kPa/(m3/s)" value={toNumber(selectedData.resistance, 100000)} onChange={value => updateSelected({ resistance: value })} />
                )}
              </div>
            )}
          </div>

          <div className="border-t border-gray-200 pt-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">計算結果</h2>
            {!result ? (
              <p className="text-sm text-gray-400">計算後に最終時刻の結果を表示します</p>
            ) : !selectedNode ? (
              <p className="text-sm text-gray-400">ノードを選択してください</p>
            ) : selectedResultRows.length === 0 ? (
              <p className="text-sm text-gray-400">表示できる結果がありません</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
                <div className="mb-2 text-xs font-semibold text-gray-600">{selectedNode.data.label}</div>
                <table className="w-full text-xs">
                  <thead className="bg-white text-gray-500">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">項目</th>
                      <th className="px-2 py-1.5 text-left font-medium">単位</th>
                      <th className="px-2 py-1.5 text-right font-medium">値</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedResultRows.map(row => (
                      <tr
                        key={`${row.item}-${row.unit}`}
                        draggable
                        onDragStart={event => onResultDragStart(event, row.source)}
                        className="cursor-grab border-t border-gray-200 bg-gray-50 hover:bg-blue-50 active:cursor-grabbing"
                        title="グラフへドラッグできます"
                      >
                        <td className="px-2 py-1.5 text-gray-600">{row.item}</td>
                        <td className="px-2 py-1.5 text-gray-500">{row.unit}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-gray-800">{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </aside>
      </div>

      {result && graphs.length > 0 && (
        <div className="grid gap-5 xl:grid-cols-2">
          {graphs.map(graph => {
            const xSource = graph.mode === 'time' ? { kind: 'time' as const, label: '時間', unit: 's' } : graph.xSource
            const xValues = xSource ? sourceValues(xSource) : []
            const traces = graph.ySources.map(source => ({
              x: xValues,
              y: sourceValues(source),
              type: 'scatter' as const,
              mode: 'lines' as const,
              name: source.label,
            }))
            const yUnit = graph.ySources[0]?.unit ?? ''
            const yAxisLabel = (() => {
              if (graph.ySources.length === 0) return '縦軸'
              const labels = graph.ySources.map(source => source.label).join(' / ')
              const sameUnit = graph.ySources.every(source => source.unit === yUnit)
              return sameUnit && yUnit ? `${labels} [${yUnit}]` : labels
            })()
            return (
              <div key={graph.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-gray-700">{graph.title}</h2>
                  <div className="flex items-center gap-2">
                    {graph.mode === 'xy' && (
                      <button
                        type="button"
                        onClick={() => swapGraphAxes(graph.id)}
                        disabled={!graph.xSource || graph.ySources.length === 0}
                        className="rounded-md border border-blue-200 px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        XY反転
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeGraph(graph.id)}
                      className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50"
                    >
                      削除
                    </button>
                  </div>
                </div>
                <div className="mb-3 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
                  {([
                    ['time', '時刻歴'],
                    ['xy', 'X/Y'],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setGraphMode(graph.id, mode)}
                      className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                        graph.mode === mode
                          ? 'bg-white text-blue-700 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {((graph.mode === 'xy' && graph.xSource) || graph.ySources.length > 0) && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {graph.mode === 'xy' && graph.xSource && (
                      <button
                        type="button"
                        onClick={() => clearGraphXSource(graph.id)}
                        className="rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100"
                        title="X軸を解除します。次にドロップした結果がX軸になります。"
                      >
                        X: {graph.xSource.label}
                        <span className="ml-1 text-blue-500">×</span>
                      </button>
                    )}
                    {graph.ySources.map(source => (
                      <button
                        key={JSON.stringify(source)}
                        type="button"
                        onClick={() => removeGraphSeries(graph.id, source)}
                        className="rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
                      >
                        {source.label}
                      </button>
                    ))}
                  </div>
                )}
                <div
                  onDrop={event => onGraphDrop(event, graph.id)}
                  onDragOver={onGraphDragOver}
                  className="min-h-80 rounded-lg border border-dashed border-gray-200"
                >
                  {traces.length === 0 ? (
                    <div className="flex h-80 items-center justify-center rounded-lg bg-gray-50 px-4 text-center text-sm text-gray-400">
                      {graph.mode === 'time'
                        ? '時刻歴に表示したい結果をドロップしてください'
                        : graph.xSource
                          ? 'Y軸に表示したい結果をドロップしてください'
                          : 'X軸にしたい結果をドロップしてください'}
                    </div>
                  ) : (
                    <Plot
                      data={traces}
                      layout={{
                        height: 320,
                        margin: { l: 55, r: 20, t: 10, b: 45 },
                        xaxis: { title: { text: xSource ? `${xSource.label} [${xSource.unit}]` : '横軸' } },
                        yaxis: { title: { text: yAxisLabel } },
                      }}
                      config={{ responsive: true, displaylogo: false }}
                      className="w-full"
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {result && result.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {result.warnings.join(' / ')}
        </div>
      )}
    </div>
  )
}

export default function TransientNetworkCalc(props: Props) {
  return (
    <ReactFlowProvider>
      <TransientNetworkCalcInner {...props} />
    </ReactFlowProvider>
  )
}
