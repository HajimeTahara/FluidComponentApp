from collections import defaultdict
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any
import CoolProp.CoolProp as CP
import numpy as np
import pandas as pd
from scipy.integrate import solve_ivp
from scipy.optimize import brentq
import io

app = FastAPI(title="Fluid Properties API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPPORTED_FLUIDS = [
    "Methane", "Nitrogen", "Oxygen", "Hydrogen", "CarbonDioxide",
    "Propane", "Water", "Ammonia", "R134a", "Ethane",
]

PROPS = {
    "T": "温度 [K]",
    "P": "圧力 [Pa]",
    "D": "密度 [kg/m³]",
    "H": "比エンタルピー [J/kg]",
    "S": "比エントロピー [J/kg/K]",
    "C": "定圧比熱 [J/kg/K]",
    "V": "粘度 [Pa·s]",
    "L": "熱伝導率 [W/m/K]",
}


@app.get("/fluids")
def list_fluids():
    return {"fluids": SUPPORTED_FLUIDS}


@app.get("/fluids/{fluid}/critical")
def get_critical_point(fluid: str):
    if fluid not in SUPPORTED_FLUIDS:
        raise HTTPException(status_code=404, detail=f"Fluid '{fluid}' not supported")
    return {
        "T_critical": CP.PropsSI("Tcrit", fluid),
        "P_critical": CP.PropsSI("Pcrit", fluid),
        "D_critical": CP.PropsSI("rhocrit", fluid),
    }


@app.get("/fluids/{fluid}/saturation")
def get_saturation_curve(fluid: str, points: int = 200):
    """飽和蒸気圧曲線（液相・気相）のデータを返す"""
    if fluid not in SUPPORTED_FLUIDS:
        raise HTTPException(status_code=404, detail=f"Fluid '{fluid}' not supported")

    T_min = CP.PropsSI("Tmin", fluid) + 1
    T_crit = CP.PropsSI("Tcrit", fluid)
    temps = np.linspace(T_min, T_crit * 0.999, points)

    liquid, vapor = [], []
    for T in temps:
        try:
            P = CP.PropsSI("P", "T", T, "Q", 0, fluid)
            H_liq = CP.PropsSI("H", "T", T, "Q", 0, fluid)
            H_vap = CP.PropsSI("H", "T", T, "Q", 1, fluid)
            S_liq = CP.PropsSI("S", "T", T, "Q", 0, fluid)
            S_vap = CP.PropsSI("S", "T", T, "Q", 1, fluid)
            D_liq = CP.PropsSI("D", "T", T, "Q", 0, fluid)
            D_vap = CP.PropsSI("D", "T", T, "Q", 1, fluid)
            liquid.append({"T": T, "P": P, "H": H_liq, "S": S_liq, "D": D_liq})
            vapor.append({"T": T, "P": P, "H": H_vap, "S": S_vap, "D": D_vap})
        except Exception:
            continue

    return {"fluid": fluid, "liquid": liquid, "vapor": vapor}


