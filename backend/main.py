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
from scipy.optimize import brentq, least_squares
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

    sign  = 1 if Q_m3s >= 0 else -1
    Q_abs = abs(Q_m3s)

    if D_h <= 0 or A <= 0 or Q_abs < 1e-12:
        return {"Q_m3h": round(Q_m3s * 3600, 4), "v": 0, "Re": 0, "f": 0, "dP_kpa": 0, "regime": "laminar"}

    v  = Q_abs / A
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
        "Q_m3h":  round(Q_m3s * 3600, 4),  # 符号付き: 負=逆流
        "v":      round(sign * v, 4),         # 符号付き
        "Re":     round(Re, 2),
        "f":      round(f, 8),
        "dP_kpa": round(dP / 1000, 6),      # 常に正（エネルギー散逸の大きさ）
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
            # dP_kpa は常に正。Q の符号で「正方向に圧力が落ちる」か「上がる」かを決める
            total += seg["dP_kpa"] if Q_m3s >= 0 else -seg["dP_kpa"]
        elif node.node_type == "sink" or node.node_type == "boundary":
            # boundaryType='pressure' または旧 sinkType='pressure' の場合に背圧を加算
            btype = node.params.get("boundaryType", node.params.get("sinkType", "pressure"))
            if btype == "pressure":
                total += float(node.params.get("pressure", 0.0))
            break

        downstream = outgoing.get(nid, [])
        n_down = len(downstream)
        if n_down == 0:
            break

        if node.node_type == "tee" and n_down >= 2:
            # ネスト T字管: 再帰的に圧損バランスを解く（逆流も許可）
            tid1 = downstream[0][0]
            tid2 = downstream[1][0]
            fv = frozenset(local_v)

            def nested_delta(q1: float, _Q: float = Q_m3s, _fv: frozenset = fv) -> float:
                bp1 = _path_total_backpressure(tid1, q1,     nodes_dict, outgoing, rho, mu, method, _fv)
                bp2 = _path_total_backpressure(tid2, _Q - q1, nodes_dict, outgoing, rho, mu, method, _fv)
                return bp1 - bp2

            Q_range = max(abs(Q_m3s) * 20, 1.0)
            try:
                d_lo = nested_delta(1e-12 * max(abs(Q_m3s), 1e-6))
                d_hi = nested_delta((1 - 1e-10) * Q_m3s)
                if d_lo * d_hi < 0:
                    q1_opt = brentq(nested_delta, 1e-12 * max(abs(Q_m3s), 1e-6),
                                    (1 - 1e-10) * Q_m3s, xtol=max(abs(Q_m3s), 1e-8) * 1e-8, maxiter=80)
                else:
                    q1_opt = brentq(nested_delta, -Q_range, Q_m3s + Q_range, xtol=1e-10, maxiter=150)
            except Exception:
                q1_opt = Q_m3s * 0.5

            # 解では bp1 == bp2 なのでどちらを足しても同じ
            total += _path_total_backpressure(tid1, q1_opt, nodes_dict, outgoing, rho, mu, method, fv)
            break
        else:
            nid = downstream[0][0]

    return total


def _boundary_type(node_params: dict) -> str:
    """ソース/シンク共通の境界条件種別を返す。boundaryType > sourceType/sinkType の優先順。"""
    return node_params.get("boundaryType",
           node_params.get("sourceType",
           node_params.get("sinkType", "flow")))


BOUNDARY_NODE_TYPES = {"source", "sink", "boundary"}


def _pipe_flow_for_pressure_drop(
    params: dict,
    dp_kpa: float,
    rho: float,
    mu: float,
    method: str,
) -> float:
    """指定した圧力差[kPa]を生む体積流量[m³/s]の絶対値を返す。"""
    if dp_kpa <= 1e-9:
        return 0.0

    def residual(q_m3s: float) -> float:
        return _calc_pipe_segment(params, q_m3s, rho, mu, method)["dP_kpa"] - dp_kpa

    q_hi = 1e-6
    for _ in range(80):
        if residual(q_hi) >= 0:
            return brentq(residual, 0.0, q_hi, xtol=1e-12, maxiter=120)
        q_hi *= 2.0

    raise HTTPException(status_code=400, detail="圧力差に対応する流量の探索範囲を超えました")


