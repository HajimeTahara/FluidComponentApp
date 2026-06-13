'use client'

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import dynamic from 'next/dynamic'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  ConnectionMode,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type NodeProps,
  Handle,
  Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { runSimulate, type SimResults, type TankResult, type EquipResult } from '@/app/lib/api'

const Plot = dynamic(() => import('react-plotly.js'), { ssr: false })

// ── Types ──────────────────────────────────────────────────────────
type EquipType = 'tank' | 'pump' | 'valve' | 'heatExchanger'

type ParamDef = {
  key: string
  label: string
  unit: string
  default: number
  min?: number
  max?: number
  step?: number
}

interface PIDNodeData extends Record<string, unknown> {
  label: string
  equipType: EquipType
  params: Record<string, number>
}

type SimConfig = { durationH: number; durationM: number; dt: number; fluid: string }

type PipeParams = { diameter: number; length: number; thickness: number; roughness: number }

// ── Equipment definitions ──────────────────────────────────────────
const EQUIP_DEFS = [
  { type: 'tank'          as EquipType, label: 'タンク',   desc: '貯槽・容器',      accent: '#2563eb' },
  { type: 'pump'          as EquipType, label: 'ポンプ',   desc: '遠心ポンプ',      accent: '#7c3aed' },
  { type: 'valve'         as EquipType, label: 'バルブ',   desc: '調節弁・遮断弁',  accent: '#d97706' },
  { type: 'heatExchanger' as EquipType, label: '熱交換器', desc: 'シェル&チューブ', accent: '#dc2626' },
]

const ACCENT_MAP: Record<EquipType, string> = {
  tank: '#2563eb', pump: '#7c3aed', valve: '#d97706', heatExchanger: '#dc2626',
}

const EQUIP_PREFIX: Record<EquipType, string> = {
  tank: 'T', pump: 'P', valve: 'V', heatExchanger: 'E',
}

const SUPPORTED_FLUIDS = [
  'Water', 'Methane', 'Nitrogen', 'Oxygen', 'Hydrogen',
  'CarbonDioxide', 'Propane', 'Ammonia', 'R134a', 'Ethane',
]

// ── Parameter schemas ──────────────────────────────────────────────
const PARAM_SCHEMAS: Record<EquipType, ParamDef[]> = {
  tank: [
    { key: 'height',    label: 'タンク高さ', unit: 'm',    default: 5,   min: 0.1, step: 0.1 },
    { key: 'area',      label: '底面積',     unit: 'm²',   default: 10,  min: 0.01, step: 0.1 },
    { key: 'initLevel', label: '初期水位',   unit: 'm',    default: 2.5, min: 0, step: 0.1 },
  ],
  pump: [
    { key: 'flowRate',   label: '設計流量', unit: 'm³/h', default: 50, min: 0, step: 1 },
    { key: 'head',       label: '設計揚程', unit: 'm',    default: 30, min: 0, step: 0.5 },
    { key: 'efficiency', label: '効率',     unit: '%',    default: 75, min: 0, max: 100, step: 1 },
  ],
  valve: [
    { key: 'cv',       label: 'Cv値',  unit: '-',  default: 10,  min: 0, step: 0.1 },
    { key: 'opening',  label: '開度',  unit: '%',  default: 100, min: 0, max: 100, step: 1 },
    { key: 'diameter', label: '口径',  unit: 'mm', default: 50,  min: 1, step: 1 },
  ],
  heatExchanger: [
    { key: 'area',     label: '伝熱面積',      unit: 'm²',    default: 20,  min: 0, step: 0.5 },
    { key: 'u',        label: '総括熱伝達係数', unit: 'W/m²K', default: 500, min: 0, step: 10 },
    { key: 'flowRate', label: 'シェル側流量',   unit: 'm³/h',  default: 30,  min: 0, step: 1 },
  ],
}

// ── Pipe parameter schema ──────────────────────────────────────────
const PIPE_PARAM_SCHEMA: ParamDef[] = [
  { key: 'diameter',  label: '内径',   unit: 'mm', default: 50,    min: 1,    step: 0.5 },
  { key: 'length',    label: '長さ',   unit: 'm',  default: 10,    min: 0.01, step: 0.1 },
  { key: 'thickness', label: '肉厚',   unit: 'mm', default: 3,     min: 0.1,  step: 0.1 },
  { key: 'roughness', label: '粗さ',   unit: 'mm', default: 0.046, min: 0,    step: 0.001 },
]

const PIPE_PARAM_DEFAULTS: PipeParams = Object.fromEntries(
  PIPE_PARAM_SCHEMA.map(p => [p.key, p.default])
) as PipeParams

// ── Icons ──────────────────────────────────────────────────────────
function PipeIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={Math.round(size * 0.5)} viewBox="0 0 24 12" fill="none">
      <rect x="0" y="0" width="24" height="12" rx="6" fill="#e2e8f0" stroke="#64748b" strokeWidth="1.2"/>
      <rect x="2" y="2" width="20" height="8" rx="4" fill="#f8fafc" stroke="#94a3b8" strokeWidth="0.8"/>
    </svg>
  )
}