@app.get("/fluids/{fluid}/ph-diagram")
def get_ph_diagram(
    fluid: str,
    iso_T_count: int = Query(default=8, ge=2, le=20),
    iso_S_count: int = Query(default=6, ge=2, le=20),
):
    """pH線図用データ（等温線・等エントロピー線）を返す"""
    if fluid not in SUPPORTED_FLUIDS:
        raise HTTPException(status_code=404, detail=f"Fluid '{fluid}' not supported")

    T_trip = CP.PropsSI("Tmin", fluid) + 1
    T_crit = CP.PropsSI("Tcrit", fluid)
    T_max  = T_crit * 2.0
    P_crit = CP.PropsSI("Pcrit", fluid)

    # 三重点付近の飽和圧力を下限に使う（極低圧を避ける）
    P_trip = CP.PropsSI("P", "T", T_trip, "Q", 0, fluid)
    P_min  = max(P_trip * 0.5, 1e3)   # 少なくとも 1 kPa
    P_max  = P_crit * 8.0
    P_points = np.logspace(np.log10(P_min), np.log10(P_max), 120)

    def is_valid(v: float) -> bool:
        return np.isfinite(v)

    iso_T_lines = []
    for T in np.linspace(T_trip, T_max, iso_T_count):
        line = []
        for P in P_points:
            try:
                H = CP.PropsSI("H", "T", T, "P", P, fluid)
                if is_valid(H):
                    line.append({"H": round(H, 2), "P": round(float(P), 4)})
            except Exception:
                continue
        if len(line) >= 2:
            iso_T_lines.append({"T": round(T, 2), "points": line})

    # エントロピー範囲を飽和線から取得
    S_liq_trip = CP.PropsSI("S", "T", T_trip, "Q", 0, fluid)
    S_vap_crit = CP.PropsSI("S", "T", T_crit * 0.999, "Q", 1, fluid)
    iso_S_lines = []
    for S in np.linspace(S_liq_trip, S_vap_crit, iso_S_count):
        line = []
        for P in P_points:
            try:
                H = CP.PropsSI("H", "S", S, "P", P, fluid)
                if is_valid(H):
                    line.append({"H": round(H, 2), "P": round(float(P), 4)})
            except Exception:
                continue
        if len(line) >= 2:
            iso_S_lines.append({"S": round(S, 4), "points": line})

    return {
        "fluid": fluid,
        "iso_T": iso_T_lines,
        "iso_S": iso_S_lines,
    }


@app.get("/fluids/{fluid}/properties")
def get_properties(
    fluid: str,
    T: float = Query(..., description="温度 [K]"),
    P: float = Query(..., description="圧力 [Pa]"),
):
    """指定した温度・圧力での物性値を返す"""
    if fluid not in SUPPORTED_FLUIDS:
        raise HTTPException(status_code=404, detail=f"Fluid '{fluid}' not supported")

    result: dict = {"fluid": fluid, "T": T, "P": P}

    # T, P での物性値
    for key in ["D", "H", "S", "C", "V", "L"]:
        try:
            result[key] = CP.PropsSI(key, "T", T, "P", P, fluid)
        except Exception:
            result[key] = None

    # P₀ における飽和特性
    try:
        T_sat = CP.PropsSI("T", "P", P, "Q", 0, fluid)
        H_liq = CP.PropsSI("H", "P", P, "Q", 0, fluid)
        H_vap = CP.PropsSI("H", "P", P, "Q", 1, fluid)
        result["T_sat_at_P"] = T_sat
        result["H_sat_liq_at_P"] = H_liq
        result["H_sat_vap_at_P"] = H_vap
        result["latent_heat_at_P"] = H_vap - H_liq
    except Exception:
        result["T_sat_at_P"] = None
        result["H_sat_liq_at_P"] = None
        result["H_sat_vap_at_P"] = None
        result["latent_heat_at_P"] = None

    # T₀ における飽和蒸気圧
    try:
        result["P_sat_at_T"] = CP.PropsSI("P", "T", T, "Q", 0, fluid)
    except Exception:
        result["P_sat_at_T"] = None

    # 臨界点
    result["T_crit"] = CP.PropsSI("Tcrit", fluid)
    result["P_crit"] = CP.PropsSI("Pcrit", fluid)
    result["D_crit"] = CP.PropsSI("rhocrit", fluid)

    # 三重点
    result["T_triple"] = CP.PropsSI("Ttriple", fluid)
    result["P_triple"] = CP.PropsSI("ptriple", fluid)

    return result


@app.get("/fluids/{fluid}/state")
def get_state_from_hp(
    fluid: str,
    H: float = Query(..., description="比エンタルピー [J/kg]"),
    P: float = Query(..., description="圧力 [Pa]"),
):
    """エンタルピー・圧力から状態量を返す（pV線図用）"""
    if fluid not in SUPPORTED_FLUIDS:
        raise HTTPException(status_code=404, detail=f"Fluid '{fluid}' not supported")
    result: dict = {"fluid": fluid, "H": H, "P": P}
    for key in ["T", "D", "S", "Q"]:
        try:
            val = CP.PropsSI(key, "H", H, "P", P, fluid)
            result[key] = val if np.isfinite(val) else None
        except Exception:
            result[key] = None
    return result


