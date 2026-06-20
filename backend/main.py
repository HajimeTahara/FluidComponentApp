from collections import defaultdict
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from tinydb import TinyDB
from typing import Any
import CoolProp.CoolProp as CP
import numpy as np
import os
import pandas as pd
from scipy.integrate import solve_ivp
from scipy.optimize import brentq, least_squares
import io
import math

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
        D_liq = CP.PropsSI("D", "P", P, "Q", 0, fluid)
        D_vap = CP.PropsSI("D", "P", P, "Q", 1, fluid)
        H_liq = CP.PropsSI("H", "P", P, "Q", 0, fluid)
        H_vap = CP.PropsSI("H", "P", P, "Q", 1, fluid)
        result["T_sat_at_P"] = T_sat
        result["D_sat_liq_at_P"] = D_liq
        result["D_sat_vap_at_P"] = D_vap
        result["H_sat_liq_at_P"] = H_liq
        result["H_sat_vap_at_P"] = H_vap
        result["latent_heat_at_P"] = H_vap - H_liq
    except Exception:
        result["T_sat_at_P"] = None
        result["D_sat_liq_at_P"] = None
        result["D_sat_vap_at_P"] = None
        result["H_sat_liq_at_P"] = None
        result["H_sat_vap_at_P"] = None
        result["latent_heat_at_P"] = None

    # T₀ における飽和特性
    try:
        P_sat = CP.PropsSI("P", "T", T, "Q", 0, fluid)
        D_liq = CP.PropsSI("D", "T", T, "Q", 0, fluid)
        D_vap = CP.PropsSI("D", "T", T, "Q", 1, fluid)
        H_liq = CP.PropsSI("H", "T", T, "Q", 0, fluid)
        H_vap = CP.PropsSI("H", "T", T, "Q", 1, fluid)
        result["P_sat_at_T"] = P_sat
        result["D_sat_liq_at_T"] = D_liq
        result["D_sat_vap_at_T"] = D_vap
        result["H_sat_liq_at_T"] = H_liq
        result["H_sat_vap_at_T"] = H_vap
        result["latent_heat_at_T"] = H_vap - H_liq
    except Exception:
        result["P_sat_at_T"] = None
        result["D_sat_liq_at_T"] = None
        result["D_sat_vap_at_T"] = None
        result["H_sat_liq_at_T"] = None
        result["H_sat_vap_at_T"] = None
        result["latent_heat_at_T"] = None

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
    line_type: str = "fluid"

class PipeNetworkFluidSystem(BaseModel):
    id: str
    name: str = ""
    fluid: str = "Water"
    propertyMode: str = "constant"
    density: float = 1000.0
    viscosity: float = 0.001
    specificHeat: float = 4184.0
    color: str | None = None

class PipeNetworkRequest(BaseModel):
    nodes: list[PipeNetworkNode]
    edges: list[PipeNetworkEdge]
    density: float = 1000.0
    viscosity: float = 0.001
    friction_method: str = "colebrook"
    fluidSystems: list[PipeNetworkFluidSystem] = Field(default_factory=list)


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

        if node.node_type in TWO_PORT_NODE_TYPES and node.node_type != "pump":
            dP_kpa = _component_pressure_delta_kpa(node.node_type, node.params, Q_m3s, rho, mu, method)
            # dP_kpa は常に正。Q の符号で「正方向に圧力が落ちる」か「上がる」かを決める
            total += dP_kpa if Q_m3s >= 0 else -dP_kpa
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
TWO_PORT_NODE_TYPES = {"pipe", "pump", "turbine", "heatExchanger", "reducer", "elbow", "valve"}
TWO_FLUID_HEAT_EXCHANGER_NODE_TYPES = {"twoFluidHeatExchanger"}
DEFAULT_TEMPERATURE_K = 293.15
DEFAULT_SPECIFIC_HEAT_J_KG_K = 4184.0
DEFAULT_FLUID_SYSTEM_ID = "default"


def _fluid_system_map(req: PipeNetworkRequest) -> dict[str, dict[str, Any]]:
    systems: dict[str, dict[str, Any]] = {}
    for fs in req.fluidSystems:
        systems[fs.id] = {
            "id": fs.id,
            "name": fs.name or fs.id,
            "fluid": fs.fluid,
            "propertyMode": fs.propertyMode,
            "density": float(fs.density),
            "viscosity": float(fs.viscosity),
            "specificHeat": float(fs.specificHeat),
            "color": fs.color,
        }
    if not systems:
        systems[DEFAULT_FLUID_SYSTEM_ID] = {
            "id": DEFAULT_FLUID_SYSTEM_ID,
            "name": "Default",
            "fluid": "Water",
            "propertyMode": "constant",
            "density": float(req.density),
            "viscosity": float(req.viscosity),
            "specificHeat": DEFAULT_SPECIFIC_HEAT_J_KG_K,
            "color": None,
        }
    return systems


def _node_fluid_system_id(node: PipeNetworkNode, default_id: str = DEFAULT_FLUID_SYSTEM_ID) -> str:
    value = node.params.get("fluidSystemId", default_id)
    return str(value) if value else default_id


def _node_temperature_k(node: PipeNetworkNode | None) -> float:
    if node is None:
        return DEFAULT_TEMPERATURE_K
    return float(node.params.get("temperature", DEFAULT_TEMPERATURE_K))


def _round_temperature(value: float | None) -> float | None:
    if value is None or not np.isfinite(value):
        return None
    return round(float(value), 3)


def _heat_exchange_state(
    params: dict,
    q_m3s: float,
    rho: float,
    t_in_k: float,
    default_cp: float = DEFAULT_SPECIFIC_HEAT_J_KG_K,
) -> dict[str, float]:
    q_abs = abs(q_m3s)
    exchange_temp = float(params.get("exchangeTemperature", DEFAULT_TEMPERATURE_K))
    u_value = max(float(params.get("heatTransferCoeff", 500.0)), 0.0)
    area = max(float(params.get("heatTransferArea", 10.0)), 0.0)
    cp = max(float(params.get("specificHeat", default_cp)), 1e-9)
    ua_w_k = u_value * area
    mdot = rho * q_abs

    if mdot <= 1e-12 or ua_w_k <= 0:
        t_out_k = t_in_k
    else:
        t_out_k = exchange_temp + (t_in_k - exchange_temp) * np.exp(-ua_w_k / (mdot * cp))

    heat_kw = mdot * cp * (t_out_k - t_in_k) / 1000.0
    return {
        "T_in_K": round(float(t_in_k), 3),
        "T_out_K": round(float(t_out_k), 3),
        "heat_duty_kw": round(float(heat_kw), 6),
        "UA_w_per_k": round(float(ua_w_k), 6),
    }


def _heat_exchanger_pressure_drop_kpa(params: dict, q_m3s: float) -> float:
    rated_flow_m3h = max(float(params.get("ratedFlow", 10.0)), 1e-9)
    nominal_dp_kpa = max(float(params.get("nominalPressureDrop", 10.0)), 0.0)
    q_m3h = abs(q_m3s) * 3600.0
    return nominal_dp_kpa * (q_m3h / rated_flow_m3h) ** 2


def _heat_exchanger_flow_for_pressure_drop(params: dict, dp_kpa: float) -> float:
    nominal_dp_kpa = max(float(params.get("nominalPressureDrop", 10.0)), 0.0)
    rated_flow_m3h = max(float(params.get("ratedFlow", 10.0)), 1e-9)
    if dp_kpa <= 1e-12 or nominal_dp_kpa <= 1e-12:
        return 0.0
    return rated_flow_m3h * np.sqrt(dp_kpa / nominal_dp_kpa) / 3600.0


def _two_fluid_side_pressure_drop_kpa(params: dict, side: str, q_m3s: float) -> float:
    rated_key = "hotRatedFlow" if side == "hot" else "coldRatedFlow"
    dp_key = "hotNominalPressureDrop" if side == "hot" else "coldNominalPressureDrop"
    rated_flow_m3h = max(float(params.get(rated_key, 10.0)), 1e-9)
    nominal_dp_kpa = max(float(params.get(dp_key, 10.0)), 0.0)
    q_m3h = abs(q_m3s) * 3600.0
    return nominal_dp_kpa * (q_m3h / rated_flow_m3h) ** 2


def _two_fluid_side_flow_for_pressure_drop(params: dict, side: str, dp_kpa: float) -> float:
    rated_key = "hotRatedFlow" if side == "hot" else "coldRatedFlow"
    dp_key = "hotNominalPressureDrop" if side == "hot" else "coldNominalPressureDrop"
    nominal_dp_kpa = max(float(params.get(dp_key, 10.0)), 0.0)
    rated_flow_m3h = max(float(params.get(rated_key, 10.0)), 1e-9)
    if dp_kpa <= 1e-12 or nominal_dp_kpa <= 1e-12:
        return 0.0
    return rated_flow_m3h * np.sqrt(dp_kpa / nominal_dp_kpa) / 3600.0


def _calc_two_fluid_side_segment(params: dict, side: str, q_m3s: float) -> dict:
    return {
        "Q_m3h": round(q_m3s * 3600.0, 4),
        "v": 0.0,
        "Re": 0.0,
        "f": 0.0,
        "dP_kpa": round(_two_fluid_side_pressure_drop_kpa(params, side, q_m3s), 6),
        "regime": "twoFluidHeatExchanger",
        "side": side,
    }


