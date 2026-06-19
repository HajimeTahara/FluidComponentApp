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
type ReducerLossMode = 'auto' | 'manual'
type ElbowLossMode = 'auto' | 'manual'
type ValveCharacteristic = 'linear' | 'quickOpening' | 'equalPercentage'
type LineType = 'fluid' | 'power'
type FluidSystem = {
  id: string
  name: string
  fluid: string
  propertyMode: 'constant'
  density: number
  viscosity: number // Pa·s
  specificHeat: number
  color: string
}

const PRESSURE_UNITS: PressureUnit[] = ['m', 'Pa', 'kPa', 'MPa', 'bar']
const G_ACCEL = 9.80665
const DEFAULT_FLUID_SYSTEM_ID = 'water-loop'
const FLUID_SYSTEM_COLORS = ['#0ea5e9', '#f97316', '#10b981', '#a855f7', '#e11d48', '#64748b']

function createDefaultFluidSystems(): FluidSystem[] {
  return [{
    id: DEFAULT_FLUID_SYSTEM_ID,
    name: 'Water',
    fluid: 'Water',
    propertyMode: 'constant',
    density: 1000,
    viscosity: 0.001,
    specificHeat: 4184,
    color: FLUID_SYSTEM_COLORS[0],
  }]
}

function fluidSystemForNode(data: NetworkNodeData, systems: FluidSystem[]): FluidSystem {
  return systems.find(system => system.id === data.fluidSystemId) ?? systems[0] ?? createDefaultFluidSystems()[0]
}

function fluidColorForEdge(edge: Edge, nodes: Node[], systems: FluidSystem[]): string {
  const sourceData = nodes.find(n => n.id === edge.source)?.data as unknown as NetworkNodeData | undefined
  const targetData = nodes.find(n => n.id === edge.target)?.data as unknown as NetworkNodeData | undefined
  const sourceSystem = sourceData ? fluidSystemForNode(sourceData, systems) : null
  const targetSystem = targetData ? fluidSystemForNode(targetData, systems) : null
  if (sourceSystem && targetSystem && sourceSystem.id !== targetSystem.id) return '#64748b'
  return (sourceSystem ?? targetSystem ?? systems[0] ?? createDefaultFluidSystems()[0]).color
}

type PowerSpeedResolution = {
  speeds: Map<string, number>
  torques: Map<string, number>
  modes: Map<string, 'fixed' | 'torque' | 'fallback'>
  errors: string[]
}

function motorTorqueAtSpeed(data: NetworkNodeData, speedRpm: number): number {
  const ns = Math.max(motorSynchronousSpeed(data), 1e-9)
  const nr = Math.max(motorRatedSpeed(data), 1e-9)
  const ratedPowerKw = Math.max(data.motorRatedPower ?? 5.5, 0)
  const ratedSlip = Math.max((ns - nr) / ns, 1e-6)
  const omegaRated = 2 * Math.PI * nr / 60
  const ratedTorqueNm = omegaRated > 0 ? ratedPowerKw * 1000 / omegaRated : 0
  const maxTorqueNm = ratedTorqueNm * 2.5
  const ratio = ratedTorqueNm > 0 && maxTorqueNm > 0 ? ratedTorqueNm / maxTorqueNm : 0.4
  const a = Math.max(2 / Math.max(ratio, 1e-6), 2.000001)
  const breakdownSlip = Math.min(ratedSlip * ((a + Math.sqrt(a * a - 4)) / 2), 0.95)
  const slip = Math.max((ns - Math.min(Math.max(speedRpm, 0), ns)) / ns, 1e-6)
  return Math.max(maxTorqueNm * 2 / ((slip / breakdownSlip) + (breakdownSlip / slip)), 0)
}

function pumpRatedTorque(data: NetworkNodeData, rho = 1000): number {
  const ratedSpeed = Math.max(data.ratedSpeed ?? 1450, 1e-9)
  const ratedFlowM3s = Math.max(data.ratedFlow ?? 30, 0) / 3600
  const ratedHead = Math.max(data.ratedHead ?? 20, 0)
  const efficiency = Math.max(data.efficiency ?? 70, 1e-9) / 100
  const shaftPowerW = rho * G_ACCEL * ratedHead * ratedFlowM3s / efficiency
  const omega = 2 * Math.PI * ratedSpeed / 60
  return omega > 0 ? Math.max(shaftPowerW / omega, 0) : 0
}

function pumpTorqueAtSpeed(data: NetworkNodeData, speedRpm: number, rho = 1000): number {
  const ratedSpeed = Math.max(data.ratedSpeed ?? 1450, 1e-9)
  const ratio = Math.max(speedRpm, 0) / ratedSpeed
  return pumpRatedTorque(data, rho) * ratio * ratio
}

function turbineRatedTorque(data: NetworkNodeData, rho = 1000): number {
  const ratedSpeed = Math.max(data.ratedSpeed ?? 1450, 1e-9)
  const ratedFlowM3s = Math.max(data.ratedFlow ?? 30, 0) / 3600
  const ratedHead = Math.max(data.ratedHead ?? 20, 0)
  const efficiency = Math.max(data.efficiency ?? 85, 0) / 100
  const shaftPowerW = rho * G_ACCEL * ratedHead * ratedFlowM3s * efficiency
  const omega = 2 * Math.PI * ratedSpeed / 60
  return omega > 0 ? Math.max(shaftPowerW / omega, 0) : 0
}

function turbineTorqueAtSpeed(data: NetworkNodeData, speedRpm: number, rho = 1000): number {
  const ratedSpeed = Math.max(data.ratedSpeed ?? 1450, 1e-9)
  const ratio = Math.max(speedRpm, 0) / ratedSpeed
  return turbineRatedTorque(data, rho) * ratio * ratio
}

function motorPowerAtSpeed(data: NetworkNodeData, speedRpm: number): number {
  const omega = 2 * Math.PI * Math.max(speedRpm, 0) / 60
  return Math.max(motorTorqueAtSpeed(data, speedRpm) * omega / 1000, 0)
}

function resolvePowerSpeeds(nodes: Node[], edges: Edge[], fluidSystems: FluidSystem[]): PowerSpeedResolution {
  const parent = new Map<string, string>()
  const nodeById = new Map(nodes.map(n => [n.id, n]))
  const add = (id: string) => {
    if (!parent.has(id)) parent.set(id, id)
  }
  const find = (id: string): string => {
    add(id)
    const p = parent.get(id)!
    if (p === id) return id
    const root = find(p)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }

  nodes.forEach(n => add(n.id))
  edges
    .filter(e => ((e.data as FlowEdgeData | undefined)?.lineType ?? 'fluid') === 'power')
    .forEach(e => union(e.source, e.target))

  const fixedByRoot = new Map<string, { speed: number; label: string }>()
  const errors: string[] = []
  for (const node of nodes) {
    const data = node.data as unknown as NetworkNodeData
    if (data.nodeType !== 'speedBoundary') continue
    const speed = Math.max(data.fixedSpeed ?? 1450, 0)
    const root = find(node.id)
    const existing = fixedByRoot.get(root)
    if (existing && Math.abs(existing.speed - speed) > 1e-6) {
      errors.push(`動力ラインに異なる固定回転数が接続されています: ${existing.label}=${existing.speed} rpm, ${data.label}=${speed} rpm`)
    } else {
      fixedByRoot.set(root, { speed, label: data.label })
    }
  }

  const membersByRoot = new Map<string, Node[]>()
  for (const node of nodes) {
    const root = find(node.id)
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), node])
  }

  const speeds = new Map<string, number>()
  const torques = new Map<string, number>()
  const modes = new Map<string, 'fixed' | 'torque' | 'fallback'>()
  const setGroup = (members: Node[], speed: number, mode: 'fixed' | 'torque' | 'fallback') => {
    for (const member of members) {
      if (!nodeById.has(member.id)) continue
      const data = member.data as unknown as NetworkNodeData
      const system = fluidSystemForNode(data, fluidSystems)
      speeds.set(member.id, speed)
      modes.set(member.id, mode)
      if (data.nodeType === 'motor') torques.set(member.id, motorTorqueAtSpeed(data, speed))
      if (data.nodeType === 'turbine') torques.set(member.id, turbineTorqueAtSpeed(data, speed, system.density))
      if (data.nodeType === 'pump') torques.set(member.id, pumpTorqueAtSpeed(data, speed, system.density))
    }
  }

  for (const [root, members] of membersByRoot) {
    const fixed = fixedByRoot.get(root)
    if (fixed) {
      setGroup(members, fixed.speed, 'fixed')
      continue
    }

    const motors = members.filter(n => ((n.data as unknown as NetworkNodeData).nodeType === 'motor'))
    const turbines = members.filter(n => ((n.data as unknown as NetworkNodeData).nodeType === 'turbine'))
    const pumps = members.filter(n => ((n.data as unknown as NetworkNodeData).nodeType === 'pump'))
    if ((motors.length > 0 || turbines.length > 0) && pumps.length > 0) {
      const motorDatas = motors.map(n => n.data as unknown as NetworkNodeData)
      const turbineDatas = turbines.map(n => {
        const data = n.data as unknown as NetworkNodeData
        return { data, rho: fluidSystemForNode(data, fluidSystems).density }
      })
      const pumpDatas = pumps.map(n => {
        const data = n.data as unknown as NetworkNodeData
        return { data, rho: fluidSystemForNode(data, fluidSystems).density }
      })
      const producerSpeedLimits = [
        ...motorDatas.map(motorSynchronousSpeed),
        ...turbineDatas.map(item => item.data.ratedSpeed ?? 1450),
      ].filter(v => v > 0)
      const maxSpeed = Math.max(Math.min(...producerSpeedLimits) * 0.999, 1)
      const balance = (speed: number) => (
        motorDatas.reduce((sum, data) => sum + motorTorqueAtSpeed(data, speed), 0)
        + turbineDatas.reduce((sum, item) => sum + turbineTorqueAtSpeed(item.data, speed, item.rho), 0)
        - pumpDatas.reduce((sum, item) => sum + pumpTorqueAtSpeed(item.data, speed, item.rho), 0)
      )
      let lo = maxSpeed * 1e-6
      let hi = maxSpeed
      let flo = balance(lo)
      const fhi = balance(hi)
      if (flo <= 0 && fhi <= 0) {
        errors.push(`動力ラインの始動トルクが不足しています: ${members.map(n => (n.data as unknown as NetworkNodeData).label).join(', ')}`)
        setGroup(members, Math.max(...pumpDatas.map(item => item.data.ratedSpeed ?? 1450)), 'fallback')
        continue
      }
      if (flo >= 0 && fhi >= 0) {
        setGroup(members, hi, 'torque')
        continue
      }
      for (let i = 0; i < 80; i += 1) {
        const mid = (lo + hi) / 2
        const fm = balance(mid)
        if (Math.abs(fm) < 1e-6) {
          lo = mid
          hi = mid
          break
        }
        if (Math.sign(fm) === Math.sign(flo)) {
          lo = mid
          flo = fm
        } else {
          hi = mid
        }
      }
      setGroup(members, (lo + hi) / 2, 'torque')
      continue
    }

    const fallbackSpeed = motors.length > 0
      ? Math.max(Math.min(...motors.map(n => motorSynchronousSpeed(n.data as unknown as NetworkNodeData))) * 0.999, 0)
      : turbines.length > 0
        ? Math.max(...turbines.map(n => (n.data as unknown as NetworkNodeData).ratedSpeed ?? 1450), 0)
      : Math.max(...members.map(n => {
        const data = n.data as unknown as NetworkNodeData
        return data.nodeType === 'pump' ? data.ratedSpeed ?? 1450 : 0
      }), 0)
    if (fallbackSpeed > 0) setGroup(members, fallbackSpeed, 'fallback')
  }
  return { speeds, torques, modes, errors }
}

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

function valveRelativeCapacity(data: NetworkNodeData, openingPercent = data.valveOpening ?? 100): number {
  const opening = Math.min(Math.max(openingPercent, 0), 100) / 100
  if (opening <= 0) return 1e-6
  if ((data.valveCharacteristic ?? 'linear') === 'quickOpening') {
    return Math.max(Math.sqrt(opening), 1e-6)
  }
  if ((data.valveCharacteristic ?? 'linear') === 'equalPercentage') {
    const rangeability = Math.max(data.valveRangeability ?? 50, 1.000001)
    return Math.max(rangeability ** (opening - 1), 1e-6)
  }
  return Math.max(opening, 1e-6)
}

function valveEffectiveZeta(data: NetworkNodeData, openingPercent = data.valveOpening ?? 100): number {
  const zetaFullOpen = Math.max(data.valveZetaFullOpen ?? 1, 0)
  const relativeCapacity = valveRelativeCapacity(data, openingPercent)
  return zetaFullOpen > 0 ? zetaFullOpen / (relativeCapacity ** 2) : 0
}

function motorSynchronousSpeed(data: NetworkNodeData): number {
  const frequency = Math.max(data.motorFrequency ?? 50, 0)
  const poles = Math.max(Math.round(data.motorPoles ?? 4), 1)
  return 120 * frequency / poles
}

function motorRatedSpeed(data: NetworkNodeData): number {
  const slip = Math.min(Math.max(data.motorSlip ?? 3, 0), 100) / 100
  return motorSynchronousSpeed(data) * (1 - slip)
}

function motorInputPower(data: NetworkNodeData): number {
  const efficiency = Math.max(data.motorEfficiency ?? 90, 1e-9) / 100
  return Math.max(data.motorRatedPower ?? 5.5, 0) / efficiency
}