class SimNode(BaseModel):
    id: str
    data: dict[str, Any]

class SimEdge(BaseModel):
    id: str
    source: str
    target: str

class SimRequest(BaseModel):
    nodes: list[SimNode]
    edges: list[SimEdge]
    duration: float = 3600.0
    dt: float = 60.0
    fluid: str = "Water"


@app.post("/simulate")
def simulate(req: SimRequest):
    """P&ID グラフをもとに液位・流量の時間発展をシミュレーションする"""
    if req.fluid not in SUPPORTED_FLUIDS:
        raise HTTPException(status_code=400, detail=f"Fluid '{req.fluid}' not supported")

    # 流体密度（常温常圧）
    try:
        rho = CP.PropsSI("D", "T", 293.15, "P", 101325.0, req.fluid)
    except Exception:
        rho = 1000.0
    g = 9.81

    nodes_dict: dict[str, SimNode] = {n.id: n for n in req.nodes}

    def get_type(nid: str) -> str:
        n = nodes_dict.get(nid)
        return (n.data.get("equipType", "unknown") if n else "unknown")

    def get_params(nid: str) -> dict:
        n = nodes_dict.get(nid)
        return (n.data.get("params", {}) if n else {})

    # タンクを抽出して状態変数インデックスを確定
    tank_nodes = [n for n in req.nodes if n.data.get("equipType") == "tank"]
    if not tank_nodes:
        raise HTTPException(status_code=400, detail="シミュレーションにはタンクが少なくとも1つ必要です")

    tank_ids = [n.id for n in tank_nodes]
    tank_idx = {tid: i for i, tid in enumerate(tank_ids)}

    areas   = [float(n.data.get("params", {}).get("area",      10.0)) for n in tank_nodes]
    heights = [float(n.data.get("params", {}).get("height",     5.0)) for n in tank_nodes]
    h0      = [float(n.data.get("params", {}).get("initLevel",  2.5)) for n in tank_nodes]

    # 隣接リスト
    outgoing: dict[str, list[str]] = {n.id: [] for n in req.nodes}
    incoming: dict[str, list[str]] = {n.id: [] for n in req.nodes}
    for e in req.edges:
        if e.source in outgoing:
            outgoing[e.source].append(e.target)
        if e.target in incoming:
            incoming[e.target].append(e.source)

    def trace_tanks(nid: str, follow_outgoing: bool, depth: int = 0) -> list[str]:
        """再帰的に上流または下流のタンクを探す"""
        if depth > 12:
            return []
        if get_type(nid) == "tank":
            return [nid]
        nexts = outgoing[nid] if follow_outgoing else incoming.get(nid, [])
        result: list[str] = []
        for nxt in nexts:
            result.extend(trace_tanks(nxt, follow_outgoing, depth + 1))
        return result

    # フローセグメントを構築
    flow_segments: list[dict] = []

    # タンク直結エッジ
    for e in req.edges:
        if get_type(e.source) == "tank" and get_type(e.target) == "tank":
            flow_segments.append({
                "equip_id": None, "equip_type": "direct",
                "equip_params": {}, "upstream": e.source, "downstream": e.target,
            })

    # 非タンク機器を経由するフロー
    for n in req.nodes:
        eq_type = n.data.get("equipType")
        if eq_type == "tank":
            continue
        ups   = trace_tanks(n.id, follow_outgoing=False)
        downs = trace_tanks(n.id, follow_outgoing=True)
        for up in ups:
            for down in downs:
                if up == down:
                    continue
                flow_segments.append({
                    "equip_id": n.id, "equip_type": eq_type,
                    "equip_params": n.data.get("params", {}),
                    "upstream": up, "downstream": down,
                })

    # 重複排除
    seen: set[tuple] = set()
    unique_segs: list[dict] = []
    for s in flow_segments:
        key = (s["equip_id"], s["upstream"], s["downstream"])
        if key not in seen:
            seen.add(key)
            unique_segs.append(s)
    flow_segments = unique_segs

    def compute_flow(seg: dict, h: list[float]) -> float:
        """m³/s 単位の体積流量を返す"""
        eq_type = seg["equip_type"]
        params  = seg["equip_params"]
        up_id   = seg["upstream"]
        down_id = seg["downstream"]

        h_up   = h[tank_idx[up_id]]   if up_id   in tank_idx else 0.0
        h_down = h[tank_idx[down_id]] if down_id in tank_idx else 0.0

        if h_up <= 1e-6:
            return 0.0

        dH = max(0.0, h_up - h_down)

        if eq_type == "pump":
            q_m3h = float(params.get("flowRate", 50.0))
            return q_m3h / 3600.0

        elif eq_type == "valve":
            cv      = float(params.get("cv", 10.0))
            opening = float(params.get("opening", 100.0))
            if cv <= 0 or opening <= 0 or dH <= 0:
                return 0.0
            dp_bar = rho * g * dH / 1e5
            sg     = rho / 1000.0
            q_m3h  = cv * (opening / 100.0) * np.sqrt(dp_bar / sg)
            return q_m3h / 3600.0

        elif eq_type == "heatExchanger":
            rated  = float(params.get("flowRate", 30.0))
            if dH <= 0:
                return 0.0
            dp_bar  = rho * g * dH / 1e5
            sg      = rho / 1000.0
            cv_eq   = 20.0
            q_m3h   = min(rated, cv_eq * np.sqrt(max(0.0, dp_bar / sg)))
            return q_m3h / 3600.0

        else:  # direct tank-to-tank
            if dH <= 0:
                return 0.0
            dp_bar = rho * g * dH / 1e5
            sg     = rho / 1000.0
            q_m3h  = 5.0 * np.sqrt(max(0.0, dp_bar / sg))
            return q_m3h / 3600.0

    def ode(t: float, h: list[float]) -> list[float]:
        dh = [0.0] * len(tank_ids)
        for seg in flow_segments:
            Q   = compute_flow(seg, h)
            up  = seg["upstream"]
            dn  = seg["downstream"]
            if up in tank_idx:
                i = tank_idx[up]
                dh[i] -= Q / areas[i]
            if dn in tank_idx:
                j = tank_idx[dn]
                dh[j] += Q / areas[j]
        # 液位の上下限でフラックスをゼロに
        for i, (hi, h_max) in enumerate(zip(h, heights)):
            if hi <= 0 and dh[i] < 0:
                dh[i] = 0.0
            if hi >= h_max and dh[i] > 0:
                dh[i] = 0.0
        return dh

    t_eval = np.arange(0, req.duration + req.dt, req.dt)
    try:
        sol = solve_ivp(
            ode, (0.0, req.duration), h0,
            t_eval=t_eval, method="RK45",
            max_step=req.dt, rtol=1e-4, atol=1e-6,
        )
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"計算エラー: {ex}")

    if not sol.success:
        raise HTTPException(status_code=500, detail=f"ODE 未収束: {sol.message}")

    # タンク結果
    results: dict[str, Any] = {}
    for i, t_node in enumerate(tank_nodes):
        levels  = np.clip(sol.y[i], 0.0, heights[i]).tolist()
        volumes = [lv * areas[i] for lv in levels]
        results[t_node.id] = {
            "label":     t_node.data.get("label", t_node.id),
            "equipType": "tank",
            "level":     levels,
            "volume":    volumes,
            "area":      areas[i],
            "height":    heights[i],
        }

    # 非タンク機器の流量
    for n in req.nodes:
        if n.data.get("equipType") == "tank":
            continue
        flows = []
        for k in range(len(sol.t)):
            h_k = [sol.y[i][k] for i in range(len(tank_ids))]
            q_total = sum(
                compute_flow(seg, h_k) * 3600
                for seg in flow_segments
                if seg["equip_id"] == n.id
            )
            flows.append(round(q_total, 4))
        results[n.id] = {
            "label":     n.data.get("label", n.id),
            "equipType": n.data.get("equipType"),
            "flowRate":  flows,
        }

    return {"time": sol.t.tolist(), "results": results, "fluid": req.fluid, "rho": rho}


