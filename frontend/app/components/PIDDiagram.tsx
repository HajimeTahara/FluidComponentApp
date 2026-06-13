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
type EquipType = 'tank' | 'pump' | 'valve' | 'heatExchanger' | 'compressor' | 'separator'

interface PIDNodeData extends Record<string, unknown> {
  label: string
  equipType: EquipType
}

// ── Equipment definitions ──────────────────────────────────────────
const EQUIP_DEFS = [
  { type: 'tank'          as EquipType, label: 'タンク',     desc: '貯槽・容器',      accent: '#2563eb' },
  { type: 'pump'          as EquipType, label: 'ポンプ',     desc: '遠心ポンプ',      accent: '#7c3aed' },
  { type: 'valve'         as EquipType, label: 'バルブ',     desc: '調節弁・遮断弁',  accent: '#d97706' },
  { type: 'heatExchanger' as EquipType, label: '熱交換器',   desc: 'シェル&チューブ', accent: '#dc2626' },
  { type: 'compressor'    as EquipType, label: '圧縮機',     desc: 'コンプレッサー',  accent: '#059669' },
  { type: 'separator'     as EquipType, label: 'セパレータ', desc: '気液分離器',      accent: '#0891b2' },
]

const ACCENT_MAP: Record<EquipType, string> = Object.fromEntries(
  EQUIP_DEFS.map(e => [e.type, e.accent])
) as Record<EquipType, string>

const EQUIP_PREFIX: Record<EquipType, string> = {
  tank: 'T', pump: 'P', valve: 'V', heatExchanger: 'E', compressor: 'C', separator: 'D',
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
    case 'compressor':
      return (
        <svg width={size} height={size} viewBox="0 0 52 52" fill="none">
          <circle cx="26" cy="26" r="20" fill="#d1fae5" stroke="#059669" strokeWidth="1.5"/>
          <polygon points="10,40 10,12 42,26" fill="#a7f3d0" stroke="#059669" strokeWidth="1.5"/>
          <line x1="42" y1="26" x2="48" y2="26" stroke="#059669" strokeWidth="1.5"/>
        </svg>
      )
    case 'separator':
      return (
        <svg width={size} height={Math.round(size * 1.5)} viewBox="0 0 52 78" fill="none">
          <rect x="10" y="14" width="32" height="50" fill="#cffafe" stroke="#0891b2" strokeWidth="1.5"/>
          <ellipse cx="26" cy="14" rx="16" ry="7" fill="#a5f3fc" stroke="#0891b2" strokeWidth="1.5"/>
          <ellipse cx="26" cy="64" rx="16" ry="7" fill="#a5f3fc" stroke="#0891b2" strokeWidth="1.5"/>
          <line x1="11" y1="39" x2="41" y2="39" stroke="#0891b2" strokeWidth="1" strokeDasharray="4,3"/>
          <text x="15" y="34" fontSize="8" fill="#0891b2" fontFamily="monospace">GAS</text>
          <text x="12" y="58" fontSize="8" fill="#0891b2" fontFamily="monospace">LIQ.</text>
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
  transition: 'background 0.15s, border-color 0.15s',
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
      padding: '10px 14px',
      borderRadius: 10,
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
          autoFocus
          value={editValue}
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
            border: `1.5px solid ${accent}`,
            borderRadius: 4, padding: '1px 4px', textAlign: 'center',
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
  style: { stroke: '#475569', strokeWidth: 2.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: '#475569', width: 14, height: 14 },
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

// ── Inner component (requires ReactFlowProvider context) ───────────
function PIDDiagramInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PIDNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const { screenToFlowPosition } = useReactFlow()
  const counters = useRef<Partial<Record<EquipType, number>>>({})

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
    setNodes(nds => [...nds, {
      id: `pid-${Date.now()}`,
      type: 'pid',
      position,
      data: { label, equipType },
    }])
  }, [screenToFlowPosition, setNodes])

  const onClear = useCallback(() => {
    setNodes([]); setEdges([]); counters.current = {}
  }, [setNodes, setEdges])

  return (
    <div style={{
      display: 'flex',
      height: 'calc(100vh - 148px)',
      overflow: 'hidden',
      borderRadius: 10,
      border: '1px solid #e2e8f0',
      boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
    }}>
      {/* ── Palette ─────────────────────────────────────────── */}
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
          marginBottom: 12, paddingBottom: 9,
          borderBottom: '1px solid #1e293b',
        }}>
          ⚙ 機器パレット
        </div>

        {EQUIP_DEFS.map(e => <PaletteItem key={e.type} {...e}/>)}

        <div style={{ flex: 1 }}/>

        <div style={{
          fontSize: 9, color: '#2d3f55', lineHeight: 1.8,
          paddingTop: 10, borderTop: '1px solid #1e293b',
        }}>
          ドラッグ → キャンバスに追加<br/>
          ハンドル → 配管で接続<br/>
          ダブルクリック → 名称編集<br/>
          Delete → 選択項目を削除
        </div>
      </aside>

      {/* ── Canvas ──────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', background: '#f8fafc' }}>
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
            style={{
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: 6,
            }}
          />

          {/* Toolbar */}
          <Panel position="top-right">
            <div style={{ display: 'flex', gap: 6 }}>
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
            </div>
          </Panel>

          {/* Empty state */}
          {nodes.length === 0 && (
            <Panel position="top-center" style={{ marginTop: 80, pointerEvents: 'none' }}>
              <div style={{
                padding: '12px 22px',
                background: 'rgba(15,23,42,0.7)',
                color: '#94a3b8', fontSize: 13,
                borderRadius: 8, border: '1px solid #1e293b',
                backdropFilter: 'blur(6px)',
                letterSpacing: '0.02em',
              }}>
                左のパレットから機器をドラッグしてキャンバスに追加してください
              </div>
            </Panel>
          )}
        </ReactFlow>
      </div>
    </div>
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
