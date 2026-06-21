// 酸化剤・燃料の組み合わせと、その理論（化学量論）混合比 O/F（質量比）。
// LOX/LH2:  2 H2 + O2 -> 2 H2O
// LOX/LCH4: CH4 + 2 O2 -> CO2 + 2 H2O
// LOX/RP-1: C12H26 + 18.5 O2 -> 12 CO2 + 13 H2O（RP-1をC12H26で近似）
// NTO/MMH:  文献値（出典: Sutton, "Rocket Propulsion Elements"）

export const OXIDIZER_OPTIONS = [
  { value: 'LOX', label: '液体酸素 LOX' },
  { value: 'NTO', label: '四酸化二窒素 NTO' },
]

export const FUEL_OPTIONS_BY_OXIDIZER: Record<string, { value: string; label: string; ratio: number }[]> = {
  LOX: [
    { value: 'LCH4', label: '液化メタン LCH4', ratio: 4.00 },
    { value: 'LH2', label: '液体水素 LH2', ratio: 8.00 },
    { value: 'RP-1', label: 'RP-1（ケロシン）', ratio: 3.48 },
  ],
  NTO: [
    { value: 'MMH', label: 'モノメチルヒドラジン MMH', ratio: 2.67 },
  ],
}

// 配管（エッジ）1本は酸化剤・燃料いずれか一種類の推進剤のみを運ぶため、
// 酸化剤・燃料を一つのリストにまとめた選択肢（配管の「推進剤」パラメータ用）。
const ALL_FUELS = Object.values(FUEL_OPTIONS_BY_OXIDIZER).flat()
const UNIQUE_FUELS = [...new Map(ALL_FUELS.map(f => [f.value, f])).values()]

export const PROPELLANT_OPTIONS: { value: string; label: string; role: 'oxidizer' | 'fuel' }[] = [
  ...OXIDIZER_OPTIONS.map(o => ({ ...o, role: 'oxidizer' as const })),
  ...UNIQUE_FUELS.map(f => ({ value: f.value, label: f.label, role: 'fuel' as const })),
]