class PressureDropRequest(BaseModel):
    pipe_type: str = "circular"
    diameter: float = 0.1          # [m] 円管内径
    width: float = 0.1             # [m] 矩形管幅
    duct_height: float = 0.05      # [m] 矩形管高さ
    outer_diameter: float = 0.1    # [m] 環状管外径
    inner_diameter: float = 0.05   # [m] 環状管内径
    length: float = 100.0          # [m] 配管長
    roughness: float = 4.6e-5      # [m] 表面粗さ（商業鋼管デフォルト 0.046 mm）
    density: float = 1000.0        # [kg/m³]
    viscosity: float = 0.001       # [Pa·s]
    friction_method: str = "colebrook"
    flow_rate_min: float = 1.0     # [m³/h]
    flow_rate_max: float = 100.0   # [m³/h]
    points: int = 80


def _darcy_friction_turbulent(method: str, Re: float, eps: float, D_h: float) -> float:
    """乱流域のダルシー摩擦係数を返す"""
    if method == "blasius":
        return 0.316 * Re ** (-0.25)
    # Colebrook-White: 1/√f = -2 log10(ε/(3.7 Dh) + 2.51/(Re √f))
    eps_D = eps / D_h

    def eq(f: float) -> float:
        return 1.0 / np.sqrt(f) + 2.0 * np.log10(eps_D / 3.7 + 2.51 / (Re * np.sqrt(f)))

    try:
        return brentq(eq, 1e-6, 0.5, xtol=1e-10)
    except Exception:
        # Swamee-Jain 近似式にフォールバック
        return 0.25 / (np.log10(eps_D / 3.7 + 5.74 / Re ** 0.9)) ** 2