type NetworkNodeData = {
  nodeType: 'boundary' | 'source' | 'pipe' | 'pump' | 'turbine' | 'heatExchanger' | 'reducer' | 'elbow' | 'valve' | 'motor' | 'speedBoundary' | 'tee' | 'sink'
  label: string
  fluidSystemId?: string
  // boundary/source/sink: unified boundary condition
  // flow: Q is fixed input → P is computed result
  // pressure: P is fixed input → Q is computed result
  boundaryType?: 'flow' | 'pressure'
  flowRate?: number       // flow-type: m³/h
  pressure?: number       // pressure-type: kPa
  temperature?: number    // boundary temperature: K
  calcPressure?: number   // flow-type result: required pressure kPa
  calcFlow?: number       // pressure-type result: computed flow m³/h
  calcTemperature?: number // propagated boundary/source temperature K
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
  speed?: number          // rpm: power network resolved speed
  shaftTorque?: number    // Nm: power network resolved torque
  speedSolveMode?: 'fixed' | 'torque' | 'fallback'
  pumpCurveMode?: PumpCurveMode
  pumpCurvePoints?: PumpCurvePoint[]
  // heat exchanger
  exchangeTemperature?: number // K
  heatTransferCoeff?: number   // W/m²/K
  heatTransferArea?: number    // m²
  nominalPressureDrop?: number // kPa at ratedFlow
  // reducer / expander
  diameterIn?: number          // mm
  diameterOut?: number         // mm
  lossMode?: ReducerLossMode
  lossCoefficient?: number
  // elbow
  elbowLossMode?: ElbowLossMode
  angle?: number               // deg
  zeta90?: number
  // valve
  valveCharacteristic?: ValveCharacteristic
  valveOpening?: number         // %
  valveZetaFullOpen?: number
  valveRangeability?: number
  // induction motor
  motorRatedPower?: number       // kW, shaft output
  motorEfficiency?: number       // %
  motorVoltage?: number          // V
  motorFrequency?: number        // Hz
  motorPoles?: number
  motorSlip?: number             // %
  // speed boundary
  fixedSpeed?: number             // rpm
  // tee (flow split is physics-based; no manual parameter)
  teeMode?: 'split' | 'merge'
  // result
  result?: PipeSegmentResult
  resultVisibleSymbols?: string[]
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

function portHandleStyle(color: string, role: 'in' | 'out', lineType: LineType = 'fluid'): CSSProperties {
  const base: CSSProperties = {
    width: lineType === 'power' ? 13 : 14,
    height: lineType === 'power' ? 13 : 14,
    borderRadius: lineType === 'power' ? 2 : '9999px',
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

function pumpShaftTorqueAtFlow(data: NetworkNodeData, qM3h: number, rho = 1000): number {
  const speed = Math.max(data.speed ?? data.ratedSpeed ?? 1450, 0)
  const omega = 2 * Math.PI * speed / 60
  if (omega <= 1e-12) return 0
  const qM3s = Math.max(qM3h, 0) / 3600
  const head = pumpHeadAt(data, qM3h)
  const efficiency = Math.max(data.efficiency ?? 70, 1e-9) / 100
  const shaftPowerW = rho * G_ACCEL * head * qM3s / efficiency
  return Math.max(shaftPowerW / omega, 0)
}

function turbineHeadAtFlow(data: NetworkNodeData, qM3h: number): number {
  const ratedFlow = Math.max(data.ratedFlow ?? 30, 1e-9)
  const ratedHead = Math.max(data.ratedHead ?? 20, 0)
  return ratedHead * (Math.max(qM3h, 0) / ratedFlow) ** 2
}

function turbineOutputPowerAtFlow(data: NetworkNodeData, qM3h: number, rho = 1000): number {
  const qM3s = Math.max(qM3h, 0) / 3600
  const head = turbineHeadAtFlow(data, qM3h)
  const efficiency = Math.max(data.efficiency ?? 85, 0) / 100
  return rho * G_ACCEL * head * qM3s * efficiency / 1000
}

function turbineShaftTorqueAtFlow(data: NetworkNodeData, qM3h: number, rho = 1000): number {
  const speed = Math.max(data.speed ?? data.ratedSpeed ?? 1450, 0)
  const omega = 2 * Math.PI * speed / 60
  return omega > 1e-12 ? turbineOutputPowerAtFlow(data, qM3h, rho) * 1000 / omega : 0
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

function SvgTurbine({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="7" />
      <path d="M2 12h3" />
      <path d="M19 12h3" />
      <path d="M14 8l-5 4 5 4V8z" />
      <path d="M12 5v3" />
      <path d="M12 16v3" />
    </svg>
  )
}

function SvgHeatExchanger({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M6 9h12" />
      <path d="M6 15h12" />
      <path d="M8 3v3" />
      <path d="M16 18v3" />
      <path d="M9 12h6" />
      <path d="M13 10l2 2-2 2" />
    </svg>
  )
}

function SvgReducer({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8h6l4 4-4 4H2" />
      <path d="M12 12h10" />
      <path d="M18 9l4 3-4 3" />
    </svg>
  )
}

function SvgElbow({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20v-7a9 9 0 0 1 9-9h7" />
      <path d="M17 1l3 3-3 3" />
      <path d="M1 17l3 3 3-3" />
    </svg>
  )
}

function SvgValve({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8l8 4-8 4V8z" />
      <path d="M21 8l-8 4 8 4V8z" />
      <path d="M12 12V5" />
      <path d="M8 5h8" />
      <path d="M3 12H1" />
      <path d="M23 12h-2" />
    </svg>
  )
}

function SvgMotor({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="7" width="14" height="10" rx="2" />
      <path d="M18 10h3v4h-3" />
      <path d="M7 17v3" />
      <path d="M15 17v3" />
      <path d="M7 14V10l3 4 3-4v4" />
    </svg>
  )
}

function SvgSpeedBoundary({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 12l4-4" />
      <path d="M12 4v3" />
      <path d="M20 12h-3" />
      <path d="M4 12h3" />
      <path d="M18 18l3 3" />
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
  const displayedTemperature = d.calcTemperature ?? d.result?.T_K ?? d.temperature
  return (
    <div className={`relative px-3 py-2 rounded-xl border-2 bg-teal-50 min-w-[130px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-teal-500'}`}>
      <Handle type="target" position={inPosition} id="fluid-in" style={portHandleStyle('#14b8a6', 'in')} />
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
      {displayedTemperature !== undefined && (
        <div className="text-xs text-teal-500 pl-5">T: {displayedTemperature.toFixed(2)} K</div>
      )}
      {d.showPressureResults && pressureLabel && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {pressureLabel}
        </div>
      )}
      <Handle type="source" position={outPosition} id="fluid-out" style={portHandleStyle('#14b8a6', 'out')} />
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
      <Handle type="target" position={inPosition} id="fluid-in" style={portHandleStyle('#38bdf8', 'in')} />
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
      {d.result?.T_in_K !== undefined && (
        <div className="text-xs text-sky-500 pl-5">T: {d.result.T_in_K.toFixed(2)} K</div>
      )}
      {d.showPressureResults && d.result?.P_to_kpa !== undefined && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {formatPressure(d.result.P_to_kpa, unit, rho)} {unit}
        </div>
      )}
      <Handle type="source" position={outPosition} id="fluid-out" style={portHandleStyle('#38bdf8', 'out')} />
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
      <Handle type="target" position={inPosition} id="fluid-in" style={portHandleStyle('#8b5cf6', 'in')} />
      <Handle type="target" position={Position.Top} id="power-in" style={portHandleStyle('#eab308', 'in', 'power')} />
      <Handle type="source" position={Position.Bottom} id="power-out" style={portHandleStyle('#eab308', 'out', 'power')} />
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
      <div className="text-xs text-violet-500 pl-5">N={(d.speed ?? d.ratedSpeed ?? 1450).toFixed(0)} rpm</div>
      {d.result?.boost_kpa !== undefined && (
        <div className="text-xs font-bold text-emerald-600 mt-0.5 pl-5">+ΔP: {formatPressure(d.result.boost_kpa, unit, rho)} {unit}</div>
      )}
      {d.result?.T_in_K !== undefined && (
        <div className="text-xs text-violet-500 pl-5">T: {d.result.T_in_K.toFixed(2)} K</div>
      )}
      {d.showPressureResults && d.result?.P_to_kpa !== undefined && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {formatPressure(d.result.P_to_kpa, unit, rho)} {unit}
        </div>
      )}
      <Handle type="source" position={outPosition} id="fluid-out" style={portHandleStyle('#8b5cf6', 'out')} />
    </div>
  )
}

function TurbineNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const inPosition = orientPosition(Position.Left, d)
  const outPosition = orientPosition(Position.Right, d)
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  return (
    <div className={`relative px-3 py-2 rounded border-2 bg-emerald-50 min-w-[150px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-emerald-500'}`}>
      <Handle type="target" position={inPosition} id="fluid-in" style={portHandleStyle('#10b981', 'in')} />
      <Handle type="source" position={Position.Bottom} id="power-out" style={portHandleStyle('#eab308', 'out', 'power')} />
      {d.showPressureResults && d.result?.P_from_kpa !== undefined && (d.portInConnected ?? d.portLeftConnected) && (
        <div className={pressureBadgeClass(inPosition)}>
          {formatPressure(d.result.P_from_kpa, unit, rho)} {unit}
        </div>
      )}
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgTurbine className="w-4 h-4 text-emerald-600 shrink-0" />
        <span className="text-xs font-bold text-emerald-700">{d.label}</span>
      </div>
      <div className="text-xs text-emerald-600 pl-5">H={d.ratedHead ?? 20} m · Qr={d.ratedFlow ?? 30} m³/h</div>
      <div className="text-xs text-emerald-600 pl-5">N={(d.speed ?? d.ratedSpeed ?? 1450).toFixed(0)} rpm</div>
      {d.result?.output_power_kw !== undefined && (
        <div className="text-xs font-bold text-emerald-700 mt-0.5 pl-5">Pout: {d.result.output_power_kw.toFixed(3)} kW</div>
      )}
      {d.result?.T_in_K !== undefined && (
        <div className="text-xs text-emerald-600 pl-5">T: {d.result.T_in_K.toFixed(2)} K</div>
      )}
      {d.showPressureResults && d.result?.P_to_kpa !== undefined && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {formatPressure(d.result.P_to_kpa, unit, rho)} {unit}
        </div>
      )}
      <Handle type="source" position={outPosition} id="fluid-out" style={portHandleStyle('#10b981', 'out')} />
    </div>
  )
}

function HeatExchangerNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const inPosition = orientPosition(Position.Left, d)
  const outPosition = orientPosition(Position.Right, d)
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  return (
    <div className={`relative px-3 py-2 rounded border-2 bg-orange-50 min-w-[160px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-orange-500'}`}>
      <Handle type="target" position={inPosition} id="fluid-in" style={portHandleStyle('#f97316', 'in')} />
      {d.showPressureResults && d.result?.P_from_kpa !== undefined && (d.portInConnected ?? d.portLeftConnected) && (
        <div className={pressureBadgeClass(inPosition)}>
          {formatPressure(d.result.P_from_kpa, unit, rho)} {unit}
        </div>
      )}
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgHeatExchanger className="w-4 h-4 text-orange-600 shrink-0" />
        <span className="text-xs font-bold text-orange-700">{d.label}</span>
      </div>
      <div className="text-xs text-orange-500 pl-5">U={d.heatTransferCoeff ?? 500} · A={d.heatTransferArea ?? 10}</div>
      <div className="text-xs text-orange-500 pl-5">Qr={d.ratedFlow ?? 10} m³/h · ΔPn={d.nominalPressureDrop ?? 10} kPa</div>
      {d.result?.heat_duty_kw !== undefined && (
        <div className="text-xs font-bold text-orange-600 mt-0.5 pl-5">Q熱: {d.result.heat_duty_kw.toFixed(3)} kW</div>
      )}
      {d.result?.T_in_K !== undefined && d.result?.T_out_K !== undefined && (
        <div className="text-xs text-orange-500 pl-5">{d.result.T_in_K.toFixed(2)} → {d.result.T_out_K.toFixed(2)} K</div>
      )}
      {d.showPressureResults && d.result?.P_to_kpa !== undefined && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {formatPressure(d.result.P_to_kpa, unit, rho)} {unit}
        </div>
      )}
      <Handle type="source" position={outPosition} id="fluid-out" style={portHandleStyle('#f97316', 'out')} />
    </div>
  )
}

function ReducerNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const inPosition = orientPosition(Position.Left, d)
  const outPosition = orientPosition(Position.Right, d)
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  const kindLabel = d.result?.reducer_kind === 'expansion'
    ? '拡大'
    : d.result?.reducer_kind === 'contraction'
      ? '縮小'
      : '拡縮'
  return (
    <div className={`relative px-3 py-2 rounded border-2 bg-lime-50 min-w-[150px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-lime-500'}`}>
      <Handle type="target" position={inPosition} id="fluid-in" style={portHandleStyle('#84cc16', 'in')} />
      {d.showPressureResults && d.result?.P_from_kpa !== undefined && (d.portInConnected ?? d.portLeftConnected) && (
        <div className={pressureBadgeClass(inPosition)}>
          {formatPressure(d.result.P_from_kpa, unit, rho)} {unit}
        </div>
      )}
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgReducer className="w-4 h-4 text-lime-700 shrink-0" />
        <span className="text-xs font-bold text-lime-800">{d.label}</span>
      </div>
      <div className="text-xs text-lime-600 pl-5">D: {d.diameterIn ?? 100} → {d.diameterOut ?? 50} mm</div>
      {d.result && (
        <div className="text-xs font-bold text-red-500 mt-0.5 pl-5">ΔP: {formatPressure(d.result.dP_kpa, unit, rho)} {unit}</div>
      )}
      {d.result?.loss_coefficient !== undefined && (
        <div className="text-xs text-lime-600 pl-5">{kindLabel} · ζ={d.result.loss_coefficient.toFixed(3)}</div>
      )}
      {d.showPressureResults && d.result?.P_to_kpa !== undefined && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {formatPressure(d.result.P_to_kpa, unit, rho)} {unit}
        </div>
      )}
      <Handle type="source" position={outPosition} id="fluid-out" style={portHandleStyle('#84cc16', 'out')} />
    </div>
  )
}

function ElbowNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const inPosition = orientPosition(Position.Left, d)
  const outPosition = orientPosition(Position.Right, d)
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  return (
    <div className={`relative px-3 py-2 rounded border-2 bg-cyan-50 min-w-[145px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-cyan-500'}`}>
      <Handle type="target" position={inPosition} id="fluid-in" style={portHandleStyle('#06b6d4', 'in')} />
      {d.showPressureResults && d.result?.P_from_kpa !== undefined && (d.portInConnected ?? d.portLeftConnected) && (
        <div className={pressureBadgeClass(inPosition)}>
          {formatPressure(d.result.P_from_kpa, unit, rho)} {unit}
        </div>
      )}
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgElbow className="w-4 h-4 text-cyan-700 shrink-0" />
        <span className="text-xs font-bold text-cyan-800">{d.label}</span>
      </div>
      <div className="text-xs text-cyan-600 pl-5">θ={d.angle ?? 90}° · D={d.diameter ?? 100} mm</div>
      {d.result && (
        <div className="text-xs font-bold text-red-500 mt-0.5 pl-5">ΔP: {formatPressure(d.result.dP_kpa, unit, rho)} {unit}</div>
      )}
      {d.result?.loss_coefficient !== undefined && (
        <div className="text-xs text-cyan-600 pl-5">ζ={d.result.loss_coefficient.toFixed(3)}</div>
      )}
      {d.showPressureResults && d.result?.P_to_kpa !== undefined && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {formatPressure(d.result.P_to_kpa, unit, rho)} {unit}
        </div>
      )}
      <Handle type="source" position={outPosition} id="fluid-out" style={portHandleStyle('#06b6d4', 'out')} />
    </div>
  )
}

function ValveNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const inPosition = orientPosition(Position.Left, d)
  const outPosition = orientPosition(Position.Right, d)
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  const characteristicLabel = d.valveCharacteristic === 'quickOpening'
    ? 'クイック'
    : d.valveCharacteristic === 'equalPercentage'
      ? 'EQ%'
      : 'リニア'
  return (
    <div className={`relative px-3 py-2 rounded border-2 bg-rose-50 min-w-[150px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-rose-500'}`}>
      <Handle type="target" position={inPosition} id="fluid-in" style={portHandleStyle('#f43f5e', 'in')} />
      {d.showPressureResults && d.result?.P_from_kpa !== undefined && (d.portInConnected ?? d.portLeftConnected) && (
        <div className={pressureBadgeClass(inPosition)}>
          {formatPressure(d.result.P_from_kpa, unit, rho)} {unit}
        </div>
      )}
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgValve className="w-4 h-4 text-rose-700 shrink-0" />
        <span className="text-xs font-bold text-rose-800">{d.label}</span>
      </div>
      <div className="text-xs text-rose-600 pl-5">{characteristicLabel} · 開度 {d.valveOpening ?? 100}%</div>
      {d.result && (
        <div className="text-xs font-bold text-red-500 mt-0.5 pl-5">ΔP: {formatPressure(d.result.dP_kpa, unit, rho)} {unit}</div>
      )}
      {d.result?.loss_coefficient !== undefined && (
        <div className="text-xs text-rose-600 pl-5">ζeff={d.result.loss_coefficient.toFixed(3)}</div>
      )}
      {d.showPressureResults && d.result?.P_to_kpa !== undefined && (d.portOutConnected ?? d.portRightConnected) && (
        <div className={pressureBadgeClass(outPosition)}>
          {formatPressure(d.result.P_to_kpa, unit, rho)} {unit}
        </div>
      )}
      <Handle type="source" position={outPosition} id="fluid-out" style={portHandleStyle('#f43f5e', 'out')} />
    </div>
  )
}

function MotorNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  return (
    <div className={`relative px-3 py-2 rounded border-2 bg-yellow-50 min-w-[155px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-yellow-500'}`}>
      <Handle type="target" position={Position.Left} id="power-in" style={portHandleStyle('#eab308', 'in', 'power')} />
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgMotor className="w-4 h-4 text-yellow-700 shrink-0" />
        <span className="text-xs font-bold text-yellow-800">{d.label}</span>
      </div>
      <div className="text-xs text-yellow-700 pl-5">Pout={d.motorRatedPower ?? 5.5} kW · η={d.motorEfficiency ?? 90}%</div>
      <div className="text-xs text-yellow-600 pl-5">N={(d.speed ?? motorRatedSpeed(d)).toFixed(0)} rpm · {d.motorFrequency ?? 50} Hz</div>
      <Handle type="source" position={Position.Right} id="power-out" style={portHandleStyle('#eab308', 'out', 'power')} />
    </div>
  )
}

function SpeedBoundaryNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  return (
    <div className={`relative px-3 py-2 rounded-xl border-2 bg-yellow-50 min-w-[135px] overflow-visible ${selected ? 'border-blue-500 shadow-lg' : 'border-yellow-400'}`}>
      <div className="flex items-center gap-1.5 mb-0.5">
        <SvgSpeedBoundary className="w-4 h-4 text-yellow-700 shrink-0" />
        <span className="text-xs font-bold text-yellow-800">{d.label}</span>
      </div>
      <div className="text-xs text-yellow-700 pl-5">N={d.fixedSpeed ?? 1450} rpm</div>
      <Handle type="source" position={Position.Right} id="power-out" style={portHandleStyle('#eab308', 'out', 'power')} />
    </div>
  )
}

function TeeNode({ data, selected }: NodeProps) {
  const d = data as unknown as NetworkNodeData
  const r = d.result
  const unit = d.pressureUnit ?? 'kPa'
  const rho = d.rho ?? 1000
  const mode = d.teeMode ?? 'split'
  const inPosition = orientPosition(Position.Left, d)
  const branchPosition = orientPosition(Position.Bottom, d)
  const outPosition = orientPosition(Position.Right, d)
  return (
    <div className={`px-3 py-3 rounded border-2 bg-amber-50 min-w-[110px] text-center ${selected ? 'border-blue-500 shadow-lg' : 'border-amber-400'}`}>
      {mode === 'split' ? (
        <Handle type="target" position={inPosition} id="fluid-in" style={portHandleStyle('#f59e0b', 'in')} />
      ) : (
        <>
          <Handle type="target" position={inPosition} id="fluid-in-1" style={portHandleStyle('#f59e0b', 'in')} />
          <Handle type="target" position={branchPosition} id="fluid-in-2" style={portHandleStyle('#f59e0b', 'in')} />
        </>
      )}
      <div className="flex items-center justify-center gap-1.5 mb-0.5">
        <SvgTee className="w-4 h-4 text-amber-600 shrink-0" />
        <span className="text-xs font-bold text-amber-700">{d.label}</span>
      </div>
      {r?.regime === 'split' ? (
        <div className="text-xs text-amber-600 font-medium tabular-nums">
          {r.P_kpa !== undefined && <div>P: {formatPressure(r.P_kpa, unit, rho)} {unit}</div>}
          {r.T_K !== undefined && <div>T: {r.T_K.toFixed(2)} K</div>}
          <div>{r.Q1_m3h?.toFixed(2)} / {r.Q2_m3h?.toFixed(2)} m³/h</div>
        </div>
      ) : r?.regime === 'junction' && r.P_kpa !== undefined ? (
        <div className="text-xs text-amber-600 font-medium tabular-nums">
          P: {formatPressure(r.P_kpa, unit, rho)} {unit}
          {r.T_K !== undefined && <div>T: {r.T_K.toFixed(2)} K</div>}
          <div>{r.Q_m3h.toFixed(2)} m³/h</div>
        </div>
      ) : (
        <div className="text-xs text-amber-400">{mode === 'split' ? '圧損バランス分配' : '合流節点'}</div>
      )}
      {mode === 'split' ? (
        <>
          <Handle type="source" position={outPosition} id="fluid-out-1" style={portHandleStyle('#f59e0b', 'out')} />
          <Handle type="source" position={branchPosition} id="fluid-out-2" style={portHandleStyle('#f59e0b', 'out')} />
        </>
      ) : (
        <Handle type="source" position={outPosition} id="fluid-out" style={portHandleStyle('#f59e0b', 'out')} />
      )}
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
      <Handle type="target" position={inPosition} id="fluid-in" style={portHandleStyle('#fb7185', 'in')} />
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
          {d.result?.T_K !== undefined && (
            <div className="text-xs text-rose-400">T: {d.result.T_K.toFixed(2)} K</div>
          )}
        </>
      ) : (
        <>
          <div className="text-xs text-rose-400">自由出口 (P=0)</div>
          {d.result && (
            <div className="text-xs font-bold text-blue-600">Q: {d.result.Q_m3h.toFixed(2)} m³/h</div>
          )}
          {d.result?.T_K !== undefined && (
            <div className="text-xs text-rose-400">T: {d.result.T_K.toFixed(2)} K</div>
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
  turbine: TurbineNode,
  heatExchanger: HeatExchangerNode,
  reducer: ReducerNode,
  elbow: ElbowNode,
  valve: ValveNode,
  motor: MotorNode,
  speedBoundary: SpeedBoundaryNode,
  tee: TeeNode,
  teeMerge: TeeNode,
  sink: SinkNode,
}

type FlowEdgeData = Record<string, unknown> & { flowLabel?: string; labelVisible?: boolean; lineType?: LineType; fluidColor?: string }
type FlowEdgeType = Edge<FlowEdgeData, 'flow'>

function handleLineType(handleId?: string | null): LineType {
  return handleId?.startsWith('power') ? 'power' : 'fluid'
}

function connectionLineType(sourceHandle?: string | null, targetHandle?: string | null): LineType | null {
  const sourceType = handleLineType(sourceHandle)
  const targetType = handleLineType(targetHandle)
  return sourceType === targetType ? sourceType : null
}

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
  selected,
}: EdgeProps<FlowEdgeType>) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  const lineType = data?.lineType ?? 'fluid'
  const stroke = selected ? '#f97316' : lineType === 'power' ? '#facc15' : data?.fluidColor ?? '#94a3b8'
  const strokeWidth = selected ? 6 : lineType === 'power' ? 3 : 2.5

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke,
          strokeWidth,
          strokeDasharray: lineType === 'power' ? '8 5' : undefined,
          filter: selected ? 'drop-shadow(0 0 8px rgba(194, 65, 12, 0.95)) drop-shadow(0 0 3px rgba(249, 115, 22, 0.9))' : undefined,
        }}
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
  { type: 'turbine', label: 'タービン', sub: '動力回収', color: 'text-emerald-300', Icon: SvgTurbine },
  { type: 'heatExchanger', label: '熱交換器', sub: 'UA', color: 'text-orange-300', Icon: SvgHeatExchanger },
  { type: 'reducer', label: '拡縮管', sub: 'ζ', color: 'text-lime-300', Icon: SvgReducer },
  { type: 'elbow', label: 'エルボ', sub: 'θ/ζ', color: 'text-cyan-300', Icon: SvgElbow },
  { type: 'valve', label: 'バルブ', sub: '開度/PQ', color: 'text-rose-300', Icon: SvgValve },
  { type: 'motor', label: '誘導M', sub: '動力', color: 'text-yellow-300', Icon: SvgMotor },
  { type: 'speedBoundary', label: '回転境界', sub: 'rpm', color: 'text-yellow-300', Icon: SvgSpeedBoundary },
  { type: 'tee',    label: 'T字管',   sub: '分岐',  color: 'text-amber-300',  Icon: SvgTee },
  { type: 'teeMerge', label: 'T字管', sub: '合流', color: 'text-amber-300', Icon: SvgTee },
]