def _two_fluid_heat_exchange_result(
    params: dict,
    hot: dict[str, Any] | None,
    cold: dict[str, Any] | None,
    hot_fluid: dict[str, Any],
    cold_fluid: dict[str, Any],
) -> dict[str, Any]:
    hot = hot or {}
    cold = cold or {}
    hot_q = float(hot.get("Q_m3h", 0.0)) / 3600.0
    cold_q = float(cold.get("Q_m3h", 0.0)) / 3600.0
    hot_t_in = float(hot.get("T_in_K", DEFAULT_TEMPERATURE_K))
    cold_t_in = float(cold.get("T_in_K", DEFAULT_TEMPERATURE_K))
    hot_cp = max(float(hot_fluid.get("specificHeat", DEFAULT_SPECIFIC_HEAT_J_KG_K)), 1e-9)
    cold_cp = max(float(cold_fluid.get("specificHeat", DEFAULT_SPECIFIC_HEAT_J_KG_K)), 1e-9)
    hot_c = abs(hot_q) * float(hot_fluid.get("density", 1000.0)) * hot_cp
    cold_c = abs(cold_q) * float(cold_fluid.get("density", 1000.0)) * cold_cp
    ua = max(float(params.get("heatTransferCoeff", 500.0)), 0.0) * max(float(params.get("heatTransferArea", 10.0)), 0.0)

    heat_w = 0.0
    effectiveness = 0.0
    if hot_c > 1e-12 and cold_c > 1e-12 and ua > 0:
        c_min = min(hot_c, cold_c)
        c_max = max(hot_c, cold_c)
        cr = c_min / c_max if c_max > 0 else 0.0
        ntu = ua / c_min
        if abs(1.0 - cr) < 1e-9:
            effectiveness = ntu / (1.0 + ntu)
        else:
            effectiveness = (1.0 - math.exp(-ntu * (1.0 - cr))) / (1.0 - cr * math.exp(-ntu * (1.0 - cr)))
        heat_w = effectiveness * c_min * (hot_t_in - cold_t_in)

    hot_t_out = hot_t_in - heat_w / hot_c if hot_c > 1e-12 else hot_t_in
    cold_t_out = cold_t_in + heat_w / cold_c if cold_c > 1e-12 else cold_t_in

    return {
        "Q_m3h": round(hot_q * 3600.0, 4),
        "hot_Q_m3h": round(hot_q * 3600.0, 4),
        "cold_Q_m3h": round(cold_q * 3600.0, 4),
        "dP_kpa": round(max(float(hot.get("dP_kpa", 0.0)), float(cold.get("dP_kpa", 0.0))), 6),
        "hot_dP_kpa": round(float(hot.get("dP_kpa", 0.0)), 6),
        "cold_dP_kpa": round(float(cold.get("dP_kpa", 0.0)), 6),
        "heat_duty_kw": round(heat_w / 1000.0, 6),
        "UA_w_per_k": round(ua, 6),
        "effectiveness": round(effectiveness, 6),
        "hot_capacity_w_per_k": round(hot_c, 6),
        "cold_capacity_w_per_k": round(cold_c, 6),
        "hot_T_in_K": _round_temperature(hot_t_in),
        "hot_T_out_K": _round_temperature(hot_t_out),
        "cold_T_in_K": _round_temperature(cold_t_in),
        "cold_T_out_K": _round_temperature(cold_t_out),
        "regime": "twoFluidHeatExchanger",
        "v": 0.0,
        "Re": 0.0,
        "f": 0.0,
    }


def _reducer_areas(params: dict, q_m3s: float) -> tuple[float, float, float, float]:
    d_in = max(float(params.get("diameterIn", 100.0)) / 1000.0, 1e-9)
    d_out = max(float(params.get("diameterOut", 50.0)) / 1000.0, 1e-9)
    upstream_d = d_in if q_m3s >= 0 else d_out
    downstream_d = d_out if q_m3s >= 0 else d_in
    upstream_a = np.pi * upstream_d ** 2 / 4.0
    downstream_a = np.pi * downstream_d ** 2 / 4.0
    return upstream_d, downstream_d, upstream_a, downstream_a


def _reducer_loss_coefficient(params: dict, q_m3s: float) -> tuple[float, str]:
    mode = params.get("lossMode", "auto")
    upstream_d, downstream_d, upstream_a, downstream_a = _reducer_areas(params, q_m3s)
    if mode == "manual":
        return max(float(params.get("lossCoefficient", 0.5)), 0.0), "manual"

    small_a = min(upstream_a, downstream_a)
    large_a = max(upstream_a, downstream_a)
    beta_area = small_a / large_a if large_a > 0 else 1.0
    if downstream_d > upstream_d:
        zeta = (1.0 - beta_area) ** 2
        return max(zeta, 0.0), "expansion"

    beta_d = min(upstream_d, downstream_d) / max(upstream_d, downstream_d)
    contraction_cc = max(0.62 + 0.38 * beta_d ** 3, 1e-9)
    zeta = (1.0 / contraction_cc - 1.0) ** 2
    return max(zeta, 0.0), "contraction"


def _reducer_pressure_drop_kpa(params: dict, q_m3s: float, rho: float) -> float:
    _, _, upstream_a, downstream_a = _reducer_areas(params, q_m3s)
    ref_area = min(upstream_a, downstream_a)
    v_ref = abs(q_m3s) / ref_area if ref_area > 0 else 0.0
    zeta, _ = _reducer_loss_coefficient(params, q_m3s)
    return zeta * rho * v_ref ** 2 / 2.0 / 1000.0


def _reducer_flow_for_pressure_drop(params: dict, dp_kpa: float, rho: float) -> float:
    if dp_kpa <= 1e-12:
        return 0.0
    # ζ can change with direction, but not with flow magnitude for a fixed direction.
    zeta, _ = _reducer_loss_coefficient(params, 1.0)
    _, _, upstream_a, downstream_a = _reducer_areas(params, 1.0)
    ref_area = min(upstream_a, downstream_a)
    if zeta <= 1e-12 or ref_area <= 0:
        return 0.0
    return ref_area * np.sqrt(2.0 * dp_kpa * 1000.0 / (rho * zeta))


def _elbow_area(params: dict) -> float:
    diameter = max(float(params.get("diameter", 100.0)) / 1000.0, 1e-9)
    return np.pi * diameter ** 2 / 4.0


def _elbow_loss_coefficient(params: dict) -> tuple[float, str]:
    if params.get("elbowLossMode", params.get("lossMode", "auto")) == "manual":
        return max(float(params.get("lossCoefficient", 0.7)), 0.0), "manual"
    angle = max(float(params.get("angle", 90.0)), 0.0)
    zeta90 = max(float(params.get("zeta90", 0.75)), 0.0)
    exponent = max(float(params.get("angleExponent", 1.0)), 0.0)
    if angle <= 0 or zeta90 <= 0:
        return 0.0, "auto"
    return zeta90 * (angle / 90.0) ** exponent, "auto"


def _elbow_pressure_drop_kpa(params: dict, q_m3s: float, rho: float) -> float:
    area = _elbow_area(params)
    v = abs(q_m3s) / area if area > 0 else 0.0
    zeta, _ = _elbow_loss_coefficient(params)
    return zeta * rho * v ** 2 / 2.0 / 1000.0


def _elbow_flow_for_pressure_drop(params: dict, dp_kpa: float, rho: float) -> float:
    if dp_kpa <= 1e-12:
        return 0.0
    area = _elbow_area(params)
    zeta, _ = _elbow_loss_coefficient(params)
    if area <= 0 or zeta <= 1e-12:
        return 0.0
    return area * np.sqrt(2.0 * dp_kpa * 1000.0 / (rho * zeta))


def _valve_area(params: dict) -> float:
    diameter = max(float(params.get("diameter", 100.0)) / 1000.0, 1e-9)
    return np.pi * diameter ** 2 / 4.0


def _valve_relative_capacity(params: dict) -> tuple[float, str]:
    characteristic = str(params.get("valveCharacteristic", "linear"))
    opening = min(max(float(params.get("valveOpening", 100.0)), 0.0), 100.0) / 100.0
    if opening <= 0:
        return 1e-6, characteristic
    if characteristic == "quickOpening":
        return max(np.sqrt(opening), 1e-6), characteristic
    if characteristic == "equalPercentage":
        rangeability = max(float(params.get("valveRangeability", 50.0)), 1.000001)
        return max(rangeability ** (opening - 1.0), 1e-6), characteristic
    return max(opening, 1e-6), "linear"


def _valve_loss_coefficient(params: dict) -> tuple[float, float, str]:
    zeta_full_open = max(float(params.get("valveZetaFullOpen", 1.0)), 0.0)
    relative_capacity, characteristic = _valve_relative_capacity(params)
    if zeta_full_open <= 0:
        return 0.0, relative_capacity, characteristic
    return zeta_full_open / (relative_capacity ** 2), relative_capacity, characteristic


def _valve_pressure_drop_kpa(params: dict, q_m3s: float, rho: float) -> float:
    area = _valve_area(params)
    v = abs(q_m3s) / area if area > 0 else 0.0
    zeta, _, _ = _valve_loss_coefficient(params)
    return zeta * rho * v ** 2 / 2.0 / 1000.0


def _valve_flow_for_pressure_drop(params: dict, dp_kpa: float, rho: float) -> float:
    if dp_kpa <= 1e-12:
        return 0.0
    area = _valve_area(params)
    zeta, _, _ = _valve_loss_coefficient(params)
    if area <= 0 or zeta <= 1e-12:
        return 0.0
    return area * np.sqrt(2.0 * dp_kpa * 1000.0 / (rho * zeta))


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


def _pump_curve_points(params: dict) -> list[tuple[float, float]]:
    raw_points = params.get("pumpCurvePoints", [])
    points: list[tuple[float, float]] = []
    if isinstance(raw_points, list):
        for point in raw_points:
            if not isinstance(point, dict):
                continue
            try:
                q = float(point.get("q", point.get("flow", 0.0)))
                h = float(point.get("h", point.get("head", 0.0)))
            except (TypeError, ValueError):
                continue
            if q >= 0 and h >= 0:
                points.append((q, h))
    if len(points) < 2:
        q_rated = max(float(params.get("ratedFlow", 30.0)), 0.0)
        h_rated = max(float(params.get("ratedHead", 20.0)), 0.0)
        h_shutoff = max(float(params.get("shutoffHead", max(h_rated, 0.0))), 0.0)
        q_max = _pump_zero_head_flow(params)
        points = [(0.0, h_shutoff), (q_rated, h_rated), (q_max, 0.0)]

    return sorted(points, key=lambda p: p[0])


def _pump_zero_head_flow(params: dict) -> float:
    """基準回転数におけるH=0となる流量[m³/h]（相似則適用前の基準値）。"""
    q_rated = max(float(params.get("ratedFlow", 30.0)), 1e-9)
    h_rated = float(params.get("ratedHead", 20.0))
    h_shutoff = float(params.get("shutoffHead", max(h_rated, 0.0)))
    drop_at_rated = h_shutoff - h_rated
    if h_shutoff <= 0 or drop_at_rated <= 1e-9:
        return q_rated
    return q_rated * (h_shutoff / drop_at_rated) ** 0.5