@app.post("/pressure-drop")
def calc_pressure_drop(req: PressureDropRequest):
    """Darcy-Weisbach 式で流量–圧力損失特性を計算する"""
    pt = req.pipe_type
    if pt == "circular":
        A = np.pi * req.diameter ** 2 / 4.0
        D_h = req.diameter
    elif pt == "rectangular":
        w, h = req.width, req.duct_height
        if w <= 0 or h <= 0:
            raise HTTPException(status_code=400, detail="幅・高さは正の値を入力してください")
        A = w * h
        D_h = 2.0 * w * h / (w + h)
    elif pt == "annulus":
        D_o, D_i = req.outer_diameter, req.inner_diameter
        if D_i >= D_o:
            raise HTTPException(status_code=400, detail="内径は外径より小さくしてください")
        A = np.pi / 4.0 * (D_o ** 2 - D_i ** 2)
        D_h = D_o - D_i
    else:
        raise HTTPException(status_code=400, detail=f"不明な管タイプ: {pt}")

    if A <= 0 or D_h <= 0:
        raise HTTPException(status_code=400, detail="ジオメトリが不正です")

    eps = req.roughness
    rho = req.density
    mu = req.viscosity
    L = req.length
    nu = mu / rho  # 動粘度 [m²/s]

    flow_rates = np.linspace(req.flow_rate_min, req.flow_rate_max, req.points)
    q_list, v_list, re_list, f_list, dp_list, regime_list = [], [], [], [], [], []

    for Q_m3h in flow_rates:
        Q_m3s = Q_m3h / 3600.0
        v = Q_m3s / A
        Re = rho * v * D_h / mu if mu > 0 else 0.0

        if Re < 1e-3:
            f, regime = 0.0, "laminar"
        elif Re < 2300.0:
            f, regime = 64.0 / Re, "laminar"
        elif Re < 4000.0:
            f_lam = 64.0 / 2300.0
            f_turb = _darcy_friction_turbulent(req.friction_method, 4000.0, eps, D_h)
            alpha = (Re - 2300.0) / 1700.0
            f, regime = f_lam * (1.0 - alpha) + f_turb * alpha, "transitional"
        else:
            f, regime = _darcy_friction_turbulent(req.friction_method, Re, eps, D_h), "turbulent"

        dP = f * (L / D_h) * (rho * v ** 2 / 2.0)

        q_list.append(round(float(Q_m3h), 4))
        v_list.append(round(float(v), 4))
        re_list.append(round(float(Re), 2))
        f_list.append(round(float(f), 8))
        dp_list.append(round(float(dP), 4))
        regime_list.append(regime)

    Q_lam = 2300.0 * nu * A / D_h * 3600.0
    Q_turb = 4000.0 * nu * A / D_h * 3600.0

    return {
        "flow_rates": q_list,
        "velocities": v_list,
        "reynolds": re_list,
        "friction_factors": f_list,
        "pressure_drops": dp_list,
        "regimes": regime_list,
        "hydraulic_diameter_mm": round(float(D_h) * 1000, 3),
        "cross_section_area_mm2": round(float(A) * 1e6, 3),
        "q_lam_turb": [round(float(Q_lam), 4), round(float(Q_turb), 4)],
    }


