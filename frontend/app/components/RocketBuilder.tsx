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
  NodeResizer,
  Position,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  buildRocketStage,
  type RocketNodePayload,
  type RocketEdgePayload,
  type RocketNodeResult,
  type StageSpec,
} from '@/app/lib/api'
import { OXIDIZER_OPTIONS, FUEL_OPTIONS_BY_OXIDIZER } from '@/app/lib/propellants'

// ── Categories ───────────────────────────────────────────────────────

type NodeCategory = 'tank' | 'pipe' | 'pump' | 'combustor' | 'nozzle' | 'fairing'

const CATEGORIES: NodeCategory[] = ['tank', 'pipe', 'pump', 'combustor', 'nozzle', 'fairing']

const CATEGORY_LABEL: Record<NodeCategory, string> = {
  tank: 'タンク',
  pipe: '配管',
  pump: 'ポンプ',
  combustor: '燃焼器',
  nozzle: 'ノズル',
  fairing: 'フェアリング',
}

const CATEGORY_COLOR: Record<NodeCategory, { border: string; bg: string; text: string; chip: string }> = {
  tank: { border: 'border-emerald-400', bg: 'bg-emerald-50', text: 'text-emerald-700', chip: 'text-emerald-300' },
  pipe: { border: 'border-sky-400', bg: 'bg-sky-50', text: 'text-sky-700', chip: 'text-sky-300' },
  pump: { border: 'border-violet-400', bg: 'bg-violet-50', text: 'text-violet-700', chip: 'text-violet-300' },
  combustor: { border: 'border-rose-400', bg: 'bg-rose-50', text: 'text-rose-700', chip: 'text-rose-300' },
  nozzle: { border: 'border-orange-400', bg: 'bg-orange-50', text: 'text-orange-700', chip: 'text-orange-300' },
  fairing: { border: 'border-cyan-400', bg: 'bg-cyan-50', text: 'text-cyan-700', chip: 'text-cyan-300' },
}

type FieldDef = {
  key: string
  label: string
  unit?: string
  type?: 'select' | 'text'
  options?: { value: string; label: string }[]
}

