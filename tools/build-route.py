#!/usr/bin/env python3
"""
build-route.py — Genera js/route-data.js desde datos abiertos.

Fuentes:
  · Geometría de calles y polígonos: OpenStreetMap vía Overpass API (ODbL).
  · Cotas: modelo de elevación SRTM 30 m vía OpenTopoData.

El recorrido NO se dibuja a mano: se encadenan las vías reales de Cartagena en
orden de bajada. Av. Cartagena está mapeada como calzada dividida entre los
metros 560 y 1520 —el bandejón—, así que hay dos vías paralelas por tramo y se
toma siempre la de sentido poniente, que es por donde bajaría un skater.

Uso:
    python3 tools/build-route.py > js/route-data.js

Ojo: Overpass devuelve 504 con frecuencia cuando está cargado. El script
reintenta; si insiste en fallar, esperar unos minutos.
"""

import json
import math
import sys
import time
import urllib.parse
import urllib.request

OVERPASS = "https://overpass-api.de/api/interpreter"
ELEV = "https://api.opentopodata.org/v1/srtm30m"

# Vías OSM del descenso, en orden. rev=True invierte la vía para dejarla en
# sentido de bajada. El hueco entre la última de Av. Cartagena y Mariano
# Casanova es el rodeo de la Plaza de Cartagena.
PLAN = [
    (1342218158, True),   # Av. Cartagena, tramo alto (calzada simple)
    (684083043,  True),
    (684083042,  False),  # bandejón, calzada poniente
    (684083039,  False),
    (1297359428, False),
    (684083041,  False),  # 4 pistas, llegada a la plaza
    (80671788,   False),  # Mariano Casanova, frente a la Municipalidad
    (80671152,   False),  # Av. Playa Chica: zigzag y costanera
]

# Cotas de referencia del perfil de Google para la calzada. SRTM mide la
# superficie (incluye techos y copas) y en zona urbana lee ~10 m alto, así que
# se conserva su FORMA y se anclan los extremos a estos valores.
COTA_SALIDA, COTA_META = 123.0, 12.0

PASO = 20        # metros entre puntos del eje
R = 6371000.0


def overpass(query, intentos=6):
    for i in range(intentos):
        try:
            req = urllib.request.Request(OVERPASS, data=query.encode(),
                                         headers={"Content-Type": "text/plain"})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
            if d.get("elements"):
                return d
            print(f"  respuesta vacía (intento {i+1})", file=sys.stderr)
        except Exception as e:
            print(f"  {type(e).__name__}: {e} (intento {i+1})", file=sys.stderr)
        time.sleep(15)
    sys.exit("Overpass no respondió. Reintentar más tarde.")


def metros(a, b):
    dy = (b[0] - a[0]) * math.pi / 180 * R
    dx = (b[1] - a[1]) * math.pi / 180 * R * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)


def remuestrear(pts, paso):
    out = [pts[0]]
    recorrido, siguiente = 0.0, paso
    for a, b in zip(pts, pts[1:]):
        L = metros(a, b)
        if L == 0:
            continue
        while siguiente <= recorrido + L:
            f = (siguiente - recorrido) / L
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
            siguiente += paso
        recorrido += L
    return out, recorrido


def suavizar(v, w):
    return [sum(v[max(0, i - w):i + w + 1]) / len(v[max(0, i - w):i + w + 1])
            for i in range(len(v))]


def elevaciones(pts):
    out = []
    for i in range(0, len(pts), 100):
        lote = pts[i:i + 100]
        loc = "|".join(f"{p[0]:.6f},{p[1]:.6f}" for p in lote)
        url = f"{ELEV}?locations={urllib.parse.quote(loc)}"
        for intento in range(5):
            try:
                r = json.load(urllib.request.urlopen(url, timeout=60))
                if r.get("status") == "OK":
                    out += [x["elevation"] for x in r["results"]]
                    break
            except Exception as e:
                print(f"  elevación: {e}", file=sys.stderr)
            time.sleep(4)
        else:
            sys.exit("OpenTopoData no respondió.")
        time.sleep(1.5)
    return out


def main():
    print("Descargando calles...", file=sys.stderr)
    calles = overpass(
        '[out:json][timeout:180];'
        'way["highway"]["name"](-33.5540,-71.6120,-33.5430,-71.5880);out geom;')
    W = {e["id"]: [(p["lat"], p["lon"]) for p in e["geometry"]]
         for e in calles["elements"] if e.get("geometry")}

    ruta = []
    for wid, rev in PLAN:
        if wid not in W:
            sys.exit(f"Falta la vía {wid} en la respuesta de Overpass.")
        pts = W[wid][::-1] if rev else W[wid]
        if ruta and metros(ruta[-1], pts[0]) < 1:
            pts = pts[1:]
        ruta += pts

    eje, largo = remuestrear(ruta, PASO)
    print(f"  eje: {len(eje)} puntos, {largo:.0f} m", file=sys.stderr)

    print("Descargando elevaciones...", file=sys.stderr)
    ele = suavizar(elevaciones(eje), 1)
    lo, hi = ele[-1], ele[0]
    ele = [COTA_META + (v - lo) * (COTA_SALIDA - COTA_META) / (hi - lo) for v in ele]

    print("Descargando costa, playas y plaza...", file=sys.stderr)
    geo = overpass(
        '[out:json][timeout:180];('
        'way["natural"="coastline"](-33.570,-71.640,-33.535,-71.595);'
        'way["natural"="beach"](-33.560,-71.620,-33.540,-71.600);'
        'way["leisure"="park"](-33.550,-71.610,-33.543,-71.600););out geom;')
    rasgos = {}
    for e in geo["elements"]:
        t = e.get("tags", {})
        clave = t.get("name") or t.get("natural")
        rasgos.setdefault(clave, []).extend(
            [(p["lat"], p["lon"]) for p in e["geometry"]])

    costa = sorted((p for p in rasgos["coastline"]
                    if -33.560 < p[0] < -33.535 and -71.618 < p[1] < -71.600),
                   key=lambda p: -p[0])

    def f(v):
        return round(v, 6)

    def arr(ps):
        return "[" + ",".join(f"[{f(a)},{f(b)}]" for a, b in ps) + "]"

    salida = [
        "// GENERADO desde OpenStreetMap (ODbL) + elevación SRTM 30m via OpenTopoData.",
        "// No editar a mano: regenerar con tools/build-route.py",
        "",
        f"export const ORIGIN = {{ lat: {f(eje[0][0])}, lon: {f(eje[0][1])} }};",
        "",
        f"// Eje del descenso, un punto cada {PASO} m: [lat, lon, cota_m]",
        "export const ROUTE = [" + ",".join(
            f"[{f(p[0])},{f(p[1])},{round(v,1)}]" for p, v in zip(eje, ele)) + "];",
        "",
        "export const COAST = " + arr(costa) + ";",
        "",
        "export const PLAYA_CHICA = " + arr(rasgos["Playa Chica"]) + ";",
        "",
        "export const PLAYA_GRANDE = " + arr(rasgos["Playa Cartagena"]) + ";",
        "",
        "export const PLAZA = " + arr(rasgos["Plaza Cartagena"]) + ";",
        "",
    ]
    print("\n".join(salida))
    print("Listo.", file=sys.stderr)


if __name__ == "__main__":
    main()
