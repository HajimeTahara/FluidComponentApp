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
  H_sat_liq_at_P: number | null
  H_sat_vap_at_P: number | null
  latent_heat_at_P: number | null
  // T₀における飽和蒸気圧
  P_sat_at_T: number | null
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