const FIELD_DEFS: Record<NodeCategory, FieldDef[]> = {
  tank: [
    { key: 'diameterMm', label: '外径', unit: 'mm' },
    { key: 'lengthMm', label: '長さ', unit: 'mm' },
    { key: 'designPressurePa', label: '設計圧力', unit: 'Pa' },
    { key: 'yieldStrengthPa', label: '降伏強度', unit: 'Pa' },
    { key: 'safetyFactor', label: '安全係数' },
    { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3' },
    { key: 'propellantDensityKgM3', label: '推進剤密度', unit: 'kg/m3' },
    { key: 'ullagePercent', label: 'アレージ', unit: '%' },
  ],
  pipe: [
    { key: 'diameterMm', label: '外径', unit: 'mm' },
    { key: 'lengthMm', label: '長さ', unit: 'mm' },
    { key: 'thicknessMm', label: '肉厚', unit: 'mm' },
    { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3' },
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
    { key: 'oxidizer', label: '酸化剤', type: 'select', options: OXIDIZER_OPTIONS },
    { key: 'fuel', label: '燃料', type: 'select', options: [] },
    { key: 'ofRatio', label: 'O/F比' },
    { key: 'yieldStrengthPa', label: '降伏強度', unit: 'Pa' },
    { key: 'safetyFactor', label: '安全係数' },
    { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3' },
  ],
  nozzle: [
    { key: 'exitDiameterMm', label: '出口径', unit: 'mm' },
    { key: 'lengthMm', label: '長さ', unit: 'mm' },
    { key: 'expansionRatio', label: '拡大比 Ae/At' },
    { key: 'ambientPressurePa', label: '外気圧', unit: 'Pa' },
    { key: 'thicknessMm', label: '肉厚', unit: 'mm' },
    { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3' },
  ],
  fairing: [
    { key: 'diameterMm', label: '外径', unit: 'mm' },
    { key: 'lengthMm', label: '長さ', unit: 'mm' },
    { key: 'thicknessMm', label: '肉厚', unit: 'mm' },
    { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3' },
  ],
}

function defaultParams(category: NodeCategory): Record<string, number | string> {
  switch (category) {
    case 'tank': return {
      diameterMm: 3700, lengthMm: 8000, designPressurePa: 300000, yieldStrengthPa: 430000000,
      safetyFactor: 1.5, densityKgM3: 2700, propellantDensityKgM3: 423, ullagePercent: 3,
    }
    case 'pipe': return { diameterMm: 200, lengthMm: 1000, thicknessMm: 2, densityKgM3: 2700 }
    case 'pump': return { massKg: 50 }
    case 'combustor': return {
      diameterMm: 400, lengthMm: 600, throatDiameterMm: 150, chamberPressurePa: 6000000,
      cStarMS: 1800, gamma: 1.2, oxidizer: 'LOX', fuel: 'LCH4', ofRatio: 3.5,
      yieldStrengthPa: 900000000, safetyFactor: 1.5, densityKgM3: 8400,
    }
    case 'nozzle': return {
      exitDiameterMm: 900, lengthMm: 1200, expansionRatio: 36, ambientPressurePa: 101325,
      thicknessMm: 3, densityKgM3: 8400,
    }
    case 'fairing': return { diameterMm: 4000, lengthMm: 9000, thicknessMm: 4, densityKgM3: 1600 }
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
  if (d.category === 'nozzle') {
    return r.thrust_n ? `F=${r.thrust_n.toFixed(0)} N / Isp=${(r.isp_s ?? 0).toFixed(0)} s` : `殻 ${(r.shell_mass_kg ?? 0).toFixed(1)} kg`
  }
  if (d.category === 'tank') {
    return `殻 ${(r.shell_mass_kg ?? 0).toFixed(1)} kg / 推進剤 ${(r.propellant_mass_kg ?? 0).toFixed(1)} kg`
  }
  if (d.category === 'combustor') {
    return `殻 ${(r.shell_mass_kg ?? 0).toFixed(1)} kg / ṁ ${(r.mdot_kg_s ?? 0).toFixed(2)} kg/s`
  }
  if (r.mass_kg !== undefined) return `${r.mass_kg.toFixed(1)} kg`
  if (r.shell_mass_kg !== undefined) return `${r.shell_mass_kg.toFixed(1)} kg`
  return null
}

// ── Component node ───────────────────────────────────────────────────

function RocketFlowNode({ data, selected }: NodeProps) {
  const d = data as unknown as RocketNodeData
  const color = CATEGORY_COLOR[d.category]
  const summary = resultSummary(d)
  return (
    <div className={`min-w-[150px] rounded-lg border-2 ${color.border} ${color.bg} px-3 py-2 shadow-sm ${selected ? 'ring-2 ring-blue-500' : ''}`}>
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !bg-slate-400" />
      <div className={`text-xs font-semibold ${color.text}`}>{CATEGORY_LABEL[d.category]}</div>
      <div className="truncate text-sm font-medium text-gray-900">{d.label}</div>
      {summary && <div className="mt-1 text-xs text-gray-500 tabular-nums">{summary}</div>}
      <Handle type="source" position={Position.Bottom} className="!h-2.5 !w-2.5 !bg-slate-400" />
    </div>
  )
}

// ── Stage (group) node ────────────────────────────────────────────────

const STAGE_TYPE = 'stage'
const STAGE_DEFAULT_WIDTH = 800
const STAGE_DEFAULT_HEIGHT = 260
const STAGE_GAP = 40
const STAGE_DROP_TOP_INSET = 44

type FixedMass = { id: string; label: string; massKg: number }
type StageStructureParams = { diameterMm: number; lengthMm: number; thicknessMm: number; densityKgM3: number }
type StageNodeData = Record<string, unknown> & {
  name: string
  structure: StageStructureParams
  fixedMasses: FixedMass[]
  stageResult: StageSpec | null
}

const STRUCTURE_FIELD_DEFS: FieldDef[] = [
  { key: 'diameterMm', label: '外径', unit: 'mm' },
  { key: 'lengthMm', label: '長さ', unit: 'mm' },
  { key: 'thicknessMm', label: '肉厚', unit: 'mm' },
  { key: 'densityKgM3', label: '材料密度', unit: 'kg/m3' },
]

function defaultStageStructure(): StageStructureParams {
  return { diameterMm: 3700, lengthMm: 2000, thicknessMm: 5, densityKgM3: 2700 }
}

function createStageNode(id: string, name: string, y: number): Node {
  return {
    id,
    type: STAGE_TYPE,
    position: { x: 0, y },
    width: STAGE_DEFAULT_WIDTH,
    height: STAGE_DEFAULT_HEIGHT,
    deletable: false,
    data: {
      name,
      structure: defaultStageStructure(),
      fixedMasses: [],
      stageResult: null,
    } as StageNodeData,
  }
}

function isInsideStage(stage: Node, point: { x: number; y: number }): boolean {
  const w = stage.width ?? stage.measured?.width ?? STAGE_DEFAULT_WIDTH
  const h = stage.height ?? stage.measured?.height ?? STAGE_DEFAULT_HEIGHT
  return point.x >= stage.position.x && point.x <= stage.position.x + w
    && point.y >= stage.position.y && point.y <= stage.position.y + h
}

function StageFlowNode({ data, selected }: NodeProps) {
  const d = data as unknown as StageNodeData
  return (
    <div className={`h-full w-full rounded-lg border-2 ${selected ? 'border-blue-500' : 'border-gray-300'} bg-gray-50/60`}>
      <NodeResizer
        isVisible={selected}
        minWidth={400}
        minHeight={160}
        lineClassName="!border-blue-400"
        handleClassName="!h-3 !w-3 !rounded-sm !border !border-blue-500 !bg-white"
      />
      <div className="flex items-center justify-between gap-3 rounded-t-md border-b border-gray-200 bg-white/90 px-3 py-1.5">
        <span className="text-sm font-semibold text-gray-700">{d.name}</span>
        {d.stageResult && (
          <span className="text-xs tabular-nums text-gray-500">
            乾燥 {d.stageResult.dry_mass.toFixed(0)}kg / 推進剤 {d.stageResult.propellant_mass.toFixed(0)}kg / F {d.stageResult.thrust.toFixed(0)}N
          </span>
        )}
      </div>
    </div>
  )
}

type FlowNodeComponent = (props: NodeProps) => React.ReactElement

const nodeTypes: Record<string, FlowNodeComponent> = {
  ...Object.fromEntries(CATEGORIES.map(c => [c, RocketFlowNode])),
  [STAGE_TYPE]: StageFlowNode,
}

// ── Component param panel ─────────────────────────────────────────────

function ParamPanel({
  node, onChangeParam, onChangeLabel,
}: {
  node: Node
  onChangeParam: (key: string, value: string) => void
  onChangeLabel: (value: string) => void
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
        if (field.key === 'fuel' && d.category === 'combustor') {
          const oxidizer = String(d.params.oxidizer ?? 'LOX')
          const options = FUEL_OPTIONS_BY_OXIDIZER[oxidizer] ?? []
          return (
            <div key={field.key}>
              <label className="mb-1 block text-xs font-medium text-gray-500">{field.label}</label>
              <select
                value={String(d.params[field.key] ?? '')}
                onChange={e => onChangeParam(field.key, e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )
        }
        if (field.type === 'select') {
          return (
            <div key={field.key}>
              <label className="mb-1 block text-xs font-medium text-gray-500">{field.label}</label>
              <select
                value={String(d.params[field.key] ?? '')}
                onChange={e => onChangeParam(field.key, e.target.value)}
                className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {(field.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )
        }
        if (field.type === 'text') {
          return (
            <div key={field.key}>
              <label className="mb-1 block text-xs font-medium text-gray-500">{field.label}</label>
              <input
                value={String(d.params[field.key] ?? '')}
                onChange={e => onChangeParam(field.key, e.target.value)}
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )
        }
        return (
          <div key={field.key}>
            <label className="mb-1 block text-xs font-medium text-gray-500">
              {field.label}{field.unit ? ` [${field.unit}]` : ''}
            </label>
            <input
              type="number"
              step="any"
              value={String(d.params[field.key] ?? '')}
              onChange={e => onChangeParam(field.key, e.target.value)}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        )
      })}
    </div>
  )
}

// ── Stage param panel ──────────────────────────────────────────────────

function StagePanel({
  stageNode, onChangeName, onChangeStructure, onAddFixedMass, onChangeFixedMass, onRemoveFixedMass, onCalc, calculating,
}: {
  stageNode: Node
  onChangeName: (value: string) => void
  onChangeStructure: (key: string, value: string) => void
  onAddFixedMass: () => void
  onChangeFixedMass: (id: string, patch: Partial<FixedMass>) => void
  onRemoveFixedMass: (id: string) => void
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
          {STRUCTURE_FIELD_DEFS.map(field => (
            <div key={field.key}>
              <label className="mb-1 block text-xs font-medium text-gray-500">
                {field.label}{field.unit ? ` [${field.unit}]` : ''}
              </label>
              <input
                type="number"
                step="any"
                value={String(d.structure[field.key as keyof StageStructureParams] ?? '')}
                onChange={e => onChangeStructure(field.key, e.target.value)}
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}
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
              <button type="button" onClick={() => onRemoveFixedMass(fm.id)} className="text-gray-400 hover:text-red-600">
                ×
              </button>
            </div>
          ))}
          {d.fixedMasses.length === 0 && <p className="text-xs text-gray-400">固定質量はありません</p>}
        </div>
      </div>

      <button
        type="button"
        onClick={onCalc}
        disabled={calculating}
        className="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-1.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {calculating ? '計算中...' : 'この段を計算'}
      </button>

      {d.stageResult && (
        <div className="flex flex-col gap-1 border-t border-gray-100 pt-3 text-xs text-gray-600">
          <span>乾燥質量 <b className="tabular-nums">{d.stageResult.dry_mass.toFixed(1)}</b> kg</span>
          <span>推進剤 <b className="tabular-nums">{d.stageResult.propellant_mass.toFixed(1)}</b> kg</span>
          <span>推力 <b className="tabular-nums">{d.stageResult.thrust.toFixed(0)}</b> N</span>
          <span>燃焼時間 <b className="tabular-nums">{d.stageResult.burn_time.toFixed(1)}</b> s</span>
        </div>
      )}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────

const ZERO_STAGE: StageSpec = { propellant_mass: 0, dry_mass: 0, oxidizer: 'LOX', fuel: 'LCH4', thrust: 0, burn_time: 0 }

function RocketBuilderInner({ onStagesChange }: { onStagesChange?: (stages: StageSpec[]) => void }) {
  const { screenToFlowPosition } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([createStageNode('stage-1', 'ステージ1', 0)])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadingStageId, setLoadingStageId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nodeCounter = useRef(0)
  const stageCounter = useRef(1)
  const lastStagesKey = useRef<string>('')

  const selectedNode = nodes.find(n => n.id === selectedId) ?? null

  const orderedNodes = useMemo(() => {
    const stages = nodes.filter(n => n.type === STAGE_TYPE)
    const others = nodes.filter(n => n.type !== STAGE_TYPE)
    return [...stages, ...others]
  }, [nodes])

  useEffect(() => {
    const stageNodes = nodes.filter(n => n.type === STAGE_TYPE)
    const sorted = [...stageNodes].sort((a, b) => b.position.y - a.position.y)
    const specs = sorted.map(n => (n.data as unknown as StageNodeData).stageResult ?? ZERO_STAGE)
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
      const h = n.height ?? STAGE_DEFAULT_HEIGHT
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
    setEdges(prev => addEdge(conn, prev))
  }, [nodes, setEdges])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId(node.id)
  }, [])

  const updateParam = useCallback((key: string, value: string) => {
    setNodes(prev => prev.map(n => {
      if (n.id !== selectedId) return n
      const d = n.data as unknown as RocketNodeData
      return { ...n, data: { ...d, params: { ...d.params, [key]: value } } as unknown as Record<string, unknown> }
    }))
  }, [selectedId, setNodes])

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

  const updateStageField = (stageId: string, updater: (d: StageNodeData) => StageNodeData) => {
    setNodes(prev => prev.map(n => (
      n.id === stageId ? { ...n, data: updater(n.data as unknown as StageNodeData) as unknown as Record<string, unknown> } : n
    )))
  }

  const updateStageName = (stageId: string, name: string) => updateStageField(stageId, d => ({ ...d, name }))

  const updateStageStructure = (stageId: string, key: string, value: string) => updateStageField(stageId, d => ({
    ...d, structure: { ...d.structure, [key]: Number(value) || 0 },
  }))

  const addFixedMass = (stageId: string) => updateStageField(stageId, d => ({
    ...d, fixedMasses: [...d.fixedMasses, { id: `fm-${Date.now()}`, label: '', massKg: 0 }],
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
        return { id: n.id, node_type: d.category, params: d.params }
      })
      const payloadEdges: RocketEdgePayload[] = stageEdges.map(e => ({
        id: e.id, source: e.source, target: e.target,
        source_handle: e.sourceHandle ?? null, target_handle: e.targetHandle ?? null,
      }))
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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '段の計算に失敗しました')
    } finally {
      setLoadingStageId(null)
    }
  }

  return (
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

        {/* Param panel */}
        <div className="w-72 shrink-0 border-l border-gray-200 bg-white p-4 overflow-y-auto">
          <h3 className="text-sm font-semibold text-gray-600 mb-4 pb-3 border-b border-gray-100">パラメータ設定</h3>
          {selectedNode ? (
            selectedNode.type === STAGE_TYPE ? (
              <div className="flex flex-col gap-3">
                <StagePanel
                  stageNode={selectedNode}
                  onChangeName={v => updateStageName(selectedNode.id, v)}
                  onChangeStructure={(k, v) => updateStageStructure(selectedNode.id, k, v)}
                  onAddFixedMass={() => addFixedMass(selectedNode.id)}
                  onChangeFixedMass={(id, patch) => updateFixedMass(selectedNode.id, id, patch)}
                  onRemoveFixedMass={id => removeFixedMass(selectedNode.id, id)}
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
                <ParamPanel node={selectedNode} onChangeParam={updateParam} onChangeLabel={updateLabel} />
                <button
                  type="button"
                  onClick={removeSelectedNode}
                  className="mt-2 w-full rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  ノードを削除
                </button>
              </div>
            )
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-center gap-2">
              <p className="text-sm text-gray-400">キャンバスのノードを<br />クリックして選択</p>
            </div>
          )}
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