def _solve_boundary_network(
    req: PipeNetworkRequest,
    nodes_dict: dict[str, PipeNetworkNode],
    outgoing: dict[str, list[tuple[str, str | None]]],
    incoming: dict[str, list[tuple[str, str | None]]],
) -> dict[str, Any]:
    """圧力固定・流量固定の境界条件を節点圧から解く。"""
    rho, mu = req.density, req.viscosity

    parent: dict[str, str] = {}

    def add_point(pid: str) -> None:
        parent.setdefault(pid, pid)

    def find(pid: str) -> str:
        add_point(pid)
        if parent[pid] != pid:
            parent[pid] = find(parent[pid])
        return parent[pid]

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    def node_point(nid: str, outgoing_side: bool) -> str:
        node = nodes_dict[nid]
        if node.node_type == "pipe":
            return f"{nid}:out" if outgoing_side else f"{nid}:in"
        return nid

    for n in req.nodes:
        if n.node_type == "pipe":
            add_point(f"{n.id}:in")
            add_point(f"{n.id}:out")
        elif n.node_type in BOUNDARY_NODE_TYPES or n.node_type == "tee":
            add_point(n.id)

    for e in req.edges:
        union(node_point(e.source, outgoing_side=True), node_point(e.target, outgoing_side=False))

    fixed_p: dict[str, float] = {}
    fixed_q: dict[str, float] = defaultdict(float)
    fixed_pressure_count = 0
    fixed_flow_count = 0
    for n in req.nodes:
        if n.node_type not in BOUNDARY_NODE_TYPES:
            continue

        btype = _boundary_type(n.params)
        root_id = find(n.id)
        if btype == "pressure":
            fixed_pressure_count += 1
            root_id = find(n.id)
            p_val = float(n.params.get("pressure", 0.0))
            if root_id in fixed_p and abs(fixed_p[root_id] - p_val) > 1e-9:
                raise HTTPException(
                    status_code=400,
                    detail="圧力が異なる境界ノードが抵抗要素なしで直接接続されています",
                )
            fixed_p[root_id] = p_val
        elif btype == "flow":
            fixed_flow_count += 1
            fixed_q[root_id] += float(n.params.get("flowRate", 0.0)) / 3600.0
        else:
            raise HTTPException(status_code=400, detail=f"不明な境界条件: {btype}")

    if fixed_pressure_count < 1:
        raise HTTPException(status_code=400, detail="境界条件計算には圧力固定境界が少なくとも1つ必要です")

    links: list[dict[str, Any]] = []
    for pipe in (n for n in req.nodes if n.node_type == "pipe"):
        a = find(f"{pipe.id}:in")
        b = find(f"{pipe.id}:out")
        if a == b:
            continue
        links.append({"id": pipe.id, "a": a, "b": b, "params": pipe.params})

    if not links:
        raise HTTPException(status_code=400, detail="圧力境界計算にはパイプが少なくとも1本必要です")

    junction_ids = sorted({pid for link in links for pid in (link["a"], link["b"])})
    unknown_ids = [pid for pid in junction_ids if pid not in fixed_p]

    def pressure_map(x: np.ndarray) -> dict[str, float]:
        p = dict(fixed_p)
        p.update({nid: float(x[i]) for i, nid in enumerate(unknown_ids)})
        return p

    def signed_link_flow(link: dict[str, Any], p: dict[str, float]) -> float:
        dp = p[link["a"]] - p[link["b"]]
        q_abs = _pipe_flow_for_pressure_drop(link["params"], abs(dp), rho, mu, req.friction_method)
        return q_abs if dp >= 0 else -q_abs

    def residual(x: np.ndarray) -> np.ndarray:
        p = pressure_map(x)
        net_out = defaultdict(float)
        for link in links:
            q = signed_link_flow(link, p)
            net_out[link["a"]] += q
            net_out[link["b"]] -= q
        return np.array([net_out[nid] - fixed_q.get(nid, 0.0) for nid in unknown_ids], dtype=float)

    if unknown_ids:
        mean_p = sum(fixed_p.values()) / len(fixed_p)
        initial_p: dict[str, float] = {}

        adjacency: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
        for link in links:
            adjacency[link["a"]].append((link["b"], link))
            adjacency[link["b"]].append((link["a"], link))

        for start_id, q in fixed_q.items():
            if start_id in fixed_p or abs(q) < 1e-12:
                continue
            queue: list[tuple[str, list[tuple[str, str, dict[str, Any]]]]] = [(start_id, [])]
            seen = {start_id}
            found_path: list[tuple[str, str, dict[str, Any]]] | None = None
            end_id: str | None = None
            while queue and found_path is None:
                nid, path = queue.pop(0)
                if nid in fixed_p:
                    found_path = path
                    end_id = nid
                    break
                for next_id, link in adjacency.get(nid, []):
                    if next_id in seen:
                        continue
                    seen.add(next_id)
                    queue.append((next_id, path + [(nid, next_id, link)]))

            if found_path is None or end_id is None:
                continue

            p_next = fixed_p[end_id]
            for from_id, to_id, link in reversed(found_path):
                dp_est = _calc_pipe_segment(link["params"], abs(q), rho, mu, req.friction_method)["dP_kpa"]
                p_from = p_next + (dp_est if q > 0 else -dp_est)
                initial_p.setdefault(from_id, p_from)
                p_next = p_from

        def initial_pressure(nid: str) -> float:
            if nid in initial_p:
                return initial_p[nid]
            q = fixed_q.get(nid, 0.0)
            if abs(q) < 1e-12:
                return mean_p
            adjacent = next((link for link in links if link["a"] == nid or link["b"] == nid), None)
            if adjacent is None:
                return mean_p
            dp_est = _calc_pipe_segment(adjacent["params"], abs(q), rho, mu, req.friction_method)["dP_kpa"]
            return mean_p + (dp_est if q > 0 else -dp_est)

        x0 = np.array([initial_pressure(nid) for nid in unknown_ids], dtype=float)
        sol = least_squares(residual, x0, xtol=1e-10, ftol=1e-10, gtol=1e-10, max_nfev=300)
        max_residual = float(np.max(np.abs(residual(sol.x)))) if len(unknown_ids) > 0 else 0.0
        if not sol.success or max_residual > 1e-5:
            raise HTTPException(status_code=400, detail=f"圧力分布の解が収束しませんでした: {sol.message}")
        pressures = pressure_map(sol.x)
    else:
        pressures = dict(fixed_p)

    results: dict[str, Any] = {}
    net_out = defaultdict(float)
    link_flows: dict[str, float] = {}
    for link in links:
        p_a = pressures[link["a"]]
        p_b = pressures[link["b"]]
        q = signed_link_flow(link, pressures)
        link_flows[link["id"]] = q
        seg = _calc_pipe_segment(link["params"], q, rho, mu, req.friction_method)
        seg.update({
            "P_from_kpa": round(p_a, 4),
            "P_to_kpa": round(p_b, 4),
            "P_in_kpa": round(max(p_a, p_b), 4),
            "P_out_kpa": round(min(p_a, p_b), 4),
        })
        results[link["id"]] = seg
        net_out[link["a"]] += q
        net_out[link["b"]] -= q

    source_pressures: dict[str, float] = {}
    source_flows: dict[str, float] = {}
    for n in req.nodes:
        p_id = find(n.id) if n.node_type in BOUNDARY_NODE_TYPES or n.node_type == "tee" else None
        if n.node_type == "source" and p_id in pressures:
            source_pressures[n.id] = round(pressures[p_id], 4)
            source_flows[n.id] = round(net_out[p_id] * 3600, 4)
        elif n.node_type == "sink" and p_id in pressures:
            results[n.id] = {
                "Q_m3h": round(-net_out[p_id] * 3600, 4),
                "P_kpa": round(pressures[p_id], 4),
                "v": 0.0, "Re": 0.0, "f": 0.0, "dP_kpa": 0.0, "regime": "sink",
            }
        elif n.node_type == "boundary" and p_id in pressures:
            q_out = fixed_q.get(p_id, net_out[p_id]) * 3600
            source_pressures[n.id] = round(pressures[p_id], 4)
            source_flows[n.id] = round(q_out, 4)
            results[n.id] = {
                "Q_m3h": round(q_out, 4),
                "P_kpa": round(pressures[p_id], 4),
                "v": 0.0, "Re": 0.0, "f": 0.0, "dP_kpa": 0.0, "regime": "boundary",
            }
        elif n.node_type == "tee" and p_id in pressures:
            out_edges = outgoing.get(n.id, [])
            outlet_flows: list[float] = []
            for target_id, _ in out_edges:
                for link in links:
                    if link["id"] == target_id and link["a"] == p_id:
                        outlet_flows.append(link_flows[link["id"]] * 3600)
                    elif link["id"] == target_id and link["b"] == p_id:
                        outlet_flows.append(-link_flows[link["id"]] * 3600)
            tee_result: dict[str, Any] = {
                "Q_m3h": round(sum(max(0.0, q) for q in outlet_flows), 4),
                "P_kpa": round(pressures[p_id], 4),
                "v": 0.0, "Re": 0.0, "f": 0.0, "dP_kpa": 0.0, "regime": "junction",
            }
            if len(outlet_flows) >= 2:
                tee_result["Q1_m3h"] = round(outlet_flows[0], 4)
                tee_result["Q2_m3h"] = round(outlet_flows[1], 4)
            results[n.id] = tee_result

    return {"nodes": results, "source_pressures": source_pressures, "source_flows": source_flows}