function defaultData(type: string, n: number): NetworkNodeData {
  switch (type) {
    case 'boundary': return { nodeType: 'boundary', label: `境界${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID, boundaryType: 'pressure', pressure: 101.325, flowRate: 10, temperature: 293.15 }
    case 'source': return { nodeType: 'source', label: `ソース${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID, boundaryType: 'flow', flowRate: 10, pressure: 100, temperature: 293.15 }
    case 'pipe':   return {
      nodeType: 'pipe', label: `パイプ${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID,
      pipeShape: 'circular',
      diameter: 100, outerDiameter: 100, innerDiameter: 50,
      width: 100, ductHeight: 50,
      length: 50, roughness: 0.046,
      frictionMethod: 'colebrook',
    }
    case 'pump': return {
      nodeType: 'pump', label: `ポンプ${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID,
      ratedFlow: 30, ratedHead: 20,
      shutoffHead: 30,
      efficiency: 70,
      ratedSpeed: 1450,
      pumpCurveMode: 'quadratic',
      pumpCurvePoints: [
        { q: 0, h: 30 },
        { q: 30, h: 20 },
        { q: 51.96, h: 0 },
      ],
    }
    case 'turbine': return {
      nodeType: 'turbine', label: `タービン${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID,
      ratedFlow: 30,
      ratedHead: 20,
      efficiency: 85,
      ratedSpeed: 1450,
    }
    case 'heatExchanger': return {
      nodeType: 'heatExchanger', label: `熱交換器${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID,
      exchangeTemperature: 303.15,
      heatTransferCoeff: 500,
      heatTransferArea: 10,
      ratedFlow: 10,
      nominalPressureDrop: 10,
    }
    case 'reducer': return {
      nodeType: 'reducer', label: `拡縮管${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID,
      diameterIn: 100,
      diameterOut: 50,
      lossMode: 'auto',
      lossCoefficient: 0.5,
    }
    case 'elbow': return {
      nodeType: 'elbow', label: `エルボ${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID,
      diameter: 100,
      angle: 90,
      elbowLossMode: 'auto',
      lossCoefficient: 0.75,
      zeta90: 0.75,
    }
    case 'valve': return {
      nodeType: 'valve', label: `バルブ${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID,
      diameter: 100,
      valveCharacteristic: 'linear',
      valveOpening: 100,
      valveZetaFullOpen: 1.0,
      valveRangeability: 50,
    }
    case 'motor': return {
      nodeType: 'motor', label: `誘導モーター${n}`,
      motorRatedPower: 5.5,
      motorEfficiency: 90,
      motorVoltage: 200,
      motorFrequency: 50,
      motorPoles: 4,
      motorSlip: 3,
    }
    case 'speedBoundary': return {
      nodeType: 'speedBoundary', label: `回転境界${n}`,
      fixedSpeed: 1450,
    }
    case 'tee':  return { nodeType: 'tee',  label: `分岐T字管${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID, teeMode: 'split' }
    case 'teeMerge': return { nodeType: 'tee', label: `合流T字管${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID, teeMode: 'merge' }
    case 'sink': return { nodeType: 'sink', label: `シンク${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID, boundaryType: 'pressure', pressure: 101.325, temperature: 293.15 }
    default:     return { nodeType: 'boundary', label: `${type}${n}`, fluidSystemId: DEFAULT_FLUID_SYSTEM_ID, boundaryType: 'pressure', pressure: 101.325, flowRate: 10, temperature: 293.15 }
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
    { id: 'e-boundary-1-pipe-3', source: 'boundary-1', sourceHandle: 'fluid-out', target: 'pipe-3', targetHandle: 'fluid-in', type: 'flow', style: edgeStyle, data: { lineType: 'fluid' } },
    { id: 'e-pipe-3-pump-4',     source: 'pipe-3',     sourceHandle: 'fluid-out', target: 'pump-4', targetHandle: 'fluid-in', type: 'flow', style: edgeStyle, data: { lineType: 'fluid' } },
    { id: 'e-pump-4-pipe-2',     source: 'pump-4',     sourceHandle: 'fluid-out', target: 'pipe-2', targetHandle: 'fluid-in', type: 'flow', style: edgeStyle, data: { lineType: 'fluid' } },
    { id: 'e-pipe-2-boundary-1', source: 'pipe-2',     sourceHandle: 'fluid-out', target: 'boundary-1', targetHandle: 'fluid-in', type: 'flow', style: edgeStyle, data: { lineType: 'fluid' } },
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
type ResultTheme = 'sky' | 'violet' | 'orange' | 'amber' | 'blue' | 'rose' | 'green'

const RESULT_THEME_CLASSES: Record<ResultTheme, { bg: string; border: string; title: string }> = {
  sky:    { bg: 'bg-sky-50',    border: 'border-sky-100',    title: 'text-sky-600' },
  violet: { bg: 'bg-violet-50', border: 'border-violet-100', title: 'text-violet-600' },
  orange: { bg: 'bg-orange-50', border: 'border-orange-100', title: 'text-orange-600' },
  amber:  { bg: 'bg-amber-50',  border: 'border-amber-100',  title: 'text-amber-600' },
  blue:   { bg: 'bg-blue-50',   border: 'border-blue-100',   title: 'text-blue-600' },
  rose:   { bg: 'bg-rose-50',   border: 'border-rose-100',   title: 'text-rose-600' },
  green:  { bg: 'bg-emerald-50', border: 'border-emerald-100', title: 'text-emerald-700' },
}

function resultSymbols(rows: ResultRow[]): string[] {
  return rows.map(row => row.symbol)
}

function filterVisibleRows(rows: ResultRow[] | null, data: NetworkNodeData): ResultRow[] | null {
  if (!rows) return null
  const visible = data.resultVisibleSymbols
  if (!visible) return []
  const visibleSet = new Set(visible)
  return rows.filter(row => visibleSet.has(row.symbol))
}

function ResultTable({ title, rows, theme = 'sky', note, selectedSymbols, onToggleSymbol }: {
  title: string
  rows: ResultRow[]
  theme?: ResultTheme
  note?: string
  selectedSymbols?: string[]
  onToggleSymbol?: (symbol: string, checked: boolean, allSymbols: string[]) => void
}) {
  const c = RESULT_THEME_CLASSES[theme]
  const allSymbols = resultSymbols(rows)
  const selectedSet = selectedSymbols ? new Set(selectedSymbols) : null
  return (
    <div className={`rounded-lg p-3 border ${c.bg} ${c.border}`}>
      <div className={`text-xs font-semibold mb-2 ${c.title}`}>{title}</div>
      {note && <div className="text-xs text-gray-500 mb-2">{note}</div>}
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-xs text-gray-400">
            <th className="w-6 pb-1" />
            <th className="text-left font-medium pb-1">項目</th>
            <th className="text-left font-medium pb-1">記号</th>
            <th className="text-right font-medium pb-1">値</th>
            <th className="text-left font-medium pb-1 pl-2">単位</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.symbol} className="border-t border-black/5">
              <td className="py-1 pr-2">
                <input
                  type="checkbox"
                  checked={selectedSet ? selectedSet.has(r.symbol) : false}
                  onChange={e => onToggleSymbol?.(r.symbol, e.target.checked, allSymbols)}
                  className="h-3.5 w-3.5 accent-blue-600"
                />
              </td>
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
    ...(result.T_in_K  !== undefined ? [{ item: '入口温度', symbol: 'T_in',  value: result.T_in_K.toFixed(3), unit: 'K' }] : []),
    ...(result.T_out_K !== undefined ? [{ item: '出口温度', symbol: 'T_out', value: result.T_out_K.toFixed(3), unit: 'K' }] : []),
  ]
}

function pumpResultRows(result: PipeSegmentResult, unit: PressureUnit, rho: number): ResultRow[] {
  return [
    { item: '流量',   symbol: 'Q',   value: result.Q_m3h.toFixed(3),                       unit: 'm³/h' },
    { item: '揚程',   symbol: 'H',   value: (result.head_m ?? 0).toFixed(3),               unit: 'm' },
    { item: '昇圧',   symbol: 'ΔP',  value: formatPressure(result.boost_kpa ?? 0, unit, rho), unit, highlight: true },
    ...(result.speed_rpm !== undefined ? [{ item: '動作回転数', symbol: 'N', value: result.speed_rpm.toFixed(1), unit: 'rpm', highlight: true }] : []),
    { item: '理論動力', symbol: 'P_h', value: (result.hydraulic_power_kw ?? 0).toFixed(4), unit: 'kW' },
    { item: '消費動力', symbol: 'P_s', value: (result.shaft_power_kw ?? 0).toFixed(4),     unit: 'kW', highlight: true },
    ...(result.shaft_torque_nm !== undefined ? [{ item: '軸トルク', symbol: 'T_s', value: result.shaft_torque_nm.toFixed(3), unit: 'N·m', highlight: true }] : []),
    ...(result.P_from_kpa !== undefined ? [{ item: '入口圧', symbol: 'P_in',  value: formatPressure(result.P_from_kpa, unit, rho), unit }] : []),
    ...(result.P_to_kpa   !== undefined ? [{ item: '出口圧', symbol: 'P_out', value: formatPressure(result.P_to_kpa,   unit, rho), unit }] : []),
    ...(result.T_in_K     !== undefined ? [{ item: '入口温度', symbol: 'T_in', value: result.T_in_K.toFixed(3), unit: 'K' }] : []),
    ...(result.T_out_K    !== undefined ? [{ item: '出口温度', symbol: 'T_out', value: result.T_out_K.toFixed(3), unit: 'K' }] : []),
  ]
}

function heatExchangerResultRows(result: PipeSegmentResult, unit: PressureUnit, rho: number): ResultRow[] {
  return [
    { item: '流量',       symbol: 'Q',     value: result.Q_m3h.toFixed(3), unit: 'm³/h' },
    { item: '圧力損失',   symbol: 'ΔP',    value: formatPressure(result.dP_kpa, unit, rho), unit, highlight: true },
    { item: '熱交換量',   symbol: 'Q_heat', value: (result.heat_duty_kw ?? 0).toFixed(4), unit: 'kW', highlight: true },
    { item: '入口温度',   symbol: 'T_in',  value: result.T_in_K !== undefined ? result.T_in_K.toFixed(3) : '—', unit: 'K' },
    { item: '出口温度',   symbol: 'T_out', value: result.T_out_K !== undefined ? result.T_out_K.toFixed(3) : '—', unit: 'K', highlight: true },
    ...(result.exchange_temperature_K !== undefined ? [{ item: '熱交換温度', symbol: 'T_env', value: result.exchange_temperature_K.toFixed(3), unit: 'K' }] : []),
    ...(result.UA_w_per_k !== undefined ? [{ item: 'UA', symbol: 'UA', value: result.UA_w_per_k.toFixed(3), unit: 'W/K' }] : []),
    ...(result.rated_flow_m3h !== undefined ? [{ item: '定格流量', symbol: 'Q_r', value: result.rated_flow_m3h.toFixed(3), unit: 'm³/h' }] : []),
    ...(result.nominal_pressure_drop_kpa !== undefined ? [{ item: 'ノミナル圧損', symbol: 'ΔP_n', value: formatPressure(result.nominal_pressure_drop_kpa, unit, rho), unit }] : []),
    ...(result.P_in_kpa  !== undefined ? [{ item: '上流圧', symbol: 'P_in',  value: formatPressure(result.P_in_kpa,  unit, rho), unit }] : []),
    ...(result.P_out_kpa !== undefined ? [{ item: '下流圧', symbol: 'P_out', value: formatPressure(result.P_out_kpa, unit, rho), unit }] : []),
  ]
}

function reducerResultRows(result: PipeSegmentResult, unit: PressureUnit, rho: number): ResultRow[] {
  const kind = result.reducer_kind === 'expansion'
    ? '拡大'
    : result.reducer_kind === 'contraction'
      ? '縮小'
      : result.reducer_kind === 'manual'
        ? '手動'
        : '拡縮'
  return [
    { item: '流量',       symbol: 'Q',  value: result.Q_m3h.toFixed(3), unit: 'm³/h' },
    { item: '基準流速',   symbol: 'v',  value: result.v.toFixed(4),     unit: 'm/s' },
    { item: '圧力損失',   symbol: 'ΔP', value: formatPressure(result.dP_kpa, unit, rho), unit, highlight: true },
    ...(result.loss_coefficient !== undefined ? [{ item: '抵抗係数', symbol: 'ζ', value: result.loss_coefficient.toFixed(4), unit: '-' }] : []),
    ...(result.upstream_diameter_mm !== undefined ? [{ item: '上流径', symbol: 'D_up', value: result.upstream_diameter_mm.toFixed(3), unit: 'mm' }] : []),
    ...(result.downstream_diameter_mm !== undefined ? [{ item: '下流径', symbol: 'D_down', value: result.downstream_diameter_mm.toFixed(3), unit: 'mm' }] : []),
    { item: '流動形態', symbol: 'type', value: kind, unit: '-' },
    ...(result.P_in_kpa  !== undefined ? [{ item: '上流圧', symbol: 'P_in',  value: formatPressure(result.P_in_kpa,  unit, rho), unit }] : []),
    ...(result.P_out_kpa !== undefined ? [{ item: '下流圧', symbol: 'P_out', value: formatPressure(result.P_out_kpa, unit, rho), unit }] : []),
    ...(result.T_in_K  !== undefined ? [{ item: '入口温度', symbol: 'T_in',  value: result.T_in_K.toFixed(3), unit: 'K' }] : []),
    ...(result.T_out_K !== undefined ? [{ item: '出口温度', symbol: 'T_out', value: result.T_out_K.toFixed(3), unit: 'K' }] : []),
  ]
}

function elbowResultRows(result: PipeSegmentResult, unit: PressureUnit, rho: number): ResultRow[] {
  return [
    { item: '流量',       symbol: 'Q',  value: result.Q_m3h.toFixed(3), unit: 'm³/h' },
    { item: '流速',       symbol: 'v',  value: result.v.toFixed(4),     unit: 'm/s' },
    { item: '圧力損失',   symbol: 'ΔP', value: formatPressure(result.dP_kpa, unit, rho), unit, highlight: true },
    ...(result.angle_deg !== undefined ? [{ item: '角度', symbol: 'θ', value: result.angle_deg.toFixed(1), unit: 'deg' }] : []),
    ...(result.diameter_mm !== undefined ? [{ item: '基準径', symbol: 'D', value: result.diameter_mm.toFixed(3), unit: 'mm' }] : []),
    ...(result.loss_coefficient !== undefined ? [{ item: '抵抗係数', symbol: 'ζ', value: result.loss_coefficient.toFixed(4), unit: '-' }] : []),
    ...(result.zeta90 !== undefined ? [{ item: '90度基準ζ', symbol: 'ζ90', value: result.zeta90.toFixed(4), unit: '-' }] : []),
    ...(result.P_in_kpa  !== undefined ? [{ item: '上流圧', symbol: 'P_in',  value: formatPressure(result.P_in_kpa,  unit, rho), unit }] : []),
    ...(result.P_out_kpa !== undefined ? [{ item: '下流圧', symbol: 'P_out', value: formatPressure(result.P_out_kpa, unit, rho), unit }] : []),
    ...(result.T_in_K  !== undefined ? [{ item: '入口温度', symbol: 'T_in',  value: result.T_in_K.toFixed(3), unit: 'K' }] : []),
    ...(result.T_out_K !== undefined ? [{ item: '出口温度', symbol: 'T_out', value: result.T_out_K.toFixed(3), unit: 'K' }] : []),
  ]
}

function valveCharacteristicLabel(characteristic: string | undefined): string {
  if (characteristic === 'quickOpening') return 'クイックオープン'
  if (characteristic === 'equalPercentage') return 'イコールパーセント'
  return 'リニア'
}

function valveResultRows(result: PipeSegmentResult, unit: PressureUnit, rho: number): ResultRow[] {
  return [
    { item: '流量',       symbol: 'Q',  value: result.Q_m3h.toFixed(3), unit: 'm³/h' },
    { item: '流速',       symbol: 'v',  value: result.v.toFixed(4),     unit: 'm/s' },
    { item: '圧力損失',   symbol: 'ΔP', value: formatPressure(result.dP_kpa, unit, rho), unit, highlight: true },
    ...(result.valve_opening_percent !== undefined ? [{ item: '開度', symbol: 'open', value: result.valve_opening_percent.toFixed(1), unit: '%' }] : []),
    ...(result.valve_characteristic !== undefined ? [{ item: '特性', symbol: 'type', value: valveCharacteristicLabel(result.valve_characteristic), unit: '-' }] : []),
    ...(result.valve_relative_capacity !== undefined ? [{ item: '相対Cv', symbol: 'Cv_rel', value: result.valve_relative_capacity.toFixed(4), unit: '-' }] : []),
    ...(result.loss_coefficient !== undefined ? [{ item: '有効抵抗係数', symbol: 'ζeff', value: result.loss_coefficient.toFixed(4), unit: '-' }] : []),
    ...(result.valve_zeta_full_open !== undefined ? [{ item: '全開時ζ', symbol: 'ζ_open', value: result.valve_zeta_full_open.toFixed(4), unit: '-' }] : []),
    ...(result.diameter_mm !== undefined ? [{ item: '基準径', symbol: 'D', value: result.diameter_mm.toFixed(3), unit: 'mm' }] : []),
    ...(result.P_in_kpa  !== undefined ? [{ item: '上流圧', symbol: 'P_in',  value: formatPressure(result.P_in_kpa,  unit, rho), unit }] : []),
    ...(result.P_out_kpa !== undefined ? [{ item: '下流圧', symbol: 'P_out', value: formatPressure(result.P_out_kpa, unit, rho), unit }] : []),
    ...(result.T_in_K  !== undefined ? [{ item: '入口温度', symbol: 'T_in',  value: result.T_in_K.toFixed(3), unit: 'K' }] : []),
    ...(result.T_out_K !== undefined ? [{ item: '出口温度', symbol: 'T_out', value: result.T_out_K.toFixed(3), unit: 'K' }] : []),
  ]
}

function turbineResultRows(result: PipeSegmentResult, unit: PressureUnit, rho: number): ResultRow[] {
  return [
    { item: '流量', symbol: 'Q', value: result.Q_m3h.toFixed(3), unit: 'm³/h' },
    { item: '有効落差', symbol: 'H', value: (result.head_m ?? 0).toFixed(3), unit: 'm' },
    { item: '圧力損失', symbol: 'ΔP', value: formatPressure(result.dP_kpa, unit, rho), unit, highlight: true },
    ...(result.speed_rpm !== undefined ? [{ item: '動作回転数', symbol: 'N', value: result.speed_rpm.toFixed(1), unit: 'rpm', highlight: true }] : []),
    { item: '流体動力', symbol: 'P_h', value: (result.extracted_power_kw ?? 0).toFixed(4), unit: 'kW' },
    { item: '軸出力', symbol: 'P_out', value: (result.output_power_kw ?? 0).toFixed(4), unit: 'kW', highlight: true },
    ...(result.shaft_torque_nm !== undefined ? [{ item: '軸トルク', symbol: 'T_s', value: result.shaft_torque_nm.toFixed(3), unit: 'N·m', highlight: true }] : []),
    ...(result.P_in_kpa !== undefined ? [{ item: '入口圧', symbol: 'P_in', value: formatPressure(result.P_in_kpa, unit, rho), unit }] : []),
    ...(result.P_out_kpa !== undefined ? [{ item: '出口圧', symbol: 'P_out', value: formatPressure(result.P_out_kpa, unit, rho), unit }] : []),
    ...(result.T_in_K !== undefined ? [{ item: '入口温度', symbol: 'T_in', value: result.T_in_K.toFixed(3), unit: 'K' }] : []),
    ...(result.T_out_K !== undefined ? [{ item: '出口温度', symbol: 'T_out', value: result.T_out_K.toFixed(3), unit: 'K' }] : []),
  ]
}

function speedSolveModeLabel(mode: NetworkNodeData['speedSolveMode']): string {
  if (mode === 'fixed') return '固定境界'
  if (mode === 'torque') return 'トルク釣合'
  return '未接続'
}

function motorResultRows(d: NetworkNodeData): ResultRow[] {
  return [
    { item: '定格軸出力', symbol: 'P_out', value: (d.motorRatedPower ?? 5.5).toFixed(3), unit: 'kW', highlight: true },
    ...(d.speed !== undefined ? [{ item: '動作回転数', symbol: 'N', value: d.speed.toFixed(1), unit: 'rpm', highlight: true }] : []),
    ...(d.shaftTorque !== undefined ? [{ item: '発生トルク', symbol: 'T_m', value: d.shaftTorque.toFixed(3), unit: 'N·m', highlight: true }] : []),
    ...(d.speedSolveMode !== undefined ? [{ item: '回転数決定', symbol: 'mode', value: speedSolveModeLabel(d.speedSolveMode), unit: '-' }] : []),
    { item: '入力電力', symbol: 'P_in', value: motorInputPower(d).toFixed(3), unit: 'kW' },
    { item: '効率', symbol: 'η', value: (d.motorEfficiency ?? 90).toFixed(2), unit: '%' },
    { item: '電圧', symbol: 'V', value: (d.motorVoltage ?? 200).toFixed(1), unit: 'V' },
    { item: '周波数', symbol: 'f', value: (d.motorFrequency ?? 50).toFixed(1), unit: 'Hz' },
    { item: '極数', symbol: 'p', value: Math.round(d.motorPoles ?? 4).toString(), unit: '-' },
    { item: 'すべり', symbol: 's', value: (d.motorSlip ?? 3).toFixed(2), unit: '%' },
    { item: '同期速度', symbol: 'N_s', value: motorSynchronousSpeed(d).toFixed(1), unit: 'rpm' },
    { item: '定格回転数', symbol: 'N_r', value: motorRatedSpeed(d).toFixed(1), unit: 'rpm' },
  ]
}

function speedBoundaryResultRows(d: NetworkNodeData): ResultRow[] {
  return [
    { item: '固定回転数', symbol: 'N_set', value: (d.fixedSpeed ?? 1450).toFixed(1), unit: 'rpm', highlight: true },
  ]
}

function boundaryResultRows(d: NetworkNodeData, unit: PressureUnit, rho: number): ResultRow[] | null {
  const isFlow = (d.boundaryType ?? 'flow') === 'flow'
  const temp = d.calcTemperature ?? d.result?.T_K ?? d.temperature
  if (isFlow && d.calcPressure !== undefined) {
    return [
      { item: '境界圧力', symbol: 'P', value: formatPressure(d.calcPressure, unit, rho), unit, highlight: true },
      ...(temp !== undefined ? [{ item: '流体温度', symbol: 'T', value: temp.toFixed(3), unit: 'K' }] : []),
    ]
  }
  if (!isFlow && d.calcFlow !== undefined) {
    return [
      { item: '境界流量', symbol: 'Q', value: d.calcFlow.toFixed(3), unit: 'm³/h', highlight: true },
      ...(temp !== undefined ? [{ item: '流体温度', symbol: 'T', value: temp.toFixed(3), unit: 'K' }] : []),
    ]
  }
  return null
}

function teeResultRows(d: NetworkNodeData, unit: PressureUnit, rho: number): ResultRow[] | null {
  const r = d.result
  if (r?.regime === 'junction') {
    return [
      { item: '圧力',   symbol: 'P', value: r.P_kpa !== undefined ? formatPressure(r.P_kpa, unit, rho) : '—', unit, highlight: true },
      { item: '通過流量', symbol: 'Q', value: r.Q_m3h.toFixed(3), unit: 'm³/h' },
      ...(r.T_K !== undefined ? [{ item: '流体温度', symbol: 'T', value: r.T_K.toFixed(3), unit: 'K' }] : []),
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
      ...(r.T_K !== undefined ? [{ item: '流体温度', symbol: 'T', value: r.T_K.toFixed(3), unit: 'K' }] : []),
    ]
  }
  return null
}

function componentTypeLabel(nodeType: string): string {
  if (nodeType === 'pipe') return 'パイプ'
  if (nodeType === 'pump') return 'ポンプ'
  if (nodeType === 'turbine') return 'タービン'
  if (nodeType === 'heatExchanger') return '熱交換器'
  if (nodeType === 'reducer') return '拡縮管'
  if (nodeType === 'elbow') return 'エルボ'
  if (nodeType === 'valve') return 'バルブ'
  if (nodeType === 'motor') return '誘導モーター'
  if (nodeType === 'speedBoundary') return '回転境界'
  if (nodeType === 'tee')  return 'T字管'
  return '境界'
}

function componentResultRows(d: NetworkNodeData, unit: PressureUnit, rho: number): ResultRow[] | null {
  const rows =
    d.nodeType === 'pipe' ? (d.result ? pipeResultRows(d.result, unit, rho) : null)
    : d.nodeType === 'pump' ? (d.result ? pumpResultRows(d.result, unit, rho) : null)
    : d.nodeType === 'turbine' ? (d.result ? turbineResultRows(d.result, unit, rho) : null)
    : d.nodeType === 'heatExchanger' ? (d.result ? heatExchangerResultRows(d.result, unit, rho) : null)
    : d.nodeType === 'reducer' ? (d.result ? reducerResultRows(d.result, unit, rho) : null)
    : d.nodeType === 'elbow' ? (d.result ? elbowResultRows(d.result, unit, rho) : null)
    : d.nodeType === 'valve' ? (d.result ? valveResultRows(d.result, unit, rho) : null)
    : d.nodeType === 'motor' ? motorResultRows(d)
    : d.nodeType === 'speedBoundary' ? speedBoundaryResultRows(d)
    : d.nodeType === 'tee' ? teeResultRows(d, unit, rho)
    : boundaryResultRows(d, unit, rho)
  return filterVisibleRows(rows, d)
}

function NodeParamPanel({ node, onChange, fluidSystems }: {
  node: Node
  onChange: (u: Partial<NetworkNodeData>) => void
  fluidSystems: FluidSystem[]
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
  const isFluidNode = d.nodeType !== 'motor' && d.nodeType !== 'speedBoundary'

  const Icon = isBoundaryNode ? SvgSource
    : d.nodeType === 'pipe' ? SvgPipe
    : d.nodeType === 'pump' ? SvgPump
    : d.nodeType === 'turbine' ? SvgTurbine
    : d.nodeType === 'heatExchanger' ? SvgHeatExchanger
    : d.nodeType === 'reducer' ? SvgReducer
    : d.nodeType === 'elbow' ? SvgElbow
    : d.nodeType === 'valve' ? SvgValve
    : d.nodeType === 'motor' ? SvgMotor
    : d.nodeType === 'speedBoundary' ? SvgSpeedBoundary
    : SvgTee

  const iconColor = isBoundaryNode ? 'text-teal-600'
    : d.nodeType === 'pipe' ? 'text-sky-600'
    : d.nodeType === 'pump' ? 'text-violet-600'
    : d.nodeType === 'turbine' ? 'text-emerald-600'
    : d.nodeType === 'heatExchanger' ? 'text-orange-600'
    : d.nodeType === 'reducer' ? 'text-lime-700'
    : d.nodeType === 'elbow' ? 'text-cyan-700'
    : d.nodeType === 'valve' ? 'text-rose-700'
    : d.nodeType === 'motor' ? 'text-yellow-700'
    : d.nodeType === 'speedBoundary' ? 'text-yellow-700'
    : 'text-amber-600'

  return (
    <div className="flex flex-col gap-4">
      {/* Node identity */}
      <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
        <Icon className={`w-5 h-5 ${iconColor} shrink-0`} />
        <span className="text-base font-semibold text-gray-800 min-w-0 flex-1 truncate">{d.label}</span>
      </div>

      {isFluidNode && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-600">流体系統</label>
          <select
            value={d.fluidSystemId ?? fluidSystems[0]?.id ?? DEFAULT_FLUID_SYSTEM_ID}
            onChange={e => onChange({ fluidSystemId: e.target.value })}
            className="border border-gray-300 rounded-md px-2 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {fluidSystems.map(system => (
              <option key={system.id} value={system.id}>{system.name}</option>
            ))}
          </select>
        </div>
      )}

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
        <NumField label="流体温度 T" unit="K" value={d.temperature ?? 293.15} onChange={v => onChange({ temperature: v })} />
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
          <div className="rounded-md border border-violet-100 bg-white px-3 py-2">
            <div className="flex justify-between items-baseline gap-2">
              <span className="text-xs text-gray-500">動作回転数 N</span>
              <span className="text-sm font-semibold text-violet-700 tabular-nums">{(d.speed ?? d.ratedSpeed ?? 1450).toFixed(1)} rpm</span>
            </div>
            {d.shaftTorque !== undefined && (
              <div className="mt-1 flex justify-between items-baseline gap-2">
                <span className="text-xs text-gray-500">負荷トルク T</span>
                <span className="text-sm font-semibold text-violet-700 tabular-nums">{d.shaftTorque.toFixed(3)} N·m</span>
              </div>
            )}
            <div className="mt-1 flex justify-between items-baseline gap-2">
              <span className="text-xs text-gray-400">決定方法</span>
              <span className="text-xs font-medium text-violet-600">{speedSolveModeLabel(d.speedSolveMode)}</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            PQ特性は基準回転数Nrで定義し、現在回転数Nは固定回転境界またはモーターとのトルク釣合で決定します。未接続時はNrで計算します。
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

      {/* ── Turbine ── */}
      {d.nodeType === 'turbine' && (<>
        <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 p-3 flex flex-col gap-3">
          <div className="text-xs font-semibold text-emerald-700">動力回収</div>
          <NumField label="基準回転数 Nr" unit="rpm" value={d.ratedSpeed ?? 1450} onChange={v => onChange({ ratedSpeed: v })} />
          <div className="rounded-md border border-emerald-100 bg-white px-3 py-2">
            <div className="flex justify-between items-baseline gap-2">
              <span className="text-xs text-gray-500">動作回転数 N</span>
              <span className="text-sm font-semibold text-emerald-700 tabular-nums">{(d.speed ?? d.ratedSpeed ?? 1450).toFixed(1)} rpm</span>
            </div>
            {d.shaftTorque !== undefined && (
              <div className="mt-1 flex justify-between items-baseline gap-2">
                <span className="text-xs text-gray-500">供給トルク T</span>
                <span className="text-sm font-semibold text-emerald-700 tabular-nums">{d.shaftTorque.toFixed(3)} N·m</span>
              </div>
            )}
            <div className="mt-1 flex justify-between items-baseline gap-2">
              <span className="text-xs text-gray-400">決定方法</span>
              <span className="text-xs font-medium text-emerald-700">{speedSolveModeLabel(d.speedSolveMode)}</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            タービンは流体側で有効落差分の圧力を消費し、動力ラインへ軸トルクを供給します。初期モデルでは定格点からT∝N²のトルク特性を作ります。
          </p>
        </div>
        <NumField label="定格流量 Qr" unit="m³/h" value={d.ratedFlow ?? 30} onChange={v => onChange({ ratedFlow: v })} />
        <NumField label="有効落差 H" unit="m" value={d.ratedHead ?? 20} onChange={v => onChange({ ratedHead: v })} />
        <NumField label="効率 η" unit="%" value={d.efficiency ?? 85} onChange={v => onChange({ efficiency: v })} />
      </>)}

      {/* ── Heat Exchanger ── */}
      {d.nodeType === 'heatExchanger' && (<>
        <NumField label="熱交換温度 T_env" unit="K" value={d.exchangeTemperature ?? 303.15} onChange={v => onChange({ exchangeTemperature: v })} />
        <NumField label="総括熱伝達率 U" unit="W/m²/K" value={d.heatTransferCoeff ?? 500} onChange={v => onChange({ heatTransferCoeff: v })} />
        <NumField label="熱交換面積 A" unit="m²" value={d.heatTransferArea ?? 10} onChange={v => onChange({ heatTransferArea: v })} />
        <NumField label="定格流量 Qr" unit="m³/h" value={d.ratedFlow ?? 10} onChange={v => onChange({ ratedFlow: v })} />
        <NumField label="ノミナル圧損 ΔPn" unit="kPa" value={d.nominalPressureDrop ?? 10} onChange={v => onChange({ nominalPressureDrop: v })} />
      </>)}

      {/* ── Reducer / Expander ── */}
      {d.nodeType === 'reducer' && (<>
        <NumField label="入口径 D_in" unit="mm" value={d.diameterIn ?? 100} onChange={v => onChange({ diameterIn: v })} />
        <NumField label="出口径 D_out" unit="mm" value={d.diameterOut ?? 50} onChange={v => onChange({ diameterOut: v })} />
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-600">抵抗係数モード</label>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['auto', '自動'],
              ['manual', '手動'],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange({ lossMode: mode })}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  (d.lossMode ?? 'auto') === mode
                    ? 'border-lime-400 bg-lime-50 text-lime-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {(d.lossMode ?? 'auto') === 'manual' && (
          <NumField label="抵抗係数 ζ" unit="-" value={d.lossCoefficient ?? 0.5} onChange={v => onChange({ lossCoefficient: v })} />
        )}
      </>)}

      {/* ── Elbow ── */}
      {d.nodeType === 'elbow' && (<>
        <NumField label="基準径 D" unit="mm" value={d.diameter ?? 100} onChange={v => onChange({ diameter: v })} />
        <NumField label="角度 θ" unit="deg" value={d.angle ?? 90} onChange={v => onChange({ angle: v })} />
        <div className="grid grid-cols-3 gap-2">
          {[90, 45, 30].map(angle => (
            <button
              key={angle}
              type="button"
              onClick={() => onChange({ angle })}
              className="rounded-md border border-cyan-200 bg-white px-2 py-1.5 text-sm font-medium text-cyan-700 hover:bg-cyan-50"
            >
              {angle}°
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-600">抵抗係数モード</label>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['auto', '自動'],
              ['manual', '手動'],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange({ elbowLossMode: mode })}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  (d.elbowLossMode ?? 'auto') === mode
                    ? 'border-cyan-400 bg-cyan-50 text-cyan-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {(d.elbowLossMode ?? 'auto') === 'auto' ? (
          <NumField label="90度基準 ζ90" unit="-" value={d.zeta90 ?? 0.75} onChange={v => onChange({ zeta90: v })} />
        ) : (
          <NumField label="抵抗係数 ζ" unit="-" value={d.lossCoefficient ?? 0.75} onChange={v => onChange({ lossCoefficient: v })} />
        )}
      </>)}

      {/* ── Valve ── */}
      {d.nodeType === 'valve' && (<>
        <NumField label="基準径 D" unit="mm" value={d.diameter ?? 100} onChange={v => onChange({ diameter: v })} />
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-600">PQ特性</label>
          <div className="grid grid-cols-1 gap-2">
            {([
              ['linear', 'リニア'],
              ['quickOpening', 'クイックオープン'],
              ['equalPercentage', 'イコールパーセント'],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange({ valveCharacteristic: mode })}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  (d.valveCharacteristic ?? 'linear') === mode
                    ? 'border-rose-400 bg-rose-50 text-rose-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-medium text-gray-600">開度</label>
            <span className="text-sm font-semibold tabular-nums text-rose-700">{(d.valveOpening ?? 100).toFixed(1)} %</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={d.valveOpening ?? 100}
            onChange={e => onChange({ valveOpening: Number(e.target.value) })}
            className="w-full accent-rose-500"
          />
        </div>
        <NumField label="全開時抵抗係数 ζopen" unit="-" value={d.valveZetaFullOpen ?? 1.0} onChange={v => onChange({ valveZetaFullOpen: v })} />
        {(d.valveCharacteristic ?? 'linear') === 'equalPercentage' && (
          <NumField label="レンジアビリティ R" unit="-" value={d.valveRangeability ?? 50} onChange={v => onChange({ valveRangeability: v })} />
        )}
        <div className="rounded-lg border border-rose-100 bg-rose-50 p-3 text-sm text-rose-700">
          <div className="flex justify-between gap-3">
            <span className="text-xs text-rose-500">相対Cv</span>
            <span className="font-semibold tabular-nums">{valveRelativeCapacity(d).toFixed(4)}</span>
          </div>
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-xs text-rose-500">有効ζ</span>
            <span className="font-semibold tabular-nums">{valveEffectiveZeta(d).toFixed(4)}</span>
          </div>
        </div>
      </>)}

      {/* ── Induction Motor ── */}
      {d.nodeType === 'motor' && (<>
        <NumField label="定格軸出力 Pout" unit="kW" value={d.motorRatedPower ?? 5.5} onChange={v => onChange({ motorRatedPower: v })} />
        <NumField label="効率 η" unit="%" value={d.motorEfficiency ?? 90} onChange={v => onChange({ motorEfficiency: v })} />
        <NumField label="電圧 V" unit="V" value={d.motorVoltage ?? 200} onChange={v => onChange({ motorVoltage: v })} />
        <NumField label="周波数 f" unit="Hz" value={d.motorFrequency ?? 50} onChange={v => onChange({ motorFrequency: v })} />
        <NumField label="極数 p" unit="-" value={d.motorPoles ?? 4} onChange={v => onChange({ motorPoles: Math.max(Math.round(v), 1) })} />
        <NumField label="すべり s" unit="%" value={d.motorSlip ?? 3} onChange={v => onChange({ motorSlip: v })} />
        <div className="rounded-lg border border-yellow-100 bg-yellow-50 p-3 text-sm text-yellow-800">
          <div className="flex justify-between gap-3">
            <span className="text-xs text-yellow-600">動作回転数</span>
            <span className="font-semibold tabular-nums">{(d.speed ?? motorRatedSpeed(d)).toFixed(0)} rpm</span>
          </div>
          {d.shaftTorque !== undefined && (
            <div className="mt-1 flex justify-between gap-3">
              <span className="text-xs text-yellow-600">発生トルク</span>
              <span className="font-semibold tabular-nums">{d.shaftTorque.toFixed(3)} N·m</span>
            </div>
          )}
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-xs text-yellow-600">回転数決定</span>
            <span className="font-semibold">{speedSolveModeLabel(d.speedSolveMode)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-xs text-yellow-600">同期速度</span>
            <span className="font-semibold tabular-nums">{motorSynchronousSpeed(d).toFixed(0)} rpm</span>
          </div>
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-xs text-yellow-600">定格回転数</span>
            <span className="font-semibold tabular-nums">{motorRatedSpeed(d).toFixed(0)} rpm</span>
          </div>
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-xs text-yellow-600">入力電力</span>
            <span className="font-semibold tabular-nums">{motorInputPower(d).toFixed(3)} kW</span>
          </div>
        </div>
      </>)}

      {/* ── Fixed Speed Boundary ── */}
      {d.nodeType === 'speedBoundary' && (
        <NumField label="固定回転数 N" unit="rpm" value={d.fixedSpeed ?? 1450} onChange={v => onChange({ fixedSpeed: v })} />
      )}

      {/* ── Tee ── */}
      {d.nodeType === 'tee' && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-gray-600">T字管モード</label>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['split', '分岐'],
              ['merge', '合流'],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange({ teeMode: mode })}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  (d.teeMode ?? 'split') === mode
                    ? 'border-amber-400 bg-amber-50 text-amber-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const REGIME_TEXT_LABEL: Record<string, string> = {
  laminar: '層流', transitional: '遷移域', turbulent: '乱流', junction: '節点',
}

function ResultsPanel({ node, pressureUnit, rho, onToggleResultSymbol }: {
  node: Node | null
  pressureUnit: PressureUnit
  rho: number
  onToggleResultSymbol: (nodeId: string, symbol: string, checked: boolean, allSymbols: string[]) => void
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
          selectedSymbols={d.resultVisibleSymbols}
          onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
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
        selectedSymbols={d.resultVisibleSymbols}
        onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
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
        selectedSymbols={d.resultVisibleSymbols}
        onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
      />
    )
  }

  if (d.nodeType === 'turbine') {
    if (!d.result) return empty
    return (
      <ResultTable
        theme="green"
        title="計算結果 — タービン"
        rows={turbineResultRows(d.result, pressureUnit, rho)}
        selectedSymbols={d.resultVisibleSymbols}
        onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
      />
    )
  }

  if (d.nodeType === 'heatExchanger') {
    if (!d.result) return empty
    return (
      <ResultTable
        theme="orange"
        title="計算結果 — 熱交換器"
        rows={heatExchangerResultRows(d.result, pressureUnit, rho)}
        selectedSymbols={d.resultVisibleSymbols}
        onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
      />
    )
  }

  if (d.nodeType === 'reducer') {
    if (!d.result) return empty
    return (
      <ResultTable
        theme="sky"
        title="計算結果 — 拡縮管"
        rows={reducerResultRows(d.result, pressureUnit, rho)}
        selectedSymbols={d.resultVisibleSymbols}
        onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
      />
    )
  }

  if (d.nodeType === 'elbow') {
    if (!d.result) return empty
    return (
      <ResultTable
        theme="blue"
        title="計算結果 — エルボ"
        rows={elbowResultRows(d.result, pressureUnit, rho)}
        selectedSymbols={d.resultVisibleSymbols}
        onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
      />
    )
  }

  if (d.nodeType === 'valve') {
    if (!d.result) return empty
    return (
      <ResultTable
        theme="rose"
        title="計算結果 — バルブ"
        rows={valveResultRows(d.result, pressureUnit, rho)}
        selectedSymbols={d.resultVisibleSymbols}
        onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
      />
    )
  }

  if (d.nodeType === 'motor') {
    return (
      <ResultTable
        theme="amber"
        title="設定値 — 誘導モーター"
        rows={motorResultRows(d)}
        selectedSymbols={d.resultVisibleSymbols}
        onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
      />
    )
  }

  if (d.nodeType === 'speedBoundary') {
    return (
      <ResultTable
        theme="amber"
        title="設定値 — 回転境界"
        rows={speedBoundaryResultRows(d)}
        selectedSymbols={d.resultVisibleSymbols}
        onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
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
          selectedSymbols={d.resultVisibleSymbols}
          onToggleSymbol={(symbol, checked, allSymbols) => onToggleResultSymbol(node.id, symbol, checked, allSymbols)}
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
  const isTurbine = d?.nodeType === 'turbine'
  const isHeatExchanger = d?.nodeType === 'heatExchanger'
  const isReducer = d?.nodeType === 'reducer'
  const isElbow = d?.nodeType === 'elbow'
  const isValve = d?.nodeType === 'valve'
  const isMotor = d?.nodeType === 'motor'

  const [chartData, setChartData] = useState<PressureDropResult | null>(null)
  const [fetching,  setFetching]  = useState(false)
  const [fetchErr,  setFetchErr]  = useState<string | null>(null)
  const pumpQMax = isPump && d ? pumpMaxFlow(d) : null
  const heatExchangerRatedFlow = isHeatExchanger && d ? Math.max(d.ratedFlow ?? 10, 1e-9) : null
  const heatExchangerNominalDp = isHeatExchanger && d ? Math.max(d.nominalPressureDrop ?? 10, 0) : null

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
    if (isMotor && d) {
      const ns = Math.max(motorSynchronousSpeed(d), 1)
      const nr = motorRatedSpeed(d)
      const speeds = Array.from({ length: 120 }, (_, i) => ns * i / 119)
      const out: object[] = [{
        x: speeds,
        y: speeds.map(n => motorPowerAtSpeed(d, n)),
        type: 'scatter',
        mode: 'lines',
        name: '軸出力特性',
        line: { color: '#ca8a04', width: 2.8 },
        hovertemplate: 'N: %{x:.0f} rpm<br>Pout: %{y:.3f} kW<extra></extra>',
      }, {
        x: speeds,
        y: speeds.map(n => motorTorqueAtSpeed(d, n)),
        yaxis: 'y2',
        type: 'scatter',
        mode: 'lines',
        name: '発生トルク',
        line: { color: '#f97316', width: 2.4, dash: 'dot' },
        hovertemplate: 'N: %{x:.0f} rpm<br>T: %{y:.3f} N·m<extra></extra>',
      }, {
        x: [nr],
        y: [d.motorRatedPower ?? 5.5],
        type: 'scatter',
        mode: 'markers',
        name: '定格点',
        marker: { color: '#059669', size: 12, symbol: 'circle', line: { color: '#fff', width: 2 } },
        hovertemplate: 'Nr: %{x:.0f} rpm<br>Pout: %{y:.3f} kW<extra>定格点</extra>',
      }, {
        x: [ns],
        y: [0],
        type: 'scatter',
        mode: 'markers',
        name: '同期速度',
        marker: { color: '#64748b', size: 10, symbol: 'diamond', line: { color: '#fff', width: 2 } },
        hovertemplate: 'Ns: %{x:.0f} rpm<extra>同期速度</extra>',
      }]
      if (d.speed !== undefined) {
        out.push({
          x: [d.speed],
          y: [motorPowerAtSpeed(d, d.speed)],
          type: 'scatter',
          mode: 'markers',
          name: '動作点',
          marker: { color: '#dc2626', size: 13, symbol: 'circle', line: { color: '#fff', width: 2 } },
          hovertemplate: 'N: %{x:.0f} rpm<br>Pout: %{y:.3f} kW<extra>動作点</extra>',
        }, {
          x: [d.speed],
          y: [d.shaftTorque ?? motorTorqueAtSpeed(d, d.speed)],
          yaxis: 'y2',
          type: 'scatter',
          mode: 'markers',
          name: '動作トルク',
          marker: { color: '#ea580c', size: 12, symbol: 'square', line: { color: '#fff', width: 2 } },
          hovertemplate: 'N: %{x:.0f} rpm<br>T: %{y:.3f} N·m<extra>動作トルク</extra>',
        })
      }
      return out
    }

    if (isValve && d) {
      const diameter = Math.max(d.diameter ?? 100, 1e-9) / 1000
      const area = Math.PI * diameter ** 2 / 4
      const zeta = d.result?.loss_coefficient ?? valveEffectiveZeta(d)
      const resultQ = Math.abs(d.result?.Q_m3h ?? 0)
      const qMax = Math.max(resultQ * 1.2, area * 5 * 3600, 1)
      const flowRates = Array.from({ length: 100 }, (_, i) => qMax * i / 99)
      const out: object[] = [{
        x: flowRates,
        y: flowRates.map(q => {
          const qM3s = q / 3600
          const v = area > 0 ? qM3s / area : 0
          return kpaToUnit(zeta * rho * v ** 2 / 2 / 1000, pressureUnit, rho)
        }),
        type: 'scatter',
        mode: 'lines',
        name: `${valveCharacteristicLabel(d.valveCharacteristic)} ${d.valveOpening ?? 100}%`,
        line: { color: '#e11d48', width: 2.8 },
        hovertemplate: `Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} ${pressureUnit}<extra></extra>`,
      }]
      if (d.result) {
        out.push({
          x: [d.result.Q_m3h],
          y: [kpaToUnit(d.result.dP_kpa, pressureUnit, rho)],
          type: 'scatter',
          mode: 'markers',
          name: '動作点',
          marker: { color: '#059669', size: 12, symbol: 'circle', line: { color: '#fff', width: 2 } },
          hovertemplate: `Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} ${pressureUnit}<extra>動作点</extra>`,
        })
      }
      return out
    }

    if (isElbow && d) {
      const diameter = Math.max(d.diameter ?? 100, 1e-9) / 1000
      const area = Math.PI * diameter ** 2 / 4
      const zeta = d.result?.loss_coefficient ?? (
        (d.elbowLossMode ?? 'auto') === 'manual'
          ? Math.max(d.lossCoefficient ?? 0.75, 0)
          : Math.max(d.zeta90 ?? 0.75, 0) * (Math.max(d.angle ?? 90, 0) / 90)
      )
      const resultQ = Math.abs(d.result?.Q_m3h ?? 0)
      const qMax = Math.max(resultQ * 1.2, area * 5 * 3600, 1)
      const flowRates = Array.from({ length: 100 }, (_, i) => qMax * i / 99)
      const out: object[] = [{
        x: flowRates,
        y: flowRates.map(q => {
          const qM3s = q / 3600
          const v = area > 0 ? qM3s / area : 0
          return kpaToUnit(zeta * rho * v ** 2 / 2 / 1000, pressureUnit, rho)
        }),
        type: 'scatter',
        mode: 'lines',
        name: 'ζ特性',
        line: { color: '#0891b2', width: 2.8 },
        hovertemplate: `Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} ${pressureUnit}<extra></extra>`,
      }]
      if (d.result) {
        out.push({
          x: [d.result.Q_m3h],
          y: [kpaToUnit(d.result.dP_kpa, pressureUnit, rho)],
          type: 'scatter',
          mode: 'markers',
          name: '動作点',
          marker: { color: '#059669', size: 12, symbol: 'circle', line: { color: '#fff', width: 2 } },
          hovertemplate: `Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} ${pressureUnit}<extra>動作点</extra>`,
        })
      }
      return out
    }

    if (isReducer && d) {
      const dIn = Math.max(d.diameterIn ?? 100, 1e-9) / 1000
      const dOut = Math.max(d.diameterOut ?? 50, 1e-9) / 1000
      const smallArea = Math.PI * Math.min(dIn, dOut) ** 2 / 4
      const zeta = d.result?.loss_coefficient ?? Math.max(d.lossCoefficient ?? 0.5, 0)
      const resultQ = Math.abs(d.result?.Q_m3h ?? 0)
      const qMax = Math.max(resultQ * 1.2, smallArea * 5 * 3600, 1)
      const flowRates = Array.from({ length: 100 }, (_, i) => qMax * i / 99)
      const out: object[] = [{
        x: flowRates,
        y: flowRates.map(q => {
          const qM3s = q / 3600
          const v = smallArea > 0 ? qM3s / smallArea : 0
          return kpaToUnit(zeta * rho * v ** 2 / 2 / 1000, pressureUnit, rho)
        }),
        type: 'scatter',
        mode: 'lines',
        name: 'ζ特性',
        line: { color: '#65a30d', width: 2.8 },
        hovertemplate: `Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} ${pressureUnit}<extra></extra>`,
      }]
      if (d.result) {
        out.push({
          x: [d.result.Q_m3h],
          y: [kpaToUnit(d.result.dP_kpa, pressureUnit, rho)],
          type: 'scatter',
          mode: 'markers',
          name: '動作点',
          marker: { color: '#059669', size: 12, symbol: 'circle', line: { color: '#fff', width: 2 } },
          hovertemplate: `Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} ${pressureUnit}<extra>動作点</extra>`,
        })
      }
      return out
    }

    if (isHeatExchanger && d) {
      const qRated = Math.max(d.ratedFlow ?? 10, 1e-9)
      const dpNominal = Math.max(d.nominalPressureDrop ?? 10, 0)
      const resultQ = Math.abs(d.result?.Q_m3h ?? 0)
      const qMax = Math.max(qRated * 2, resultQ * 1.2, 1)
      const flowRates = Array.from({ length: 100 }, (_, i) => qMax * i / 99)
      const out: object[] = [{
        x: flowRates,
        y: flowRates.map(q => kpaToUnit(dpNominal * (q / qRated) ** 2, pressureUnit, rho)),
        type: 'scatter',
        mode: 'lines',
        name: 'PQ特性',
        line: { color: '#f97316', width: 2.8 },
        hovertemplate: `Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} ${pressureUnit}<extra></extra>`,
      }, {
        x: [qRated],
        y: [kpaToUnit(dpNominal, pressureUnit, rho)],
        type: 'scatter',
        mode: 'markers',
        name: '定格点',
        marker: { color: '#f59e0b', size: 10, symbol: 'diamond', line: { color: '#fff', width: 2 } },
        hovertemplate: `Qr: %{x:.2f} m³/h<br>ΔPn: %{y:.3f} ${pressureUnit}<extra>定格点</extra>`,
      }]
      if (d.result) {
        out.push({
          x: [d.result.Q_m3h],
          y: [kpaToUnit(d.result.dP_kpa, pressureUnit, rho)],
          type: 'scatter',
          mode: 'markers',
          name: '動作点',
          marker: { color: '#059669', size: 12, symbol: 'circle', line: { color: '#fff', width: 2 } },
          hovertemplate: `Q: %{x:.2f} m³/h<br>ΔP: %{y:.3f} ${pressureUnit}<extra>動作点</extra>`,
        })
      }
      return out
    }

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
      }, {
        x: flowRates,
        y: flowRates.map(q => pumpShaftTorqueAtFlow(d, q, rho)),
        yaxis: 'y2',
        type: 'scatter',
        mode: 'lines',
        name: '軸トルク特性',
        line: { color: '#f97316', width: 2.4, dash: 'dot' },
        hovertemplate: 'Q: %{x:.2f} m³/h<br>T: %{y:.3f} N·m<extra></extra>',
      }]
      if (d.result) {
        const resultTorque = d.result.shaft_torque_nm ?? pumpShaftTorqueAtFlow(d, d.result.Q_m3h, rho)
        out.push({
          x: [d.result.Q_m3h],
          y: [d.result.head_m ?? pumpHeadAt(d, d.result.Q_m3h)],
          type: 'scatter',
          mode: 'markers',
          name: '動作点',
          marker: { color: '#059669', size: 12, symbol: 'circle', line: { color: '#fff', width: 2 } },
          hovertemplate: 'Q: %{x:.2f} m³/h<br>H: %{y:.3f} m<extra>動作点</extra>',
        }, {
          x: [d.result.Q_m3h],
          y: [resultTorque],
          yaxis: 'y2',
          type: 'scatter',
          mode: 'markers',
          name: '動作トルク',
          marker: { color: '#ea580c', size: 12, symbol: 'square', line: { color: '#fff', width: 2 } },
          hovertemplate: 'Q: %{x:.2f} m³/h<br>T: %{y:.3f} N·m<extra>動作トルク</extra>',
        })
      }
      return out
    }

    if (isTurbine && d) {
      const qRated = Math.max(d.ratedFlow ?? 30, 1e-9)
      const resultQ = Math.abs(d.result?.Q_m3h ?? 0)
      const qMax = Math.max(qRated * 2, resultQ * 1.2, 1)
      const flowRates = Array.from({ length: 100 }, (_, i) => qMax * i / 99)
      const out: object[] = [{
        x: flowRates,
        y: flowRates.map(q => turbineHeadAtFlow(d, q)),
        type: 'scatter',
        mode: 'lines',
        name: '有効落差特性',
        line: { color: '#059669', width: 2.8 },
        hovertemplate: 'Q: %{x:.2f} m³/h<br>H: %{y:.3f} m<extra></extra>',
      }, {
        x: flowRates,
        y: flowRates.map(q => turbineShaftTorqueAtFlow(d, q, rho)),
        yaxis: 'y2',
        type: 'scatter',
        mode: 'lines',
        name: '軸トルク特性',
        line: { color: '#f97316', width: 2.4, dash: 'dot' },
        hovertemplate: 'Q: %{x:.2f} m³/h<br>T: %{y:.3f} N·m<extra></extra>',
      }]
      if (d.result) {
        const resultTorque = d.result.shaft_torque_nm ?? turbineShaftTorqueAtFlow(d, d.result.Q_m3h, rho)
        out.push({
          x: [d.result.Q_m3h],
          y: [d.result.head_m ?? turbineHeadAtFlow(d, d.result.Q_m3h)],
          type: 'scatter',
          mode: 'markers',
          name: '動作点',
          marker: { color: '#059669', size: 12, symbol: 'circle', line: { color: '#fff', width: 2 } },
          hovertemplate: 'Q: %{x:.2f} m³/h<br>H: %{y:.3f} m<extra>動作点</extra>',
        }, {
          x: [d.result.Q_m3h],
          y: [resultTorque],
          yaxis: 'y2',
          type: 'scatter',
          mode: 'markers',
          name: '動作トルク',
          marker: { color: '#ea580c', size: 12, symbol: 'square', line: { color: '#fff', width: 2 } },
          hovertemplate: 'Q: %{x:.2f} m³/h<br>T: %{y:.3f} N·m<extra>動作トルク</extra>',
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
  }, [chartData, d, isElbow, isHeatExchanger, isMotor, isPump, isReducer, isTurbine, isValve, pressureUnit, rho])

  if (!node || (!isPipe && !isPump && !isTurbine && !isHeatExchanger && !isReducer && !isElbow && !isValve && !isMotor)) {
    return (
      <div className="flex items-center justify-center h-48">
        <p className="text-sm text-gray-300">パイプ、ポンプ、タービン、熱交換器、拡縮管、エルボ、バルブ、モーターを選択すると特性曲線を表示します</p>
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
      {(chartData || isPump || isTurbine || isHeatExchanger || isReducer || isElbow || isValve || isMotor) && !fetching && (
        <Plot
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data={traces as any}
          layout={{
            title: { text: isMotor ? '回転数–出力/トルク特性（誘導モーター）' : isPump ? '流量–揚程/トルク特性（ポンプ）' : isTurbine ? '流量–落差/トルク特性（タービン）' : isHeatExchanger ? '流量–圧損特性（熱交換器）' : isReducer ? '流量–圧損特性（拡縮管）' : isElbow ? '流量–圧損特性（エルボ）' : isValve ? '流量–圧損特性（バルブ）' : '流量–圧損特性（Darcy-Weisbach）', font: { size: 13 } },
            xaxis: { title: { text: isMotor ? '回転数 N [rpm]' : '流量 Q [m³/h]' }, showgrid: true, gridcolor: '#f1f5f9', zeroline: false },
            yaxis: { title: { text: isMotor ? '軸出力 Pout [kW]' : isPump ? '揚程 H [m]' : isTurbine ? '有効落差 H [m]' : `ΔP [${pressureUnit}]` }, showgrid: true, gridcolor: '#f1f5f9', zeroline: false },
            ...(isMotor || isPump || isTurbine ? { yaxis2: { title: { text: 'トルク T [N·m]' }, overlaying: 'y' as const, side: 'right' as const, showgrid: false, zeroline: false } } : {}),
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
            }] : heatExchangerRatedFlow !== null && heatExchangerNominalDp !== null ? [{
              x: heatExchangerRatedFlow,
              y: kpaToUnit(heatExchangerNominalDp, pressureUnit, rho),
              ax: 30,
              ay: -60,
              text: `Qr / ΔPn:<br>${heatExchangerRatedFlow.toFixed(1)} m³/h<br>${kpaToUnit(heatExchangerNominalDp, pressureUnit, rho).toFixed(3)} ${pressureUnit}`,
              showarrow: true,
              arrowhead: 2,
              bordercolor: '#f97316',
              borderwidth: 1,
              bgcolor: '#ffffff',
              font: { size: 13, color: '#9a3412' },
            }] : [],
            legend: { orientation: 'h' as const, y: -0.22, x: 0 },
            margin: { l: 60, r: isMotor || isPump || isTurbine ? 62 : 24, t: 44, b: 70 },
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
      const rows = componentResultRows(n.data, pressureUnit, n.data.rho ?? rho)
      if (!rows || rows.length === 0) continue
      if (!byId.has(n.id)) order.push(n.id)
      byId.set(n.id, { id: n.id, label: n.data.label, typeLabel: componentTypeLabel(n.data.nodeType), rows })
    }
  }
  return order.map(id => byId.get(id)!)
}

function numericValue(value: string): number | null {
  const n = Number.parseFloat(value.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function decimalPlaces(value: string): number {
  const match = value.match(/\.(\d+)/)
  return match ? match[1].length : 0
}

function formatDelta(value: string, baseline: string): string | null {
  const current = numericValue(value)
  const base = numericValue(baseline)
  if (current === null || base === null) return null
  const diff = current - base
  const decimals = Math.max(decimalPlaces(value), decimalPlaces(baseline))
  const sign = diff > 0 ? '+' : ''
  return `${sign}${diff.toFixed(decimals)}`
}

function SystemResultsTable({ components, runHistory, pressureUnit, rho, baselineRunId, onBaselineChange }: {
  components: SystemComponent[]
  runHistory: CalcRun[]
  pressureUnit: PressureUnit
  rho: number
  baselineRunId: string | null
  onBaselineChange: (runId: string | null) => void
}) {
  const cellValue = (run: CalcRun, componentId: string, symbol: string): string => {
    const nodeData = run.nodes.find(n => n.id === componentId)?.data
    const rows = nodeData ? componentResultRows(nodeData, pressureUnit, nodeData.rho ?? rho) : null
    const row = rows?.find(r => r.symbol === symbol)
    return row ? row.value : '—'
  }
  const baselineRun = baselineRunId ? runHistory.find(run => run.id === baselineRunId) : null

  if (components.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-center text-sm text-gray-400">
        結果表示で項目にチェックを入れると一覧に追加されます
      </div>
    )
  }

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-xs text-gray-400">
          <th className="py-1 pr-3" />
          <th className="py-1 pr-3" />
          <th className="py-1 pr-3" />
          <th className="text-left font-medium py-1 pr-3">ベースライン</th>
          {runHistory.map((run, i) => (
            <th key={run.id} className="text-right font-medium py-1 pr-3 whitespace-nowrap">
              <label className="inline-flex cursor-pointer select-none items-center justify-end gap-1.5">
              <input
                type="radio"
                name="baseline-run"
                checked={baselineRunId === run.id}
                onChange={() => onBaselineChange(run.id)}
                className="h-3.5 w-3.5 accent-blue-600"
              />
                <span className={baselineRunId === run.id ? 'text-blue-600' : ''}>実行{i + 1}</span>
              </label>
              <div className="text-[10px] text-gray-300 font-normal">{new Date(run.timestamp).toLocaleTimeString('ja-JP')}</div>
            </th>
          ))}
        </tr>
        <tr className="text-xs text-gray-400 border-b border-gray-200">
          <th className="text-left font-medium py-2 pr-3">部品</th>
          <th className="text-left font-medium py-2 pr-3">種別</th>
          <th className="text-left font-medium py-2 pr-3">項目</th>
          <th className="text-left font-medium py-2 pr-3">単位</th>
          {runHistory.map((run, i) => (
            <th key={run.id} className="text-right font-medium py-2 pr-3 whitespace-nowrap">
              <span className={baselineRunId === run.id ? 'text-blue-600' : ''}>実行{i + 1}</span>
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
            {runHistory.map(run => {
              const value = cellValue(run, comp.id, row.symbol)
              const baselineValue = baselineRun ? cellValue(baselineRun, comp.id, row.symbol) : '—'
              const delta = baselineRun && baselineRun.id !== run.id ? formatDelta(value, baselineValue) : null
              return (
                <td
                  key={run.id}
                  className={`py-1.5 pr-3 text-right tabular-nums whitespace-nowrap ${row.highlight ? 'font-semibold text-gray-800' : 'text-gray-700'}`}
                >
                  <div>{value}</div>
                  {delta !== null && (
                    <div className={`text-[11px] font-normal ${numericValue(delta) && numericValue(delta)! > 0 ? 'text-rose-500' : numericValue(delta) && numericValue(delta)! < 0 ? 'text-blue-500' : 'text-gray-400'}`}>
                      ({delta})
                    </div>
                  )}
                </td>
              )
            })}
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
  const [fluidSystems, setFluidSystems] = useState<FluidSystem[]>(() => createDefaultFluidSystems())
  const [selectedFluidSystemId, setSelectedFluidSystemId] = useState(DEFAULT_FLUID_SYSTEM_ID)
  const selectedFluidSystem = fluidSystems.find(system => system.id === selectedFluidSystemId) ?? fluidSystems[0]
  const rho = selectedFluidSystem?.density ?? (parseFloat(density) || 1000)
  const selectedRho = selectedData ? fluidSystemForNode(selectedData, fluidSystems).density : rho
  const powerSpeedResolution = useMemo(() => resolvePowerSpeeds(nodes, edges, fluidSystems), [nodes, edges, fluidSystems])

  const updateFluidSystem = useCallback((id: string, updates: Partial<FluidSystem>) => {
    setFluidSystems(prev => prev.map(system => system.id === id ? { ...system, ...updates } : system))
  }, [])

  const addFluidSystem = useCallback(() => {
    setFluidSystems(prev => {
      const index = prev.length + 1
      const id = `fluid-${Date.now().toString(36)}`
      const next: FluidSystem = {
        id,
        name: `流体系統${index}`,
        fluid: 'Air',
        propertyMode: 'constant',
        density: 1.2,
        viscosity: 0.000018,
        specificHeat: 1005,
        color: FLUID_SYSTEM_COLORS[prev.length % FLUID_SYSTEM_COLORS.length],
      }
      setSelectedFluidSystemId(id)
      return [...prev, next]
    })
  }, [])

  const removeFluidSystem = useCallback((id: string) => {
    setFluidSystems(prev => {
      if (prev.length <= 1) return prev
      const fallback = prev.find(system => system.id !== id) ?? prev[0]
      setSelectedFluidSystemId(current => current === id ? fallback.id : current)
      setNodes(nodesPrev => nodesPrev.map(n => {
        const d = n.data as unknown as NetworkNodeData
        if ((d.fluidSystemId ?? prev[0].id) !== id) return n
        return { ...n, data: { ...d, fluidSystemId: fallback.id } as NetworkNodeData }
      }))
      return prev.filter(system => system.id !== id)
    })
  }, [setNodes])

  const displayNodes = useMemo(() => {
    const fluidEdges = edges.filter(e => ((e.data as FlowEdgeData | undefined)?.lineType ?? 'fluid') === 'fluid')
    const inConnected = new Set(fluidEdges.map(e => e.target))
    const outConnected = new Set(fluidEdges.map(e => e.source))
    return nodes.map(n => {
      const data = n.data as unknown as NetworkNodeData
      const system = fluidSystemForNode(data, fluidSystems)
      const resolvedSpeed = powerSpeedResolution.speeds.get(n.id)
      const resolvedTorque = powerSpeedResolution.torques.get(n.id)
      const solveMode = powerSpeedResolution.modes.get(n.id)
      const displayData = ['pump', 'motor', 'turbine'].includes(data.nodeType)
        ? {
          ...data,
          speed: resolvedSpeed ?? (data.nodeType === 'motor' ? motorRatedSpeed(data) : data.ratedSpeed ?? 1450),
          ...(resolvedTorque !== undefined ? { shaftTorque: resolvedTorque } : {}),
          ...(solveMode !== undefined ? { speedSolveMode: solveMode } : {}),
        }
        : data
      return {
        ...n,
        data: {
        ...displayData,
        portLeftConnected: inConnected.has(n.id),
        portRightConnected: outConnected.has(n.id),
        portInConnected: inConnected.has(n.id),
        portOutConnected: outConnected.has(n.id),
        showPressureResults,
        pressureUnit,
        rho: system.density,
      },
      }
    })
  }, [nodes, edges, showPressureResults, pressureUnit, fluidSystems, powerSpeedResolution])
  const displayEdges = useMemo(() => edges.map(e => ({
    ...e,
    data: {
      ...((e.data as Record<string, unknown> | undefined) ?? {}),
      labelVisible: showLineResults,
      fluidColor: ((e.data as FlowEdgeData | undefined)?.lineType ?? 'fluid') === 'fluid'
        ? fluidColorForEdge(e, nodes, fluidSystems)
        : undefined,
    },
  })), [edges, nodes, fluidSystems, showLineResults])
  const selectedDisplayNode: Node | null = displayNodes.find(n => n.id === selectedId) ?? selectedNode

  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [totalDp,   setTotalDp]   = useState<number | null>(null)
  const [runHistory, setRunHistory] = useState<CalcRun[]>([])
  const [baselineRunId, setBaselineRunId] = useState<string | null>(null)
  const systemComponents = useMemo(
    () => buildSystemComponents(runHistory, pressureUnit, rho),
    [runHistory, pressureUnit, rho],
  )
  const clearRunHistory = () => {
    setRunHistory([])
    setBaselineRunId(null)
  }

  const updateResultSymbolSelection = useCallback((
    nodeId: string,
    symbol: string,
    checked: boolean,
    allSymbols: string[],
  ) => {
    const nextData = (data: NetworkNodeData): NetworkNodeData => {
      const current = data.resultVisibleSymbols ?? []
      const selected = new Set(current)
      if (checked) {
        selected.add(symbol)
      } else {
        selected.delete(symbol)
      }
      return {
        ...data,
        resultVisibleSymbols: allSymbols.filter(s => selected.has(s)),
      }
    }

    setNodes(prev => prev.map(n => {
      if (n.id !== nodeId) return n
      return { ...n, data: nextData(n.data as unknown as NetworkNodeData) as NetworkNodeData }
    }))
    setRunHistory(prev => prev.map(run => ({
      ...run,
      nodes: run.nodes.map(n => (
        n.id === nodeId ? { ...n, data: nextData(n.data) } : n
      )),
    })))
  }, [setNodes])

  const clearSketch = () => {
    if (!window.confirm('ダイアグラムをすべて削除します。よろしいですか？')) return
    setNodes([])
    setEdges([])
    setSelectedId(null)
    setTotalDp(null)
    setError(null)
    setRunHistory([])
    setBaselineRunId(null)
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
      if (selectedFluidSystem) {
        updateFluidSystem(selectedFluidSystem.id, {
          fluid: coolFluid,
          ...(props.D != null ? { density: props.D } : {}),
          ...(props.V != null ? { viscosity: props.V } : {}),
        })
      }
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
    const data = defaultData(type, nodeCounter.current)
    setNodes(prev => [...prev, {
      id, type, position: pos,
      data: { ...data, ...(!['motor', 'speedBoundary'].includes(data.nodeType) ? { fluidSystemId: selectedFluidSystemId } : {}) } as NetworkNodeData,
    }])
  }, [screenToFlowPosition, selectedFluidSystemId, setNodes])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  // ── Connect ──────────────────────────────────────────────────
  const onConnect = useCallback((conn: Connection) => {
    const lineType = connectionLineType(conn.sourceHandle, conn.targetHandle)
    if (!lineType) {
      setError('異なる種類のポートは接続できません。丸ポート同士、または四角ポート同士を接続してください。')
      return
    }
    setError(null)
    setEdges(prev => addEdge({
      ...conn,
      type: 'flow',
      data: { lineType },
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
      if (powerSpeedResolution.errors.length > 0) {
        throw new Error(powerSpeedResolution.errors.join('\n'))
      }
      const res = await calcPipeNetwork({
        nodes: nodes.map(n => {
          const d = n.data as unknown as NetworkNodeData
          const resolvedSpeed = powerSpeedResolution.speeds.get(n.id)
          const resolvedTorque = powerSpeedResolution.torques.get(n.id)
          const solveMode = powerSpeedResolution.modes.get(n.id)
          return {
            id: n.id,
            node_type: d.nodeType,
            params: {
              ...(n.data as Record<string, unknown>),
              ...(!['motor', 'speedBoundary'].includes(d.nodeType) ? { fluidSystemId: d.fluidSystemId ?? fluidSystems[0]?.id ?? DEFAULT_FLUID_SYSTEM_ID } : {}),
              ...(['pump', 'motor', 'turbine'].includes(d.nodeType) ? {
                speed: resolvedSpeed ?? (d.nodeType === 'motor' ? motorRatedSpeed(d) : d.ratedSpeed ?? 1450),
                ...(resolvedTorque !== undefined ? { shaftTorque: resolvedTorque } : {}),
                ...(solveMode !== undefined ? { speedSolveMode: solveMode } : {}),
              } : {}),
            },
          }
        }),
        edges: edges.map(e => ({
          id: e.id, source: e.source, target: e.target,
          source_handle: e.sourceHandle ?? null,
          target_handle: e.targetHandle ?? null,
          line_type: ((e.data as FlowEdgeData | undefined)?.lineType ?? 'fluid'),
        })),
        density:   parseFloat(density),
        viscosity: parseFloat(viscosity) / 1000,
        fluidSystems: fluidSystems.map(system => ({
          id: system.id,
          name: system.name,
          fluid: system.fluid,
          propertyMode: system.propertyMode,
          density: system.density,
          viscosity: system.viscosity,
          specificHeat: system.specificHeat,
          color: system.color,
        })),
      })

      const mergeResult = (d: NetworkNodeData, id: string): NetworkNodeData => {
        const nodeResult  = res.nodes[id]
        const srcPressure = res.source_pressures[id]
        const srcFlow     = res.source_flows[id]
        const srcTemp     = res.source_temperatures?.[id] ?? res.boundary_temperatures?.[id]
        const system = fluidSystemForNode(d, fluidSystems)
        const resolvedSpeed = powerSpeedResolution.speeds.get(id)
        const resolvedTorque = powerSpeedResolution.torques.get(id)
        const solveMode = powerSpeedResolution.modes.get(id)
        return {
          ...d,
          rho: system.density,
          ...(['pump', 'motor', 'turbine'].includes(d.nodeType) ? {
            speed: resolvedSpeed ?? (d.nodeType === 'motor' ? motorRatedSpeed(d) : d.ratedSpeed ?? 1450),
            ...(resolvedTorque !== undefined ? { shaftTorque: resolvedTorque } : {}),
            ...(solveMode !== undefined ? { speedSolveMode: solveMode } : {}),
          } : {}),
          ...(nodeResult  !== undefined ? { result: nodeResult }        : {}),
          ...(srcPressure !== undefined ? { calcPressure: srcPressure } : {}),
          ...(srcFlow     !== undefined ? { calcFlow: srcFlow }         : {}),
          ...(srcTemp     !== undefined ? { calcTemperature: srcTemp }  : {}),
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
        if (((edge.data as FlowEdgeData | undefined)?.lineType ?? 'fluid') !== 'fluid') return undefined
        const sourceData = nodeById.get(edge.source)?.data as unknown as NetworkNodeData | undefined
        const targetData = nodeById.get(edge.target)?.data as unknown as NetworkNodeData | undefined
        const elementId =
          sourceData?.nodeType === 'pipe' || sourceData?.nodeType === 'pump' || sourceData?.nodeType === 'turbine' || sourceData?.nodeType === 'heatExchanger' || sourceData?.nodeType === 'reducer' || sourceData?.nodeType === 'elbow' || sourceData?.nodeType === 'valve' ? edge.source
          : targetData?.nodeType === 'pipe' || targetData?.nodeType === 'pump' || targetData?.nodeType === 'turbine' || targetData?.nodeType === 'heatExchanger' || targetData?.nodeType === 'reducer' || targetData?.nodeType === 'elbow' || targetData?.nodeType === 'valve' ? edge.target
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

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-gray-500 shrink-0">系統</span>
            <select
              value={selectedFluidSystem?.id ?? ''}
              onChange={e => setSelectedFluidSystemId(e.target.value)}
              className="border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {fluidSystems.map(system => (
                <option key={system.id} value={system.id}>{system.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={addFluidSystem}
              className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
            >
              追加
            </button>
            <button
              type="button"
              onClick={() => selectedFluidSystem && removeFluidSystem(selectedFluidSystem.id)}
              disabled={fluidSystems.length <= 1}
              className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              削除
            </button>
          </div>

          {selectedFluidSystem && (
            <>
              <input
                type="text"
                value={selectedFluidSystem.name}
                onChange={e => updateFluidSystem(selectedFluidSystem.id, { name: e.target.value })}
                className="w-28 border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="color"
                value={selectedFluidSystem.color}
                onChange={e => updateFluidSystem(selectedFluidSystem.id, { color: e.target.value })}
                className="h-8 w-9 rounded border border-gray-300 bg-white p-1"
                title="系統色"
              />
            </>
          )}

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
          <InlineField
            label="密度 ρ"
            unit="kg/m³"
            value={selectedFluidSystem ? selectedFluidSystem.density.toString() : density}
            onChange={value => {
              setDensity(value)
              if (selectedFluidSystem) updateFluidSystem(selectedFluidSystem.id, { density: Number(value) || 0 })
            }}
            width="w-24"
          />
          <InlineField
            label="粘度 μ"
            unit="mPa·s"
            value={selectedFluidSystem ? (selectedFluidSystem.viscosity * 1000).toString() : viscosity}
            onChange={value => {
              setViscosity(value)
              if (selectedFluidSystem) updateFluidSystem(selectedFluidSystem.id, { viscosity: (Number(value) || 0) / 1000 })
            }}
            width="w-20"
          />
          {selectedFluidSystem && (
            <InlineField
              label="比熱 Cp"
              unit="J/kg/K"
              value={selectedFluidSystem.specificHeat.toString()}
              onChange={value => updateFluidSystem(selectedFluidSystem.id, { specificHeat: Number(value) || 0 })}
              width="w-24"
            />
          )}

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
            <div className="min-h-0 flex-1 overflow-y-auto">
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
            </div>
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
            {selectedDisplayNode ? (
              <NodeParamPanel
                node={selectedDisplayNode}
                onChange={u => updateNode(selectedDisplayNode.id, u)}
                fluidSystems={fluidSystems}
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
            <ResultsPanel
              node={selectedDisplayNode}
              pressureUnit={pressureUnit}
              rho={selectedRho}
              onToggleResultSymbol={updateResultSymbolSelection}
            />
          </div>
        </div>

        {/* コンポーネント特性 */}
        <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm p-5 min-h-[360px]">
          <h3 className="text-sm font-semibold text-gray-600 mb-4 pb-3 border-b border-gray-100">
            コンポーネント特性
          </h3>
          <AnalysisPanel
            node={selectedDisplayNode}
            density={selectedRho.toString()}
            viscosity={(selectedData ? fluidSystemForNode(selectedData, fluidSystems).viscosity * 1000 : Number(viscosity)).toString()}
            pressureUnit={pressureUnit}
            rho={selectedRho}
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
            <SystemResultsTable
              components={systemComponents}
              runHistory={runHistory}
              pressureUnit={pressureUnit}
              rho={rho}
              baselineRunId={baselineRunId}
              onBaselineChange={setBaselineRunId}
            />
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