def _pump_speed_ratio(params: dict) -> float:
    """現在回転数 / 基準回転数。基準回転数<=0なら1.0として扱う。"""
    rated_speed = float(params.get("ratedSpeed", 1450.0))
    if rated_speed <= 0:
        return 1.0
    speed = float(params.get("speed", rated_speed))
    return max(speed, 0.0) / rated_speed


def _pump_head_m_at_rated(params: dict, q_m3h: float) -> float:
    """基準回転数のPQ特性（簡易曲線 or テーブル）から揚程[m]を返す。"""
    if params.get("pumpCurveMode") == "table":
        points = _pump_curve_points(params)
        if len(points) >= 2:
            q = max(q_m3h, 0.0)
            if q <= points[0][0]:
                return points[0][1]
            for (q0, h0), (q1, h1) in zip(points, points[1:]):
                if q <= q1:
                    if abs(q1 - q0) < 1e-12:
                        return h1
                    t = (q - q0) / (q1 - q0)
                    return max(h0 + (h1 - h0) * t, 0.0)
            return points[-1][1]

    q_rated = max(float(params.get("ratedFlow", 30.0)), 1e-9)
    h_rated = float(params.get("ratedHead", 20.0))
    h_shutoff = float(params.get("shutoffHead", max(h_rated, 0.0)))
    h_max = max(h_shutoff, h_rated, 0.0)
    if h_max <= 0:
        return 0.0

    curve = max((h_shutoff - h_rated) / (q_rated ** 2), 0.0)
    if curve <= 1e-12:
        return h_max
    return max(h_shutoff - curve * (max(q_m3h, 0.0) ** 2), 0.0)


def _pump_head_m(params: dict, q_m3h: float) -> float:
    """PQ特性から揚程[m]を返す。ポンプ方向はIN→OUT固定。
    相似則 (Q∝N, H∝N²) で基準回転数の特性を現在回転数に変換する。
    """
    r = _pump_speed_ratio(params)
    if r <= 1e-9:
        return 0.0
    q_at_rated = max(q_m3h, 0.0) / r
    h_at_rated = _pump_head_m_at_rated(params, q_at_rated)
    return h_at_rated * r ** 2


def _pump_max_flow(params: dict) -> float:
    """現在回転数におけるH=0となる流量[m³/h]（相似則適用後）。"""
    r = _pump_speed_ratio(params)
    if params.get("pumpCurveMode") == "table":
        points = _pump_curve_points(params)
        q_at_rated = points[-1][0] if len(points) >= 2 else _pump_zero_head_flow(params)
    else:
        q_at_rated = _pump_zero_head_flow(params)
    return q_at_rated * r


def _pump_boost_kpa(params: dict, q_m3h: float, rho: float) -> float:
    return rho * 9.80665 * _pump_head_m(params, q_m3h) / 1000.0


def _pump_flow_for_required_boost(params: dict, boost_kpa: float, rho: float) -> float:
    """要求昇圧[kPa]に対応するポンプ流量[m³/s]を返す。逆流は許可しない。"""
    q_max = max(_pump_max_flow(params), 1e-9)
    boost_zero = _pump_boost_kpa(params, 0.0, rho)
    boost_max = _pump_boost_kpa(params, q_max, rho)

    if boost_kpa >= boost_zero:
        return 0.0
    if boost_kpa <= boost_max:
        return q_max / 3600.0

    def residual(q_m3h: float) -> float:
        return _pump_boost_kpa(params, q_m3h, rho) - boost_kpa

    return brentq(residual, 0.0, q_max, xtol=1e-9, maxiter=80) / 3600.0


def _calc_pump_segment(params: dict, q_m3s: float, rho: float) -> dict:
    q_m3h = max(q_m3s * 3600.0, 0.0)
    head_m = _pump_head_m(params, q_m3h)
    boost_kpa = _pump_boost_kpa(params, q_m3h, rho)
    hydraulic_power_kw = boost_kpa * q_m3s
    efficiency = max(float(params.get("efficiency", 70.0)), 1e-9) / 100.0
    shaft_power_kw = hydraulic_power_kw / efficiency
    rated_speed = max(float(params.get("ratedSpeed", 1450.0)), 1e-9)
    speed_rpm = max(float(params.get("speed", rated_speed)), 0.0)
    omega = 2.0 * math.pi * speed_rpm / 60.0
    shaft_torque_nm = shaft_power_kw * 1000.0 / omega if omega > 1e-12 else 0.0
    return {
        "Q_m3h": round(q_m3h, 4),
        "v": 0.0,
        "Re": 0.0,
        "f": 0.0,
        "dP_kpa": round(-boost_kpa, 4),
        "boost_kpa": round(boost_kpa, 4),
        "head_m": round(head_m, 4),
        "hydraulic_power_kw": round(hydraulic_power_kw, 6),
        "shaft_power_kw": round(shaft_power_kw, 6),
        "speed_rpm": round(speed_rpm, 6),
        "shaft_torque_nm": round(shaft_torque_nm, 6),
        "regime": "pump",
    }


def _turbine_head_m(params: dict, q_m3s: float) -> float:
    q_rated_m3s = max(float(params.get("ratedFlow", 30.0)) / 3600.0, 1e-12)
    h_rated = max(float(params.get("ratedHead", 20.0)), 0.0)
    return h_rated * (abs(q_m3s) / q_rated_m3s) ** 2


def _turbine_pressure_drop_kpa(params: dict, q_m3s: float, rho: float) -> float:
    return rho * 9.80665 * _turbine_head_m(params, q_m3s) / 1000.0


def _turbine_flow_for_pressure_drop(params: dict, dp_kpa: float, rho: float) -> float:
    h_rated = max(float(params.get("ratedHead", 20.0)), 1e-12)
    q_rated_m3s = max(float(params.get("ratedFlow", 30.0)) / 3600.0, 0.0)
    target_head = max(dp_kpa, 0.0) * 1000.0 / max(rho * 9.80665, 1e-12)
    return q_rated_m3s * (target_head / h_rated) ** 0.5


def _calc_turbine_segment(params: dict, q_m3s: float, rho: float) -> dict:
    q_abs = abs(q_m3s)
    head_m = _turbine_head_m(params, q_m3s)
    dP_kpa = _turbine_pressure_drop_kpa(params, q_m3s, rho)
    extracted_power_kw = dP_kpa * q_abs
    efficiency = max(float(params.get("efficiency", 85.0)), 0.0) / 100.0
    output_power_kw = extracted_power_kw * efficiency
    rated_speed = max(float(params.get("ratedSpeed", 1450.0)), 1e-9)
    speed_rpm = max(float(params.get("speed", rated_speed)), 0.0)
    omega = 2.0 * math.pi * speed_rpm / 60.0
    shaft_torque_nm = output_power_kw * 1000.0 / omega if omega > 1e-12 else 0.0
    return {
        "Q_m3h": round(q_m3s * 3600.0, 4),
        "v": 0.0,
        "Re": 0.0,
        "f": 0.0,
        "dP_kpa": round(dP_kpa, 6),
        "head_m": round(head_m, 6),
        "extracted_power_kw": round(extracted_power_kw, 6),
        "output_power_kw": round(output_power_kw, 6),
        "speed_rpm": round(speed_rpm, 6),
        "shaft_torque_nm": round(shaft_torque_nm, 6),
        "regime": "turbine",
    }


def _calc_heat_exchanger_segment(
    params: dict,
    q_m3s: float,
    rho: float,
    mu: float,
    method: str,
) -> dict:
    return {
        "Q_m3h": round(q_m3s * 3600.0, 4),
        "v": 0.0,
        "Re": 0.0,
        "f": 0.0,
        "dP_kpa": round(_heat_exchanger_pressure_drop_kpa(params, q_m3s), 6),
        "regime": "heatExchanger",
        "exchange_temperature_K": round(float(params.get("exchangeTemperature", DEFAULT_TEMPERATURE_K)), 3),
        "heat_transfer_coeff_w_m2_k": round(float(params.get("heatTransferCoeff", 500.0)), 6),
        "heat_transfer_area_m2": round(float(params.get("heatTransferArea", 10.0)), 6),
        "rated_flow_m3h": round(float(params.get("ratedFlow", 10.0)), 6),
        "nominal_pressure_drop_kpa": round(float(params.get("nominalPressureDrop", 10.0)), 6),
    }


def _calc_reducer_segment(params: dict, q_m3s: float, rho: float) -> dict:
    upstream_d, downstream_d, upstream_a, downstream_a = _reducer_areas(params, q_m3s)
    ref_area = min(upstream_a, downstream_a)
    v_ref = abs(q_m3s) / ref_area if ref_area > 0 else 0.0
    zeta, reducer_kind = _reducer_loss_coefficient(params, q_m3s)
    return {
        "Q_m3h": round(q_m3s * 3600.0, 4),
        "v": round(np.sign(q_m3s) * v_ref, 4),
        "Re": 0.0,
        "f": 0.0,
        "dP_kpa": round(_reducer_pressure_drop_kpa(params, q_m3s, rho), 6),
        "regime": "reducer",
        "diameter_in_mm": round(float(params.get("diameterIn", 100.0)), 6),
        "diameter_out_mm": round(float(params.get("diameterOut", 50.0)), 6),
        "upstream_diameter_mm": round(upstream_d * 1000.0, 6),
        "downstream_diameter_mm": round(downstream_d * 1000.0, 6),
        "loss_coefficient": round(zeta, 6),
        "loss_mode": params.get("lossMode", "auto"),
        "reducer_kind": reducer_kind,
    }


def _calc_elbow_segment(params: dict, q_m3s: float, rho: float) -> dict:
    area = _elbow_area(params)
    v = abs(q_m3s) / area if area > 0 else 0.0
    zeta, mode = _elbow_loss_coefficient(params)
    return {
        "Q_m3h": round(q_m3s * 3600.0, 4),
        "v": round(np.sign(q_m3s) * v, 4),
        "Re": 0.0,
        "f": 0.0,
        "dP_kpa": round(_elbow_pressure_drop_kpa(params, q_m3s, rho), 6),
        "regime": "elbow",
        "diameter_mm": round(float(params.get("diameter", 100.0)), 6),
        "angle_deg": round(float(params.get("angle", 90.0)), 6),
        "loss_coefficient": round(zeta, 6),
        "loss_mode": mode,
        "zeta90": round(float(params.get("zeta90", 0.75)), 6),
    }


