'use client'

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
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

// ── Parameter schemas ──────────────────────────────────────────────
const PARAM_SCHEMAS: Record<EquipType, ParamDef[]> = {
  tank: [
    { key: 'height',    label: 'タンク高さ', unit: 'm',    default: 5,   min: 0.1,  step: 0.1 },
    { key: 'area',      label: '底面積',     unit: 'm²',   default: 10,  min: 0.01, step: 0.1 },
    { key: 'initLevel', label: '初期水位',   unit: 'm',    default: 2.5, min: 0,    step: 0.1 },
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

// ── SVG P&ID Symbols ───────────────────────────────────────────────
function EquipIcon({ type, size = 52 }: { type: EquipType; size?: number }) {
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
  }
}

// ── Custom Node Component ──────────────────────────────────────────
const HANDLE_STYLE: React.CSSProperties = {
  width: 10, height: 10,
  background: '#94a3b8',
  border: '2px solid #64748b',
  borderRadius: '50%',
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
      backdropFilter: 'blur(4px)',
      minWidth: 76,
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
            padding: '1px 4px', textAlign: 'center',
            background: 'white', outline: 'none',
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

// nodeTypes must be stable (defined at module level)
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

// ── Parameter Panel ────────────────────────────────────────────────
function ParamPanel({
  node,
  onParamChange,
}: {
  node: Node | null
  onParamChange: (nodeId: string, key: string, value: number) => void
}) {
  const panelStyle: React.CSSProperties = {
    width: 240, flexShrink: 0,
    background: 'white',
    borderLeft: '1px solid #e2e8f0',
    display: 'flex', flexDirection: 'column',
    overflowY: 'auto',
  }

  if (!node) {
    return (
      <aside style={{ ...panelStyle, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ textAlign: 'center', color: '#cbd5e1', lineHeight: 1.9 }}>
          <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.5 }}>⊙</div>
          <div style={{ fontSize: 11 }}>機器を選択すると<br/>パラメータが表示されます</div>
        </div>
      </aside>
    )
  }

  const { label, equipType, params = {} } = node.data as unknown as PIDNodeData
  const schema = PARAM_SCHEMAS[equipType] ?? []
  const accent = ACCENT_MAP[equipType] ?? '#475569'
  const def = EQUIP_DEFS.find(e => e.type === equipType)

  return (
    <aside style={{ ...panelStyle, padding: '20px 16px' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        marginBottom: 20, paddingBottom: 14,
        borderBottom: '1px solid #f1f5f9',
      }}>
        <div style={{ flexShrink: 0 }}>
          <EquipIcon type={equipType} size={36}/>
        </div>
        <div>
          <div style={{
            fontSize: 9, color: '#94a3b8',
            textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700,
            marginBottom: 2,
          }}>
            {def?.label}
          </div>
          <div style={{
            fontSize: 16, fontWeight: 800, color: accent,
            fontFamily: 'ui-monospace, monospace', letterSpacing: '0.04em',
          }}>
            {label}
          </div>
        </div>
      </div>

      {/* Section title */}
      <div style={{
        fontSize: 9, fontWeight: 800, color: '#94a3b8',
        letterSpacing: '0.14em', textTransform: 'uppercase',
        marginBottom: 14,
      }}>
        パラメータ
      </div>

      {/* Parameter inputs */}
      {schema.map(p => {
        const val = (params[p.key] as number | undefined) ?? p.default
        return (
          <div key={p.key} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
              <span style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>{p.label}</span>
              <span style={{
                fontSize: 10, color: '#94a3b8',
                fontFamily: 'ui-monospace, monospace',
                background: '#f1f5f9', padding: '1px 5px', borderRadius: 3,
              }}>
                {p.unit}
              </span>
            </div>
            <input
              type="number"
              value={val}
              min={p.min}
              max={p.max}
              step={p.step}
              onChange={e => {
                const v = parseFloat(e.target.value)
                if (!isNaN(v)) onParamChange(node.id, p.key, v)
              }}
              style={{
                width: '100%', padding: '7px 10px',
                border: `1.5px solid ${accent}33`,
                borderRadius: 6, fontSize: 13,
                fontFamily: 'ui-monospace, monospace',
                color: '#0f172a', fontWeight: 600,
                outline: 'none', background: '#fafafa',
                transition: 'border-color 0.15s, box-shadow 0.15s',
                boxSizing: 'border-box',
              }}
              onFocus={e => {
                e.currentTarget.style.borderColor = accent
                e.currentTarget.style.boxShadow = `0 0 0 3px ${accent}22`
              }}
              onBlur={e => {
                e.currentTarget.style.borderColor = `${accent}33`
                e.currentTarget.style.boxShadow = 'none'
              }}
            />
          </div>
        )
      })}
    </aside>
  )
}

