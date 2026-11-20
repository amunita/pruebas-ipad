#!/usr/bin/env python3
"""Convierte los diagnósticos «mapa» (Markdown) a JSON para la página mapa/.

Determinista, sin IA. Sólo publica lo que ve el niño: la introducción y las
preguntas. Las reglas para el adulto y las pautas NO se copian.

Uso:
  MAPA_FUENTE=…/salidas/diagnostico-2027 .venv/bin/python tools/convertir_mapa.py
"""
import json
import os
import re
import sys
from pathlib import Path

import markdown

RAIZ = Path(__file__).resolve().parent.parent
FUENTE = Path(os.environ.get("MAPA_FUENTE", ""))
SALIDA = RAIZ / "mapa" / "data"

ITEM = re.compile(r"^\*\*([A-Z]{1,2}-?\d+)(?: · (.+?))?\*\*\s*$")
PARTE = re.compile(r"^([a-h])\) (.*)$")


def html(texto):
    texto = texto.strip("\n")
    if not texto.strip():
        return ""
    # Las viñetas « • » de las fuentes pasan a lista de Markdown.
    lineas = []
    for l in texto.split("\n"):
        m = re.match(r"^\s*• (.*)$", l)
        if m:
            if lineas and not lineas[-1].startswith("- ") and lineas[-1].strip():
                lineas.append("")
            lineas.append("- " + m.group(1))
        else:
            lineas.append(l)
    return markdown.markdown("\n".join(lineas), extensions=["tables", "fenced_code", "nl2br", "sane_lists"])


def cortar_items(lineas):
    """Devuelve (texto previo, [items]) de un bloque de líneas."""
    previo, items, actual = [], [], None
    en_codigo = False
    for l in lineas:
        if l.strip().startswith("```"):
            en_codigo = not en_codigo
        m = None if en_codigo else ITEM.match(l)
        if m:
            actual = {"codigo": m.group(1), "titulo": m.group(2) or "", "lineas": []}
            items.append(actual)
        elif actual is None:
            previo.append(l)
        else:
            actual["lineas"].append(l)
    salida = []
    for it in items:
        enunciado, partes, parte = [], [], None
        en_codigo = False
        for l in it["lineas"]:
            if l.strip().startswith("```"):
                en_codigo = not en_codigo
            m = None if en_codigo else PARTE.match(l)
            if m:
                parte = {"letra": m.group(1), "lineas": [m.group(2)]}
                partes.append(parte)
            elif parte is None:
                enunciado.append(l)
            else:
                parte["lineas"].append(l)
        if not partes:
            partes = [{"letra": "", "lineas": []}]
        salida.append({
            "codigo": it["codigo"],
            "titulo": it["titulo"],
            "enunciado": html("\n".join(enunciado)),
            "partes": [{"letra": p["letra"], "html": html("\n".join(p["lineas"]))} for p in partes],
        })
    return "\n".join(previo), salida


def secciones(texto, nivel):
    """Parte el texto por encabezados del nivel dado: [(título, [líneas])]."""
    marca = "#" * nivel + " "
    res, actual = [], None
    for l in texto.split("\n"):
        if l.startswith(marca):
            actual = (l[len(marca):].strip(), [])
            res.append(actual)
        elif actual is not None:
            actual[1].append(l)
    return res


def sin_regla(lineas):
    return [l for l in lineas if l.strip() != "---"]


def matematica(texto):
    h2 = dict(secciones(texto.split("\n# Eje")[0], 2))
    intro = next(v for k, v in h2.items() if k.startswith("Para Javier"))
    etapas = []
    for titulo_eje, cuerpo in secciones(texto, 1):
        if not titulo_eje.startswith("Eje"):
            continue
        eje = titulo_eje.split("·", 1)[1].strip()
        for titulo_tramo, lineas in secciones("\n".join(cuerpo), 2):
            tramo = re.match(r"(Tramo \d+)", titulo_tramo).group(1)
            previo, items = cortar_items(sin_regla(lineas))
            etapas.append({"grupo": eje, "titulo": f"{eje} · {tramo}", "intro": html(previo), "items": items})
    return {
        "id": "matematica", "titulo": "Matemática", "emoji": "🧮",
        "intro": html("\n".join(sin_regla(intro))),
        "estados": ["La resuelvo", "La he visto, pero no me acuerdo", "Esto no lo he visto nunca"],
        "extras": False,
        "cierre": "¿Quieres revisar alguna antes de seguir?",
        "etapas": etapas,
    }