class PipeNetworkNode(BaseModel):
    id: str
    node_type: str
    params: dict[str, Any] = {}

class PipeNetworkEdge(BaseModel):
    id: str
    source: str
    target: str
    source_handle: str | None = None
    target_handle: str | None = None

class PipeNetworkRequest(BaseModel):
    nodes: list[PipeNetworkNode]
    edges: list[PipeNetworkEdge]
    density: float = 1000.0
    viscosity: float = 0.001
    friction_method: str = "colebrook"


def _calc_pipe_segment(params: dict, Q_m3s: float, rho: float, mu: float, method: str) -> dict:
    # Per-pipe friction method overrides the global default
    method    = params.get("frictionMethod", method)
    pipe_shape = params.get("pipeShape", "circular")
    L         = float(params.get("length",    50))
    eps       = float(params.get("roughness", 0.046)) / 1000  # mm → m

    if pipe_shape == "annulus":
        Do  = float(params.get("outerDiameter", 100)) / 1000
        Di  = float(params.get("innerDiameter",  50)) / 1000
        D_h = Do - Di
        A   = np.pi * (Do ** 2 - Di ** 2) / 4.0
    elif pipe_shape == "rectangular":
        W   = float(params.get("width",       100)) / 1000
        H   = float(params.get("ductHeight",   50)) / 1000
        D_h = 2 * W * H / (W + H) if (W + H) > 0 else 0.0
        A   = W * H
    else:  # circular
        D   = float(params.get("diameter", 100)) / 1000
        D_h = D
        A   = np.pi * D ** 2 / 4.0

    if D_h <= 0 or A <= 0 or Q_m3s <= 0:
        return {"Q_m3h": 0, "v": 0, "Re": 0, "f": 0, "dP_kpa": 0, "regime": "laminar"}

    v  = Q_m3s / A
    Re = rho * v * D_h / mu if mu > 0 else 0.0

    if Re < 1e-3:
        f, regime = 0.0, "laminar"
    elif Re < 2300.0:
        f, regime = 64.0 / Re, "laminar"
    elif Re < 4000.0:
        f_l = 64.0 / 2300.0
        f_t = _darcy_friction_turbulent(method, 4000.0, eps, D_h)
        f   = f_l + (f_t - f_l) * (Re - 2300.0) / 1700.0
        regime = "transitional"
    else:
        f  = _darcy_friction_turbulent(method, Re, eps, D_h)
        regime = "turbulent"

    dP = f * (L / D_h) * (rho * v ** 2 / 2.0)
    return {
        "Q_m3h":  round(Q_m3s * 3600, 4),
        "v":      round(v, 4),
        "Re":     round(Re, 2),
        "f":      round(f, 8),
        "dP_kpa": round(dP / 1000, 6),
        "regime": regime,
    }


