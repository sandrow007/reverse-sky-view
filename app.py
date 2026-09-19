#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Manolit∞ Nubes — backend del visor de nubes reales a nivel de calle.

Recibe lat/lon + orientación y campo de visión de la cámara, descarga la
imagen global de nubes de NASA GIBS (MODIS Terra, con respaldo Aqua) para
la fecha más reciente disponible, calcula la porción exacta de cielo que
cabría en el encuadre desde esa posición proyectada sobre un plano a
CLOUD_ALT metros sobre el ojo, la recorta con una homografía exacta y
genera la máscara alfa (transparente donde no hay nube).

Devuelve la textura en base64 + los metadatos de georreferenciación.

Autor: Sandro. Licencia: AGPL-3.0.
"""

import base64
import io
import math
import os
import threading
from datetime import datetime, timedelta

import numpy as np
import requests
from PIL import Image, ImageFilter
from flask import Flask, jsonify, request, send_from_directory

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

GIBS_BASE = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best"
MATRIX_SET = "250m"
TILE_PX = 512
MAX_ZOOM = 8
MIN_ZOOM = 3

CAPAS_NUBE = [
    "MODIS_Terra_CorrectedReflectance_TrueColor",
    "MODIS_Aqua_CorrectedReflectance_TrueColor",
]

RADIO_TIERRA = 6378137.0

CLOUD_ALT = 2000.0      # altitud de la banda de nubes sobre el ojo, en metros
OUT_W = 1024            # resolución horizontal de la textura de cielo
OUT_H = 640             # resolución vertical de la textura de cielo
PITCH_MIN = 25.0        # inclinación mínima sobre el horizonte que aceptamos
PITCH_MAX = 89.0
FOVH_MIN = 20.0
FOVH_MAX = 110.0

DIAS_RETROCESO = 4      # cuántos días atrás buscar imagen disponible
TIMEOUT_TILE = 20       # segundos por tesela
REINTENTOS_TILE = 2

app = Flask(__name__, static_folder=None)

sesion_http = requests.Session()
sesion_http.headers.update({"User-Agent": "manolit-nubes/1.0 (civic-tech; AGPL)"})
cerrojo_http = threading.Lock()


# ---------------------------------------------------------------------------
# Utilidades geométricas
# ---------------------------------------------------------------------------

def clamp(valor, lo, hi):
    return max(lo, min(hi, valor))


def rayo_enu(heading, pitch, a, b, fovh, fovv):
    """Dirección (E,N,U) normalizada del rayo del píxel (a,b) en [-1,1]."""
    h = math.radians(heading)
    p = math.radians(pitch)
    f = np.array([
        math.sin(h) * math.cos(p),
        math.cos(h) * math.cos(p),
        math.sin(p),
    ])
    r = np.array([math.cos(h), -math.sin(h), 0.0])
    s = np.cross(r, f)
    tx = math.tan(math.radians(fovh) / 2.0)
    ty = math.tan(math.radians(fovv) / 2.0)
    d = f + a * tx * r + b * ty * s
    n = np.linalg.norm(d)
    if n < 1e-12:
        return None
    return d / n


def rayo_a_lonlat(d, lat0, altura):
    """Intersección del rayo con el plano horizontal a 'altura' metros."""
    if d[2] <= 1e-6:
        return None
    t = altura / d[2]
    este, norte = d[0] * t, d[1] * t
    dlon = este / (RADIO_TIERRA * math.cos(math.radians(lat0))) * 180.0 / math.pi
    dlat = norte / RADIO_TIERRA * 180.0 / math.pi
    return dlon, dlat


def smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# ---------------------------------------------------------------------------
# Descarga GIBS
# ---------------------------------------------------------------------------

def fecha_candidatas(pedida):
    """Fechas a probar, de la más reciente a la más antigua."""
    if pedida:
        try:
            base = datetime.strptime(pedida, "%Y-%m-%d")
        except ValueError:
            base = datetime.utcnow()
    else:
        base = datetime.utcnow()
    return [(base - timedelta(days=i)).strftime("%Y-%m-%d")
            for i in range(DIAS_RETROCESO + 1)]


def zoom_para_bbox(ancho_deg, alto_deg):
    """Zoom GIBS cuya resolución no desperdicie píxeles de salida."""
    necesario = math.log2(180.0 / (TILE_PX * max(ancho_deg / OUT_W,
                                                alto_deg / OUT_H,
                                                1e-9)))
    return int(clamp(math.ceil(necesario), MIN_ZOOM, MAX_ZOOM))


def descargar_tesela(capa, fecha, z, y, x):
    """Devuelve PIL Image de la tesela o None si falla."""
    url = (f"{GIBS_BASE}/{capa}/default/{fecha}/{MATRIX_SET}/"
           f"{z}/{y}/{x}.jpeg")
    for _ in range(REINTENTOS_TILE):
        try:
            with cerrojo_http:
                r = sesion_http.get(url, timeout=TIMEOUT_TILE)
            if r.status_code == 200 and len(r.content) > 1000:
                return Image.open(io.BytesIO(r.content)).convert("RGB")
        except Exception:
            continue
    return None


def mosaico_gibs(lon_min, lon_max, lat_min, lat_max, capas_fecha, z):
    """Descarga el mosaico de teselas que cubre el bbox. Fija una única
    (capa, fecha) para todo el mosaico. Devuelve (imagen, capa, fecha,
    lon_min_mosaico, lat_max_mosaico, grados_por_px)."""
    ancho_t = 180.0 / (2 ** z)
    x0 = int((lon_min + 180.0) // ancho_t)
    x1 = int((lon_max + 180.0) // ancho_t)
    y0 = int((90.0 - lat_max) // ancho_t)
    y1 = int((90.0 - lat_min) // ancho_t)
    nx = x1 - x0 + 1
    ny = y1 - y0 + 1
    if nx * ny > 64:
        raise RuntimeError("La región pedida es demasiado grande para recortar.")

    # Descubrir la primera (capa, fecha) que responda, con la tesela inicial
    tile0 = None
    capa_ok = fecha_ok = None
    for capa, fecha in capas_fecha:
        tile0 = descargar_tesela(capa, fecha, z, y0, x0)
        if tile0 is not None:
            capa_ok, fecha_ok = capa, fecha
            break
    if tile0 is None:
        raise RuntimeError("No hay imagen de nubes disponible en GIBS "
                           "para los últimos días.")

    mosaico = Image.new("RGB", (nx * TILE_PX, ny * TILE_PX), (32, 32, 48))
    mosaico.paste(tile0, (0, 0))
    for dy in range(ny):
        for dx in range(nx):
            if dx == 0 and dy == 0:
                continue
            tile = descargar_tesela(capa_ok, fecha_ok, z, y0 + dy, x0 + dx)
            if tile is None:
                raise RuntimeError("No se pudo completar la imagen de nubes.")
            mosaico.paste(tile, (dx * TILE_PX, dy * TILE_PX))
    return (mosaico, capa_ok, fecha_ok,
            -180.0 + x0 * ancho_t, 90.0 - y0 * ancho_t, ancho_t / TILE_PX)


# ---------------------------------------------------------------------------
# Núcleo: recorte exacto del cielo
# ---------------------------------------------------------------------------

def calcular_recorte(lat, lon, heading, pitch, fovh, fovv):
    """Calcula la homografía entre píxeles de salida y píxeles GIBS.

    Devuelve dict con esquinas lon/lat del cuadrilátero de cielo, el bbox,
    el zoom elegido y la correspondencia píxel salida -> píxel fuente.
    """
    # Esquinas de salida (píxels de borde) en orden TL, TR, BR, BL
    esquinas_salida = [(0, 0), (OUT_W, 0), (OUT_W, OUT_H), (0, OUT_H)]
    rayos = []
    for (px, py) in esquinas_salida:
        a = (px / OUT_W) * 2.0 - 1.0
        b = 1.0 - (py / OUT_H) * 2.0
        d = rayo_enu(heading, pitch, a, b, fovh, fovv)
        if d is None:
            raise RuntimeError("Dirección de cámara inválida.")
        rayos.append(d)

    # Intersección de cada rayo con el plano de nubes
    quad = []
    for d in rayos:
        hit = rayo_a_lonlat(d, lat, CLOUD_ALT)
        if hit is None:
            raise RuntimeError("El encuadre no corta el plano de nubes. "
                               "Mira más hacia el cielo.")
        quad.append((lon + hit[0], lat + hit[1]))

    lons = [q[0] for q in quad]
    lats = [q[1] for q in quad]
    lon_min, lon_max = min(lons), max(lons)
    lat_min, lat_max = min(lats), max(lats)
    if lon_max - lon_min > 20.0 or lat_max - lat_min > 20.0:
        raise RuntimeError("Campo de visión demasiado amplio para proyectar.")

    # Relleno para que el warp tenga margen de interpolación
    pad_x = (lon_max - lon_min) * 0.04
    pad_y = (lat_max - lat_min) * 0.04
    lon_min -= pad_x; lon_max += pad_x
    lat_min -= pad_y; lat_max += pad_y

    z = zoom_para_bbox(lon_max - lon_min, lat_max - lat_min)

    esquinas = {
        "tl": [quad[0][0], quad[0][1]],
        "tr": [quad[1][0], quad[1][1]],
        "br": [quad[2][0], quad[2][1]],
        "bl": [quad[3][0], quad[3][1]],
    }
    bbox = {"west": lon_min, "south": lat_min,
            "east": lon_max, "north": lat_max}
    return esquinas, bbox, z, esquinas_salida, quad


def homografia(esquinas_salida, puntos_fuente):
    """Resuelve los 8 coeficientes salida->fuente para PIL."""
    A, B = [], []
    for (x, y), (u, v) in zip(esquinas_salida, puntos_fuente):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        B.append(v)
    return np.linalg.solve(np.array(A, dtype=float), np.array(B, dtype=float))


def mascara_nubes(rgb):
    """Alfa 0 donde no hay nube, 1 donde la hay, suave en los bordes."""
    mn = rgb.min(axis=2)
    mx = rgb.max(axis=2)
    spread = mx - mn
    blancura = smoothstep((mn - 135.0) / (225.0 - 135.0))
    blancura = blancura * (1.0 - smoothstep((spread - 28.0) / (75.0 - 28.0)))
    return blancura


def generar_textura(lat, lon, heading, pitch, fovh, fovv, fecha_pedida):
    esquinas, bbox, z, esq_salida, quad = calcular_recorte(
        lat, lon, heading, pitch, fovh, fovv)

    capas_fecha = [(c, f) for f in fecha_candidatas(fecha_pedida)
                   for c in CAPAS_NUBE]
    mosaico, capa, fecha, m_lon_min, m_lat_max, deg_px = mosaico_gibs(
        bbox["west"], bbox["east"], bbox["south"], bbox["north"],
        capas_fecha, z)

    puntos_fuente = []
    for (qlon, qlat) in quad:
        px = (qlon - m_lon_min) / deg_px
        py = (m_lat_max - qlat) / deg_px
        puntos_fuente.append((px, py))

    coeffs = homografia(esq_salida, puntos_fuente)
    warped = mosaico.convert("RGBA").transform(
        (OUT_W, OUT_H), Image.PERSPECTIVE, tuple(coeffs),
        resample=Image.BICUBIC, fillcolor=(0, 0, 0, 0))

    arr = np.asarray(warped).astype(np.float32)

    # La máscara se calcula sobre el color original del satélite
    alfa = mascara_nubes(arr[..., :3])
    alfa = np.power(alfa, 0.75)  # el cirro fino se aprecia algo más

    # Realce de presentación sobre el RGB (la georreferenciación no cambia)
    rgb_img = Image.fromarray(arr[..., :3].astype(np.uint8), "RGB")
    rgb_img = rgb_img.filter(ImageFilter.UnsharpMask(radius=2, percent=45, threshold=3))
    arr[..., :3] = np.asarray(rgb_img).astype(np.float32)
    # estira contraste para que la nube se lea sobre el cielo azul
    arr[..., :3] = np.clip((arr[..., :3] - 60.0) / 195.0, 0.0, 1.0) * 255.0
    alfa_img = Image.fromarray((alfa * 255.0).astype(np.uint8), "L")
    alfa_img = alfa_img.filter(ImageFilter.GaussianBlur(1.2))
    arr[..., 3] = np.minimum(arr[..., 3], np.asarray(alfa_img, dtype=np.float32))

    salida = Image.fromarray(arr.astype(np.uint8), "RGBA")
    buf = io.BytesIO()
    salida.save(buf, format="PNG", optimize=True)
    texture_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    return {
        "ok": True,
        "layer": capa,
        "time": fecha,
        "texture": "data:image/png;base64," + texture_b64,
        "corners": esquinas,
        "cloudAlt": CLOUD_ALT,
        "size": [OUT_W, OUT_H],
        "zoom": z,
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.route("/")
def raiz():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/clouds.js")
def clouds_js():
    return send_from_directory(BASE_DIR, "clouds.js",
                               mimetype="application/javascript")


@app.route("/healthz")
def healthz():
    return jsonify(ok=True)


OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


@app.route("/overpass")
def overpass():
    """Proxy de edificios OSM: el navegador solo habla con nosotros."""
    try:
        lat = float(request.args.get("lat", "nan"))
        lon = float(request.args.get("lon", "nan"))
    except (TypeError, ValueError):
        return jsonify(ok=False)
    if not (math.isfinite(lat) and math.isfinite(lon)) or \
            not (-85.0 <= lat <= 85.0) or not (-180.0 <= lon <= 180.0):
        return jsonify(ok=False)
    query = ('[out:json];way["building"](around:280,' +
             f"{lat:.6f},{lon:.6f}" + ');out geom 600;')
    for ep in OVERPASS_ENDPOINTS:
        try:
            with cerrojo_http:
                r = sesion_http.post(ep, data={"data": query}, timeout=60)
            if r.status_code == 200:
                return app.response_class(
                    response=r.content, status=200,
                    mimetype="application/json")
        except Exception:
            continue
    return jsonify(ok=False)


@app.route("/elevation")
def elevation():
    """Proxy de la elevación del terreno (Open-Meteo, sin clave)."""
    try:
        lat = float(request.args.get("lat", "nan"))
        lon = float(request.args.get("lon", "nan"))
    except (TypeError, ValueError):
        return jsonify(elevation=0)
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return jsonify(elevation=0)
    url = ("https://api.open-meteo.com/v1/elevation?latitude=" +
           f"{lat:.5f}&longitude={lon:.5f}")
    try:
        with cerrojo_http:
            r = sesion_http.get(url, timeout=20)
        if r.status_code == 200:
            j = r.json()
            elev = j.get("elevation", [0])
            return jsonify(elevation=elev[0] if elev else 0)
    except Exception:
        pass
    return jsonify(elevation=0)


@app.route("/clouds")
def clouds():
    try:
        lat = float(request.args.get("lat", "nan"))
        lon = float(request.args.get("lon", "nan"))
        heading = float(request.args.get("heading", "0"))
        pitch = float(request.args.get("pitch", "45"))
        fovh = float(request.args.get("fovH", "60"))
        aspect = float(request.args.get("aspect", "1.6"))
        fecha = request.args.get("time", "").strip() or None
    except (TypeError, ValueError):
        return jsonify(ok=False, message="Parámetros numéricos inválidos.")

    if not (math.isfinite(lat) and math.isfinite(lon)) or \
            not (-85.0 <= lat <= 85.0) or not (-180.0 <= lon <= 180.0):
        return jsonify(ok=False, message="Latitud o longitud fuera de rango.")

    pitch = clamp(pitch, PITCH_MIN, PITCH_MAX)
    fovh = clamp(fovh, FOVH_MIN, FOVH_MAX)
    if not (0.2 <= aspect <= 6.0):
        aspect = 1.6
    fovv = math.degrees(2.0 * math.atan(math.tan(math.radians(fovh) / 2.0) / aspect))

    try:
        resultado = generar_textura(lat, lon, heading, pitch, fovh, fovv, fecha)
    except RuntimeError as e:
        return jsonify(ok=False, message=str(e))
    except Exception:
        return jsonify(ok=False, message="Error interno generando la textura.")

    resultado["meta"] = {
        "lat": lat, "lon": lon, "heading": heading, "pitch": pitch,
        "fovH": fovh, "fovV": round(fovv, 3), "cloudAlt": CLOUD_ALT,
    }
    return jsonify(resultado)


if __name__ == "__main__":
    puerto = int(os.environ.get("PORT", "5000"))
    print(f"\n  Manolit∞ Nubes en marcha")
    print(f"  Abre http://localhost:{puerto}\n")
    app.run(host="0.0.0.0", port=puerto, threaded=True)