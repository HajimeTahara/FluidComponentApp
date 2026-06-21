'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  buildRocketStage,
  fetchMaterials,
  fetchFluidLibrary,
  type RocketNodePayload,
  type RocketEdgePayload,
  type RocketNodeResult,
  type StageSpec,
  type Material,
  type FluidLibraryEntry,
} from '@/app/lib/api'
import { PROPELLANT_OPTIONS } from '@/app/lib/propellants'

const G0 = 9.80665 // 標準重力加速度 [m/s²]（質量から重量[N]を算出する際に使用）

// ── Categories ───────────────────────────────────────────────────────

type NodeCategory = 'tank' | 'pump' | 'combustor'

const CATEGORIES: NodeCategory[] = ['tank', 'pump', 'combustor']

const CATEGORY_LABEL: Record<NodeCategory, string> = {
  tank: 'タンク',
  pump: 'ポンプ',
  combustor: '燃焼器',
}

const CATEGORY_COLOR: Record<NodeCategory, { border: string; bg: string; text: string; chip: string }> = {
  tank: { border: 'border-emerald-400', bg: 'bg-emerald-50', text: 'text-emerald-700', chip: 'text-emerald-300' },
  pump: { border: 'border-violet-400', bg: 'bg-violet-50', text: 'text-violet-700', chip: 'text-violet-300' },
  combustor: { border: 'border-rose-400', bg: 'bg-rose-50', text: 'text-rose-700', chip: 'text-rose-300' },
}

type FieldDef = {
  key: string
  label: string
  unit?: string
  type?: 'material' | 'propellantDensity'
}

// 長さ系パラメータ（外径・長さ・肉厚など、unit:'mm'のフィールド）の表示単位をmm/mで切り替える
type LengthUnit = 'mm' | 'm'

function toDisplayLength(mmValue: number, unit: LengthUnit): number {
  return unit === 'm' ? mmValue / 1000 : mmValue
}

function fromDisplayLength(displayValue: number, unit: LengthUnit): number {
  return unit === 'm' ? displayValue * 1000 : displayValue
}

const FIELD_DEFS: Record<NodeCategory, FieldDef[]> = {
  tank: [
    { key: 'diameterMm', label: '外径', unit: 'mm' },
    { key: 'lengthMm', label: '長さ', unit: 'mm' },
    { key: 'thicknessMm', label: '肉厚', unit: 'mm' },
    { key: 'material', label: '材質', type: 'material' },
    { key: 'propellantDensityKgM3', label: '推進剤密度', unit: 'kg/m3', type: 'propellantDensity' },
    { key: 'ullagePercent', label: 'アレージ', unit: '%' },
  ],
  pump: [
    { key: 'massKg', label: '質量', unit: 'kg' },
  ],
  combustor: [
    { key: 'diameterMm', label: '燃焼室外径', unit: 'mm' },
    { key: 'lengthMm', label: '燃焼室長さ', unit: 'mm' },
    { key: 'throatDiameterMm', label: 'スロート径', unit: 'mm' },
    { key: 'chamberPressurePa', label: '燃焼圧', unit: 'Pa' },
    { key: 'cStarMS', label: '特性排気速度 c*', unit: 'm/s' },
    { key: 'gamma', label: '比熱比 γ' },
    { key: 'ofRatio', label: 'O/F比' },
    { key: 'safetyFactor', label: '安全係数' },
    { key: 'exitDiameterMm', label: 'ノズル出口径', unit: 'mm' },
    { key: 'nozzleLengthMm', label: 'ノズル長さ', unit: 'mm' },
    { key: 'expansionRatio', label: '拡大比 Ae/At' },
    { key: 'ambientPressurePa', label: '外気圧', unit: 'Pa' },
    { key: 'thicknessMm', label: 'ノズル肉厚', unit: 'mm' },
    { key: 'material', label: '材質', type: 'material' },
  ],
}

function defaultParams(category: NodeCategory): Record<string, number | string> {
  switch (category) {
    case 'tank': return {
      diameterMm: 3700, lengthMm: 8000, thicknessMm: 5,
      material: '', densityKgM3: 2700, propellantDensityKgM3: 423, ullagePercent: 3,
    }
    case 'pump': return { massKg: 50 }
    case 'combustor': return {
      diameterMm: 400, lengthMm: 600, throatDiameterMm: 150, chamberPressurePa: 6000000,
      cStarMS: 1800, gamma: 1.2, ofRatio: 3.5, safetyFactor: 1.5,
      exitDiameterMm: 900, nozzleLengthMm: 1200, expansionRatio: 36, ambientPressurePa: 101325, thicknessMm: 3,
      material: '', densityKgM3: 8400, yieldStrengthPa: 900000000,
    }
  }
}

type RocketNodeData = Record<string, unknown> & {
  category: NodeCategory
  label: string
  params: Record<string, number | string>
  result?: RocketNodeResult
}

function resultSummary(d: RocketNodeData): string | null {
  const r = d.result
  if (!r) return null
  if (d.category === 'tank') {
    return `殻 ${(r.shell_mass_kg ?? 0).toFixed(1)} kg / 推進剤 ${(r.propellant_mass_kg ?? 0).toFixed(1)} kg`
  }
  if (d.category === 'combustor') {
    return r.thrust_n
      ? `F=${r.thrust_n.toFixed(0)} N / Isp=${(r.isp_s ?? 0).toFixed(0)} s`
      : `殻 ${(r.shell_mass_kg ?? 0).toFixed(1)} kg / ṁ ${(r.mdot_kg_s ?? 0).toFixed(2)} kg/s`
  }
  if (r.mass_kg !== undefined) return `${r.mass_kg.toFixed(1)} kg`
  if (r.shell_mass_kg !== undefined) return `${r.shell_mass_kg.toFixed(1)} kg`
  return null
}

// ── Component node ───────────────────────────────────────────────────

// 部品の外径・長さパラメータに応じてノードの表示サイズを伸縮させる。
// 縦横比＝外径:長さの実寸比をそのまま保つため、幅・高さは常に同じ係数で拡大縮小する
// （大きい方の辺だけを下限・上限の範囲に収め、もう一方の辺は比率に従って決まる）。
const PX_PER_MM = 0.03
const NODE_MIN_DIM = 70
const NODE_MAX_DIM = 220

function clampPreserveAspect(rawWidth: number, rawHeight: number, minDim: number, maxDim: number): { width: number; height: number } {
  if (rawWidth <= 0 || rawHeight <= 0) return { width: minDim, height: minDim }
  const maxSide = Math.max(rawWidth, rawHeight)
  let scale = 1
  if (maxSide > maxDim) scale = maxDim / maxSide
  else if (maxSide < minDim) scale = minDim / maxSide
  return { width: rawWidth * scale, height: rawHeight * scale }
}