def _path_total_backpressure(
    start_id: str,
    Q_m3s: float,
    nodes_dict: dict,
    outgoing: dict,
    rho: float,
    mu: float,
    method: str,
    visited: frozenset = frozenset(),
) -> float:
    """
    T字管の流量分配を求めるためのヘルパー。
    start_id から辿った経路の「合計背圧」(kPa) を返す。
    合計背圧 = 経路上の全配管 ΔP の和 + 末端シンクの圧力
    """
    total = 0.0
    nid = start_id
    local_v = set(visited)

    while nid and nid not in local_v:
        local_v.add(nid)
        node = nodes_dict.get(nid)
        if not node:
            break

        if node.node_type == "pipe":
            seg = _calc_pipe_segment(node.params, Q_m3s, rho, mu, method)
            total += seg["dP_kpa"]
        elif node.node_type == "sink":
            if node.params.get("sinkType", "pressure") == "pressure":
                total += float(node.params.get("pressure", 0.0))
            break

        downstream = outgoing.get(nid, [])
        n_down = len(downstream)
        if n_down == 0:
            break

        if node.node_type == "tee" and n_down >= 2:
            # ネスト T字管: 再帰的に圧損バランスを解く
            tid1 = downstream[0][0]
            tid2 = downstream[1][0]
            fv = frozenset(local_v)

            def nested_delta(q1: float) -> float:
                bp1 = _path_total_backpressure(tid1, q1,         nodes_dict, outgoing, rho, mu, method, fv)
                bp2 = _path_total_backpressure(tid2, Q_m3s - q1, nodes_dict, outgoing, rho, mu, method, fv)
                return bp1 - bp2

            try:
                q1_opt = brentq(nested_delta, 1e-10 * Q_m3s, (1 - 1e-10) * Q_m3s,
                                xtol=Q_m3s * 1e-8, maxiter=50)
            except Exception:
                q1_opt = Q_m3s * 0.5

            # 解では bp1 == bp2 なのでどちらを足しても同じ
            total += _path_total_backpressure(tid1, q1_opt, nodes_dict, outgoing, rho, mu, method, fv)
            break
        else:
            nid = downstream[0][0]

    return total