function ClockIcon({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  )
}

function EquipIcon({ type, size = 52 }: { type: string; size?: number }) {
  switch (type) {
    case 'tank':
      return (
        <svg width={size} height={Math.round(size * 1.3)} viewBox="0 0 52 68" fill="none">
          <rect x="8" y="16" width="36" height="40" fill="#dbeafe" stroke="#2563eb" strokeWidth="1.5"/>
          <ellipse cx="26" cy="16" rx="18" ry="7" fill="#bfdbfe" stroke="#2563eb" strokeWidth="1.5"/>
          <ellipse cx="26" cy="56" rx="18" ry="7" fill="#bfdbfe" stroke="#2563eb" strokeWidth="1.5"/>
          <line x1="9" y1="32" x2="43" y2="32" stroke="#93c5fd" strokeWidth="1" strokeDasharray="4,3"/>
          <line x1="9" y1="44" x2="43" y2="44" stroke="#93c5fd" strokeWidth="1" strokeDasharray="4,3"/>
        </svg>
      )
    case 'pump':
      return (
        <svg width={size} height={size} viewBox="0 0 52 52" fill="none">
          <circle cx="26" cy="26" r="20" fill="#ede9fe" stroke="#7c3aed" strokeWidth="1.5"/>
          <polygon points="13,38 13,14 40,26" fill="#c4b5fd" stroke="#7c3aed" strokeWidth="1.5"/>
          <circle cx="26" cy="26" r="3" fill="#7c3aed"/>
        </svg>
      )
    case 'valve':
      return (
        <svg width={size} height={Math.round(size * 0.75)} viewBox="0 0 52 40" fill="none">
          <polygon points="2,2 26,20 2,38" fill="#fef3c7" stroke="#d97706" strokeWidth="1.5"/>
          <polygon points="50,2 26,20 50,38" fill="#fef3c7" stroke="#d97706" strokeWidth="1.5"/>
          <line x1="26" y1="4" x2="26" y2="20" stroke="#d97706" strokeWidth="1.5"/>
          <circle cx="26" cy="4" r="5" fill="#fde68a" stroke="#d97706" strokeWidth="1.5"/>
        </svg>
      )
    case 'heatExchanger':
      return (
        <svg width={size} height={size} viewBox="0 0 52 52" fill="none">
          <circle cx="26" cy="26" r="20" fill="#fee2e2" stroke="#dc2626" strokeWidth="1.5"/>
          <line x1="6" y1="20" x2="46" y2="20" stroke="#dc2626" strokeWidth="1.5"/>
          <line x1="6" y1="26" x2="46" y2="26" stroke="#dc2626" strokeWidth="1.5"/>
          <line x1="6" y1="32" x2="46" y2="32" stroke="#dc2626" strokeWidth="1.5"/>
          <polyline points="20,20 24,15 28,20" stroke="#f87171" strokeWidth="1.5" fill="none"/>
          <polyline points="24,32 28,37 32,32" stroke="#f87171" strokeWidth="1.5" fill="none"/>
        </svg>
      )
    default:
      return <svg width={size} height={size} viewBox="0 0 52 52" fill="none"><rect x="8" y="8" width="36" height="36" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="1.5"/></svg>
  }
}

// ── Custom Node Component ──────────────────────────────────────────
const HANDLE_STYLE: React.CSSProperties = {
  width: 10, height: 10,
  background: '#94a3b8', border: '2px solid #64748b', borderRadius: '50%',
}

function PIDNodeComponent({ data, id, selected }: NodeProps) {
  const { label, equipType } = data as unknown as PIDNodeData
  const { setNodes } = useReactFlow()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(label)
  const accent = ACCENT_MAP[equipType] ?? '#475569'

  useEffect(() => { setEditValue(label) }, [label])

  const commitEdit = useCallback(() => {
    setEditing(false)
    const trimmed = editValue.trim()
    if (trimmed) {
      setNodes(nds => nds.map(n =>
        n.id === id ? { ...n, data: { ...n.data, label: trimmed } } : n
      ))
    } else {
      setEditValue(label)
    }
  }, [editValue, id, label, setNodes])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '10px 14px', borderRadius: 10,
      border: `2px solid ${selected ? accent : 'rgba(148,163,184,0.35)'}`,
      boxShadow: selected
        ? `0 0 0 3px ${accent}33, 0 4px 16px rgba(0,0,0,0.1)`
        : '0 2px 8px rgba(0,0,0,0.07)',
      background: selected ? `${accent}0d` : 'rgba(255,255,255,0.95)',
      backdropFilter: 'blur(4px)', minWidth: 76,
    }}>
      <Handle type="source" position={Position.Top}    id="top"    style={HANDLE_STYLE}/>
      <Handle type="source" position={Position.Right}  id="right"  style={HANDLE_STYLE}/>
      <Handle type="source" position={Position.Bottom} id="bottom" style={HANDLE_STYLE}/>
      <Handle type="source" position={Position.Left}   id="left"   style={HANDLE_STYLE}/>

      <EquipIcon type={equipType} size={52}/>

      {editing ? (
        <input
          autoFocus value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => {
            if (e.key === 'Enter') commitEdit()
            if (e.key === 'Escape') { setEditing(false); setEditValue(label) }
            e.stopPropagation()
          }}
          onClick={e => e.stopPropagation()}
          style={{
            marginTop: 5, width: 72, fontSize: 11, fontWeight: 700,
            color: accent, fontFamily: 'ui-monospace, monospace',
            border: `1.5px solid ${accent}`, borderRadius: 4,
            padding: '1px 4px', textAlign: 'center', background: 'white', outline: 'none',
          }}
        />
      ) : (
        <span
          onDoubleClick={e => { e.stopPropagation(); setEditing(true) }}
          title="ダブルクリックで名称を編集"
          style={{
            marginTop: 5, fontSize: 11, fontWeight: 700,
            color: accent, fontFamily: 'ui-monospace, monospace',
            letterSpacing: '0.06em', cursor: 'text',
          }}
        >
          {label}
        </span>
      )}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeTypes: NodeTypes = { pid: PIDNodeComponent as any }