function nodeSize(category: NodeCategory, params: Record<string, number | string>): { width: number; height: number } {
  if (category === 'pump') return { width: NODE_MIN_DIM, height: NODE_MIN_DIM }
  const diameterMm = Number(params.diameterMm) || 0
  let lengthMm = Number(params.lengthMm) || 0
  if (category === 'combustor') lengthMm += Number(params.nozzleLengthMm) || 0
  return clampPreserveAspect(diameterMm * PX_PER_MM, lengthMm * PX_PER_MM, NODE_MIN_DIM, NODE_MAX_DIM)
}

function RocketFlowNode({ data, selected }: NodeProps) {
  const d = data as unknown as RocketNodeData
  const color = CATEGORY_COLOR[d.category]
  const summary = resultSummary(d)
  const { width, height } = nodeSize(d.category, d.params)
  return (
    <div
      style={{ width, height, minWidth: 0, minHeight: 0 }}
      className={`flex flex-col items-center justify-center gap-0.5 overflow-hidden text-center rounded-lg border ${color.border} ${color.bg} px-1 py-1 shadow-sm ${selected ? 'ring-2 ring-blue-500' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !bg-slate-400" />
      <div className={`text-xs font-semibold ${color.text}`}>{CATEGORY_LABEL[d.category]}</div>
      <div className="max-w-full truncate text-sm font-medium text-gray-900">{d.label}</div>
      {summary && <div className="text-xs text-gray-500 tabular-nums">{summary}</div>}
      <Handle type="source" position={Position.Bottom} className="!h-2.5 !w-2.5 !bg-slate-400" />
    </div>
  )
}

function CombustorFlowNode({ data, selected }: NodeProps) {
  const d = data as unknown as RocketNodeData
  const color = CATEGORY_COLOR.combustor
  const summary = resultSummary(d)
  const { width, height } = nodeSize('combustor', d.params)
  return (
    <div
      style={{ width, height, minWidth: 0, minHeight: 0 }}
      className={`relative flex flex-col items-center justify-center gap-0.5 overflow-hidden text-center rounded-lg border ${color.border} ${color.bg} px-1 py-1 shadow-sm ${selected ? 'ring-2 ring-blue-500' : ''}`}
    >
      <Handle type="target" id="oxidizer" position={Position.Left} className="!h-2.5 !w-2.5 !bg-sky-500" />
      <span className="absolute left-1 top-0.5 text-[9px] leading-none text-sky-600">酸</span>
      <Handle type="target" id="fuel" position={Position.Right} className="!h-2.5 !w-2.5 !bg-orange-500" />
      <span className="absolute right-1 top-0.5 text-[9px] leading-none text-orange-600">燃</span>
      <div className={`text-xs font-semibold ${color.text}`}>{CATEGORY_LABEL.combustor}</div>
      <div className="max-w-full truncate text-sm font-medium text-gray-900">{d.label}</div>
      {summary && <div className="text-xs text-gray-500 tabular-nums">{summary}</div>}
    </div>
  )
}

// ── Stage (group) node ────────────────────────────────────────────────

const STAGE_TYPE = 'stage'
const STAGE_GAP = 40
const STAGE_DROP_TOP_INSET = 44

// ステージ（外壁構造材）の外径・長さに応じて枠の表示サイズを伸縮させる。
// 部品ノードと同様、幅・高さを同じ係数で拡大縮小し縦横比＝外径:長さを保つ
// （部品ノードを複数並べて収められるよう、縮尺・下限/上限は部品より大きめにする）。
const STAGE_PX_PER_MM = 0.15
const STAGE_MIN_DIM = 220
const STAGE_MAX_DIM = 900

type FixedMass = { id: string; label: string; massKg: number; isPayload: boolean }
type StageStructureParams = { diameterMm: number; lengthMm: number; thicknessMm: number; material: string; densityKgM3: number }
type StageNodeData = Record<string, unknown> & {
  name: string
  structure: StageStructureParams
  fixedMasses: FixedMass[]
  separationDelayS: number
  stageResult: StageSpec | null
}

const STRUCTURE_FIELD_DEFS: FieldDef[] = [
  { key: 'diameterMm', label: '外径', unit: 'mm' },
  { key: 'lengthMm', label: '長さ', unit: 'mm' },
  { key: 'thicknessMm', label: '肉厚', unit: 'mm' },
  { key: 'material', label: '材質', type: 'material' },
]

function defaultStageStructure(): StageStructureParams {
  return { diameterMm: 3700, lengthMm: 2000, thicknessMm: 5, material: '', densityKgM3: 2700 }
}

function stageSize(structure: StageStructureParams): { width: number; height: number } {
  return clampPreserveAspect(structure.diameterMm * STAGE_PX_PER_MM, structure.lengthMm * STAGE_PX_PER_MM, STAGE_MIN_DIM, STAGE_MAX_DIM)
}

function createStageNode(id: string, name: string, y: number): Node {
  return {
    id,
    type: STAGE_TYPE,
    position: { x: 0, y },
    deletable: false,
    data: {
      name,
      structure: defaultStageStructure(),
      fixedMasses: [],
      separationDelayS: 0,
      stageResult: null,
    } as StageNodeData,
  }
}

function isInsideStage(stage: Node, point: { x: number; y: number }): boolean {
  const fallback = stageSize((stage.data as unknown as StageNodeData).structure)
  const w = stage.measured?.width ?? fallback.width
  const h = stage.measured?.height ?? fallback.height
  return point.x >= stage.position.x && point.x <= stage.position.x + w
    && point.y >= stage.position.y && point.y <= stage.position.y + h
}

// ── デフォルトスケッチ（H3-30相当の構成、公開情報からの概算値） ───────────

function defaultChildNode(
  id: string, category: NodeCategory, label: string, params: Record<string, number | string>,
  parentId: string, x: number, y: number,
): Node {
  const data: RocketNodeData = { category, label, params }
  return { id, type: category, parentId, extent: 'parent', position: { x, y }, data: data as unknown as Record<string, unknown> }
}

function defaultEdge(
  id: string, source: string, target: string, targetHandle: 'oxidizer' | 'fuel', edgeData: RocketEdgeData,
): Edge {
  return { id, source, target, targetHandle, data: edgeData as unknown as Record<string, unknown> }
}

function createH3DefaultGraph(): { nodes: Node[]; edges: Edge[] } {
  const stage1Structure: StageStructureParams = { diameterMm: 5200, lengthMm: 3000, thicknessMm: 8, material: 'Al 2219-T87', densityKgM3: 2840 }
  const stage2Structure: StageStructureParams = { diameterMm: 5200, lengthMm: 2500, thicknessMm: 6, material: 'Al 2219-T87', densityKgM3: 2840 }
  // ステージの段順は「キャンバス上で下にあるほど先に燃焼する1段目」という既存仕様（onStagesChangeのy降順ソート）に
  // 合わせる必要があるため、実機で最初に燃焼する1段目（LE-9×3）を下、2段目（LE-5B-3）を上に配置する
  const stage2Height = stageSize(stage2Structure).height

  const stage2: Node = {
    id: 'stage-2', type: STAGE_TYPE, position: { x: 0, y: 0 }, deletable: false,
    data: {
      name: 'ステージ2（H3 2段目相当・LE-5B-3）',
      structure: stage2Structure,
      fixedMasses: [{ id: 'fm-s2', label: 'エンジン・配管・アビオニクス等', massKg: 1264, isPayload: false }],
      separationDelayS: 0,
      stageResult: null,
    } as StageNodeData,
  }
  const stage1: Node = {
    id: 'stage-1', type: STAGE_TYPE, position: { x: 0, y: stage2Height + STAGE_GAP }, deletable: false,
    data: {
      name: 'ステージ1（H3 1段目相当・LE-9×3）',
      structure: stage1Structure,
      fixedMasses: [{ id: 'fm-s1', label: 'エンジン×3・配管・アビオニクス等', massKg: 36800, isPayload: false }],
      separationDelayS: 3,
      stageResult: null,
    } as StageNodeData,
  }

  const lox1 = defaultChildNode('tank-lox-1', 'tank', 'LOXタンク', {
    diameterMm: 5200, lengthMm: 8200, thicknessMm: 8,
    material: 'Al 2219-T87', densityKgM3: 2840, propellantDensityKgM3: 1141, ullagePercent: 3,
  }, 'stage-1', 60, 60)
  const lh2_1 = defaultChildNode('tank-lh2-1', 'tank', 'LH2タンク', {
    diameterMm: 5200, lengthMm: 22000, thicknessMm: 6,
    material: 'Al-Li 2195-T8', densityKgM3: 2710, propellantDensityKgM3: 71, ullagePercent: 3,
  }, 'stage-1', 260, 60)
  const comb1 = defaultChildNode('combustor-1', 'combustor', '燃焼器（LE-9×3相当）', {
    diameterMm: 700, lengthMm: 900, throatDiameterMm: 507, chamberPressurePa: 12.16e6,
    cStarMS: 2350, gamma: 1.2, ofRatio: 6.0, safetyFactor: 1.5,
    exitDiameterMm: 3083, nozzleLengthMm: 1800, expansionRatio: 37, ambientPressurePa: 101325, thicknessMm: 6,
    material: 'Inconel 718', densityKgM3: 8190, yieldStrengthPa: 1035e6,
  }, 'stage-1', 460, 60)

  const lox2 = defaultChildNode('tank-lox-2', 'tank', 'LOXタンク', {
    diameterMm: 2500, lengthMm: 3530, thicknessMm: 4,
    material: 'Al 2219-T87', densityKgM3: 2840, propellantDensityKgM3: 1141, ullagePercent: 3,
  }, 'stage-2', 60, 60)
  const lh2_2 = defaultChildNode('tank-lh2-2', 'tank', 'LH2タンク', {
    diameterMm: 2500, lengthMm: 11340, thicknessMm: 3,
    material: 'Al-Li 2195-T8', densityKgM3: 2710, propellantDensityKgM3: 71, ullagePercent: 3,
  }, 'stage-2', 220, 60)
  const comb2 = defaultChildNode('combustor-2', 'combustor', '燃焼器（LE-5B-3相当）', {
    diameterMm: 450, lengthMm: 400, throatDiameterMm: 166, chamberPressurePa: 3.5e6,
    cStarMS: 2300, gamma: 1.2, ofRatio: 5.0, safetyFactor: 1.5,
    exitDiameterMm: 1741, nozzleLengthMm: 2500, expansionRatio: 110, ambientPressurePa: 0, thicknessMm: 4,
    material: 'Inconel 718', densityKgM3: 8190, yieldStrengthPa: 1035e6,
  }, 'stage-2', 380, 60)

  const edges: Edge[] = [
    defaultEdge('edge-lox-1', 'tank-lox-1', 'combustor-1', 'oxidizer', {
      diameterMm: 300, lengthMm: 3000, thicknessMm: 4, material: 'SUS316L', densityKgM3: 8000, propellant: 'LOX',
    }),
    defaultEdge('edge-lh2-1', 'tank-lh2-1', 'combustor-1', 'fuel', {
      diameterMm: 400, lengthMm: 4000, thicknessMm: 4, material: 'SUS316L', densityKgM3: 8000, propellant: 'LH2',
    }),
    defaultEdge('edge-lox-2', 'tank-lox-2', 'combustor-2', 'oxidizer', {
      diameterMm: 150, lengthMm: 1500, thicknessMm: 3, material: 'SUS316L', densityKgM3: 8000, propellant: 'LOX',
    }),
    defaultEdge('edge-lh2-2', 'tank-lh2-2', 'combustor-2', 'fuel', {
      diameterMm: 200, lengthMm: 2000, thicknessMm: 3, material: 'SUS316L', densityKgM3: 8000, propellant: 'LH2',
    }),
  ]

  return {
    nodes: [stage1, stage2, lox1, lh2_1, comb1, lox2, lh2_2, comb2],
    edges,
  }
}

function StageFlowNode({ data, selected }: NodeProps) {
  const d = data as unknown as StageNodeData
  const { width, height } = stageSize(d.structure)
  return (
    <div
      style={{ width, height }}
      className={`rounded-lg border-2 ${selected ? 'border-blue-500' : 'border-gray-300'} bg-gray-50/60`}
    >
      <div className="flex items-center justify-between gap-3 rounded-t-md border-b border-gray-200 bg-white/90 px-3 py-1.5">
        <span className="text-sm font-semibold text-gray-700">{d.name}</span>
        {d.stageResult && (
          <span className="text-xs tabular-nums text-gray-500">
            乾燥 {d.stageResult.dry_mass.toFixed(0)}kg / 推進剤 {d.stageResult.propellant_mass.toFixed(0)}kg
            {d.stageResult.payload_mass > 0 && ` / ペイロード ${d.stageResult.payload_mass.toFixed(0)}kg`}
            {' '}/ F {d.stageResult.thrust.toFixed(0)}N
          </span>
        )}
      </div>
    </div>
  )
}

type FlowNodeComponent = (props: NodeProps) => React.ReactElement

const nodeTypes: Record<string, FlowNodeComponent> = {
  ...Object.fromEntries(CATEGORIES.map(c => [c, RocketFlowNode])),
  combustor: CombustorFlowNode,
  [STAGE_TYPE]: StageFlowNode,
}

function MaterialField({
  label, value, materials, onChange,
}: {
  label: string
  value: string
  materials: Material[]
  onChange: (materialName: string) => void
}) {
  const selected = materials.find(m => m.name === value)
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-500">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        <option value="">材料を選択...</option>
        {materials.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
      </select>
      {selected ? (
        <p className="mt-1 text-xs text-gray-400 tabular-nums">
          密度 {selected.density_kg_m3.toLocaleString()} kg/m3
          {selected.yield_strength_pa > 0 && ` / 降伏 ${(selected.yield_strength_pa / 1e6).toFixed(0)} MPa`}
        </p>
      ) : (
        <p className="mt-1 text-xs text-gray-400">材料DBタブから材料を登録できます</p>
      )}
    </div>
  )
}

// 長さ系（unit:'mm'）フィールドはlengthUnitに応じてmm/m表示・入力変換を行う汎用の数値入力
function NumberField({
  label, unit, value, onChange,
}: {
  label: string
  unit?: string
  value: number
  onChange: (value: number) => void
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-500">
        {label}{unit ? ` [${unit}]` : ''}
      </label>
      <input
        type="number"
        step="any"
        value={String(value)}
        onChange={e => onChange(Number(e.target.value) || 0)}
        className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
}

function HintIcon({ text }: { text: string }) {
  return (
    <span
      tabIndex={0}
      title={text}
      className="inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-400 hover:border-blue-400 hover:text-blue-500"
    >
      ?
    </span>
  )
}

// ── Component param panel ─────────────────────────────────────────────

function ParamPanel({
  node, materials, propellants, edges, lengthUnit, onChangeParam, onChangeLabel, onChangeMaterial,
}: {
  node: Node
  materials: Material[]
  propellants: FluidLibraryEntry[]
  edges: Edge[]
  lengthUnit: LengthUnit
  onChangeParam: (key: string, value: string) => void
  onChangeLabel: (value: string) => void
  onChangeMaterial: (materialName: string) => void
}) {
  const d = node.data as unknown as RocketNodeData
  const fields = FIELD_DEFS[d.category]

  return (
    <div className="flex flex-col gap-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500">名称</label>
        <input
          value={d.label}
          onChange={e => onChangeLabel(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      {fields.map(field => {
        if (field.type === 'material') {
          return (
            <MaterialField
              key={field.key}
              label={field.label}
              value={String(d.params.material ?? '')}
              materials={materials}
              onChange={onChangeMaterial}
            />
          )
        }
        if (field.type === 'propellantDensity') {
          const propellant = propellantForNode(node.id, edges)
          const propellantOption = propellant ? PROPELLANT_OPTIONS.find(p => p.value === propellant) : undefined
          const dbEntry = propellant ? propellants.find(p => p.name === propellant) : undefined
          return (
            <div key={field.key}>
              <label className="mb-1 block text-xs font-medium text-gray-500">
                {field.label}{field.unit ? ` [${field.unit}]` : ''}
              </label>
              <div className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-sm text-gray-700">
                {dbEntry
                  ? `${dbEntry.density_kg_m3.toLocaleString()}（${propellantOption?.label ?? propellant}）`
                  : propellant
                    ? `${propellant}（推進剤DBに未登録）`
                    : '配管エッジで推進剤を設定してください'}
              </div>
              <p className="mt-1 text-xs text-gray-400">配管エッジの「推進剤」から自動取得されます</p>
            </div>
          )
        }
        const isLength = field.unit === 'mm'
        const rawValue = Number(d.params[field.key]) || 0
        return (
          <NumberField
            key={field.key}
            label={field.label}
            unit={isLength ? lengthUnit : field.unit}
            value={isLength ? toDisplayLength(rawValue, lengthUnit) : rawValue}
            onChange={v => onChangeParam(field.key, String(isLength ? fromDisplayLength(v, lengthUnit) : v))}
          />
        )
      })}
    </div>
  )
}

// ── Edge (propellant line) panel ────────────────────────────────────────

type RocketEdgeData = {
  diameterMm?: number
  lengthMm?: number
  thicknessMm?: number
  material?: string
  densityKgM3?: number
  propellant?: string
  massKg?: number
}

const EDGE_OXIDIZER_OPTIONS = PROPELLANT_OPTIONS.filter(p => p.role === 'oxidizer')
const EDGE_FUEL_OPTIONS = PROPELLANT_OPTIONS.filter(p => p.role === 'fuel')

const PROPELLANT_ROLE_BY_VALUE: Record<string, 'oxidizer' | 'fuel'> = Object.fromEntries(
  PROPELLANT_OPTIONS.map(p => [p.value, p.role]),
)
const OXIDIZER_EDGE_COLOR = '#0ea5e9'
const FUEL_EDGE_COLOR = '#f97316'

function propellantForNode(nodeId: string, edges: Edge[]): string | undefined {
  for (const e of edges) {
    if (e.source !== nodeId && e.target !== nodeId) continue
    const propellant = (e.data as RocketEdgeData | undefined)?.propellant
    if (propellant) return propellant
  }
  return undefined
}

function propellantEdgeColor(propellant?: string): string | undefined {
  if (!propellant) return undefined
  const role = PROPELLANT_ROLE_BY_VALUE[propellant]
  if (role === 'oxidizer') return OXIDIZER_EDGE_COLOR
  if (role === 'fuel') return FUEL_EDGE_COLOR
  return undefined
}

function EdgePanel({
  edge, materials, lengthUnit, onChangeField, onChangeMaterial,
}: {
  edge: Edge
  materials: Material[]
  lengthUnit: LengthUnit
  onChangeField: (key: string, value: number | string) => void
  onChangeMaterial: (materialName: string) => void
}) {
  const d = (edge.data ?? {}) as RocketEdgeData

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-gray-400">配管そのものを表すエッジです。寸法・材質・運ぶ推進剤を設定します</p>
      <NumberField
        label="外径"
        unit={lengthUnit}
        value={toDisplayLength(d.diameterMm ?? 0, lengthUnit)}
        onChange={v => onChangeField('diameterMm', fromDisplayLength(v, lengthUnit))}
      />
      <NumberField
        label="長さ"
        unit={lengthUnit}
        value={toDisplayLength(d.lengthMm ?? 0, lengthUnit)}
        onChange={v => onChangeField('lengthMm', fromDisplayLength(v, lengthUnit))}
      />
      <NumberField
        label="肉厚"
        unit={lengthUnit}
        value={toDisplayLength(d.thicknessMm ?? 0, lengthUnit)}
        onChange={v => onChangeField('thicknessMm', fromDisplayLength(v, lengthUnit))}
      />
      <MaterialField label="材質" value={d.material ?? ''} materials={materials} onChange={onChangeMaterial} />
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500">推進剤</label>
        <select
          value={d.propellant ?? ''}
          onChange={e => onChangeField('propellant', e.target.value)}
          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">未設定</option>
          <optgroup label="酸化剤">
            {EDGE_OXIDIZER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </optgroup>
          <optgroup label="燃料">
            {EDGE_FUEL_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </optgroup>
        </select>
        <p className="mt-1 text-xs text-gray-400">配管1本は酸化剤・燃料いずれか一種類のみを運びます（燃焼器に接続する配管で使用）</p>
      </div>
      {d.massKg !== undefined && (
        <p className="text-xs text-gray-500 tabular-nums border-t border-gray-100 pt-2">配管質量 <b>{d.massKg.toFixed(1)}</b> kg</p>
      )}
    </div>
  )
}

// ── Stage param panel ──────────────────────────────────────────────────

function StagePanel({
  stageNode, materials, lengthUnit, onChangeName, onChangeStructure, onChangeStructureMaterial,
  onAddFixedMass, onChangeFixedMass, onRemoveFixedMass, onChangeSeparationDelay, onCalc, calculating,
}: {
  stageNode: Node
  materials: Material[]
  lengthUnit: LengthUnit
  onChangeName: (value: string) => void
  onChangeStructure: (key: string, value: string) => void
  onChangeStructureMaterial: (materialName: string) => void
  onAddFixedMass: () => void
  onChangeFixedMass: (id: string, patch: Partial<FixedMass>) => void
  onRemoveFixedMass: (id: string) => void
  onChangeSeparationDelay: (value: number) => void
  onCalc: () => void
  calculating: boolean
}) {
  const d = stageNode.data as unknown as StageNodeData

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500">ステージ名</label>
        <input
          value={d.name}
          onChange={e => onChangeName(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold text-gray-500">外壁構造材</h4>
        <div className="flex flex-col gap-2">
          {STRUCTURE_FIELD_DEFS.map(field => {
            if (field.type === 'material') {
              return <MaterialField key={field.key} label={field.label} value={d.structure.material} materials={materials} onChange={onChangeStructureMaterial} />
            }
            const isLength = field.unit === 'mm'
            const rawValue = Number(d.structure[field.key as keyof StageStructureParams]) || 0
            return (
              <NumberField
                key={field.key}
                label={field.label}
                unit={isLength ? lengthUnit : field.unit}
                value={isLength ? toDisplayLength(rawValue, lengthUnit) : rawValue}
                onChange={v => onChangeStructure(field.key, String(isLength ? fromDisplayLength(v, lengthUnit) : v))}
              />
            )
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold text-gray-500">固定質量</h4>
          <button type="button" onClick={onAddFixedMass} className="text-xs font-medium text-blue-600 hover:text-blue-700">
            + 追加
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {d.fixedMasses.map(fm => (
            <div key={fm.id} className="flex items-center gap-2">
              <input
                value={fm.label}
                onChange={e => onChangeFixedMass(fm.id, { label: e.target.value })}
                placeholder="名称"
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="number"
                step="any"
                value={fm.massKg}
                onChange={e => onChangeFixedMass(fm.id, { massKg: Number(e.target.value) || 0 })}
                placeholder="kg"
                className="w-24 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <label className="flex items-center gap-1 text-xs text-gray-500 whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={fm.isPayload}
                  onChange={e => onChangeFixedMass(fm.id, { isPayload: e.target.checked })}
                  className="accent-blue-500"
                />
                ペイロード
                <HintIcon text="チェックすると、この質量は段が分離・投棄されても機体に残り続ける質量として扱われます（チェックなしの場合はこの固定質量を持つ段が分離されると一緒に投棄されます）" />
              </label>
              <button type="button" onClick={() => onRemoveFixedMass(fm.id)} className="text-gray-400 hover:text-red-600">
                ×
              </button>
            </div>
          ))}
          {d.fixedMasses.length === 0 && <p className="text-xs text-gray-400">固定質量はありません</p>}
        </div>
      </div>

      <div className="flex items-end gap-1">
        <div className="flex-1">
          <NumberField
            label="分離遅延"
            unit="s"
            value={d.separationDelayS ?? 0}
            onChange={onChangeSeparationDelay}
          />
        </div>
        <HintIcon text="エンジン燃焼終了（燃焼時間経過）から、この段が実際に切り離される（質量が投棄される）までのコースト時間です。0の場合は燃焼終了と同時に分離します。" />
      </div>

      <button
        type="button"
        onClick={onCalc}
        disabled={calculating}
        className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {calculating ? '計算中...' : 'このステージを計算'}
      </button>

      {d.stageResult && (
        <div className="flex flex-col gap-1 border-t border-gray-100 pt-3 text-xs text-gray-600">
          <span>乾燥質量 <b className="tabular-nums">{d.stageResult.dry_mass.toFixed(1)}</b> kg</span>
          <span>推進剤 <b className="tabular-nums">{d.stageResult.propellant_mass.toFixed(1)}</b> kg</span>
          {d.stageResult.payload_mass > 0 && (
            <span>ペイロード <b className="tabular-nums">{d.stageResult.payload_mass.toFixed(1)}</b> kg</span>
          )}
          <span>推力 <b className="tabular-nums">{d.stageResult.thrust.toFixed(0)}</b> N</span>
          <span>燃焼時間 <b className="tabular-nums">{d.stageResult.burn_time.toFixed(1)}</b> s</span>
        </div>
      )}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────

const ZERO_STAGE: StageSpec = {
  propellant_mass: 0, dry_mass: 0, payload_mass: 0, oxidizer: 'LOX', fuel: 'LCH4', thrust: 0, burn_time: 0,
  length_m: 0, diameter_m: 0, separation_delay_s: 0,
}

function RocketBuilderInner({ onStagesChange }: { onStagesChange?: (stages: StageSpec[]) => void }) {
  const { screenToFlowPosition } = useReactFlow()
  const [defaultGraph] = useState(() => createH3DefaultGraph())
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(defaultGraph.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(defaultGraph.edges)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [loadingStageId, setLoadingStageId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [materials, setMaterials] = useState<Material[]>([])
  const [propellants, setPropellants] = useState<FluidLibraryEntry[]>([])
  const [lengthUnit, setLengthUnit] = useState<LengthUnit>('mm')
  const nodeCounter = useRef(0)
  const stageCounter = useRef(2)
  const lastStagesKey = useRef<string>('')

  useEffect(() => {
    fetchMaterials().then(setMaterials).catch(() => {})
    fetchFluidLibrary().then(setPropellants).catch(() => {})
  }, [])

  const selectedNode = nodes.find(n => n.id === selectedId) ?? null

  const selectedEdge = edges.find(e => e.id === selectedEdgeId) ?? null

  const stageSummaries = useMemo(() => {
    const stageNodes = nodes.filter(n => n.type === STAGE_TYPE)
    const sorted = [...stageNodes].sort((a, b) => b.position.y - a.position.y)
    return sorted.map((n, i) => {
      const d = n.data as unknown as StageNodeData
      const r = d.stageResult
      const dryMass = r?.dry_mass ?? 0
      const propellantMass = r?.propellant_mass ?? 0
      const payloadMass = r?.payload_mass ?? 0
      const massKg = dryMass + propellantMass + payloadMass
      return {
        id: n.id,
        index: i + 1,
        name: d.name,
        calculated: r !== null,
        dryMass, propellantMass, payloadMass, massKg,
        weightN: massKg * G0,
        thrust: r?.thrust ?? 0,
        burnTime: r?.burn_time ?? 0,
      }
    })
  }, [nodes])

  const grandTotal = useMemo(() => stageSummaries.reduce((acc, s) => ({
    dryMass: acc.dryMass + s.dryMass,
    propellantMass: acc.propellantMass + s.propellantMass,
    payloadMass: acc.payloadMass + s.payloadMass,
    massKg: acc.massKg + s.massKg,
    weightN: acc.weightN + s.weightN,
  }), { dryMass: 0, propellantMass: 0, payloadMass: 0, massKg: 0, weightN: 0 }), [stageSummaries])

  const totalMass = grandTotal.massKg

  const orderedNodes = useMemo(() => {
    const stages = nodes.filter(n => n.type === STAGE_TYPE)
    const others = nodes.filter(n => n.type !== STAGE_TYPE)
    return [...stages, ...others]
  }, [nodes])

  const coloredEdges = useMemo(() => edges.map(e => {
    const color = propellantEdgeColor((e.data as RocketEdgeData | undefined)?.propellant)
    if (!color) return e
    return { ...e, style: { ...e.style, stroke: color, strokeWidth: 2 } }
  }), [edges])

  useEffect(() => {
    const stageNodes = nodes.filter(n => n.type === STAGE_TYPE)
    const sorted = [...stageNodes].sort((a, b) => b.position.y - a.position.y)
    const specs = sorted.map(n => {
      const d = n.data as unknown as StageNodeData
      return { ...(d.stageResult ?? ZERO_STAGE), separation_delay_s: d.separationDelayS ?? 0 }
    })
    const key = JSON.stringify(specs)
    if (key !== lastStagesKey.current) {
      lastStagesKey.current = key
      onStagesChange?.(specs)
    }
  }, [nodes, onStagesChange])

  const addStage = () => {
    stageCounter.current += 1
    const stageNodes = nodes.filter(n => n.type === STAGE_TYPE)
    const maxBottom = stageNodes.reduce((acc, n) => {
      const h = n.measured?.height ?? stageSize((n.data as unknown as StageNodeData).structure).height
      return Math.max(acc, n.position.y + h)
    }, -STAGE_GAP)
    const newStage = createStageNode(`stage-${Date.now()}`, `ステージ${stageCounter.current}`, maxBottom + STAGE_GAP)
    setNodes(prev => [...prev, newStage])
  }

  const removeStage = (stageId: string) => {
    const stageCount = nodes.filter(n => n.type === STAGE_TYPE).length
    if (stageCount <= 1) return
    setNodes(prev => prev.filter(n => n.id !== stageId && n.parentId !== stageId))
    setEdges(prev => prev.filter(e => {
      const orphaned = (id: string) => id === stageId || nodes.find(n => n.id === id)?.parentId === stageId
      return !orphaned(e.source) && !orphaned(e.target)
    }))
    setSelectedId(prev => {
      if (prev === stageId) return null
      const prevNode = nodes.find(n => n.id === prev)
      return prevNode?.parentId === stageId ? null : prev
    })
  }

  const onDragStart = (e: React.DragEvent, category: NodeCategory) => {
    e.dataTransfer.setData('application/reactflow', category)
    e.dataTransfer.effectAllowed = 'move'
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const category = e.dataTransfer.getData('application/reactflow') as NodeCategory
    if (!category) return
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const stage = nodes.find(n => n.type === STAGE_TYPE && isInsideStage(n, flowPos))
    if (!stage) {
      setError('ステージの枠内にドロップしてください')
      return
    }
    setError(null)
    nodeCounter.current += 1
    const id = `${category}-${nodeCounter.current}`
    const data: RocketNodeData = {
      category, label: `${CATEGORY_LABEL[category]}${nodeCounter.current}`, params: defaultParams(category),
    }
    setNodes(prev => [...prev, {
      id, type: category, parentId: stage.id, extent: 'parent',
      position: {
        x: Math.max(0, flowPos.x - stage.position.x),
        y: Math.max(STAGE_DROP_TOP_INSET, flowPos.y - stage.position.y),
      },
      data: data as unknown as Record<string, unknown>,
    }])
  }, [nodes, screenToFlowPosition, setNodes])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onConnect = useCallback((conn: Connection) => {
    const source = nodes.find(n => n.id === conn.source)
    const target = nodes.find(n => n.id === conn.target)
    if (!source || !target || source.parentId !== target.parentId) return
    const defaultData: RocketEdgeData = { diameterMm: 200, lengthMm: 1000, thicknessMm: 2, material: '', densityKgM3: 2700, propellant: '' }
    setEdges(prev => addEdge({ ...conn, data: defaultData as Record<string, unknown> }, prev))
  }, [nodes, setEdges])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId(node.id)
    setSelectedEdgeId(null)
  }, [])

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(edge.id)
    setSelectedId(null)
  }, [])

  const updateEdgeField = useCallback((key: string, value: number | string) => {
    setEdges(prev => prev.map(e => (
      e.id === selectedEdgeId ? { ...e, data: { ...e.data, [key]: value } } : e
    )))
  }, [selectedEdgeId, setEdges])

  const updateEdgeMaterial = useCallback((materialName: string) => {
    const material = materials.find(m => m.name === materialName)
    setEdges(prev => prev.map(e => (
      e.id === selectedEdgeId
        ? { ...e, data: { ...e.data, material: materialName, ...(material ? { densityKgM3: material.density_kg_m3 } : {}) } }
        : e
    )))
  }, [selectedEdgeId, setEdges, materials])

  const updateParam = useCallback((key: string, value: string) => {
    setNodes(prev => prev.map(n => {
      if (n.id !== selectedId) return n
      const d = n.data as unknown as RocketNodeData
      return { ...n, data: { ...d, params: { ...d.params, [key]: value } } as unknown as Record<string, unknown> }
    }))
  }, [selectedId, setNodes])

  const updateMaterial = useCallback((materialName: string) => {
    const material = materials.find(m => m.name === materialName)
    setNodes(prev => prev.map(n => {
      if (n.id !== selectedId) return n
      const d = n.data as unknown as RocketNodeData
      const nextParams: Record<string, number | string> = { ...d.params, material: materialName }
      if (material) {
        nextParams.densityKgM3 = material.density_kg_m3
        if ('yieldStrengthPa' in d.params) nextParams.yieldStrengthPa = material.yield_strength_pa
      }
      return { ...n, data: { ...d, params: nextParams } as unknown as Record<string, unknown> }
    }))
  }, [selectedId, setNodes, materials])

  const updateLabel = useCallback((value: string) => {
    setNodes(prev => prev.map(n => {
      if (n.id !== selectedId) return n
      const d = n.data as unknown as RocketNodeData
      return { ...n, data: { ...d, label: value } as unknown as Record<string, unknown> }
    }))
  }, [selectedId, setNodes])

  const removeSelectedNode = () => {
    if (!selectedId) return
    setNodes(prev => prev.filter(n => n.id !== selectedId))
    setEdges(prev => prev.filter(e => e.source !== selectedId && e.target !== selectedId))
    setSelectedId(null)
  }

  const removeSelectedEdge = () => {
    if (!selectedEdgeId) return
    setEdges(prev => prev.filter(e => e.id !== selectedEdgeId))
    setSelectedEdgeId(null)
  }

  const updateStageField = (stageId: string, updater: (d: StageNodeData) => StageNodeData) => {
    setNodes(prev => prev.map(n => (
      n.id === stageId ? { ...n, data: updater(n.data as unknown as StageNodeData) as unknown as Record<string, unknown> } : n
    )))
  }

  const updateStageName = (stageId: string, name: string) => updateStageField(stageId, d => ({ ...d, name }))

  const updateStageStructure = (stageId: string, key: string, value: string) => updateStageField(stageId, d => ({
    ...d, structure: { ...d.structure, [key]: Number(value) || 0 },
  }))

  const updateStageStructureMaterial = (stageId: string, materialName: string) => {
    const material = materials.find(m => m.name === materialName)
    updateStageField(stageId, d => ({
      ...d,
      structure: {
        ...d.structure,
        material: materialName,
        densityKgM3: material ? material.density_kg_m3 : d.structure.densityKgM3,
      },
    }))
  }

  const updateStageSeparationDelay = (stageId: string, value: number) => updateStageField(stageId, d => ({
    ...d, separationDelayS: value,
  }))

  const addFixedMass = (stageId: string) => updateStageField(stageId, d => ({
    ...d, fixedMasses: [...d.fixedMasses, { id: `fm-${Date.now()}`, label: '', massKg: 0, isPayload: false }],
  }))

  const updateFixedMass = (stageId: string, fmId: string, patch: Partial<FixedMass>) => updateStageField(stageId, d => ({
    ...d, fixedMasses: d.fixedMasses.map(fm => (fm.id === fmId ? { ...fm, ...patch } : fm)),
  }))

  const removeFixedMass = (stageId: string, fmId: string) => updateStageField(stageId, d => ({
    ...d, fixedMasses: d.fixedMasses.filter(fm => fm.id !== fmId),
  }))

  const handleCalcStage = async (stageId: string) => {
    const stageNode = nodes.find(n => n.id === stageId)
    if (!stageNode) return
    const stageData = stageNode.data as unknown as StageNodeData
    const children = nodes.filter(n => n.parentId === stageId)
    const childIds = new Set(children.map(n => n.id))
    const stageEdges = edges.filter(e => childIds.has(e.source) && childIds.has(e.target))

    setError(null)
    setLoadingStageId(stageId)
    try {
      const payloadNodes: RocketNodePayload[] = children.map(n => {
        const d = n.data as unknown as RocketNodeData
        let params = d.params
        if (d.category === 'tank') {
          const propellant = propellantForNode(n.id, stageEdges)
          const density = propellant ? propellants.find(p => p.name === propellant)?.density_kg_m3 : undefined
          if (density !== undefined) params = { ...params, propellantDensityKgM3: density }
        }
        return { id: n.id, node_type: d.category, params }
      })
      const payloadEdges: RocketEdgePayload[] = stageEdges.map(e => {
        const ed = (e.data ?? {}) as RocketEdgeData
        return {
          id: e.id, source: e.source, target: e.target,
          source_handle: e.sourceHandle ?? null, target_handle: e.targetHandle ?? null,
          diameter_mm: ed.diameterMm ?? 0, length_mm: ed.lengthMm ?? 0, thickness_mm: ed.thicknessMm ?? 0,
          material: ed.material || null, density_kg_m3: ed.densityKgM3 ?? 0, propellant: ed.propellant || null,
        }
      })
      const res = await buildRocketStage({
        nodes: payloadNodes,
        edges: payloadEdges,
        structure: stageData.structure,
        fixed_masses: stageData.fixedMasses,
      })
      setNodes(prev => prev.map(n => {
        if (n.parentId === stageId) {
          const r = res.nodes[n.id]
          if (!r) return n
          const d = n.data as unknown as RocketNodeData
          return { ...n, data: { ...d, result: r } as unknown as Record<string, unknown> }
        }
        if (n.id === stageId) {
          const d = n.data as unknown as StageNodeData
          return { ...n, data: { ...d, stageResult: res.stage } as unknown as Record<string, unknown> }
        }
        return n
      }))
      setEdges(prev => prev.map(e => {
        const r = res.edges?.[e.id]
        if (!r) return e
        const ed = (e.data ?? {}) as RocketEdgeData
        return { ...e, data: { ...ed, massKg: r.mass_kg }, label: `${r.mass_kg.toFixed(1)} kg` }
      }))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '段の計算に失敗しました')
    } finally {
      setLoadingStageId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 border-b border-gray-200 bg-slate-50 px-4 py-2">
        <span className="text-sm font-semibold text-gray-700">段の設計</span>
        <button
          type="button"
          onClick={addStage}
          className="rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
        >
          + ステージを追加
        </button>
        {error && <span className="text-sm text-red-500">{error}</span>}
        <div className="ml-auto flex items-center gap-3">
          <div className="flex rounded-md border border-gray-300 text-xs overflow-hidden">
            {(['mm', 'm'] as LengthUnit[]).map(u => (
              <button
                key={u}
                type="button"
                onClick={() => setLengthUnit(u)}
                className={`px-2 py-1 font-medium transition-colors ${
                  lengthUnit === u ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                {u}
              </button>
            ))}
          </div>
          <span className="text-sm text-gray-600">
            全備質量 <b className="text-blue-600 tabular-nums">{totalMass.toFixed(1)}</b> kg
          </span>
        </div>
      </div>

      <div className="flex min-h-0" style={{ height: 640 }}>
        {/* Palette */}
        <div className="w-36 shrink-0 bg-slate-800 text-white flex flex-col select-none">
          <div className="px-2 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wide border-b border-slate-700 text-center">
            部品
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {CATEGORIES.map(category => (
              <div
                key={category}
                draggable
                onDragStart={e => onDragStart(e, category)}
                className="py-3 px-2 border-b border-slate-700 cursor-grab active:cursor-grabbing hover:bg-slate-700 transition-colors flex flex-col items-center gap-1"
              >
                <div className={`text-sm font-medium ${CATEGORY_COLOR[category].chip}`}>{CATEGORY_LABEL[category]}</div>
              </div>
            ))}
          </div>
          <div className="px-2 py-2 text-xs text-slate-600 border-t border-slate-700 text-center">
            ステージの枠内にドロップ
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1 min-w-0" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={orderedNodes}
            edges={coloredEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null) }}
            nodeTypes={nodeTypes}
            deleteKeyCode={['Delete', 'Backspace']}
            fitView
          >
            <Background color="#e2e8f0" gap={20} />
            <Controls />
            <MiniMap nodeStrokeWidth={2} zoomable pannable />
          </ReactFlow>
        </div>

        {/* Param panel */}
        <div className="w-72 shrink-0 border-l border-gray-200 bg-white p-4 overflow-y-auto">
          <h3 className="text-sm font-semibold text-gray-600 mb-4 pb-3 border-b border-gray-100">パラメータ設定</h3>
          {selectedNode ? (
            selectedNode.type === STAGE_TYPE ? (
              <div className="flex flex-col gap-3">
                <StagePanel
                  stageNode={selectedNode}
                  materials={materials}
                  lengthUnit={lengthUnit}
                  onChangeName={v => updateStageName(selectedNode.id, v)}
                  onChangeStructure={(k, v) => updateStageStructure(selectedNode.id, k, v)}
                  onChangeStructureMaterial={v => updateStageStructureMaterial(selectedNode.id, v)}
                  onAddFixedMass={() => addFixedMass(selectedNode.id)}
                  onChangeFixedMass={(id, patch) => updateFixedMass(selectedNode.id, id, patch)}
                  onRemoveFixedMass={id => removeFixedMass(selectedNode.id, id)}
                  onChangeSeparationDelay={v => updateStageSeparationDelay(selectedNode.id, v)}
                  onCalc={() => handleCalcStage(selectedNode.id)}
                  calculating={loadingStageId === selectedNode.id}
                />
                <button
                  type="button"
                  onClick={() => removeStage(selectedNode.id)}
                  className="mt-2 w-full rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  ステージを削除
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <ParamPanel node={selectedNode} materials={materials} propellants={propellants} edges={edges} lengthUnit={lengthUnit} onChangeParam={updateParam} onChangeLabel={updateLabel} onChangeMaterial={updateMaterial} />
                <button
                  type="button"
                  onClick={removeSelectedNode}
                  className="mt-2 w-full rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  ノードを削除
                </button>
              </div>
            )
          ) : selectedEdge ? (
            <div className="flex flex-col gap-3">
              <EdgePanel edge={selectedEdge} materials={materials} lengthUnit={lengthUnit} onChangeField={updateEdgeField} onChangeMaterial={updateEdgeMaterial} />
              <button
                type="button"
                onClick={removeSelectedEdge}
                className="mt-2 w-full rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                配管を削除
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-center gap-2">
              <p className="text-sm text-gray-400">キャンバスのノード・配管を<br />クリックして選択</p>
            </div>
          )}
        </div>
      </div>
    </div>

    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b border-gray-200 bg-slate-50 px-4 py-2">
        <span className="text-sm font-semibold text-gray-700">ステージ結果一覧</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
              <th className="px-4 py-2 font-medium">ステージ</th>
              <th className="px-4 py-2 font-medium">乾燥質量 [kg]</th>
              <th className="px-4 py-2 font-medium">推進剤質量 [kg]</th>
              <th className="px-4 py-2 font-medium">ペイロード [kg]</th>
              <th className="px-4 py-2 font-medium">合計質量 [kg]</th>
              <th className="px-4 py-2 font-medium">重量 [N]</th>
              <th className="px-4 py-2 font-medium">推力 [N]</th>
              <th className="px-4 py-2 font-medium">燃焼時間 [s]</th>
            </tr>
          </thead>
          <tbody>
            {stageSummaries.map(s => (
              <tr key={s.id} className="border-b border-gray-50">
                <td className="px-4 py-2 font-medium text-gray-900">
                  第{s.index}段 {s.name}
                  {!s.calculated && <span className="ml-1 text-xs text-gray-400">（未計算）</span>}
                </td>
                <td className="px-4 py-2 tabular-nums text-gray-600">{s.dryMass.toFixed(1)}</td>
                <td className="px-4 py-2 tabular-nums text-gray-600">{s.propellantMass.toFixed(1)}</td>
                <td className="px-4 py-2 tabular-nums text-gray-600">{s.payloadMass.toFixed(1)}</td>
                <td className="px-4 py-2 tabular-nums text-gray-600">{s.massKg.toFixed(1)}</td>
                <td className="px-4 py-2 tabular-nums text-gray-600">{s.weightN.toFixed(1)}</td>
                <td className="px-4 py-2 tabular-nums text-gray-600">{s.thrust.toFixed(0)}</td>
                <td className="px-4 py-2 tabular-nums text-gray-600">{s.burnTime.toFixed(1)}</td>
              </tr>
            ))}
            {stageSummaries.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-gray-400">ステージがありません</td>
              </tr>
            )}
          </tbody>
          {stageSummaries.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold text-gray-900">
                <td className="px-4 py-2">合計（全ステージ）</td>
                <td className="px-4 py-2 tabular-nums">{grandTotal.dryMass.toFixed(1)}</td>
                <td className="px-4 py-2 tabular-nums">{grandTotal.propellantMass.toFixed(1)}</td>
                <td className="px-4 py-2 tabular-nums">{grandTotal.payloadMass.toFixed(1)}</td>
                <td className="px-4 py-2 tabular-nums">{grandTotal.massKg.toFixed(1)}</td>
                <td className="px-4 py-2 tabular-nums">{grandTotal.weightN.toFixed(1)}</td>
                <td className="px-4 py-2 text-xs text-gray-400" colSpan={2}>推力・燃焼時間は段ごとに異なるため合計なし</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
    </div>
  )
}

export default function RocketBuilder(props: { onStagesChange?: (stages: StageSpec[]) => void }) {
  return (
    <ReactFlowProvider>
      <RocketBuilderInner {...props} />
    </ReactFlowProvider>
  )
}