def ciencias(texto):
    cabeza = texto.split("\n# Sesión")[0]
    intro = next(v for k, v in secciones(cabeza, 2) if k.startswith("Para leerle"))
    manos = {}
    for k, v in secciones(texto, 2):
        if k.startswith("Para comprobar con las manos"):
            for l in v:
                m = re.match(r"^- \*\*(.+?):\*\* (.*)$", l)
                if m:
                    manos[m.group(1)] = m.group(2)
    etapas = []
    for titulo, cuerpo in secciones(texto, 1):
        if not titulo.startswith("Sesión"):
            continue
        eje = titulo.split("·", 1)[1].strip()
        # Los subtítulos de la fuente nombran el curso: no se muestran al niño.
        lineas = [l for l in cuerpo if not l.startswith("## ")]
        corte = next((i for i, l in enumerate(cuerpo) if l.startswith("## Para comprobar")), None)
        if corte is not None:
            lineas = [l for l in cuerpo[:corte] if not l.startswith("## ")]
        previo, items = cortar_items(sin_regla(lineas))
        etapas.append({"grupo": eje, "titulo": eje, "intro": html(previo), "items": items,
                       "manos": html(manos.get(eje, ""))})
    return {
        "id": "ciencias", "titulo": "Ciencias", "emoji": "🔬",
        "intro": html("\n".join(sin_regla(intro))),
        "estados": ["Te lo explico", "Lo he oído, pero no sé explicarlo", "Esto no lo he visto nunca"],
        "extras": True,
        "cierre": "Elige una pregunta de esta sesión para comprobarla con las manos.",
        "etapas": etapas,
    }


# La página es pública: se quitan las referencias a la historia personal del niño.
PUBLICO = [(", porque son de cursos que no te han tocado o porque en Canadá se veían en otro orden.",
            ", porque son de cursos que no te han tocado."),
           ("Tú viviste en Canadá. Cuando en Chile es verano, allá es invierno.",
            "Cuando en Chile es verano, en el hemisferio norte es invierno.")]
PROHIBIDO = re.compile(r"Canadá|Montessori|Oakville|Frutillar|\bpauta\b|º básico", re.I)


def publico(texto, nombre):
    for a, b in PUBLICO:
        if a in texto:
            texto = texto.replace(a, b)
    return texto


def main():
    if not FUENTE.is_dir():
        sys.exit("Falta MAPA_FUENTE (carpeta con matematica.md y ciencias.md)")
    SALIDA.mkdir(parents=True, exist_ok=True)
    indice = []
    for nombre, fn in (("matematica", matematica), ("ciencias", ciencias)):
        ruta = FUENTE / f"{nombre}.md"
        if not ruta.exists():
            continue
        datos = fn(publico(ruta.read_text(encoding="utf-8"), nombre))
        fuga = PROHIBIDO.findall(json.dumps(datos, ensure_ascii=False))
        if fuga:
            sys.exit(f"{nombre}: texto que no debe publicarse: {sorted(set(fuga))}")
        n = sum(len(e["items"]) for e in datos["etapas"])
        vacios = [i["codigo"] for e in datos["etapas"] for i in e["items"]
                  if not i["enunciado"] and not any(p["html"] for p in i["partes"])]
        if vacios:
            sys.exit(f"{nombre}: ítems sin texto: {vacios}")
        (SALIDA / f"{nombre}.json").write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")
        indice.append({"id": datos["id"], "titulo": datos["titulo"], "emoji": datos["emoji"],
                       "etapas": len(datos["etapas"]), "items": n})
        print(f"{nombre}: {len(datos['etapas'])} etapas, {n} ítems")
    (SALIDA / "indice.json").write_text(json.dumps(indice, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
