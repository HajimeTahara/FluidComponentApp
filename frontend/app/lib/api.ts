const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

export type SatPoint = { T: number; P: number; H: number; S: number; D: number }
export type SaturationData = { fluid: string; liquid: SatPoint[]; vapor: SatPoint[] }
export type IsoTLine = { T: number; points: { H: number; P: number }[] }
export type IsoSLine = { S: number; points: { H: number; P: number }[] }
export type PHDiagramData = { fluid: string; iso_T: IsoTLine[]; iso_S: IsoSLine[] }
export type Properties = {
  fluid: string
  T: number
  P: number
  D: number | null
  H: number | null
  S: number | null
  C: number | null
  V: number | null
  L: number | null
  // P₀における飽和特性
  T_sat_at_P: number | null
  D_sat_liq_at_P: number | null
  D_sat_vap_at_P: number | null
  H_sat_liq_at_P: number | null
  H_sat_vap_at_P: number | null
  latent_heat_at_P: number | null
  // T₀における飽和蒸気圧
  P_sat_at_T: number | null
  D_sat_liq_at_T: number | null
  D_sat_vap_at_T: number | null
  H_sat_liq_at_T: number | null
  H_sat_vap_at_T: number | null
  latent_heat_at_T: number | null
  // 臨界点
  T_crit: number
  P_crit: number
  D_crit: number
  // 三重点
  T_triple: number
  P_triple: number
}

export async function fetchFluids(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/fluids`)
  const data = await res.json()
  return data.fluids as string[]
}

export async function fetchSaturation(fluid: string): Promise<SaturationData> {
  const res = await fetch(`${API_BASE}/fluids/${encodeURIComponent(fluid)}/saturation`)
  if (!res.ok) throw new Error(`飽和データの取得に失敗しました: ${fluid}`)
  return res.json()
}

export async function fetchPHDiagram(fluid: string): Promise<PHDiagramData> {
  const res = await fetch(`${API_BASE}/fluids/${encodeURIComponent(fluid)}/ph-diagram`)
  if (!res.ok) throw new Error(`pH線図データの取得に失敗しました: ${fluid}`)
  return res.json()
}

export async function fetchProperties(
  fluid: string,
  T: number,
  P: number,
): Promise<Properties> {
  const url = `${API_BASE}/fluids/${encodeURIComponent(fluid)}/properties?T=${T}&P=${P}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`物性値の取得に失敗しました: ${fluid}`)
  return res.json()
}

export type StateFromHP = {
  T: number | null
  D: number | null
  S: number | null
  Q: number | null
}

export async function fetchStateFromHP(
  fluid: string,
  H_Jkg: number,
  P_Pa: number,
): Promise<StateFromHP> {
  const url = `${API_BASE}/fluids/${encodeURIComponent(fluid)}/state?H=${H_Jkg}&P=${P_Pa}`
  const res = await fetch(url)
  if (!res.ok) throw new Error('状態量の取得に失敗しました')
  return res.json()
}

export function saturationCSVUrl(fluid: string): string {
  return `${API_BASE}/fluids/${encodeURIComponent(fluid)}/saturation/csv`
}

// ── Simulation ────────────────────────────────────────────────────
export type SimNode = { id: string; data: Record<string, unknown> }
export type SimEdge = { id: string; source: string; target: string }

export type TankResult = {
  label: string
  equipType: 'tank'
  level: number[]
  volume: number[]
  area: number
  height: number
}
export type EquipResult = { label: string; equipType: string; flowRate: number[] }
export type SimResults = {
  time: number[]
  results: Record<string, TankResult | EquipResult>
  fluid: string
  rho: number
}

// ── Pressure Drop Calculation ────────────────────────────────────
export type PressureDropRequest = {
  pipe_type: 'circular' | 'rectangular' | 'annulus'
  diameter?: number
  width?: number
  duct_height?: number
  outer_diameter?: number
  inner_diameter?: number
  length: number
  roughness: number
  density: number
  viscosity: number
  friction_method: 'colebrook' | 'blasius'
  flow_rate_min: number
  flow_rate_max: number
  points?: number
}

export type PressureDropResult = {
  flow_rates: number[]
  velocities: number[]
  reynolds: number[]
  friction_factors: number[]
  pressure_drops: number[]
  regimes: string[]
  hydraulic_diameter_mm: number
  cross_section_area_mm2: number
  q_lam_turb: [number, number]
}

export async function calcPressureDrop(payload: PressureDropRequest): Promise<PressureDropResult> {
  const res = await fetch(`${API_BASE}/pressure-drop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail ?? '圧損計算に失敗しました')
  }
  return res.json()
}

// ── Pipe Network Calculation ──────────────────────────────────────
export type PipeNetworkNodePayload = {
  id: string
  node_type: string
  params: Record<string, unknown>
}
export type PipeNetworkEdgePayload = {
  id: string
  source: string
  target: string
  source_handle: string | null
  target_handle: string | null
}
export type PipeNetworkPayload = {
  nodes: PipeNetworkNodePayload[]
  edges: PipeNetworkEdgePayload[]
  density: number
  viscosity: number
  friction_method?: string  // global fallback; per-pipe frictionMethod in params takes precedence
}
export type PipeSegmentResult = {
  Q_m3h: number
  v: number
  Re: number
  f: number
  dP_kpa: number
  boost_kpa?: number
  head_m?: number
  hydraulic_power_kw?: number
  shaft_power_kw?: number
  heat_duty_kw?: number
  UA_w_per_k?: number
  exchange_temperature_K?: number
  heat_transfer_coeff_w_m2_k?: number
  heat_transfer_area_m2?: number
  rated_flow_m3h?: number
  nominal_pressure_drop_kpa?: number
  diameter_in_mm?: number
  diameter_out_mm?: number
  upstream_diameter_mm?: number
  downstream_diameter_mm?: number
  loss_coefficient?: number
  loss_mode?: string
  reducer_kind?: string
  diameter_mm?: number
  angle_deg?: number
  zeta90?: number
  valve_zeta_full_open?: number
  valve_opening_percent?: number
  valve_relative_capacity?: number
  valve_characteristic?: string
  valve_rangeability?: number
  regime: string
  Q1_m3h?: number  // tee: flow to first outlet (regime === 'split')
  Q2_m3h?: number  // tee: flow to second outlet
  P_kpa?: number   // boundary/sink/tee node pressure kPa
  P_from_kpa?: number
  P_to_kpa?: number
  P_in_kpa?: number
  P_out_kpa?: number
  T_K?: number
  T_in_K?: number
  T_out_K?: number
}
export type PipeNetworkResult = {
  nodes: Record<string, PipeSegmentResult>
  source_pressures: Record<string, number>  // boundary/source pressure kPa
  source_flows: Record<string, number>      // boundary/source flow m³/h
  source_temperatures?: Record<string, number>  // boundary/source temperature K
  boundary_temperatures?: Record<string, number> // defined boundary temperatures K
}

export async function calcPipeNetwork(payload: PipeNetworkPayload): Promise<PipeNetworkResult> {
  const res = await fetch(`${API_BASE}/pipe-network`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail ?? 'ネットワーク圧損計算に失敗しました')
  }
  return res.json()
}

export async function runSimulate(payload: {
  nodes: SimNode[]
  edges: SimEdge[]
  duration: number
  dt: number
  fluid: string
}): Promise<SimResults> {
  const res = await fetch(`${API_BASE}/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail ?? 'シミュレーションに失敗しました')
  }
  return res.json()
}
