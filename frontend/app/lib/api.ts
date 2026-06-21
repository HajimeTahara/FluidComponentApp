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
  line_type?: 'fluid' | 'power' | 'heat' | 'signal' | 'rotational'
}
export type PipeNetworkFluidSystemPayload = {
  id: string
  name: string
  fluid: string
  propertyMode: 'constant'
  density: number
  viscosity: number
  specificHeat: number
  color?: string | null
}
export type PipeNetworkPayload = {
  nodes: PipeNetworkNodePayload[]
  edges: PipeNetworkEdgePayload[]
  density: number
  viscosity: number
  fluidSystems?: PipeNetworkFluidSystemPayload[]
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
  speed_rpm?: number
  shaft_torque_nm?: number
  extracted_power_kw?: number
  output_power_kw?: number
  heat_duty_kw?: number
  UA_w_per_k?: number
  hot_Q_m3h?: number
  cold_Q_m3h?: number
  hot_dP_kpa?: number
  cold_dP_kpa?: number
  hot_T_in_K?: number
  hot_T_out_K?: number
  cold_T_in_K?: number
  cold_T_out_K?: number
  hot_capacity_w_per_k?: number
  cold_capacity_w_per_k?: number
  effectiveness?: number
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
  valve_cv?: number
  valve_effective_cv?: number
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
  fluid_systems?: Record<string, PipeNetworkFluidSystemPayload>
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

export type TransientNetworkPayload = PipeNetworkPayload & {
  duration: number
  dt: number
}

export type TransientNodeSeries = {
  pressure_kpa?: number[]
  flow_m3h?: number[]
  level_m?: number[]
  velocity_mps?: number[]
  reynolds?: number[]
  pressure_loss_kpa?: number[]
  boost_kpa?: number[]
  head_m?: number[]
  shaft_power_kw?: number[]
  speed_rpm?: number[]
  shaft_torque_nm?: number[]
  temperature_k?: number[]
  wall_temperature_k?: number[]
  heat_transfer_w?: number[]
  heat_transfer_coefficient_w_m2k?: number[]
}

export type TransientNetworkResult = {
  time: number[]
  nodes: Record<string, TransientNodeSeries>
  edges: Record<string, TransientNodeSeries>
  ports?: Record<string, Record<string, TransientNodeSeries>>
  warnings: string[]
}

export async function simulateTransientNetwork(payload: TransientNetworkPayload): Promise<TransientNetworkResult> {
  const res = await fetch(`${API_BASE}/pipe-network/transient`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail ?? '非定常ネットワーク計算に失敗しました')
  }
  return res.json()
}

// ── Launch Trajectory ──────────────────────────────────────────────
export type StageSpec = {
  propellant_mass: number
  dry_mass: number
  payload_mass: number
  oxidizer: string
  fuel: string
  thrust: number
  burn_time: number
  length_m: number
  diameter_m: number
  separation_delay_s: number
}

export type LaunchRequest = {
  stages: StageSpec[]
  payload_mass: number
  launch_angle: number
  drag_enabled: boolean
  drag_coefficient: number
  cross_section_area: number
  duration: number
  dt: number
}

export type StageBurnout = {
  stage_index: number
  time_s: number
  altitude_m: number
  speed_ms: number
  mass_kg: number
}

export type StageSeparation = {
  stage_index: number
  time_s: number
  x_m: number
  altitude_m: number
  speed_ms: number
  mass_kg: number
}

export type LaunchStats = {
  apogee_altitude_m: number
  apogee_time_s: number
  stage_burnouts: StageBurnout[]
  stage_separations: StageSeparation[]
  max_speed_ms: number
  flight_time_s: number
  downrange_m: number
  thrust_to_weight: number
  delta_v_ms: number
}

export type LaunchResult = {
  time: number[]
  x: number[]
  altitude: number[]
  vx: number[]
  vy: number[]
  speed: number[]
  mass: number[]
  landed: boolean
  stats: LaunchStats
}

export async function simulateLaunch(payload: LaunchRequest): Promise<LaunchResult> {
  const res = await fetch(`${API_BASE}/launch/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail ?? '打ち上げ計算に失敗しました')
  }
  return res.json()
}

// ── Rocket Stage Builder ─────────────────────────────────────────────
export type RocketNodePayload = {
  id: string
  node_type: string
  params: Record<string, number | string>
}
export type RocketEdgePayload = {
  id: string
  source: string
  target: string
  source_handle?: string | null
  target_handle?: string | null
  diameter_mm?: number
  length_mm?: number
  thickness_mm?: number
  material?: string | null
  density_kg_m3?: number
  propellant?: string | null
}
export type RocketFixedMassPayload = {
  id: string
  label: string
  massKg: number
  isPayload?: boolean
}
export type RocketStagePayload = {
  nodes: RocketNodePayload[]
  edges: RocketEdgePayload[]
  structure?: Record<string, number | string>
  fixed_masses?: RocketFixedMassPayload[]
}
export type RocketNodeResult = {
  mass_kg?: number
  shell_mass_kg?: number
  propellant_mass_kg?: number
  thickness_mm?: number
  mdot_kg_s?: number
  thrust_n?: number
  isp_s?: number
  mach_exit?: number
  cf?: number
}
export type RocketEdgeResult = {
  mass_kg: number
}
export type RocketStageBuildResult = {
  nodes: Record<string, RocketNodeResult>
  edges: Record<string, RocketEdgeResult>
  stage: StageSpec
}

export async function buildRocketStage(payload: RocketStagePayload): Promise<RocketStageBuildResult> {
  const res = await fetch(`${API_BASE}/rocket/stage/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail ?? '段の計算に失敗しました')
  }
  return res.json()
}

