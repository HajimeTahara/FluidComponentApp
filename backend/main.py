from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any
import CoolProp.CoolProp as CP
import numpy as np
import pandas as pd
from scipy.integrate import solve_ivp
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