@app.post("/pipe-network")
def calc_pipe_network(req: PipeNetworkRequest):
    """パイプネットワークを BFS で辿り各管の圧損を計算する。
    流量ソース: Q固定→必要入口圧力を計算。
    圧力ソース: P固定→brentq で通過流量を逆算してから BFS。
    """
    nodes_dict = {n.id: n for n in req.nodes}
    outgoing: dict[str, list[tuple[str, str | None]]] = defaultdict(list)
    for e in req.edges:
        outgoing[e.source].append((e.target, e.source_handle))

    rho, mu = req.density, req.viscosity
    results: dict[str, Any] = {}
    source_pressures: dict[str, float] = {}  # src.id → 入口圧力 kPa (流量ソース: 必要圧; 圧力ソース: 指定圧)
    source_flows: dict[str, float] = {}      # src.id → 流量 m³/h (流量ソース: 指定値; 圧力ソース: 計算値)

    for src in (n for n in req.nodes if n.node_type == "source"):
        source_type = src.params.get("sourceType", "flow")

        if source_type == "pressure":
            P_in = float(src.params.get("pressure", 100.0))  # kPa
            source_pressures[src.id] = round(P_in, 4)
            first_down = outgoing.get(src.id, [])
            if not first_down:
                source_flows[src.id] = 0.0
                continue
            first_nid = first_down[0][0]
            fv: frozenset = frozenset()

            # Q_max を P_in を超えるまで倍々で拡大
            Q_lo, Q_hi = 1e-8, 1.0
            for _ in range(25):
                try:
                    bp_hi = _path_total_backpressure(first_nid, Q_hi, nodes_dict, outgoing, rho, mu, req.friction_method, fv)
                except Exception:
                    break
                if bp_hi >= P_in:
                    break
                Q_hi *= 2.0

            try:
                def bp_eq(Q_m3s: float) -> float:
                    return _path_total_backpressure(first_nid, Q_m3s, nodes_dict, outgoing, rho, mu, req.friction_method, fv) - P_in

                bp_lo = _path_total_backpressure(first_nid, Q_lo, nodes_dict, outgoing, rho, mu, req.friction_method, fv)
                if bp_lo >= P_in:
                    Q_total = Q_lo  # 入口圧が低すぎて流れない
                else:
                    Q_total = brentq(bp_eq, Q_lo, Q_hi, xtol=1e-10, maxiter=100)
            except Exception:
                Q_total = Q_lo

            source_flows[src.id] = round(Q_total * 3600, 4)
        else:
            Q_total = float(src.params.get("flowRate", 10.0)) / 3600.0
            source_flows[src.id] = round(Q_total * 3600, 4)

        # BFS: (node_id, Q [m³/s], cumulative ΔP [kPa] from source inlet)
        queue: list[tuple[str, float, float]] = [(src.id, Q_total, 0.0)]
        visited: set[str] = set()

        while queue:
            nid, Q, cum_dp = queue.pop(0)
            node = nodes_dict.get(nid)
            if not node:
                continue

            # シンクは複数経路から到達可能なので visited を使わず流量を累積
            if node.node_type == "sink":
                sink_type = node.params.get("sinkType", "pressure")
                sink_p = float(node.params.get("pressure", 0.0)) if sink_type == "pressure" else 0.0
                if source_type == "flow":
                    req_src_p = sink_p + cum_dp
                    source_pressures[src.id] = max(source_pressures.get(src.id, 0.0), req_src_p)
                if nid in results:
                    results[nid]["Q_m3h"] = round(results[nid]["Q_m3h"] + Q * 3600, 4)
                else:
                    results[nid] = {
                        "Q_m3h": round(Q * 3600, 4), "P_kpa": round(sink_p, 4),
                        "v": 0.0, "Re": 0.0, "f": 0.0, "dP_kpa": 0.0, "regime": "sink",
                    }
                continue

            if nid in visited:
                continue
            visited.add(nid)

            next_cum_dp = cum_dp
            if node.node_type == "pipe":
                seg = _calc_pipe_segment(node.params, Q, rho, mu, req.friction_method)
                results[nid] = seg
                next_cum_dp = cum_dp + seg["dP_kpa"]

            downstream = outgoing[nid]
            n_down = len(downstream)
            if n_down == 0:
                continue

            if node.node_type == "tee" and n_down >= 2:
                tid1, _ = downstream[0]
                tid2, _ = downstream[1]
                fv2 = frozenset(visited)

                def delta_bp(q1: float, _Q: float = Q, _fv: frozenset = fv2) -> float:
                    bp1 = _path_total_backpressure(tid1, q1,      nodes_dict, outgoing, rho, mu, req.friction_method, _fv)
                    bp2 = _path_total_backpressure(tid2, _Q - q1, nodes_dict, outgoing, rho, mu, req.friction_method, _fv)
                    return bp1 - bp2

                try:
                    q1_opt = brentq(delta_bp, 1e-10 * Q, (1 - 1e-10) * Q,
                                    xtol=Q * 1e-8, maxiter=100)
                except Exception:
                    q1_opt = Q * 0.5

                results[nid] = {
                    "Q_m3h":  round(Q * 3600, 4),
                    "Q1_m3h": round(q1_opt * 3600, 4),
                    "Q2_m3h": round((Q - q1_opt) * 3600, 4),
                    "v": 0.0, "Re": 0.0, "f": 0.0, "dP_kpa": 0.0, "regime": "split",
                }
                queue.append((tid1, q1_opt,      next_cum_dp))
                queue.append((tid2, Q - q1_opt,  next_cum_dp))
            else:
                for tid, _ in downstream:
                    queue.append((tid, Q, next_cum_dp))

    return {"nodes": results, "source_pressures": source_pressures, "source_flows": source_flows}


@app.get("/fluids/{fluid}/saturation/csv")
def download_saturation_csv(fluid: str):
    """飽和蒸気圧曲線データをCSVでダウンロード"""
    data = get_saturation_curve(fluid)
    rows = []
    for row in data["liquid"]:
        rows.append({**row, "phase": "liquid"})
    for row in data["vapor"]:
        rows.append({**row, "phase": "vapor"})
    df = pd.DataFrame(rows)
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={fluid}_saturation.csv"},
    )