@app.post("/pipe-network")
def calc_pipe_network(req: PipeNetworkRequest):
    """パイプネットワーク圧損計算。
    境界条件:
      flow   型 … Q固定 → 必要圧力を逆算（ソース）またはQ到達量を表示（シンク）
      pressure 型 … P固定 → 通過流量を逆算（ソース）または背圧として使用（シンク）
    逆流: Q が負になることで表現。ΔP は常に正（エネルギー散逸の大きさ）。
    マージノード: 複数入力が揃ってから処理するトポロジカル BFS。
    """
    nodes_dict = {n.id: n for n in req.nodes}
    outgoing: dict[str, list[tuple[str, str | None]]] = defaultdict(list)
    incoming: dict[str, list[tuple[str, str | None]]] = defaultdict(list)
    for e in req.edges:
        outgoing[e.source].append((e.target, e.source_handle))
        incoming[e.target].append((e.source, e.target_handle))

    boundary_nodes = [n for n in req.nodes if n.node_type in BOUNDARY_NODE_TYPES]
    if (
        boundary_nodes
        and all(_boundary_type(n.params) in ("pressure", "flow") for n in boundary_nodes)
        and any(_boundary_type(n.params) == "pressure" for n in boundary_nodes)
    ):
        return _solve_boundary_network(req, nodes_dict, outgoing, incoming)

    # マージノード検出
    global_in_deg: dict[str, int] = defaultdict(int)
    for e in req.edges:
        global_in_deg[e.target] += 1

    rho, mu = req.density, req.viscosity
    results: dict[str, Any] = {}
    source_pressures: dict[str, float] = {}  # src.id → 入口圧力 kPa
    source_flows: dict[str, float] = {}      # src.id → 流量 m³/h (符号付き)

    for src in (n for n in req.nodes if n.node_type == "source" or (n.node_type == "boundary" and _boundary_type(n.params) == "flow")):
        btype = _boundary_type(src.params)

        # ── 圧力境界: P固定 → Q逆算 ─────────────────────────────────────
        if btype == "pressure":
            P_in = float(src.params.get("pressure", 100.0))
            source_pressures[src.id] = round(P_in, 4)
            first_down = outgoing.get(src.id, [])
            if not first_down:
                source_flows[src.id] = 0.0
                continue
            first_nid = first_down[0][0]
            fv0: frozenset = frozenset()

            Q_lo, Q_hi = 1e-8, 1.0
            for _ in range(25):
                try:
                    if _path_total_backpressure(first_nid, Q_hi, nodes_dict, outgoing, rho, mu, req.friction_method, fv0) >= P_in:
                        break
                except Exception:
                    break
                Q_hi *= 2.0

            try:
                def bp_eq(Q_m3s: float) -> float:
                    return _path_total_backpressure(first_nid, Q_m3s, nodes_dict, outgoing, rho, mu, req.friction_method, fv0) - P_in

                if _path_total_backpressure(first_nid, Q_lo, nodes_dict, outgoing, rho, mu, req.friction_method, fv0) >= P_in:
                    Q_total = Q_lo
                else:
                    Q_total = brentq(bp_eq, Q_lo, Q_hi, xtol=1e-10, maxiter=100)
            except Exception:
                Q_total = Q_lo

            source_flows[src.id] = round(Q_total * 3600, 4)
        else:
            # ── 流量境界: Q固定 ──────────────────────────────────────────
            Q_total = float(src.params.get("flowRate", 10.0)) / 3600.0
            source_flows[src.id] = round(Q_total * 3600, 4)

        # ── BFS: マージノード対応トポロジカル処理 ───────────────────────
        remaining: dict[str, int] = {nid: deg for nid, deg in global_in_deg.items()}
        pending_Q:  dict[str, float] = defaultdict(float)
        pending_dp: dict[str, float] = {}

        def _enqueue(queue_: list, tid: str, q_in: float, dp_in: float) -> None:
            """全入力が揃ったタイミングでキューへ追加する。"""
            pending_Q[tid] += q_in
            if tid not in pending_dp:
                pending_dp[tid] = dp_in
            remaining[tid] = remaining.get(tid, 1) - 1
            if remaining.get(tid, 0) <= 0:
                queue_.append((tid, pending_Q[tid], pending_dp[tid]))

        bfs: list[tuple[str, float, float]] = []
        for tid, _ in outgoing.get(src.id, []):
            _enqueue(bfs, tid, Q_total, 0.0)

        while bfs:
            nid, Q, cum_dp = bfs.pop(0)
            node = nodes_dict.get(nid)
            if not node:
                continue

            # ── シンク ──────────────────────────────────────────────────
            if node.node_type == "sink" or (node.node_type == "boundary" and node.id != src.id):
                sb = _boundary_type(node.params)
                sink_p = float(node.params.get("pressure", 0.0)) if sb == "pressure" else 0.0
                if btype == "flow":
                    # 流量ソース: シンクの背圧＋到達ΔPからソース必要圧を更新
                    source_pressures[src.id] = max(source_pressures.get(src.id, 0.0), sink_p + cum_dp)
                if nid in results:
                    results[nid]["Q_m3h"] = round(results[nid]["Q_m3h"] + Q * 3600, 4)
                else:
                    results[nid] = {
                        "Q_m3h": round(Q * 3600, 4),
                        "P_kpa": round(sink_p, 4),
                        "_cum_dp": round(cum_dp, 6),
                        "v": 0.0, "Re": 0.0, "f": 0.0, "dP_kpa": 0.0,
                        "regime": "boundary" if node.node_type == "boundary" else "sink",
                    }
                continue

            # ── パイプ ──────────────────────────────────────────────────
            next_cum_dp = cum_dp
            if node.node_type == "pipe":
                seg = _calc_pipe_segment(node.params, Q, rho, mu, req.friction_method)
                seg["_cum_dp_in"] = round(cum_dp, 6)
                results[nid] = seg
                # cum_dp = ソースからの累積ΔP。逆流(Q<0)では圧力が「回収」される
                next_cum_dp = cum_dp + (seg["dP_kpa"] if Q >= 0 else -seg["dP_kpa"])
                results[nid]["_cum_dp_out"] = round(next_cum_dp, 6)

            downstream = outgoing.get(nid, [])
            n_down = len(downstream)
            if n_down == 0:
                continue

            # ── T字管: 圧損バランスで自動分配（逆流も許可）─────────────
            if node.node_type == "tee" and n_down >= 2:
                tid1, _ = downstream[0]
                tid2, _ = downstream[1]
                fv_bfs: frozenset = frozenset(
                    nid2 for nid2, cnt in remaining.items() if cnt <= 0
                )

                def delta_bp(q1: float, _Q: float = Q, _fv: frozenset = fv_bfs) -> float:
                    bp1 = _path_total_backpressure(tid1, q1,      nodes_dict, outgoing, rho, mu, req.friction_method, _fv)
                    bp2 = _path_total_backpressure(tid2, _Q - q1, nodes_dict, outgoing, rho, mu, req.friction_method, _fv)
                    return bp1 - bp2

                Q_range = max(abs(Q) * 20, 1.0)
                q1_opt = Q * 0.5
                try:
                    d_lo = delta_bp(1e-12 * max(abs(Q), 1e-6))
                    d_hi = delta_bp((1 - 1e-10) * Q)
                    if d_lo * d_hi < 0:
                        q1_opt = brentq(delta_bp, 1e-12 * max(abs(Q), 1e-6),
                                        (1 - 1e-10) * Q, xtol=max(abs(Q), 1e-8) * 1e-8, maxiter=100)
                    else:
                        q1_opt = brentq(delta_bp, -Q_range, Q + Q_range, xtol=1e-10, maxiter=200)
                except Exception:
                    pass

                q2_opt = Q - q1_opt
                results[nid] = {
                    "Q_m3h":  round(Q * 3600, 4),
                    "Q1_m3h": round(q1_opt * 3600, 4),
                    "Q2_m3h": round(q2_opt * 3600, 4),
                    "_cum_dp": round(next_cum_dp, 6),
                    "v": 0.0, "Re": 0.0, "f": 0.0, "dP_kpa": 0.0, "regime": "split",
                }
                _enqueue(bfs, tid1, q1_opt, next_cum_dp)
                _enqueue(bfs, tid2, q2_opt, next_cum_dp)
            else:
                for tid, _ in downstream:
                    _enqueue(bfs, tid, Q, next_cum_dp)

        # ── 流量シンクの入口圧力を後処理で算出 ─────────────────────────
        P_src_kpa = source_pressures.get(src.id, 0.0)
        for nid, r in results.items():
            if r.get("regime") in ("laminar", "transitional", "turbulent"):
                cd_in = r.pop("_cum_dp_in", None)
                cd_out = r.pop("_cum_dp_out", None)
                if cd_in is not None and cd_out is not None:
                    p_from = P_src_kpa - cd_in
                    p_to = P_src_kpa - cd_out
                    r["P_from_kpa"] = round(p_from, 4)
                    r["P_to_kpa"] = round(p_to, 4)
                    r["P_in_kpa"] = round(max(p_from, p_to), 4)
                    r["P_out_kpa"] = round(min(p_from, p_to), 4)
                continue
            if r.get("regime") == "split" and "_cum_dp" in r:
                cd = r.pop("_cum_dp")
                r["P_kpa"] = round(P_src_kpa - cd, 4)
                continue
            if r.get("regime") in ("sink", "boundary") and "_cum_dp" in r:
                cd = r.pop("_cum_dp")
                sink_node = nodes_dict.get(nid)
                if sink_node and _boundary_type(sink_node.params) == "flow":
                    r["P_kpa"] = round(P_src_kpa - cd, 4)
                elif sink_node and _boundary_type(sink_node.params) == "pressure":
                    r["P_kpa"] = round(float(sink_node.params.get("pressure", r.get("P_kpa", 0.0))), 4)

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