def _calc_valve_segment(params: dict, q_m3s: float, rho: float) -> dict:
    area = _valve_area(params)
    v = abs(q_m3s) / area if area > 0 else 0.0
    zeta, relative_capacity, characteristic = _valve_loss_coefficient(params)
    return {
        "Q_m3h": round(q_m3s * 3600.0, 4),
        "v": round(np.sign(q_m3s) * v, 4),
        "Re": 0.0,
        "f": 0.0,
        "dP_kpa": round(_valve_pressure_drop_kpa(params, q_m3s, rho), 6),
        "regime": "valve",
        "diameter_mm": round(float(params.get("diameter", 100.0)), 6),
        "loss_coefficient": round(zeta, 6),
        "valve_zeta_full_open": round(float(params.get("valveZetaFullOpen", 1.0)), 6),
        "valve_opening_percent": round(min(max(float(params.get("valveOpening", 100.0)), 0.0), 100.0), 6),
        "valve_relative_capacity": round(relative_capacity, 6),
        "valve_characteristic": characteristic,
        "valve_rangeability": round(float(params.get("valveRangeability", 50.0)), 6),
    }


def _component_pressure_delta_kpa(kind: str, params: dict, q_m3s: float, rho: float, mu: float, method: str) -> float:
    if kind in ("twoFluidHeatExchanger:hot", "twoFluidHeatExchanger:cold"):
        return _two_fluid_side_pressure_drop_kpa(params, kind.split(":", 1)[1], q_m3s)
    if kind == "pump":
        return -_pump_boost_kpa(params, abs(q_m3s) * 3600.0, rho)
    if kind == "turbine":
        return _turbine_pressure_drop_kpa(params, q_m3s, rho)
    if kind == "heatExchanger":
        return _heat_exchanger_pressure_drop_kpa(params, q_m3s)
    if kind == "reducer":
        return _reducer_pressure_drop_kpa(params, q_m3s, rho)
    if kind == "elbow":
        return _elbow_pressure_drop_kpa(params, q_m3s, rho)
    if kind == "valve":
        return _valve_pressure_drop_kpa(params, q_m3s, rho)
    return _calc_pipe_segment(params, q_m3s, rho, mu, method)["dP_kpa"]


def _component_flow_for_pressure_delta(kind: str, params: dict, dp_kpa: float, rho: float, mu: float, method: str) -> float:
    if kind in ("twoFluidHeatExchanger:hot", "twoFluidHeatExchanger:cold"):
        return _two_fluid_side_flow_for_pressure_drop(params, kind.split(":", 1)[1], abs(dp_kpa))
    if kind == "pump":
        return _pump_flow_for_required_boost(params, dp_kpa, rho)
    if kind == "turbine":
        return _turbine_flow_for_pressure_drop(params, abs(dp_kpa), rho)
    if kind == "heatExchanger":
        return _heat_exchanger_flow_for_pressure_drop(params, abs(dp_kpa))
    if kind == "reducer":
        return _reducer_flow_for_pressure_drop(params, abs(dp_kpa), rho)
    if kind == "elbow":
        return _elbow_flow_for_pressure_drop(params, abs(dp_kpa), rho)
    if kind == "valve":
        return _valve_flow_for_pressure_drop(params, abs(dp_kpa), rho)
    return _pipe_flow_for_pressure_drop(params, abs(dp_kpa), rho, mu, method)


def _component_result(kind: str, params: dict, q_m3s: float, rho: float, mu: float, method: str) -> dict:
    if kind in ("twoFluidHeatExchanger:hot", "twoFluidHeatExchanger:cold"):
        return _calc_two_fluid_side_segment(params, kind.split(":", 1)[1], q_m3s)
    if kind == "pump":
        return _calc_pump_segment(params, q_m3s, rho)
    if kind == "turbine":
        return _calc_turbine_segment(params, q_m3s, rho)
    if kind == "heatExchanger":
        return _calc_heat_exchanger_segment(params, q_m3s, rho, mu, method)
    if kind == "reducer":
        return _calc_reducer_segment(params, q_m3s, rho)
    if kind == "elbow":
        return _calc_elbow_segment(params, q_m3s, rho)
    if kind == "valve":
        return _calc_valve_segment(params, q_m3s, rho)
    return _calc_pipe_segment(params, q_m3s, rho, mu, method)


def _apply_boundary_temperatures(
    req: PipeNetworkRequest,
    nodes_dict: dict[str, PipeNetworkNode],
    point_for_node: dict[str, str],
    links: list[dict[str, Any]],
    link_flows: dict[str, float],
    results: dict[str, Any],
    fluid: dict[str, Any] | None = None,
) -> tuple[dict[str, float], dict[str, float]]:
    """Attach isothermal temperatures to network results based on upstream flow direction."""
    point_temps: dict[str, float] = {}
    boundary_temps: dict[str, float] = {}
    boundary_mixed: dict[str, list[tuple[float, float]]] = defaultdict(list)

    for node in req.nodes:
        if node.node_type in BOUNDARY_NODE_TYPES:
            p_id = point_for_node.get(node.id)
            if p_id is None:
                continue
            temp = _node_temperature_k(node)
            boundary_temps[node.id] = round(temp, 3)
            if _boundary_type(node.params) == "flow":
                q_weight = abs(float(node.params.get("flowRate", 0.0)))
                if q_weight > 1e-12:
                    boundary_mixed[p_id].append((q_weight, temp))
            else:
                point_temps.setdefault(p_id, temp)

    for p_id, contributions in boundary_mixed.items():
        total_q = sum(q for q, _ in contributions)
        if total_q > 1e-12:
            point_temps[p_id] = sum(q * t for q, t in contributions) / total_q

    for _ in range(len(links) + len(point_temps) + 1):
        changed = False
        mixed: dict[str, list[tuple[float, float]]] = defaultdict(list)

        for link in links:
            q = link_flows.get(link["id"], 0.0)
            if abs(q) < 1e-12:
                continue
            up = link["a"] if q >= 0 else link["b"]
            down = link["b"] if q >= 0 else link["a"]
            t_up = point_temps.get(up)
            if t_up is None:
                continue
            seg = results.get(link["id"], {})
            if link["kind"] == "heatExchanger":
                heat = _heat_exchange_state(
                    link["params"],
                    q,
                    float((fluid or {}).get("density", req.density)),
                    t_up,
                    float((fluid or {}).get("specificHeat", DEFAULT_SPECIFIC_HEAT_J_KG_K)),
                )
                seg.update(heat)
                t_down = heat["T_out_K"]
            else:
                seg["T_in_K"] = _round_temperature(t_up)
                seg["T_out_K"] = _round_temperature(t_up)
                t_down = t_up
            mixed[down].append((abs(q), t_down))

        for pid, contributions in mixed.items():
            total_q = sum(q for q, _ in contributions)
            if total_q <= 1e-12:
                continue
            mixed_temp = sum(q * t for q, t in contributions) / total_q
            if pid not in point_temps or abs(point_temps[pid] - mixed_temp) > 1e-9:
                point_temps[pid] = mixed_temp
                changed = True

        if not changed:
            break

    source_temperatures: dict[str, float] = {}
    for node in req.nodes:
        p_id = point_for_node.get(node.id)
        if p_id is None:
            continue
        temp = point_temps.get(p_id, boundary_temps.get(node.id))
        rounded = _round_temperature(temp)
        if rounded is None:
            continue
        if node.node_type in BOUNDARY_NODE_TYPES:
            source_temperatures[node.id] = rounded
        if node.id in results:
            results[node.id]["T_K"] = rounded

    return source_temperatures, boundary_temps