// ── Scoped CSS for edge selection ──────────────────────────────────
const CANVAS_CSS = `
.pid-canvas .react-flow__edge-path {
  stroke: #64748b;
  stroke-width: 2.5px;
}
.pid-canvas .react-flow__edge.selected .react-flow__edge-path {
  stroke: #2563eb;
  stroke-width: 3px;
}
.pid-canvas .react-flow__edge:hover .react-flow__edge-path {
  stroke: #475569;
  stroke-width: 3px;
}
.pid-canvas .react-flow__handle:hover {
  transform: scale(1.3);
}
`

// ── Inner component (requires ReactFlowProvider) ───────────────────
function PIDDiagramInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const { screenToFlowPosition } = useReactFlow()
  const counters = useRef<Partial<Record<EquipType, number>>>({})

  // Compute selected node (single selection only)
  const selectedNodes = nodes.filter(n => n.selected)
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null

  const onConnect = useCallback(
    (conn: Connection) => setEdges(eds => addEdge(conn, eds)),
    [setEdges]
  )

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    const equipType = e.dataTransfer.getData('application/pid-equip') as EquipType
    if (!equipType || !EQUIP_PREFIX[equipType]) return
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    counters.current[equipType] = (counters.current[equipType] ?? 0) + 1
    const n = counters.current[equipType]!
    const label = `${EQUIP_PREFIX[equipType]}-${String(n).padStart(3, '0')}`
    const defaultParams = Object.fromEntries(
      PARAM_SCHEMAS[equipType].map(p => [p.key, p.default])
    )
    setNodes(nds => [...nds, {
      id: `pid-${Date.now()}`,
      type: 'pid',
      position,
      data: { label, equipType, params: defaultParams } as PIDNodeData,
    }])
  }, [screenToFlowPosition, setNodes])

  const onParamChange = useCallback((nodeId: string, key: string, value: number) => {
    setNodes(nds => nds.map(n => {
      if (n.id !== nodeId) return n
      const prev = (n.data as unknown as PIDNodeData).params ?? {}
      return { ...n, data: { ...n.data, params: { ...prev, [key]: value } } }
    }))
  }, [setNodes])

  const onClear = useCallback(() => {
    setNodes([]); setEdges([]); counters.current = {}
  }, [setNodes, setEdges])

  return (
    <>
      <style>{CANVAS_CSS}</style>
      <div style={{
        display: 'flex',
        height: 'calc(100vh - 148px)',
        overflow: 'hidden',
        borderRadius: 10,
        border: '1px solid #e2e8f0',
        boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
      }}>
        {/* ── Palette ─────────────────────────────────────── */}
        <aside style={{
          width: 200, flexShrink: 0,
          background: 'linear-gradient(180deg, #0f172a 0%, #131e31 100%)',
          padding: '18px 10px 14px',
          display: 'flex', flexDirection: 'column',
          overflowY: 'auto',
          borderRight: '1px solid #1e2d40',
        }}>
          <div style={{
            fontSize: 9, fontWeight: 800, color: '#475569',
            letterSpacing: '0.14em', textTransform: 'uppercase',
            marginBottom: 12, paddingBottom: 9, borderBottom: '1px solid #1e293b',
          }}>
            ⚙ 機器パレット
          </div>

          {EQUIP_DEFS.map(e => <PaletteItem key={e.type} {...e}/>)}

          <div style={{ flex: 1 }}/>
          <div style={{
            fontSize: 9, color: '#2d3f55', lineHeight: 1.9,
            paddingTop: 10, borderTop: '1px solid #1e293b',
          }}>
            ドラッグ → キャンバスに追加<br/>
            ハンドル → 配管で接続<br/>
            配管をクリック → 選択<br/>
            ダブルクリック → 名称編集<br/>
            Delete → 削除
          </div>
        </aside>

        {/* ── Canvas ──────────────────────────────────────── */}
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
                  transition: 'color 0.15s, border-color 0.15s',
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
                  backdropFilter: 'blur(6px)', letterSpacing: '0.02em',
                }}>
                  左のパレットから機器をドラッグしてキャンバスに追加してください
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>

        {/* ── Parameter Panel ─────────────────────────────── */}
        <ParamPanel node={selectedNode} onParamChange={onParamChange}/>
      </div>
    </>
  )
}

// ── Export (wrapped in ReactFlowProvider) ─────────────────────────
export default function PIDDiagram() {
  return (
    <ReactFlowProvider>
      <PIDDiagramInner/>
    </ReactFlowProvider>
  )
}