// ── Vehicle Database ────────────────────────────────────────────────
export type FairingSpec = {
  mass_kg: number
  length_m: number
  diameter_m: number
}

export type VehicleSpec = {
  name: string
  stages: StageSpec[]
  payload_mass: number
  fairing: FairingSpec
  launch_angle: number
  drag_enabled: boolean
  drag_coefficient: number
  cross_section_area: number
  note: string
}

export type Vehicle = VehicleSpec & { id: number }

async function vehicleResponse<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { detail?: string }).detail ?? fallback)
  }
  return res.json()
}

export async function fetchVehicles(): Promise<Vehicle[]> {
  const res = await fetch(`${API_BASE}/vehicles`)
  return vehicleResponse(res, '機体データベースの取得に失敗しました')
}

export async function createVehicle(payload: VehicleSpec): Promise<Vehicle> {
  const res = await fetch(`${API_BASE}/vehicles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return vehicleResponse(res, '機体の登録に失敗しました')
}

export async function deleteVehicle(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/vehicles/${id}`, { method: 'DELETE' })
  await vehicleResponse(res, '機体の削除に失敗しました')
}

// ── Parts Database ───────────────────────────────────────────────────
export type PartSpec = {
  code: string
  name: string
  category: string
  maker: string
  model: string
  note: string
  params: Record<string, string>
}

export type Part = PartSpec & { id: number }

export async function fetchParts(): Promise<Part[]> {
  const res = await fetch(`${API_BASE}/parts`)
  return vehicleResponse(res, '部品データベースの取得に失敗しました')
}

export async function createPart(payload: PartSpec): Promise<Part> {
  const res = await fetch(`${API_BASE}/parts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return vehicleResponse(res, '部品の登録に失敗しました')
}

export async function deletePart(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/parts/${id}`, { method: 'DELETE' })
  await vehicleResponse(res, '部品の削除に失敗しました')
}

// ── Material Database ──────────────────────────────────────────────
export type MaterialSpec = {
  name: string
  category: string
  density_kg_m3: number
  yield_strength_pa: number
  thermal_conductivity_w_m_k: number
  specific_heat_j_kg_k: number
  reference_temperature_k: number
  note: string
}

export type Material = MaterialSpec & { id: number }

export async function fetchMaterials(): Promise<Material[]> {
  const res = await fetch(`${API_BASE}/materials`)
  return vehicleResponse(res, '材料データベースの取得に失敗しました')
}

export async function createMaterial(payload: MaterialSpec): Promise<Material> {
  const res = await fetch(`${API_BASE}/materials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return vehicleResponse(res, '材料の登録に失敗しました')
}

export async function updateMaterial(id: number, payload: MaterialSpec): Promise<Material> {
  const res = await fetch(`${API_BASE}/materials/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return vehicleResponse(res, '材料の更新に失敗しました')
}

export async function deleteMaterial(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/materials/${id}`, { method: 'DELETE' })
  await vehicleResponse(res, '材料の削除に失敗しました')
}

// ── 流体ライブラリ（推進剤・汎用流体、材料DBとは別管理） ──────────────
export type FluidLibrarySpec = {
  name: string
  phase: string
  is_oxidizer: boolean
  is_fuel: boolean
  density_kg_m3: number
  viscosity_pa_s: number
  thermal_conductivity_w_m_k: number
  specific_heat_j_kg_k: number
  reference_temperature_k: number
  reference_pressure_pa: number
  note: string
}

export type FluidLibraryEntry = FluidLibrarySpec & { id: number }

export async function fetchFluidLibrary(): Promise<FluidLibraryEntry[]> {
  const res = await fetch(`${API_BASE}/fluid-library`)
  return vehicleResponse(res, '流体ライブラリの取得に失敗しました')
}

export async function createFluidLibraryEntry(payload: FluidLibrarySpec): Promise<FluidLibraryEntry> {
  const res = await fetch(`${API_BASE}/fluid-library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return vehicleResponse(res, '流体の登録に失敗しました')
}

export async function updateFluidLibraryEntry(id: number, payload: FluidLibrarySpec): Promise<FluidLibraryEntry> {
  const res = await fetch(`${API_BASE}/fluid-library/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return vehicleResponse(res, '流体の更新に失敗しました')
}

export async function deleteFluidLibraryEntry(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/fluid-library/${id}`, { method: 'DELETE' })
  await vehicleResponse(res, '流体の削除に失敗しました')
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
