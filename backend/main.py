from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import CoolProp.CoolProp as CP
import numpy as np
import pandas as pd
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