def _solve_boundary_network(
    req: PipeNetworkRequest,
    nodes_dict: dict[str, PipeNetworkNode],
    outgoing: dict[str, list[tuple[str, str | None]]],
    incoming: dict[str, list[tuple[str, str | None]]],
    fluid: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """圧力固定・流量固定の境界条件を節点圧から解く。"""
    rho = float((fluid or {}).get("density", req.density))
    mu = float((fluid or {}).get("viscosity", req.viscosity))

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

    def two_fluid_side_from_handle(handle: str | None) -> str:
        text = handle or ""
        return "cold" if text.startswith("cold") else "hot"

    def node_point(nid: str, outgoing_side: bool, handle: str | None = None) -> str:
        node = nodes_dict[nid]
        if node.node_type in TWO_PORT_NODE_TYPES:
            return f"{nid}:out" if outgoing_side else f"{nid}:in"
        if node.node_type in TWO_FLUID_HEAT_EXCHANGER_NODE_TYPES:
            side = two_fluid_side_from_handle(handle)
            if outgoing_side:
                return f"{nid}:{side}:out"
            return f"{nid}:{side}:in"
        return nid

    for n in req.nodes:
        if n.node_type in TWO_PORT_NODE_TYPES:
            add_point(f"{n.id}:in")
            add_point(f"{n.id}:out")
        elif n.node_type in TWO_FLUID_HEAT_EXCHANGER_NODE_TYPES:
            add_point(f"{n.id}:hot:in")
            add_point(f"{n.id}:hot:out")
            add_point(f"{n.id}:cold:in")
            add_point(f"{n.id}:cold:out")
        elif n.node_type in BOUNDARY_NODE_TYPES or n.node_type == "tee":
            add_point(n.id)

    connected_points: set[str] = set()
    for e in (edge for edge in req.edges if edge.line_type == "fluid"):
        source_point = node_point(e.source, outgoing_side=True, handle=e.source_handle)
        target_point = node_point(e.target, outgoing_side=False, handle=e.target_handle)
        connected_points.add(source_point)
        connected_points.add(target_point)
        union(
            source_point,
            target_point,
        )

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
    for elem in (n for n in req.nodes if n.node_type in TWO_PORT_NODE_TYPES):
        if not outgoing.get(elem.id) and not incoming.get(elem.id):
            continue
        a = find(f"{elem.id}:in")
        b = find(f"{elem.id}:out")
        if a == b:
            continue
        links.append({"id": elem.id, "kind": elem.node_type, "a": a, "b": b, "params": elem.params})

    for elem in (n for n in req.nodes if n.node_type in TWO_FLUID_HEAT_EXCHANGER_NODE_TYPES):
        for side in ("hot", "cold"):
            if f"{elem.id}:{side}:in" not in connected_points and f"{elem.id}:{side}:out" not in connected_points:
                continue
            a = find(f"{elem.id}:{side}:in")
            b = find(f"{elem.id}:{side}:out")
            if a == b:
                continue
            links.append({
                "id": f"{elem.id}:{side}",
                "node_id": elem.id,
                "side": side,
                "kind": f"twoFluidHeatExchanger:{side}",
                "a": a,
                "b": b,
                "params": elem.params,
            })

    if not links:
        raise HTTPException(status_code=400, detail="圧力境界計算には2ポート要素が少なくとも1つ必要です")

    junction_ids = sorted({pid for link in links for pid in (link["a"], link["b"])})
    unknown_ids = [pid for pid in junction_ids if pid not in fixed_p]

    def pressure_map(x: np.ndarray) -> dict[str, float]:
        p = dict(fixed_p)
        p.update({nid: float(x[i]) for i, nid in enumerate(unknown_ids)})
        return p

    def signed_link_flow(link: dict[str, Any], p: dict[str, float]) -> float:
        if link["kind"] == "pump":
            required_boost = p[link["b"]] - p[link["a"]]
            return _component_flow_for_pressure_delta(link["kind"], link["params"], required_boost, rho, mu, req.friction_method)

        dp = p[link["a"]] - p[link["b"]]
        q_abs = _component_flow_for_pressure_delta(link["kind"], link["params"], abs(dp), rho, mu, req.friction_method)
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
                if link["kind"] == "pump":
                    boost_est = -_component_pressure_delta_kpa(link["kind"], link["params"], q, rho, mu, req.friction_method)
                    p_from = p_next - boost_est
                else:
                    dp_est = _component_pressure_delta_kpa(link["kind"], link["params"], q, rho, mu, req.friction_method)
                    p_from = p_next + (dp_est if q > 0 else -dp_est)
                initial_p.setdefault(from_id, p_from)
                p_next = p_from

        def initial_pressure(nid: str) -> float:
            if nid in initial_p:
                return initial_p[nid]
            q = fixed_q.get(nid, 0.0)
            adjacent = next((link for link in links if link["a"] == nid or link["b"] == nid), None)
            if adjacent is None:
                return mean_p
            if adjacent["kind"] == "pump":
                q_est_m3h = abs(q) * 3600.0
                if q_est_m3h < 1e-9:
                    q_est_m3h = _pump_max_flow(adjacent["params"]) * 0.95
                dp_est = _pump_boost_kpa(adjacent["params"], q_est_m3h, rho)
                return mean_p - dp_est if adjacent["a"] == nid else mean_p + dp_est
            if abs(q) < 1e-12:
                return mean_p
            dp_est = _component_pressure_delta_kpa(adjacent["kind"], adjacent["params"], q, rho, mu, req.friction_method)
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
        seg = _component_result(link["kind"], link["params"], q, rho, mu, req.friction_method)
        seg.update({
            "P_from_kpa": round(p_a, 4),
            "P_to_kpa": round(p_b, 4),
            "P_in_kpa": round(p_a if link["kind"] == "pump" else max(p_a, p_b), 4),
            "P_out_kpa": round(p_b if link["kind"] == "pump" else min(p_a, p_b), 4),
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

    point_for_node = {
        n.id: find(n.id)
        for n in req.nodes
        if n.node_type in BOUNDARY_NODE_TYPES or n.node_type == "tee"
    }
    source_temperatures, boundary_temperatures = _apply_boundary_temperatures(
        req, nodes_dict, point_for_node, links, link_flows, results, fluid
    )

    return {
        "nodes": results,
        "source_pressures": source_pressures,
        "source_flows": source_flows,
        "source_temperatures": source_temperatures,
        "boundary_temperatures": boundary_temperatures,
    }


def _solve_multi_fluid_network(req: PipeNetworkRequest) -> dict[str, Any]:
    systems = _fluid_system_map(req)
    default_id = next(iter(systems))
    node_system = {
        n.id: _node_fluid_system_id(n, default_id)
        for n in req.nodes
    }

    def node_in_system(node: PipeNetworkNode, fs_id: str) -> bool:
        if node.node_type == "twoFluidHeatExchanger":
            return (
                str(node.params.get("hotFluidSystemId", default_id)) == fs_id
                or str(node.params.get("coldFluidSystemId", default_id)) == fs_id
            )
        return node_system.get(node.id) == fs_id

    def edge_in_system(edge: PipeNetworkEdge, fs_id: str) -> bool:
        source = next((n for n in req.nodes if n.id == edge.source), None)
        target = next((n for n in req.nodes if n.id == edge.target), None)
        node = source if source and source.node_type == "twoFluidHeatExchanger" else target if target and target.node_type == "twoFluidHeatExchanger" else None
        if node is None:
            return edge.source in sub_node_ids and edge.target in sub_node_ids
        handle = edge.source_handle if node.id == edge.source else edge.target_handle
        side = "cold" if (handle or "").startswith("cold") else "hot"
        key = "coldFluidSystemId" if side == "cold" else "hotFluidSystemId"
        return str(node.params.get(key, default_id)) == fs_id

    combined = {
        "nodes": {},
        "source_pressures": {},
        "source_flows": {},
        "source_temperatures": {},
        "boundary_temperatures": {},
        "fluid_systems": systems,
    }

    for fs_id, fluid in systems.items():
        sub_node_ids = {n.id for n in req.nodes if node_in_system(n, fs_id)}
        sub_nodes = []
        for n in req.nodes:
            if n.id not in sub_node_ids:
                continue
            params = dict(n.params)
            params.setdefault("specificHeat", float(fluid["specificHeat"]))
            sub_nodes.append(PipeNetworkNode(id=n.id, node_type=n.node_type, params=params))
        sub_edges = [
            e for e in req.edges
            if e.line_type == "fluid" and e.source in sub_node_ids and e.target in sub_node_ids and edge_in_system(e, fs_id)
        ]

        has_boundary = any(n.node_type in BOUNDARY_NODE_TYPES for n in sub_nodes)
        has_two_port = any(n.node_type in TWO_PORT_NODE_TYPES or n.node_type in TWO_FLUID_HEAT_EXCHANGER_NODE_TYPES for n in sub_nodes)
        if not sub_nodes or not sub_edges or not has_boundary or not has_two_port:
            continue

        sub_req = PipeNetworkRequest(
            nodes=sub_nodes,
            edges=sub_edges,
            density=float(fluid["density"]),
            viscosity=float(fluid["viscosity"]),
            friction_method=req.friction_method,
        )
        try:
            sub_result = calc_pipe_network(sub_req)
        except HTTPException as exc:
            name = fluid.get("name") or fs_id
            raise HTTPException(status_code=exc.status_code, detail=f"{name}: {exc.detail}") from exc

        for key in ("nodes", "source_pressures", "source_flows", "source_temperatures", "boundary_temperatures"):
            combined[key].update(sub_result.get(key, {}))

    for n in (node for node in req.nodes if node.node_type == "twoFluidHeatExchanger"):
        hot = combined["nodes"].pop(f"{n.id}:hot", None)
        cold = combined["nodes"].pop(f"{n.id}:cold", None)
        hot_fs = systems.get(str(n.params.get("hotFluidSystemId", default_id)), systems[default_id])
        cold_fs = systems.get(str(n.params.get("coldFluidSystemId", default_id)), systems[default_id])
        if hot or cold:
            combined["nodes"][n.id] = _two_fluid_heat_exchange_result(n.params, hot, cold, hot_fs, cold_fs)

    return combined


@app.post("/pipe-network")
def calc_pipe_network(req: PipeNetworkRequest):
    """パイプネットワーク圧損計算。
    境界条件:
      flow   型 … Q固定 → 必要圧力を逆算（ソース）またはQ到達量を表示（シンク）
      pressure 型 … P固定 → 通過流量を逆算（ソース）または背圧として使用（シンク）
    逆流: Q が負になることで表現。ΔP は常に正（エネルギー散逸の大きさ）。
    マージノード: 複数入力が揃ってから処理するトポロジカル BFS。
    """
    if req.fluidSystems:
        return _solve_multi_fluid_network(req)

    nodes_dict = {n.id: n for n in req.nodes}
    outgoing: dict[str, list[tuple[str, str | None]]] = defaultdict(list)
    incoming: dict[str, list[tuple[str, str | None]]] = defaultdict(list)
    for e in (edge for edge in req.edges if edge.line_type == "fluid"):
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
    for e in (edge for edge in req.edges if edge.line_type == "fluid"):
        global_in_deg[e.target] += 1

    rho, mu = req.density, req.viscosity
    results: dict[str, Any] = {}
    source_pressures: dict[str, float] = {}  # src.id → 入口圧力 kPa
    source_flows: dict[str, float] = {}      # src.id → 流量 m³/h (符号付き)
    source_temperatures: dict[str, float] = {}
    boundary_temperatures: dict[str, float] = {
        n.id: round(_node_temperature_k(n), 3)
        for n in req.nodes
        if n.node_type in BOUNDARY_NODE_TYPES
    }

    for src in (n for n in req.nodes if n.node_type == "source" or (n.node_type == "boundary" and _boundary_type(n.params) == "flow")):
        btype = _boundary_type(src.params)
        T_src = _node_temperature_k(src)
        source_temperatures[src.id] = round(T_src, 3)

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
        pending_TQ: dict[str, float] = defaultdict(float)
        pending_TW: dict[str, float] = defaultdict(float)

        def _enqueue(queue_: list, tid: str, q_in: float, dp_in: float, temp_in: float) -> None:
            """全入力が揃ったタイミングでキューへ追加する。"""
            pending_Q[tid] += q_in
            temp_weight = max(abs(q_in), 1e-12)
            pending_TQ[tid] += temp_weight * temp_in
            pending_TW[tid] += temp_weight
            if tid not in pending_dp:
                pending_dp[tid] = dp_in
            remaining[tid] = remaining.get(tid, 1) - 1
            if remaining.get(tid, 0) <= 0:
                mixed_temp = pending_TQ[tid] / pending_TW[tid] if pending_TW[tid] > 0 else temp_in
                queue_.append((tid, pending_Q[tid], pending_dp[tid], mixed_temp))

        bfs: list[tuple[str, float, float, float]] = []
        for tid, _ in outgoing.get(src.id, []):
            _enqueue(bfs, tid, Q_total, 0.0, T_src)

        while bfs:
            nid, Q, cum_dp, T_in = bfs.pop(0)
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
                    prev_q = abs(float(results[nid]["Q_m3h"])) / 3600.0
                    curr_q = abs(Q)
                    prev_t = float(results[nid].get("T_K", T_in))
                    total_w = prev_q + curr_q
                    results[nid]["T_K"] = _round_temperature((prev_q * prev_t + curr_q * T_in) / total_w if total_w > 0 else T_in)
                    results[nid]["Q_m3h"] = round(results[nid]["Q_m3h"] + Q * 3600, 4)
                else:
                    results[nid] = {
                        "Q_m3h": round(Q * 3600, 4),
                        "P_kpa": round(sink_p, 4),
                        "T_K": _round_temperature(T_in),
                        "_cum_dp": round(cum_dp, 6),
                        "v": 0.0, "Re": 0.0, "f": 0.0, "dP_kpa": 0.0,
                        "regime": "boundary" if node.node_type == "boundary" else "sink",
                    }
                continue

            # ── 2ポート要素 ─────────────────────────────────────────────
            next_cum_dp = cum_dp
            T_out = T_in
            if node.node_type in ("pipe", "turbine", "heatExchanger", "reducer", "elbow", "valve"):
                seg = _component_result(node.node_type, node.params, Q, rho, mu, req.friction_method)
                if node.node_type == "heatExchanger":
                    heat = _heat_exchange_state(node.params, Q, rho, T_in)
                    seg.update(heat)
                    T_out = heat["T_out_K"]
                else:
                    seg["T_in_K"] = _round_temperature(T_in)
                    seg["T_out_K"] = _round_temperature(T_in)
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
            if node.node_type == "tee" and node.params.get("teeMode", "split") != "merge" and n_down >= 2:
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
                    "T_K": _round_temperature(T_in),
                    "_cum_dp": round(next_cum_dp, 6),
                    "v": 0.0, "Re": 0.0, "f": 0.0, "dP_kpa": 0.0, "regime": "split",
                }
                _enqueue(bfs, tid1, q1_opt, next_cum_dp, T_out)
                _enqueue(bfs, tid2, q2_opt, next_cum_dp, T_out)
            else:
                if node.node_type == "tee":
                    results[nid] = {
                        "Q_m3h": round(Q * 3600, 4),
                        "T_K": _round_temperature(T_in),
                        "_cum_dp": round(next_cum_dp, 6),
                        "v": 0.0, "Re": 0.0, "f": 0.0, "dP_kpa": 0.0, "regime": "junction",
                    }
                for tid, _ in downstream:
                    _enqueue(bfs, tid, Q, next_cum_dp, T_out)

        # ── 流量シンクの入口圧力を後処理で算出 ─────────────────────────
        P_src_kpa = source_pressures.get(src.id, 0.0)
        for nid, r in results.items():
            if r.get("regime") in ("laminar", "transitional", "turbulent", "turbine", "heatExchanger", "reducer", "elbow", "valve"):
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
            if r.get("regime") == "junction" and "_cum_dp" in r:
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

    return {
        "nodes": results,
        "source_pressures": source_pressures,
        "source_flows": source_flows,
        "source_temperatures": source_temperatures,
        "boundary_temperatures": boundary_temperatures,
    }


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


class StageSpec(BaseModel):
    propellant_mass: float             # 推進剤質量 [kg]
    dry_mass: float                    # 段構造質量（推進剤を除く、分離時に投棄）[kg]
    oxidizer: str = "LOX"              # 酸化剤
    fuel: str = "LCH4"                 # 燃料
    thrust: float                      # 推力 [N]（燃焼中一定）
    burn_time: float                   # 燃焼時間 [s]


class LaunchRequest(BaseModel):
    stages: list[StageSpec] = Field(default_factory=lambda: [
        StageSpec(propellant_mass=300.0, dry_mass=150.0, thrust=12000.0, burn_time=20.0),
    ])
    payload_mass: float = 50.0         # ペイロード質量 [kg]
    launch_angle: float = 90.0         # 発射角度（水平からの角度）[deg]、90=垂直
    drag_enabled: bool = False
    drag_coefficient: float = 0.5
    cross_section_area: float = 0.3    # 機体投影面積 [m²]
    duration: float = 300.0            # シミュレーション最大時間 [s]
    dt: float = 0.1


@app.post("/launch/simulate")
def simulate_launch(req: LaunchRequest):
    """機体質量・推力から弾道軌道を計算する（点質量・重力一定の簡易モデル）。
    各段は順番に燃焼し、燃焼終了時に段の構造質量（dry_mass）を投棄して次の段に進む。
    全段燃焼後は無動力（慣性飛行）として計算を続ける。
    推力方向は発射角度に固定（姿勢変化・重力旋回は未対応）。
    """
    if not req.stages:
        raise HTTPException(status_code=400, detail="少なくとも1段を設定してください")
    for i, stage in enumerate(req.stages, start=1):
        if stage.propellant_mass <= 0 or stage.dry_mass < 0:
            raise HTTPException(status_code=400, detail=f"第{i}段の質量設定が不正です")
        if stage.thrust <= 0 or stage.burn_time <= 0:
            raise HTTPException(status_code=400, detail=f"第{i}段の推力・燃焼時間は正の値を入力してください")
    if req.payload_mass < 0:
        raise HTTPException(status_code=400, detail="ペイロード質量は0以上を入力してください")
    if req.duration <= 0 or req.dt <= 0:
        raise HTTPException(status_code=400, detail="シミュレーション時間・刻み幅は正の値を入力してください")

    g0 = 9.80665
    angle_rad = np.radians(req.launch_angle)
    initial_mass = sum(s.propellant_mass + s.dry_mass for s in req.stages) + req.payload_mass

    thrust_vertical = req.stages[0].thrust * np.sin(angle_rad)
    weight0 = initial_mass * g0
    if thrust_vertical <= weight0:
        raise HTTPException(
            status_code=400,
            detail=(
                f"第1段推力の鉛直成分（{thrust_vertical:.0f} N）が機体重量（{weight0:.0f} N）以下のため離床できません"
            ),
        )

    rho0 = 1.225       # 海面大気密度 [kg/m³]
    H_scale = 8500.0   # 大気スケール高度 [m]
    Cd = req.drag_coefficient
    A = req.cross_section_area

    def make_ode(thrust: float, mdot: float, burning: bool):
        def ode(t: float, state: list[float]) -> list[float]:
            x, y, vx, vy, m = state
            Fx = thrust * np.cos(angle_rad) if burning else 0.0
            Fy = thrust * np.sin(angle_rad) if burning else 0.0

            drag_x = drag_y = 0.0
            if req.drag_enabled:
                speed = float(np.hypot(vx, vy))
                if speed > 1e-9:
                    rho = rho0 * np.exp(-max(y, 0.0) / H_scale)
                    Fd = 0.5 * rho * Cd * A * speed ** 2
                    drag_x = -Fd * vx / speed
                    drag_y = -Fd * vy / speed

            ax = (Fx + drag_x) / m
            ay = (Fy + drag_y) / m - g0
            dm = -mdot if burning else 0.0
            return [vx, vy, ax, ay, dm]
        return ode

    def hit_ground(t: float, state: list[float]) -> float:
        return state[1]
    hit_ground.terminal = True
    hit_ground.direction = -1

    t_all: list[float] = [0.0]
    x_all: list[float] = [0.0]
    y_all: list[float] = [0.0]
    vx_all: list[float] = [0.0]
    vy_all: list[float] = [0.0]
    m_all: list[float] = [initial_mass]

    state = [0.0, 0.0, 0.0, 0.0, initial_mass]
    t_cursor = 0.0
    remaining = req.duration
    landed = False
    delta_v_total = 0.0
    stage_burnouts: list[dict] = []

    for stage_idx, stage in enumerate(req.stages, start=1):
        if landed or remaining <= 1e-9:
            break

        span = min(stage.burn_time, remaining)
        mdot = stage.propellant_mass / stage.burn_time
        mass_before_burn = state[4]
        n_steps = max(int(np.ceil(span / req.dt)), 1)
        t_eval = np.linspace(0.0, span, n_steps + 1)

        try:
            sol = solve_ivp(
                make_ode(stage.thrust, mdot, True), (0.0, span), state,
                t_eval=t_eval, method="RK45", events=hit_ground,
                max_step=req.dt, rtol=1e-6, atol=1e-9,
            )
        except Exception as ex:
            raise HTTPException(status_code=500, detail=f"計算エラー: {ex}")
        if not sol.success:
            raise HTTPException(status_code=500, detail=f"ODE 未収束: {sol.message}")

        t_all.extend((t_cursor + sol.t[1:]).tolist())
        x_all.extend(sol.y[0][1:].tolist())
        y_all.extend(sol.y[1][1:].tolist())
        vx_all.extend(sol.y[2][1:].tolist())
        vy_all.extend(sol.y[3][1:].tolist())
        m_all.extend(sol.y[4][1:].tolist())

        mass_at_burnout = float(sol.y[4][-1])
        ve = stage.thrust / mdot  # 有効排気速度 [m/s]
        delta_v_total += ve * float(np.log(mass_before_burn / mass_at_burnout))
        stage_burnouts.append({
            "stage_index": stage_idx,
            "time_s": round(t_cursor + float(sol.t[-1]), 2),
            "altitude_m": round(float(sol.y[1][-1]), 2),
            "speed_ms": round(float(np.hypot(sol.y[2][-1], sol.y[3][-1])), 2),
            "mass_kg": round(mass_at_burnout, 2),
        })

        if len(sol.t_events[0]) > 0:
            landed = True
            break

        t_cursor += float(sol.t[-1])
        remaining -= float(sol.t[-1])
        # 段分離: 燃焼を終えた段の構造質量を投棄
        state = [
            float(sol.y[0][-1]), float(sol.y[1][-1]),
            float(sol.y[2][-1]), float(sol.y[3][-1]),
            mass_at_burnout - stage.dry_mass,
        ]

    if not landed and remaining > 1e-9:
        n_steps = max(int(np.ceil(remaining / req.dt)), 1)
        t_eval = np.linspace(0.0, remaining, n_steps + 1)
        try:
            sol = solve_ivp(
                make_ode(0.0, 0.0, False), (0.0, remaining), state,
                t_eval=t_eval, method="RK45", events=hit_ground,
                max_step=req.dt, rtol=1e-6, atol=1e-9,
            )
        except Exception as ex:
            raise HTTPException(status_code=500, detail=f"計算エラー: {ex}")
        if not sol.success:
            raise HTTPException(status_code=500, detail=f"ODE 未収束: {sol.message}")

        t_all.extend((t_cursor + sol.t[1:]).tolist())
        x_all.extend(sol.y[0][1:].tolist())
        y_all.extend(sol.y[1][1:].tolist())
        vx_all.extend(sol.y[2][1:].tolist())
        vy_all.extend(sol.y[3][1:].tolist())
        m_all.extend(sol.y[4][1:].tolist())
        if len(sol.t_events[0]) > 0:
            landed = True

    x = np.array(x_all)
    y = np.clip(np.array(y_all), 0.0, None)
    vx = np.array(vx_all)
    vy = np.array(vy_all)
    m = np.array(m_all)
    t = np.array(t_all)
    speed = np.hypot(vx, vy)
    apogee_idx = int(np.argmax(y))

    # 浮動小数点誤差（例: 90°での cos が厳密に0でない）由来の極小値を丸めて除去
    return {
        "time": np.round(t, 6).tolist(),
        "x": np.round(x, 6).tolist(),
        "altitude": np.round(y, 6).tolist(),
        "vx": np.round(vx, 6).tolist(),
        "vy": np.round(vy, 6).tolist(),
        "speed": np.round(speed, 6).tolist(),
        "mass": np.round(m, 6).tolist(),
        "landed": landed,
        "stats": {
            "apogee_altitude_m": round(float(y[apogee_idx]), 2),
            "apogee_time_s": round(float(t[apogee_idx]), 2),
            "stage_burnouts": stage_burnouts,
            "max_speed_ms": round(float(np.max(speed)), 2),
            "flight_time_s": round(float(t[-1]), 2),
            "downrange_m": round(float(x[-1]), 2),
            "thrust_to_weight": round(float(req.stages[0].thrust / weight0), 3),
            "delta_v_ms": round(float(delta_v_total), 2),
        },
    }


# ── 機体データベース（TinyDB） ─────────────────────────────────────

VEHICLE_DB_PATH = os.path.join(os.path.dirname(__file__), "data", "vehicles_db.json")
os.makedirs(os.path.dirname(VEHICLE_DB_PATH), exist_ok=True)
vehicle_db = TinyDB(VEHICLE_DB_PATH, encoding="utf-8")
vehicle_table = vehicle_db.table("vehicles")


class VehicleSpec(BaseModel):
    name: str                          # 機体名
    stages: list[StageSpec]            # 段構成（1段目から順）
    payload_mass: float = 0.0          # ペイロード質量 [kg]
    length: float = 0.0                # 全長 [m]
    diameter: float = 0.0              # 直径 [m]
    launch_angle: float = 90.0         # 発射角度 [deg]
    drag_enabled: bool = False
    drag_coefficient: float = 0.5
    cross_section_area: float = 0.0    # 機体投影面積 [m²]
    note: str = ""                     # 出典・補足


# サンプルデータ（公開情報をもとにした概算値の2段構成モデル。各段のdry_massは推定値を含む）
# H3-30: JAXA/MHI H3ロケット（SRBなし構成）
#   1段目: 3×LE-9（LOX/LH2）推進剤225t・燃焼214s
#   2段目: LE-5B-3（LOX/LH2）推進剤約23t・推力137kN・燃焼700s（定格値）
#   全長63m、直径5.27m、ペイロードはSSO換算で約4,000kg
# Falcon 9 Block 5: SpaceX
#   1段目: 9×Merlin 1D（LOX/RP-1）推進剤411t・燃焼162s
#   2段目: Merlin 1D Vacuum（LOX/RP-1）推進剤約92.7t・推力934kN・燃焼397s
#   全長69.8m、直径3.7m、ペイロードはLEO使い切り条件で約22,800kg
SAMPLE_VEHICLES = [
    VehicleSpec(
        name="H3-30",
        stages=[
            StageSpec(
                propellant_mass=225_000.0, dry_mass=48_000.0,
                oxidizer="LOX", fuel="LH2",
                thrust=4_416_000.0, burn_time=214.0,
            ),
            StageSpec(
                propellant_mass=23_000.0, dry_mass=3_500.0,
                oxidizer="LOX", fuel="LH2",
                thrust=137_000.0, burn_time=700.0,
            ),
        ],
        payload_mass=4_000.0,
        length=63.0,
        diameter=5.27,
        launch_angle=90.0,
        cross_section_area=round(math.pi * (5.27 / 2) ** 2, 2),
        note="JAXA/MHI H3-30（SRBなし、LE-9 ×3 + LE-5B-3）。2段dry_massは推定値、ペイロードはSSO換算",
    ),
    VehicleSpec(
        name="Falcon 9 Block 5",
        stages=[
            StageSpec(
                propellant_mass=411_000.0, dry_mass=41_384.0,
                oxidizer="LOX", fuel="RP-1",
                thrust=7_607_000.0, burn_time=162.0,
            ),
            StageSpec(
                propellant_mass=92_670.0, dry_mass=4_000.0,
                oxidizer="LOX", fuel="RP-1",
                thrust=934_000.0, burn_time=397.0,
            ),
        ],
        payload_mass=22_800.0,
        length=69.8,
        diameter=3.7,
        launch_angle=90.0,
        cross_section_area=round(math.pi * (3.7 / 2) ** 2, 2),
        note="SpaceX Falcon 9 Block 5（Merlin 1D ×9 + Merlin 1D Vacuum）。1段dry_massは概算、ペイロードはLEO使い切り条件",
    ),
]


def _seed_vehicle_db() -> None:
    if len(vehicle_table) == 0:
        for vehicle in SAMPLE_VEHICLES:
            vehicle_table.insert(vehicle.model_dump())


_seed_vehicle_db()


@app.get("/vehicles")
def list_vehicles():
    return [{"id": doc.doc_id, **doc} for doc in vehicle_table.all()]


@app.post("/vehicles")
def create_vehicle(vehicle: VehicleSpec):
    doc_id = vehicle_table.insert(vehicle.model_dump())
    return {"id": doc_id, **vehicle.model_dump()}


@app.put("/vehicles/{vehicle_id}")
def update_vehicle(vehicle_id: int, vehicle: VehicleSpec):
    if not vehicle_table.contains(doc_id=vehicle_id):
        raise HTTPException(status_code=404, detail="機体が見つかりません")
    vehicle_table.update(vehicle.model_dump(), doc_ids=[vehicle_id])
    return {"id": vehicle_id, **vehicle.model_dump()}


@app.delete("/vehicles/{vehicle_id}")
def delete_vehicle(vehicle_id: int):
    if not vehicle_table.contains(doc_id=vehicle_id):
        raise HTTPException(status_code=404, detail="機体が見つかりません")
    vehicle_table.remove(doc_ids=[vehicle_id])
    return {"ok": True}


# ── 部品データベース（TinyDB、機体データベースと同じファイルを使用） ──────

parts_table = vehicle_db.table("parts")


class PartSpec(BaseModel):
    code: str                          # 部品コード
    name: str                          # 部品名
    category: str                      # "pipe" | "valve" | "pump"
    maker: str = ""                    # メーカー
    model: str = ""                    # 型式
    note: str = ""                     # タグ・用途メモ
    params: dict[str, str] = {}        # カテゴリ別の解析用パラメータ


# 部品管理タブの初期テストデータ（フロントエンドの旧ハードコードデータを移行）
SAMPLE_PARTS = [
    PartSpec(
        code="PIPE-100A-SGP", name="SGP 100A 標準配管", category="pipe",
        maker="標準", model="SGP-100A", note="定常解析の配管ノード初期値用",
        params={
            "shape": "円管", "diameterMm": "105.3", "lengthM": "6",
            "roughnessMm": "0.046", "material": "SGP", "pressureClass": "10K",
        },
    ),
    PartSpec(
        code="VALVE-GATE-50A", name="ゲートバルブ 50A", category="valve",
        maker="標準", model="GV-50A", note="開度100%の初期値",
        params={
            "diameterMm": "50", "cv": "48", "openingPct": "100",
            "pressureClass": "JIS 10K", "connection": "フランジ",
        },
    ),
    PartSpec(
        code="PUMP-030-020", name="遠心ポンプ 30m3/h 20m", category="pump",
        maker="標準", model="CP-030", note="二次PQ特性の初期登録例",
        params={
            "ratedFlowM3h": "30", "ratedHeadM": "20", "shutoffHeadM": "30",
            "efficiencyPct": "75", "ratedSpeedRpm": "1450",
        },
    ),
]


def _seed_parts_db() -> None:
    if len(parts_table) == 0:
        for part in SAMPLE_PARTS:
            parts_table.insert(part.model_dump())


_seed_parts_db()


@app.get("/parts")
def list_parts():
    return [{"id": doc.doc_id, **doc} for doc in parts_table.all()]


@app.post("/parts")
def create_part(part: PartSpec):
    doc_id = parts_table.insert(part.model_dump())
    return {"id": doc_id, **part.model_dump()}


@app.delete("/parts/{part_id}")
def delete_part(part_id: int):
    if not parts_table.contains(doc_id=part_id):
        raise HTTPException(status_code=404, detail="部品が見つかりません")
    parts_table.remove(doc_ids=[part_id])
    return {"ok": True}


# ── ロケット段デザイナー（コンポーネント単位のノードグラフ→段集計） ───────

class RocketNode(BaseModel):
    id: str
    node_type: str  # structure | tank | pipe | pump | combustor | nozzle | fairing | fixed_mass
    params: dict[str, float | str] = {}


class RocketEdge(BaseModel):
    id: str
    source: str
    target: str
    source_handle: str | None = None
    target_handle: str | None = None


class RocketStagePayload(BaseModel):
    nodes: list[RocketNode]
    edges: list[RocketEdge]
    structure: dict[str, float] = {}
    fixed_masses: list[dict] = []


def _rocket_num(params: dict, key: str, default: float = 0.0) -> float:
    try:
        return float(params.get(key, default))
    except (TypeError, ValueError):
        return default


def _shell_mass(diameter_mm: float, length_mm: float, thickness_mm: float, density: float) -> float:
    """円筒シェルの質量 = 密度 × 肉厚 × 側面表面積（簡易、底面・座屈は無視）"""
    diameter_m = diameter_mm / 1000.0
    length_m = length_mm / 1000.0
    thickness_m = thickness_mm / 1000.0
    surface_area = math.pi * diameter_m * length_m
    return density * thickness_m * surface_area


def _pressure_vessel_thickness(pressure_pa: float, diameter_mm: float, yield_strength_pa: float, safety_factor: float) -> float:
    """薄肉円筒のフープ応力から必要肉厚を算出: t = P・D / (2・σ_allow)"""
    if yield_strength_pa <= 0 or safety_factor <= 0:
        return 0.0
    sigma_allow = yield_strength_pa / safety_factor
    diameter_m = diameter_mm / 1000.0
    return (pressure_pa * diameter_m) / (2 * sigma_allow) * 1000.0  # mm


def _calc_shell_component(params: dict) -> dict:
    """外壁構造材・フェアリング・配管: 指定肉厚からのシェル質量"""
    mass = _shell_mass(
        _rocket_num(params, "diameterMm"),
        _rocket_num(params, "lengthMm"),
        _rocket_num(params, "thicknessMm"),
        _rocket_num(params, "densityKgM3"),
    )
    return {"mass_kg": round(mass, 3)}


def _calc_direct_mass(params: dict) -> dict:
    """ポンプ・固定質量: 質量を直接入力"""
    return {"mass_kg": round(_rocket_num(params, "massKg"), 3)}


def _calc_tank(params: dict) -> dict:
    """タンク: フープ応力からシェル質量、円筒近似体積から推進剤質量を算出"""
    diameter_mm = _rocket_num(params, "diameterMm")
    length_mm = _rocket_num(params, "lengthMm")
    thickness = _pressure_vessel_thickness(
        _rocket_num(params, "designPressurePa"),
        diameter_mm,
        _rocket_num(params, "yieldStrengthPa"),
        _rocket_num(params, "safetyFactor", 1.5),
    )
    shell_mass = _shell_mass(diameter_mm, length_mm, thickness, _rocket_num(params, "densityKgM3"))

    radius_m = diameter_mm / 1000.0 / 2.0
    length_m = length_mm / 1000.0
    volume_m3 = math.pi * radius_m ** 2 * length_m
    usable_volume = volume_m3 * max(0.0, 1.0 - _rocket_num(params, "ullagePercent") / 100.0)
    propellant_mass = usable_volume * _rocket_num(params, "propellantDensityKgM3")

    return {
        "thickness_mm": round(thickness, 3),
        "shell_mass_kg": round(shell_mass, 3),
        "propellant_mass_kg": round(propellant_mass, 3),
    }


def _combustor_mdot(params: dict) -> float:
    chamber_pressure = _rocket_num(params, "chamberPressurePa")
    c_star = _rocket_num(params, "cStarMS")
    throat_area_m2 = math.pi * (_rocket_num(params, "throatDiameterMm") / 1000.0 / 2.0) ** 2
    return (chamber_pressure * throat_area_m2 / c_star) if c_star > 0 else 0.0


def _calc_combustor(params: dict) -> dict:
    """燃焼器: フープ応力からシェル質量、Pc・At・c*から質量流量を算出"""
    diameter_mm = _rocket_num(params, "diameterMm")
    length_mm = _rocket_num(params, "lengthMm")
    thickness = _pressure_vessel_thickness(
        _rocket_num(params, "chamberPressurePa"),
        diameter_mm,
        _rocket_num(params, "yieldStrengthPa"),
        _rocket_num(params, "safetyFactor", 1.5),
    )
    shell_mass = _shell_mass(diameter_mm, length_mm, thickness, _rocket_num(params, "densityKgM3"))
    return {
        "thickness_mm": round(thickness, 3),
        "shell_mass_kg": round(shell_mass, 3),
        "mdot_kg_s": round(_combustor_mdot(params), 5),
    }


def _nozzle_exit_mach(expansion_ratio: float, gamma: float) -> float | None:
    """面積比 Ae/At から超音速側出口マッハ数を数値的に求める（等エントロピー流れ）"""
    if expansion_ratio <= 1.0 or gamma <= 1.0:
        return None

    def area_ratio(mach: float) -> float:
        term = (2.0 / (gamma + 1.0)) * (1.0 + (gamma - 1.0) / 2.0 * mach ** 2)
        return (1.0 / mach) * term ** ((gamma + 1.0) / (2.0 * (gamma - 1.0)))

    try:
        return brentq(lambda m: area_ratio(m) - expansion_ratio, 1.0 + 1e-6, 80.0, xtol=1e-10, maxiter=200)
    except ValueError:
        return None


def _calc_nozzle(params: dict, combustor_params: dict | None) -> dict:
    """ノズル: 燃焼器とのペアリングがあれば燃焼圧・拡大比から推力・Ispを計算"""
    shell_mass = _shell_mass(
        _rocket_num(params, "exitDiameterMm") or _rocket_num(params, "diameterMm"),
        _rocket_num(params, "lengthMm"),
        _rocket_num(params, "thicknessMm"),
        _rocket_num(params, "densityKgM3"),
    )
    result = {"shell_mass_kg": round(shell_mass, 3), "thrust_n": 0.0, "isp_s": 0.0}
    if not combustor_params:
        return result

    expansion_ratio = _rocket_num(params, "expansionRatio")
    ambient_pressure = _rocket_num(params, "ambientPressurePa", 101325.0)
    gamma = _rocket_num(combustor_params, "gamma", 1.2)
    chamber_pressure = _rocket_num(combustor_params, "chamberPressurePa")
    mdot = _combustor_mdot(combustor_params)
    throat_area_m2 = math.pi * (_rocket_num(combustor_params, "throatDiameterMm") / 1000.0 / 2.0) ** 2

    mach_e = _nozzle_exit_mach(expansion_ratio, gamma)
    if mach_e is None or chamber_pressure <= 0:
        return result

    pe_pc = (1.0 + (gamma - 1.0) / 2.0 * mach_e ** 2) ** (-gamma / (gamma - 1.0))
    cf = math.sqrt(
        (2 * gamma ** 2 / (gamma - 1.0))
        * (2 / (gamma + 1.0)) ** ((gamma + 1.0) / (gamma - 1.0))
        * (1.0 - pe_pc ** ((gamma - 1.0) / gamma))
    ) + (pe_pc - ambient_pressure / chamber_pressure) * expansion_ratio
    thrust = cf * chamber_pressure * throat_area_m2
    isp = (thrust / (mdot * 9.80665)) if mdot > 0 else 0.0

    return {
        "shell_mass_kg": round(shell_mass, 3),
        "thrust_n": round(thrust, 2),
        "isp_s": round(isp, 2),
        "mach_exit": round(mach_e, 4),
        "cf": round(cf, 4),
    }


@app.post("/rocket/stage/build")
def build_rocket_stage(payload: RocketStagePayload):
    """段の部品グラフ（外壁構造材・タンク・配管・ポンプ・燃焼器・ノズル・フェアリング・固定質量）から
    段全体の構造質量・推進剤質量・推力・燃焼時間を計算する。
    燃焼器→ノズルは接続エッジでペアリングし、燃焼圧・拡大比からノズル性能（推力・Isp）を算出する。
    結果は既存の StageSpec 形式（/launch/simulate へそのまま渡せる形）で返す。
    """
    nodes_by_id = {n.id: n for n in payload.nodes}
    nozzle_combustor: dict[str, str] = {}
    for edge in payload.edges:
        source = nodes_by_id.get(edge.source)
        target = nodes_by_id.get(edge.target)
        if not source or not target:
            continue
        if source.node_type == "combustor" and target.node_type == "nozzle":
            nozzle_combustor[target.id] = source.id
        elif source.node_type == "nozzle" and target.node_type == "combustor":
            nozzle_combustor[source.id] = target.id

    results: dict[str, dict] = {}
    dry_mass = 0.0
    propellant_mass = 0.0
    thrust_total = 0.0
    mdot_total = 0.0
    oxidizer = ""
    fuel = ""

    for node in payload.nodes:
        params = node.params
        if node.node_type in ("fairing", "pipe"):
            r = _calc_shell_component(params)
            dry_mass += r["mass_kg"]
        elif node.node_type == "pump":
            r = _calc_direct_mass(params)
            dry_mass += r["mass_kg"]
        elif node.node_type == "tank":
            r = _calc_tank(params)
            dry_mass += r["shell_mass_kg"]
            propellant_mass += r["propellant_mass_kg"]
        elif node.node_type == "combustor":
            r = _calc_combustor(params)
            dry_mass += r["shell_mass_kg"]
            mdot_total += r["mdot_kg_s"]
            oxidizer = oxidizer or str(params.get("oxidizer", ""))
            fuel = fuel or str(params.get("fuel", ""))
        elif node.node_type == "nozzle":
            combustor_id = nozzle_combustor.get(node.id)
            combustor_params = nodes_by_id[combustor_id].params if combustor_id else None
            r = _calc_nozzle(params, combustor_params)
            dry_mass += r["shell_mass_kg"]
            thrust_total += r["thrust_n"]
        else:
            r = {}
        results[node.id] = r

    if payload.structure:
        dry_mass += _calc_shell_component(payload.structure)["mass_kg"]
    dry_mass += sum(_rocket_num(m, "massKg") for m in payload.fixed_masses)

    burn_time = (propellant_mass / mdot_total) if mdot_total > 0 else 0.0
    stage = {
        "propellant_mass": round(propellant_mass, 3),
        "dry_mass": round(dry_mass, 3),
        "oxidizer": oxidizer or "LOX",
        "fuel": fuel or "LCH4",
        "thrust": round(thrust_total, 2),
        "burn_time": round(burn_time, 3),
    }
    return {"nodes": results, "stage": stage}