const DEFAULT_EDGE_OPTIONS = {
  type: 'smoothstep',
  markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b', width: 14, height: 14 },
}

// ── Palette Item ───────────────────────────────────────────────────
function PaletteItem({ type, label, desc, accent }: typeof EQUIP_DEFS[number]) {
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData('application/pid-equip', type)
    e.dataTransfer.effectAllowed = 'move'
  }
  return (
    <div
      draggable onDragStart={onDragStart}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 10px', marginBottom: 3, borderRadius: 7,
        cursor: 'grab', userSelect: 'none',
        border: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(255,255,255,0.04)',
        transition: 'background 0.15s, border-color 0.15s',
      }}
      onMouseEnter={e => {
        ;(e.currentTarget as HTMLDivElement).style.background = `${accent}22`
        ;(e.currentTarget as HTMLDivElement).style.borderColor = `${accent}55`
      }}
      onMouseLeave={e => {
        ;(e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.04)'
        ;(e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.06)'
      }}
    >
      <div style={{ flexShrink: 0, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <EquipIcon type={type} size={30}/>
      </div>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: accent, fontFamily: 'ui-monospace, monospace' }}>{label}</div>
        <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{desc}</div>
      </div>
    </div>
  )
}

// ── Simulation Settings Modal ──────────────────────────────────────
function SimSettingsModal({
  config, setConfig, onClose, onRun, running, error,
}: {
  config: SimConfig
  setConfig: React.Dispatch<React.SetStateAction<SimConfig>>
  onClose: () => void
  onRun: () => Promise<boolean>
  running: boolean
  error: string | null
}) {
  const handleRun = async () => {
    const ok = await onRun()
    if (ok) onClose()
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 12px',
    border: '1.5px solid #e2e8f0', borderRadius: 7,
    fontSize: 13, fontFamily: 'ui-monospace, monospace',
    color: '#0f172a', fontWeight: 600, outline: 'none',
    background: '#fafafa', boxSizing: 'border-box',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(15,23,42,0.55)',
        zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(2px)',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'white', borderRadius: 14,
        padding: '28px 28px 24px',
        width: 380, boxShadow: '0 24px 64px rgba(0,0,0,0.22)',
        border: '1px solid #e2e8f0',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <ClockIcon size={18} color="#2563eb"/>
          <span style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', flex: 1 }}>シミュレーション設定</span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 20, lineHeight: 1, padding: 0 }}
          >
            ✕
          </button>
        </div>

        {/* Fluid */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: '#64748b', fontWeight: 700, display: 'block', marginBottom: 5, letterSpacing: '0.05em' }}>
            流体
          </label>
          <select
            value={config.fluid}
            onChange={e => setConfig(c => ({ ...c, fluid: e.target.value }))}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            {SUPPORTED_FLUIDS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        {/* Duration */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: '#64748b', fontWeight: 700, display: 'block', marginBottom: 5, letterSpacing: '0.05em' }}>
            シミュレーション時間
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <input type="number" min={0} step={1} value={config.durationH}
                onChange={e => setConfig(c => ({ ...c, durationH: Math.max(0, parseInt(e.target.value) || 0) }))}
                style={{ ...inputStyle, textAlign: 'right' }}
                onFocus={e => { e.currentTarget.style.borderColor = '#2563eb' }}
                onBlur={e => { e.currentTarget.style.borderColor = '#e2e8f0' }}
              />
              <div style={{ fontSize: 10, color: '#94a3b8', textAlign: 'center', marginTop: 3 }}>時間</div>
            </div>
            <div style={{ flex: 1 }}>
              <input type="number" min={0} max={59} step={1} value={config.durationM}
                onChange={e => setConfig(c => ({ ...c, durationM: Math.min(59, Math.max(0, parseInt(e.target.value) || 0)) }))}
                style={{ ...inputStyle, textAlign: 'right' }}
                onFocus={e => { e.currentTarget.style.borderColor = '#2563eb' }}
                onBlur={e => { e.currentTarget.style.borderColor = '#e2e8f0' }}
              />
              <div style={{ fontSize: 10, color: '#94a3b8', textAlign: 'center', marginTop: 3 }}>分</div>
            </div>
          </div>
        </div>

        {/* Time step */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ fontSize: 11, color: '#64748b', fontWeight: 700, display: 'block', marginBottom: 5, letterSpacing: '0.05em' }}>
            出力間隔（秒）
          </label>
          <input type="number" min={1} step={1} value={config.dt}
            onChange={e => setConfig(c => ({ ...c, dt: Math.max(1, parseInt(e.target.value) || 60) }))}
            style={inputStyle}
            onFocus={e => { e.currentTarget.style.borderColor = '#2563eb' }}
            onBlur={e => { e.currentTarget.style.borderColor = '#e2e8f0' }}
          />
        </div>

        {/* Error */}
        {error && (
          <div style={{
            marginBottom: 16, padding: '8px 12px',
            background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 6, fontSize: 11, color: '#dc2626', lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: '10px',
            background: '#f1f5f9', color: '#475569',
            border: '1px solid #e2e8f0', borderRadius: 7,
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>
            キャンセル
          </button>
          <button onClick={handleRun} disabled={running} style={{
            flex: 2, padding: '10px',
            background: running ? '#94a3b8' : '#2563eb',
            color: 'white', border: 'none', borderRadius: 7,
            fontSize: 13, fontWeight: 700,
            cursor: running ? 'not-allowed' : 'pointer',
            transition: 'background 0.15s',
          }}>
            {running ? '計算中...' : '▶ 実行'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Component Parameter Section (top-right) ────────────────────────
function ParamSection({ node, onParamChange }: {
  node: Node | null
  onParamChange: (id: string, key: string, val: number) => void
}) {
  const panelBase: React.CSSProperties = {
    flex: 1, minHeight: 0,
    background: 'white',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
    overflow: 'auto',
  }

  const sectionLabel: React.CSSProperties = {
    fontSize: 9, fontWeight: 800, color: '#94a3b8',
    letterSpacing: '0.14em', textTransform: 'uppercase',
    padding: '12px 14px 0',
    position: 'sticky', top: 0,
    background: 'white', zIndex: 1,
  }

  if (!node) {
    return (
      <div style={{ ...panelBase, display: 'flex', flexDirection: 'column' }}>
        <div style={sectionLabel}>コンポーネントパラメータ</div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: '#cbd5e1', padding: 16 }}>
            <div style={{ fontSize: 26, marginBottom: 8, opacity: 0.4 }}>⊙</div>
            <div style={{ fontSize: 10, lineHeight: 1.8 }}>機器を選択するとパラメータが<br/>配管を選択すると配管パラメータが<br/>表示されます</div>
          </div>
        </div>
      </div>
    )
  }

  const { label, equipType, params = {} } = node.data as unknown as PIDNodeData
  const schema = PARAM_SCHEMAS[equipType] ?? []
  const accent = ACCENT_MAP[equipType] ?? '#475569'
  const def = EQUIP_DEFS.find(e => e.type === equipType)

  return (
    <div style={panelBase}>
      <div style={sectionLabel}>コンポーネントパラメータ</div>

      {/* Equipment header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px 10px', borderBottom: '1px solid #f1f5f9' }}>
        <EquipIcon type={equipType} size={30}/>
        <div>
          <div style={{ fontSize: 9, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 1 }}>
            {def?.label}
          </div>
          <div style={{ fontSize: 14, fontWeight: 800, color: accent, fontFamily: 'ui-monospace, monospace' }}>
            {label}
          </div>
        </div>
      </div>

      {/* Param inputs */}
      <div style={{ padding: '12px 14px' }}>
        {schema.map(p => {
          const val = (params[p.key] as number | undefined) ?? p.default
          return (
            <div key={p.key} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>{p.label}</span>
                <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'ui-monospace, monospace', background: '#f1f5f9', padding: '1px 5px', borderRadius: 3 }}>
                  {p.unit}
                </span>
              </div>
              <input
                type="number" value={val} min={p.min} max={p.max} step={p.step}
                onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onParamChange(node.id, p.key, v) }}
                style={{
                  width: '100%', padding: '6px 10px',
                  border: `1.5px solid ${accent}33`, borderRadius: 6,
                  fontSize: 12, fontFamily: 'ui-monospace, monospace',
                  color: '#0f172a', fontWeight: 600, outline: 'none',
                  background: '#fafafa', boxSizing: 'border-box',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = accent; e.currentTarget.style.boxShadow = `0 0 0 3px ${accent}18` }}
                onBlur={e => { e.currentTarget.style.borderColor = `${accent}33`; e.currentTarget.style.boxShadow = 'none' }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Pipe Parameter Section ────────────────────────────────────────
function PipeParamSection({ edge, nodes, onParamChange }: {
  edge: Edge | null
  nodes: Node[]
  onParamChange: (id: string, key: string, val: number) => void
}) {
  const panelBase: React.CSSProperties = {
    flex: 1, minHeight: 0,
    background: 'white',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
    overflow: 'auto',
  }
  const sectionLabel: React.CSSProperties = {
    fontSize: 9, fontWeight: 800, color: '#94a3b8',
    letterSpacing: '0.14em', textTransform: 'uppercase',
    padding: '12px 14px 0',
    position: 'sticky', top: 0,
    background: 'white', zIndex: 1,
  }

  if (!edge) {
    return (
      <div style={{ ...panelBase, display: 'flex', flexDirection: 'column' }}>
        <div style={sectionLabel}>配管パラメータ</div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: '#cbd5e1', padding: 16 }}>
            <div style={{ fontSize: 26, marginBottom: 8, opacity: 0.4 }}>⊙</div>
            <div style={{ fontSize: 10, lineHeight: 1.8 }}>配管（線）を選択すると<br/>パラメータが表示されます</div>
          </div>
        </div>
      </div>
    )
  }

  const params = (edge.data as Partial<PipeParams>) ?? {}
  const accent = '#475569'
  const srcLabel = (nodes.find(n => n.id === edge.source)?.data as PIDNodeData | undefined)?.label ?? edge.source
  const tgtLabel = (nodes.find(n => n.id === edge.target)?.data as PIDNodeData | undefined)?.label ?? edge.target

  return (
    <div style={panelBase}>
      <div style={sectionLabel}>配管パラメータ</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid #f1f5f9' }}>
        <PipeIcon size={28}/>
        <div>
          <div style={{ fontSize: 9, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700, marginBottom: 1 }}>
            配管
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: accent, fontFamily: 'ui-monospace, monospace' }}>
            {srcLabel} → {tgtLabel}
          </div>
        </div>
      </div>

      <div style={{ padding: '12px 14px' }}>
        {PIPE_PARAM_SCHEMA.map(p => {
          const val = (params[p.key as keyof PipeParams] as number | undefined) ?? p.default
          return (
            <div key={p.key} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>{p.label}</span>
                <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'ui-monospace, monospace', background: '#f1f5f9', padding: '1px 5px', borderRadius: 3 }}>
                  {p.unit}
                </span>
              </div>
              <input
                type="number" value={val} min={p.min} max={p.max} step={p.step}
                onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onParamChange(edge.id, p.key, v) }}
                style={{
                  width: '100%', padding: '6px 10px',
                  border: `1.5px solid ${accent}33`, borderRadius: 6,
                  fontSize: 12, fontFamily: 'ui-monospace, monospace',
                  color: '#0f172a', fontWeight: 600, outline: 'none',
                  background: '#fafafa', boxSizing: 'border-box',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = accent; e.currentTarget.style.boxShadow = `0 0 0 3px ${accent}18` }}
                onBlur={e => { e.currentTarget.style.borderColor = `${accent}33`; e.currentTarget.style.boxShadow = 'none' }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Final Results Section (bottom-right) ──────────────────────────
function FinalResultsSection({ results, selectedIds, onToggle }: {
  results: SimResults | null
  selectedIds: Set<string>
  onToggle: (id: string) => void
}) {
  const panelBase: React.CSSProperties = {
    flex: 1, minHeight: 0,
    background: 'white',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
    overflow: 'auto',
    display: 'flex', flexDirection: 'column',
  }

  if (!results) {
    return (
      <div style={panelBase}>
        <div style={{
          fontSize: 9, fontWeight: 800, color: '#94a3b8',
          letterSpacing: '0.14em', textTransform: 'uppercase',
          padding: '12px 14px 10px', borderBottom: '1px solid #f1f5f9',
        }}>
          最終シミュレーション結果
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: '#cbd5e1', padding: 16 }}>
            <div style={{ fontSize: 22, marginBottom: 6, opacity: 0.35 }}>📊</div>
            <div style={{ fontSize: 10, lineHeight: 1.8 }}>シミュレーション実行後に<br/>最終値が表示されます</div>
          </div>
        </div>
      </div>
    )
  }

  const lastIdx = results.time.length - 1
  const finalTimeH = (results.time[lastIdx] / 3600).toFixed(2)

  return (
    <div style={panelBase}>
      {/* Sticky header */}
      <div style={{
        padding: '10px 14px 8px',
        borderBottom: '1px solid #f1f5f9',
        position: 'sticky', top: 0, background: 'white', zIndex: 1,
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 9, fontWeight: 800, color: '#94a3b8', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
          最終シミュレーション結果
        </div>
        <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 2 }}>
          t = {finalTimeH} h　〈クリックでグラフ表示〉
        </div>
      </div>

      {/* Results list */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {Object.entries(results.results).map(([id, r]) => {
          const isSelected = selectedIds.has(id)
          const accent = ACCENT_MAP[r.equipType as EquipType] ?? '#64748b'
          const isTank = r.equipType === 'tank'

          let primaryLabel: string
          let primaryVal: string
          let secondaryVal: string | null = null

          if (isTank) {
            const tr = r as TankResult
            const level = tr.level[lastIdx]
            const fillPct = tr.height > 0 ? (level / tr.height) * 100 : 0
            const vol = level * tr.area
            primaryLabel = '液位'
            primaryVal = `${level.toFixed(3)} m`
            secondaryVal = `容量 ${vol.toFixed(2)} m³　(${fillPct.toFixed(0)}%)`
          } else {
            const er = r as EquipResult
            primaryLabel = '流量'
            primaryVal = `${er.flowRate[lastIdx].toFixed(3)} m³/h`
          }

          return (
            <div
              key={id}
              onClick={() => onToggle(id)}
              style={{
                padding: '9px 14px',
                borderBottom: '1px solid #f8fafc',
                cursor: 'pointer',
                background: isSelected ? `${accent}0c` : 'transparent',
                transition: 'background 0.12s',
                display: 'flex', alignItems: 'center', gap: 9,
              }}
              onMouseEnter={e => {
                if (!isSelected)(e.currentTarget as HTMLDivElement).style.background = '#f8fafc'
              }}
              onMouseLeave={e => {
                ;(e.currentTarget as HTMLDivElement).style.background = isSelected ? `${accent}0c` : 'transparent'
              }}
            >
              {/* Selection dot */}
              <div style={{
                width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                background: isSelected ? accent : 'transparent',
                border: `2px solid ${isSelected ? accent : '#d1d5db'}`,
                transition: 'all 0.12s',
              }}/>

              {/* Equip icon */}
              <div style={{ flexShrink: 0 }}>
                <EquipIcon type={r.equipType} size={20}/>
              </div>

              {/* Values */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: accent,
                    fontFamily: 'ui-monospace, monospace',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 70,
                  }}>
                    {r.label}
                  </span>
                  <span style={{ fontSize: 9, color: '#94a3b8', flexShrink: 0 }}>{primaryLabel}</span>
                </div>
                <div style={{
                  fontSize: 14, fontWeight: 800, color: '#0f172a',
                  fontFamily: 'ui-monospace, monospace', letterSpacing: '0.02em', marginTop: 1,
                }}>
                  {primaryVal}
                </div>
                {secondaryVal && (
                  <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 1 }}>{secondaryVal}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Simulation Results Chart (bottom) ──────────────────────────────
function SimResultsChart({ results, selectedIds }: { results: SimResults; selectedIds: Set<string> }) {
  const { time, results: data } = results
  const timeH = time.map(t => t / 3600)

  const tankTraces = Object.entries(data)
    .filter(([id, v]) => selectedIds.has(id) && v.equipType === 'tank')
    .map(([, v]) => {
      const r = v as TankResult
      return {
        x: timeH, y: r.level,
        name: `${r.label} 液位`,
        type: 'scatter' as const, mode: 'lines' as const,
        line: { width: 2 },
        hovertemplate: `${r.label}<br>%{x:.2f} h<br>%{y:.3f} m<extra></extra>`,
      }
    })

  const flowTraces = Object.entries(data)
    .filter(([id, v]) => selectedIds.has(id) && v.equipType !== 'tank')
    .map(([, v]) => {
      const r = v as EquipResult
      return {
        x: timeH, y: r.flowRate,
        name: `${r.label} 流量`,
        type: 'scatter' as const, mode: 'lines' as const,
        line: { width: 1.5, dash: 'dot' as const },
        yaxis: 'y2' as const,
        hovertemplate: `${r.label}<br>%{x:.2f} h<br>%{y:.2f} m³/h<extra></extra>`,
      }
    })

  const hasFlow = flowTraces.length > 0
  const hasData = tankTraces.length + flowTraces.length > 0

  return (
    <div style={{
      height: 230, flexShrink: 0,
      background: 'white',
      border: '1px solid #e2e8f0', borderRadius: 10,
      boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
      overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {hasData ? (
        <Plot
          data={[...tankTraces, ...flowTraces]}
          layout={{
            margin: { t: 28, r: hasFlow ? 65 : 16, b: 44, l: 60 },
            xaxis: {
              title: { text: '時間 [h]', font: { size: 11 } },
              gridcolor: '#f1f5f9', zeroline: false,
            },
            yaxis: {
              title: { text: '液位 [m]', font: { size: 11 } },
              gridcolor: '#f1f5f9', zeroline: false, rangemode: 'tozero',
            },
            ...(hasFlow ? {
              yaxis2: {
                title: { text: '流量 [m³/h]', font: { size: 11 } },
                overlaying: 'y', side: 'right', zeroline: false, rangemode: 'tozero',
              },
            } : {}),
            legend: { orientation: 'h', x: 0, y: 1.12, font: { size: 10 } },
            paper_bgcolor: 'white', plot_bgcolor: '#fafafa',
            font: { size: 11 },
          }}
          config={{ responsive: true, displayModeBar: false }}
          style={{ width: '100%', height: '100%' }}
        />
      ) : (
        <div style={{ textAlign: 'center', color: '#cbd5e1' }}>
          <div style={{ fontSize: 24, marginBottom: 6, opacity: 0.35 }}>📈</div>
          <div style={{ fontSize: 11 }}>右パネルの最終値をクリックしてグラフを表示</div>
        </div>
      )}
    </div>
  )
}

// ── Scoped CSS for edge selection ──────────────────────────────────
const CANVAS_CSS = `
.pid-canvas .react-flow__edge-path { stroke: #64748b; stroke-width: 2.5px; }
.pid-canvas .react-flow__edge.selected .react-flow__edge-path { stroke: #2563eb; stroke-width: 3px; }
.pid-canvas .react-flow__edge:hover .react-flow__edge-path { stroke: #475569; stroke-width: 3px; }
.pid-canvas .react-flow__handle:hover { transform: scale(1.3); }
`

// ── Inner component ────────────────────────────────────────────────
function PIDDiagramInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const { screenToFlowPosition } = useReactFlow()
  const counters = useRef<Partial<Record<EquipType, number>>>({})

  const [showSimModal, setShowSimModal]       = useState(false)
  const [simConfig, setSimConfig]             = useState<SimConfig>({ durationH: 1, durationM: 0, dt: 60, fluid: 'Water' })
  const [simRunning, setSimRunning]           = useState(false)
  const [simError, setSimError]               = useState<string | null>(null)
  const [simResults, setSimResults]           = useState<SimResults | null>(null)
  const [selectedResultIds, setSelectedResultIds] = useState<Set<string>>(new Set())

  const selectedNode = (() => {
    const sel = nodes.filter(n => n.selected)
    return sel.length === 1 ? sel[0] : null
  })()

  const selectedEdge = (() => {
    const sel = edges.filter(e => e.selected)
    return sel.length === 1 ? sel[0] : null
  })()

  const onConnect = useCallback(
    (conn: Connection) => setEdges(eds => addEdge({ ...conn, data: { ...PIPE_PARAM_DEFAULTS } }, eds)),
    [setEdges]
  )

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    const equipType = e.dataTransfer.getData('application/pid-equip') as EquipType
    if (!equipType || !EQUIP_PREFIX[equipType]) return
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    counters.current[equipType] = (counters.current[equipType] ?? 0) + 1
    const n = counters.current[equipType]!
    const label = `${EQUIP_PREFIX[equipType]}-${String(n).padStart(3, '0')}`
    const defaultParams = Object.fromEntries(PARAM_SCHEMAS[equipType].map(p => [p.key, p.default]))
    setNodes(nds => [...nds, {
      id: `pid-${Date.now()}`, type: 'pid', position,
      data: { label, equipType, params: defaultParams } as PIDNodeData,
    }])
  }, [screenToFlowPosition, setNodes])

  const onPipeParamChange = useCallback((edgeId: string, key: string, value: number) => {
    setEdges(eds => eds.map(e => {
      if (e.id !== edgeId) return e
      const prev = (e.data as Partial<PipeParams>) ?? {}
      return { ...e, data: { ...prev, [key]: value } }
    }))
  }, [setEdges])

  const onParamChange = useCallback((nodeId: string, key: string, value: number) => {
    setNodes(nds => nds.map(n => {
      if (n.id !== nodeId) return n
      const prev = (n.data as unknown as PIDNodeData).params ?? {}
      return { ...n, data: { ...n.data, params: { ...prev, [key]: value } } }
    }))
  }, [setNodes])

  const onClear = useCallback(() => {
    setNodes([]); setEdges([]); counters.current = {}
    setSimResults(null); setSimError(null); setSelectedResultIds(new Set())
  }, [setNodes, setEdges])

  const handleRunSim = useCallback(async (): Promise<boolean> => {
    const hasTank = nodes.some(n => (n.data as PIDNodeData).equipType === 'tank')
    if (!hasTank) {
      setSimError('シミュレーションにはタンクが少なくとも1つ必要です')
      return false
    }
    const duration = simConfig.durationH * 3600 + simConfig.durationM * 60
    if (duration <= 0) {
      setSimError('シミュレーション時間を1分以上に設定してください')
      return false
    }
    setSimRunning(true)
    setSimError(null)
    setSimResults(null)
    setSelectedResultIds(new Set())
    try {
      const res = await runSimulate({
        nodes: nodes.map(n => ({ id: n.id, data: n.data as Record<string, unknown> })),
        edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target })),
        duration, dt: simConfig.dt, fluid: simConfig.fluid,
      })
      setSimResults(res)
      return true
    } catch (e) {
      setSimError(e instanceof Error ? e.message : 'エラーが発生しました')
      return false
    } finally {
      setSimRunning(false)
    }
  }, [nodes, edges, simConfig])

  const toggleResultId = useCallback((id: string) => {
    setSelectedResultIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
  }, [])

  return (
    <>
      <style>{CANVAS_CSS}</style>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 148px)', gap: 8 }}>

        {/* ── Clock / Sim settings button ──────────────────── */}
        <div>
          <button
            onClick={() => setShowSimModal(true)}
            title="シミュレーション設定を開く"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '7px 16px', borderRadius: 8,
              background: 'white', border: '1px solid #e2e8f0',
              color: '#475569', fontSize: 12, fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => {
              const b = e.currentTarget
              b.style.background = '#eff6ff'; b.style.borderColor = '#93c5fd'; b.style.color = '#2563eb'
            }}
            onMouseLeave={e => {
              const b = e.currentTarget
              b.style.background = 'white'; b.style.borderColor = '#e2e8f0'; b.style.color = '#475569'
            }}
          >
            <ClockIcon size={14}/>
            シミュレーション設定
            {simRunning && <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 4 }}>計算中...</span>}
          </button>
        </div>

        {/* ── Main row ─────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', gap: 8, overflow: 'hidden', minHeight: 0 }}>

          {/* P&ID area */}
          <div style={{
            flex: 1, display: 'flex', overflow: 'hidden',
            borderRadius: 10, border: '1px solid #e2e8f0',
            boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
          }}>
            {/* Palette */}
            <aside style={{
              width: 190, flexShrink: 0,
              background: 'linear-gradient(180deg, #0f172a 0%, #131e31 100%)',
              padding: '16px 10px 12px',
              display: 'flex', flexDirection: 'column',
              overflowY: 'auto',
              borderRight: '1px solid #1e2d40',
            }}>
              <div style={{
                fontSize: 9, fontWeight: 800, color: '#475569',
                letterSpacing: '0.14em', textTransform: 'uppercase',
                marginBottom: 10, paddingBottom: 9, borderBottom: '1px solid #1e293b',
              }}>
                ⚙ 機器パレット
              </div>
              {EQUIP_DEFS.map(e => <PaletteItem key={e.type} {...e}/>)}
              <div style={{ flex: 1 }}/>
              <div style={{ fontSize: 9, color: '#2d3f55', lineHeight: 1.9, paddingTop: 10, borderTop: '1px solid #1e293b' }}>
                ドラッグ → 追加<br/>
                ハンドル → 接続<br/>
                ダブルクリック → 名称編集<br/>
                Delete → 削除
              </div>
            </aside>

            {/* Canvas */}
            <div className="pid-canvas" style={{ flex: 1, position: 'relative', minWidth: 0 }}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                nodeTypes={nodeTypes as any}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onDrop={onDrop}
                onDragOver={onDragOver}
                connectionMode={ConnectionMode.Loose}
                defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
                deleteKeyCode={['Backspace', 'Delete']}
                style={{ background: '#f8fafc' }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#cbd5e1"/>
                <Controls style={{ bottom: 16, left: 16 }}/>
                <MiniMap
                  nodeColor={n => ACCENT_MAP[(n.data as PIDNodeData).equipType] ?? '#94a3b8'}
                  maskColor="rgba(15,23,42,0.65)"
                  style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6 }}
                />
                <Panel position="top-right">
                  <button
                    onClick={onClear}
                    style={{
                      padding: '5px 14px', fontSize: 11, fontWeight: 600,
                      background: '#1e293b', color: '#94a3b8',
                      border: '1px solid #334155', borderRadius: 5,
                      cursor: 'pointer', letterSpacing: '0.04em',
                    }}
                    onMouseEnter={e => {
                      ;(e.currentTarget as HTMLButtonElement).style.color = '#f1f5f9'
                      ;(e.currentTarget as HTMLButtonElement).style.borderColor = '#475569'
                    }}
                    onMouseLeave={e => {
                      ;(e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'
                      ;(e.currentTarget as HTMLButtonElement).style.borderColor = '#334155'
                    }}
                  >
                    キャンバスをクリア
                  </button>
                </Panel>
                {nodes.length === 0 && (
                  <Panel position="top-center" style={{ marginTop: 80, pointerEvents: 'none' }}>
                    <div style={{
                      padding: '12px 22px',
                      background: 'rgba(15,23,42,0.7)', color: '#94a3b8',
                      fontSize: 13, borderRadius: 8, border: '1px solid #1e293b',
                      backdropFilter: 'blur(6px)',
                    }}>
                      左のパレットから機器をドラッグして追加してください
                    </div>
                  </Panel>
                )}
              </ReactFlow>
            </div>
          </div>

          {/* Right panels */}
          <div style={{ width: 250, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {selectedEdge && !selectedNode
              ? <PipeParamSection edge={selectedEdge} nodes={nodes} onParamChange={onPipeParamChange}/>
              : <ParamSection node={selectedNode} onParamChange={onParamChange}/>
            }
            <FinalResultsSection results={simResults} selectedIds={selectedResultIds} onToggle={toggleResultId}/>
          </div>
        </div>

        {/* ── Graph panel ──────────────────────────────────── */}
        {simResults && <SimResultsChart results={simResults} selectedIds={selectedResultIds}/>}
      </div>

      {/* Simulation settings modal */}
      {showSimModal && (
        <SimSettingsModal
          config={simConfig}
          setConfig={setSimConfig}
          onClose={() => { setShowSimModal(false); setSimError(null) }}
          onRun={handleRunSim}
          running={simRunning}
          error={simError}
        />
      )}
    </>
  )
}

// ── Export ────────────────────────────────────────────────────────
export default function PIDDiagram() {
  return (
    <ReactFlowProvider>
      <PIDDiagramInner/>
    </ReactFlowProvider>
  )
}
