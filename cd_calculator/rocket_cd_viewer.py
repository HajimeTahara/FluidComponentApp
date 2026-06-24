"""
rocket_cd_viewer.py

Step1用の簡易ロケット形状 + Cd(Mach) ビュワーです。

目的:
- 代表形状を少数パラメータで作る
- ノーズ形状、胴体長さ、ボートテール、フィン、粗さの影響をざっくり可視化する
- Cdを「固定値」ではなく Cd(Mach) として見る

注意:
- このCdモデルは教育・初期検討用の簡易モデルです。
- OpenRocket / RASAero / Missile DATCOM / CFD / 風洞試験の代替にはなりません。
- 絶対値よりも「形状を変えたときの傾向を見る」用途で使ってください。

実行:
    pip install streamlit numpy matplotlib pandas
    streamlit run rocket_cd_viewer.py
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import streamlit as st


# -----------------------------
# Geometry
# -----------------------------

@dataclass
class RocketGeometry:
    D: float
    nose_type: str
    nose_length_D: float
    body_length_D: float
    base_type: str
    boat_tail_length_D: float
    base_diameter_D: float
    nozzle_exit_diameter_D: float
    fin_enabled: bool
    fin_count: int
    fin_root_chord_D: float
    fin_tip_chord_D: float
    fin_span_D: float
    fin_sweep_D: float
    fin_thickness_D: float
    surface_finish: str
    power_on: bool
    aoa_deg: float
    reynolds_D_at_M1: float
    protuberance_area_ratio: float

    @property
    def R(self) -> float:
        return 0.5 * self.D

    @property
    def nose_length(self) -> float:
        return self.nose_length_D * self.D

    @property
    def body_length(self) -> float:
        return self.body_length_D * self.D

    @property
    def boat_tail_length(self) -> float:
        return self.boat_tail_length_D * self.D if self.base_type == "Boat tail" else 0.0

    @property
    def base_radius(self) -> float:
        return 0.5 * self.base_diameter_D * self.D

    @property
    def nozzle_radius(self) -> float:
        return 0.5 * self.nozzle_exit_diameter_D * self.D

    @property
    def total_length(self) -> float:
        return self.nose_length + self.body_length + self.boat_tail_length

    @property
    def Aref(self) -> float:
        return math.pi * self.R**2

    @property
    def base_area_ratio(self) -> float:
        exposed = max(self.base_radius**2 - self.nozzle_radius**2, 0.0)
        return exposed / max(self.R**2, 1e-12)


def nose_profile(nose_type: str, L: float, R: float, n: int = 180) -> tuple[np.ndarray, np.ndarray]:
    """Return x,r arrays for nose profile from tip x=0 to base x=L."""
    x = np.linspace(0.0, L, n)
    xi = np.clip(x / max(L, 1e-12), 0.0, 1.0)

    if nose_type == "Conical":
        r = R * xi

    elif nose_type == "Tangent ogive":
        # Tangent ogive circular arc
        rho = (R**2 + L**2) / (2.0 * R)
        inside = np.maximum(rho**2 - (L - x) ** 2, 0.0)
        r = np.sqrt(inside) + R - rho

    elif nose_type == "Elliptical":
        # Ellipse with tip at x=0 and base radius R at x=L
        r = R * np.sqrt(np.maximum(1.0 - ((x - L) / max(L, 1e-12)) ** 2, 0.0))

    elif nose_type == "Parabolic":
        # Simple parabolic profile normalized to r=R at base
        r = R * (2.0 * xi - xi**2)

    elif nose_type == "Von Karman / Haack":
        # Haack series, C=0, commonly referred to as LD-Haack / Von Karman
        theta = np.arccos(np.clip(1.0 - 2.0 * xi, -1.0, 1.0))
        term = theta - 0.5 * np.sin(2.0 * theta)
        r = R * np.sqrt(np.maximum(term / math.pi, 0.0))

    else:
        r = R * xi

    r[0] = 0.0
    r[-1] = R
    return x, r


def surface_area_of_revolution(x: np.ndarray, r: np.ndarray) -> float:
    drdx = np.gradient(r, x, edge_order=1)
    integrand = 2.0 * math.pi * r * np.sqrt(1.0 + drdx**2)
    return float(np.trapz(integrand, x))


def wetted_areas(g: RocketGeometry) -> dict[str, float]:
    x_n, r_n = nose_profile(g.nose_type, g.nose_length, g.R)
    S_nose = surface_area_of_revolution(x_n, r_n)

    S_body = 2.0 * math.pi * g.R * g.body_length

    if g.base_type == "Boat tail" and g.boat_tail_length > 0:
        slant = math.sqrt((g.R - g.base_radius) ** 2 + g.boat_tail_length**2)
        S_boattail = math.pi * (g.R + g.base_radius) * slant
    else:
        S_boattail = 0.0

    if g.fin_enabled:
        fin_planform = 0.5 * (g.fin_root_chord_D + g.fin_tip_chord_D) * g.fin_span_D * g.D**2
        S_fins = 2.0 * g.fin_count * fin_planform
    else:
        S_fins = 0.0

    return {
        "nose": S_nose,
        "body": S_body,
        "boattail": S_boattail,
        "fins": S_fins,
        "total": S_nose + S_body + S_boattail + S_fins,
    }


# -----------------------------
# Simplified Cd model
# -----------------------------

def turbulent_cf(Re: np.ndarray | float, roughness_multiplier: float = 1.0) -> np.ndarray:
    Re_arr = np.asarray(Re, dtype=float)
    Re_clip = np.clip(Re_arr, 1.0e4, 1.0e9)
    cf = 0.455 / (np.log10(Re_clip) ** 2.58)
    return cf * roughness_multiplier


def smooth_step(x: np.ndarray, x0: float, width: float) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-(x - x0) / max(width, 1e-6)))


def cd_components(g: RocketGeometry, mach: np.ndarray) -> pd.DataFrame:
    M = np.asarray(mach, dtype=float)
    areas = wetted_areas(g)

    roughness_map = {
        "Polished": 0.85,
        "Smooth paint": 1.00,
        "Regular paint": 1.15,
        "Unfinished": 1.35,
        "Rough": 1.65,
    }
    rough_mult = roughness_map.get(g.surface_finish, 1.0)

    # Re scales roughly with velocity, here controlled by Re_D at Mach 1.
    Re_D = np.clip(g.reynolds_D_at_M1 * np.maximum(M, 0.05), 1e4, 1e9)
    Re_L = Re_D * max(g.total_length / g.D, 1.0)
    Cf = turbulent_cf(Re_L, rough_mult)

    # Friction drag: Cf * Swet / Aref
    cd_friction_body = Cf * (areas["nose"] + areas["body"] + areas["boattail"]) / g.Aref
    cd_friction_fins = Cf * areas["fins"] / g.Aref

    # Nose pressure / wave drag.
    # This is intentionally simple. It creates a transonic bump and supersonic rise.
    shape_factor = {
        "Conical": 1.00,
        "Tangent ogive": 0.82,
        "Elliptical": 0.92,
        "Parabolic": 0.78,
        "Von Karman / Haack": 0.62,
    }.get(g.nose_type, 0.85)

    fineness_factor = (4.0 / max(g.nose_length_D, 0.5)) ** 1.1
    transonic_bump = np.exp(-((M - 1.05) / 0.22) ** 2)
    supersonic_ramp = smooth_step(M, 1.15, 0.10)
    cd_nose_wave = shape_factor * fineness_factor * (
        0.085 * transonic_bump + 0.045 * supersonic_ramp * (1.0 - np.exp(-0.7 * np.maximum(M - 1.0, 0.0)))
    )

    # Base drag. Power-on reduces the low-pressure wake effect in this simplified model.
    base_ratio = g.base_area_ratio
    base_transonic = 0.11 + 0.16 * smooth_step(M, 0.80, 0.12)
    base_high_mach_relief = 1.0 - 0.25 * smooth_step(M, 2.0, 0.35)
    power_factor = 0.35 if g.power_on else 1.0
    cd_base = base_ratio * base_transonic * base_high_mach_relief * power_factor

    # Boat-tail pressure penalty/benefit.
    # A moderate boat tail reduces exposed base area, but steep boat tails add separation penalty.
    if g.base_type == "Boat tail" and g.boat_tail_length_D > 0:
        angle = math.atan2(max(g.R - g.base_radius, 0.0), max(g.boat_tail_length, 1e-9))
        angle_deg = math.degrees(angle)
        cd_boattail_sep = max(angle_deg - 12.0, 0.0) / 100.0
        cd_boattail = np.full_like(M, cd_boattail_sep)
    else:
        cd_boattail = np.zeros_like(M)

    # Fin pressure/wave drag, simplified.
    if g.fin_enabled:
        fin_area_ratio = 0.5 * (g.fin_root_chord_D + g.fin_tip_chord_D) * g.fin_span_D * g.fin_count
        thickness_ratio = max(g.fin_thickness_D, 1e-4)
        cd_fin_pressure = 0.015 * fin_area_ratio * (1.0 + 2.0 * supersonic_ramp) * (thickness_ratio / 0.02)
    else:
        cd_fin_pressure = np.zeros_like(M)

    # Angle-of-attack drag increment, simplified quadratic penalty.
    alpha = math.radians(g.aoa_deg)
    side_area_ratio = (g.total_length * g.D) / g.Aref
    cd_aoa = np.full_like(M, 0.08 * side_area_ratio * alpha**2)

    # Protuberance drag as frontal-area penalty.
    cd_prot = np.full_like(M, 1.2 * max(g.protuberance_area_ratio, 0.0))

    df = pd.DataFrame(
        {
            "Mach": M,
            "Cd_friction_body": cd_friction_body,
            "Cd_friction_fins": cd_friction_fins,
            "Cd_nose_wave_pressure": cd_nose_wave,
            "Cd_base": cd_base,
            "Cd_boattail_sep": cd_boattail,
            "Cd_fin_pressure_wave": cd_fin_pressure,
            "Cd_AoA": cd_aoa,
            "Cd_protuberance": cd_prot,
        }
    )
    component_cols = [c for c in df.columns if c != "Mach"]
    df["Cd_total"] = df[component_cols].sum(axis=1)
    return df


# -----------------------------
# Plotting
# -----------------------------

def plot_shape(g: RocketGeometry) -> plt.Figure:
    fig, ax = plt.subplots(figsize=(9, 2.6))

    x_n, r_n = nose_profile(g.nose_type, g.nose_length, g.R)
    x_body = np.array([g.nose_length, g.nose_length + g.body_length])
    r_body = np.array([g.R, g.R])

    xs = list(x_n) + list(x_body)
    rs = list(r_n) + list(r_body)

    if g.base_type == "Boat tail" and g.boat_tail_length > 0:
        xs += [g.nose_length + g.body_length + g.boat_tail_length]
        rs += [g.base_radius]

    x_top = np.array(xs)
    r_top = np.array(rs)

    ax.plot(x_top / g.D, r_top / g.D)
    ax.plot(x_top / g.D, -r_top / g.D)

    # Base line
    x_end = g.total_length
    ax.plot([x_end / g.D, x_end / g.D], [-g.base_radius / g.D, g.base_radius / g.D])

    # Nozzle opening indication
    if g.nozzle_radius > 0:
        ax.plot(
            [x_end / g.D, x_end / g.D],
            [-g.nozzle_radius / g.D, g.nozzle_radius / g.D],
            linewidth=4,
        )

    # Fin side view, drawn on lower side.
    if g.fin_enabled:
        cr = g.fin_root_chord_D * g.D
        ct = g.fin_tip_chord_D * g.D
        span = g.fin_span_D * g.D
        sweep = g.fin_sweep_D * g.D

        # Put fins on cylindrical/late body. Keep root trailing edge near start of boat tail or base.
        fin_te = g.nose_length + g.body_length
        fin_le = max(g.nose_length, fin_te - cr)
        y_root = -g.R
        fin_x = np.array([fin_le, fin_te, fin_le + sweep + ct, fin_le + sweep])
        fin_y = np.array([y_root, y_root, y_root - span, y_root - span])
        ax.fill(fin_x / g.D, fin_y / g.D, alpha=0.35)

    ax.set_aspect("equal", adjustable="box")
    ax.set_xlabel("x / D")
    ax.set_ylabel("r / D")
    ax.set_title("Representative rocket geometry")
    ax.grid(True, alpha=0.25)
    ax.set_ylim(-max(1.2, 0.8 + g.fin_span_D), max(0.8, 0.65))
    return fig


def plot_cd(df: pd.DataFrame) -> plt.Figure:
    fig, ax = plt.subplots(figsize=(8, 4.2))
    ax.plot(df["Mach"], df["Cd_total"], linewidth=2.5, label="Cd total")
    ax.plot(df["Mach"], df["Cd_friction_body"], label="body friction")
    ax.plot(df["Mach"], df["Cd_nose_wave_pressure"], label="nose pressure/wave")
    ax.plot(df["Mach"], df["Cd_base"], label="base")
    ax.plot(df["Mach"], df["Cd_friction_fins"] + df["Cd_fin_pressure_wave"], label="fins")
    ax.plot(df["Mach"], df["Cd_boattail_sep"], label="boattail separation")
    ax.plot(df["Mach"], df["Cd_protuberance"], label="protuberance")
    ax.set_xlabel("Mach number")
    ax.set_ylabel("Cd [-]")
    ax.set_title("Simplified Cd(Mach) estimate")
    ax.grid(True, alpha=0.25)
    ax.legend(loc="best", fontsize=8)
    return fig


def to_csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode("utf-8-sig")


# -----------------------------
# Streamlit App
# -----------------------------

st.set_page_config(page_title="Rocket Cd Viewer", layout="wide")
st.title("Rocket Shape & Cd Viewer")
st.caption("Step1向けの簡易ビュワーです。絶対値ではなく、形状変更による傾向確認に使ってください。")

with st.sidebar:
    st.header("Geometry")

    D = st.number_input("Reference diameter D [m]", min_value=0.01, max_value=10.0, value=0.10, step=0.01)

    nose_type = st.selectbox(
        "Nose type",
        ["Conical", "Tangent ogive", "Elliptical", "Parabolic", "Von Karman / Haack"],
        index=4,
    )
    nose_length_D = st.slider("Nose length Ln/D", 0.5, 8.0, 4.0, 0.1)
    body_length_D = st.slider("Body length Lb/D", 1.0, 30.0, 10.0, 0.5)

    base_type = st.selectbox("Base type", ["Flat base", "Boat tail"])
    if base_type == "Boat tail":
        boat_tail_length_D = st.slider("Boat-tail length Lbt/D", 0.1, 5.0, 1.5, 0.1)
        base_diameter_D = st.slider("Base diameter Db/D", 0.2, 1.0, 0.65, 0.01)
    else:
        boat_tail_length_D = 0.0
        base_diameter_D = 1.0

    nozzle_exit_diameter_D = st.slider("Nozzle exit diameter De/D", 0.0, 0.95, 0.35, 0.01)

    st.divider()
    st.header("Fins")
    fin_enabled = st.checkbox("Enable fins", value=True)
    if fin_enabled:
        fin_count = st.slider("Fin count", 3, 8, 4, 1)
        fin_root_chord_D = st.slider("Root chord cr/D", 0.2, 5.0, 1.5, 0.1)
        fin_tip_chord_D = st.slider("Tip chord ct/D", 0.05, 3.0, 0.7, 0.05)
        fin_span_D = st.slider("Fin span s/D", 0.05, 2.0, 0.6, 0.05)
        fin_sweep_D = st.slider("Leading-edge sweep xs/D", 0.0, 3.0, 0.6, 0.05)
        fin_thickness_D = st.slider("Fin thickness tf/D", 0.002, 0.10, 0.02, 0.002)
    else:
        fin_count = 0
        fin_root_chord_D = 0.0
        fin_tip_chord_D = 0.0
        fin_span_D = 0.0
        fin_sweep_D = 0.0
        fin_thickness_D = 0.0

    st.divider()
    st.header("Flight / surface")
    surface_finish = st.selectbox(
        "Surface finish",
        ["Polished", "Smooth paint", "Regular paint", "Unfinished", "Rough"],
        index=1,
    )
    power_on = st.checkbox("Power-on, exhaust plume reduces base drag", value=False)
    aoa_deg = st.slider("Angle of attack [deg]", 0.0, 15.0, 0.0, 0.5)
    reynolds_D_at_M1 = st.number_input("Re_D at Mach 1 [-]", min_value=1.0e4, max_value=1.0e9, value=3.0e6, step=1.0e5, format="%.2e")
    protuberance_area_ratio = st.slider("Protuberance frontal area / Aref", 0.0, 0.20, 0.0, 0.005)

    st.divider()
    st.header("Mach range")
    M_min = st.slider("Mach min", 0.01, 2.0, 0.05, 0.01)
    M_max = st.slider("Mach max", 0.2, 8.0, 3.0, 0.1)
    n_points = st.slider("Points", 50, 1000, 300, 50)

if M_max <= M_min:
    st.error("Mach max must be greater than Mach min.")
    st.stop()

geom = RocketGeometry(
    D=D,
    nose_type=nose_type,
    nose_length_D=nose_length_D,
    body_length_D=body_length_D,
    base_type=base_type,
    boat_tail_length_D=boat_tail_length_D,
    base_diameter_D=base_diameter_D,
    nozzle_exit_diameter_D=nozzle_exit_diameter_D,
    fin_enabled=fin_enabled,
    fin_count=fin_count,
    fin_root_chord_D=fin_root_chord_D,
    fin_tip_chord_D=fin_tip_chord_D,
    fin_span_D=fin_span_D,
    fin_sweep_D=fin_sweep_D,
    fin_thickness_D=fin_thickness_D,
    surface_finish=surface_finish,
    power_on=power_on,
    aoa_deg=aoa_deg,
    reynolds_D_at_M1=reynolds_D_at_M1,
    protuberance_area_ratio=protuberance_area_ratio,
)

mach = np.linspace(M_min, M_max, n_points)
df = cd_components(geom, mach)
areas = wetted_areas(geom)

col1, col2 = st.columns([1.1, 1.4])

with col1:
    st.pyplot(plot_shape(geom), clear_figure=True)

    st.subheader("Geometry summary")
    st.write(
        {
            "D [m]": geom.D,
            "Aref [m2]": geom.Aref,
            "Total length / D": geom.total_length / geom.D,
            "Base area ratio": geom.base_area_ratio,
            "Wetted area / Aref": areas["total"] / geom.Aref,
        }
    )

with col2:
    st.pyplot(plot_cd(df), clear_figure=True)

st.subheader("Cd table")
st.dataframe(df, use_container_width=True)

st.download_button(
    "Download Cd table as CSV",
    data=to_csv_bytes(df),
    file_name="rocket_cd_table.csv",
    mime="text/csv",
)

st.info(
    "This viewer uses a simplified engineering-style model. "
    "For design decisions, compare against OpenRocket/RASAero, CFD, or experimental data."
)
