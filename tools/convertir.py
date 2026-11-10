#!/usr/bin/env python3
"""Convierte las pruebas y pautas (.md) del sistema nov-dic 2026 en JSON para la app.

Uso:
  .venv/bin/python tools/convertir.py [--fuente RUTA_A_contenido]   (o variable PRUEBAS_FUENTE)

Lee  <fuente>/<materia>/<2b|5b>/S{1..5}-prueba.md, S{n}-pauta.md, EX-examen.md, EX-pauta.md
Escribe data/index.json y data/<nivel>/<materia>/<S1..S5|EX>.json, y la lista de
archivos que el service worker deja disponibles sin conexión (sw-archivos.js).
La fuente no se edita: sólo se lee. Sin LLM: es un script determinista.
"""
import argparse, hashlib, os, html, json, pathlib, re, sys
import markdown

RAIZ = pathlib.Path(__file__).resolve().parent.parent
FUENTE = pathlib.Path(os.environ.get("PRUEBAS_FUENTE", "../Libros/Educativos/fuentes/complemento/pruebas/contenido"))
MATERIAS = [("lenguaje", "Lenguaje"), ("ingles", "Inglés"), ("matematica", "Matemática"),
            ("ciencias", "Ciencias"), ("historia", "Historia"), ("religion", "Religión")]
NIVELES = [("2b", "2º básico"), ("5b", "5º básico")]
SESIONES = ["S1", "S2", "S3", "S4", "S5", "EX"]
# Secciones que se hacen de viva voz con el adulto: no hay nada que escribir en el iPad.
ORALES = re.compile(r"(lectura en voz alta|speaking|oraci[oó]n de memoria)", re.I)
ESCRIBE = re.compile(r"\b(escrib|write|completa|complete|dibuja)", re.I)
# Párrafo que abre un texto compartido por varias preguntas: no pertenece al ítem anterior.
LIBRE = re.compile(r"^((lee|read|mira|observa|listen to the)\b.*(pregunta|question|respond|answer)|\*\*(texto|text|tabla)\b)", re.I)
PTS = re.compile(r"\*\*\((\d+)\s*pts?\.?\)\*\*")
EXT = ["tables", "sane_lists", "attr_list", "md_in_html"]


def blancos(texto):
    """Las rayas para completar (___ o \\_\\_\\_) se ven como una línea en blanco."""
    def raya(m):
        n = len(m.group(0).replace("\\", ""))
        return f'<span class="blanco" style="width:{min(max(n, 3), 30) * 0.6:.1f}em"></span>'
    return re.sub(r"(?:\\_|_){3,}", raya, texto)


def md(texto):
    return markdown.markdown(blancos(texto), extensions=EXT)


def frontmatter(texto):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", texto, re.S)
    meta = {}
    for linea in m.group(1).splitlines():
        if ":" in linea:
            k, v = linea.split(":", 1)
            meta[k.strip()] = v.split("#")[0].strip().strip('"').strip("'")
    return meta, m.group(2)


def extraer_alternativas(texto):
    """Saca los bloques <div class="alt"> y devuelve (texto sin ellos, [[{letra, html}]])."""
    grupos = []

    def sacar(m):
        alts = []
        for linea in m.group(1).strip().splitlines():
            a = re.match(r"^\s*([A-E])\)\s*(.*?)\s*$", linea)
            if a:
                alts.append({"letra": a.group(1), "html": md(a.group(2))[3:-4]})
        grupos.append(alts)
        return f"\n\n<!--ALT{len(grupos) - 1}-->\n\n"

    texto = re.sub(r'<div class="alt"[^>]*>(.*?)</div>', sacar, texto, flags=re.S)
    return texto, grupos


def partir_prueba(cuerpo):
    """Divide el cuerpo en bloques: seccion, libre (texto suelto) e item."""
    bloques, actual, prof, blanco_antes = [], None, 0, True

    def cerrar():
        if actual and (actual["tipo"] == "item" or "".join(actual["lineas"]).strip()):
            bloques.append(actual)

    for linea in cuerpo.split("\n"):
        s = linea.strip()
        if prof == 0 and s.startswith("## "):
            cerrar()
            bloques.append({"tipo": "seccion", "titulo": s[3:].strip()})
            actual = {"tipo": "libre", "lineas": []}
        elif prof == 0 and re.match(r"^\d+\.\s", s):
            cerrar()
            n, resto = s.split(".", 1)
            actual = {"tipo": "item", "n": int(n), "lineas": [resto.strip()]}
        elif prof == 0 and blanco_antes and actual and actual["tipo"] == "item" and LIBRE.match(s):
            cerrar()
            actual = {"tipo": "libre", "lineas": [linea]}
        else:
            if actual is None:
                actual = {"tipo": "libre", "lineas": []}
            actual["lineas"].append(linea)
        prof += len(re.findall(r"<div\b", s)) - len(re.findall(r"</div>", s))
        blanco_antes = s == ""
    cerrar()
    return bloques


def leer_pauta(texto):
    meta, cuerpo = frontmatter(texto)
    filas = {}
    m = re.search(r"^## Respuestas\s*\n(.*?)(?=^## |\Z)", cuerpo, re.S | re.M)
    for linea in (m.group(1) if m else "").splitlines():
        celdas = [c.strip() for c in linea.strip().strip("|").split("|")]
        if len(celdas) < 3 or not re.match(r"^\d+[a-z]?$", celdas[0]):
            continue
        n = int(re.match(r"\d+", celdas[0]).group())
        pts = int(celdas[2]) if celdas[2].isdigit() else 0
        respuesta = celdas[1]
        clave = re.match(r"^\**([A-E])\)", respuesta)
        f = filas.setdefault(n, {"pts": 0, "respuestas": [], "oa": [], "claves": []})
        f["pts"] += pts
        f["respuestas"].append((celdas[0] + ": " if not celdas[0].isdigit() else "") + respuesta)
        f["oa"].append(celdas[3] if len(celdas) > 3 else "")
        f["claves"].append(clave.group(1) if clave else None)
    return meta, cuerpo, filas


def convertir(fuente, materia, nivel, sesion):
    carpeta = fuente / materia / nivel
    instrumento = carpeta / ("EX-examen.md" if sesion == "EX" else f"{sesion}-prueba.md")
    pauta_md = carpeta / f"{sesion}-pauta.md"
    meta, cuerpo = frontmatter(instrumento.read_text(encoding="utf-8"))
    pmeta, pcuerpo, filas = leer_pauta(pauta_md.read_text(encoding="utf-8"))
    avisos = []

    bloques, seccion = [], ""
    for b in partir_prueba(cuerpo):
        if b["tipo"] == "seccion":
            seccion = b["titulo"]
            bloques.append({"tipo": "seccion", "titulo": seccion})
            continue
        texto = "\n".join(b["lineas"])
        if b["tipo"] == "libre":
            bloques.append({"tipo": "libre", "html": md(texto)})
            continue
        n = b["n"]
        texto, grupos = extraer_alternativas(texto)
        fila = filas.get(n)
        if not fila:
            avisos.append(f"ítem {n} sin fila en la pauta")
            fila = {"pts": sum(map(int, PTS.findall(texto))), "respuestas": [], "oa": [], "claves": []}
        oral = bool(ORALES.search(seccion)) and not ESCRIBE.search(b["lineas"][0]) and "lineas" not in texto
        clave = None
        if len(grupos) == 1 and len(fila["claves"]) == 1 and fila["claves"][0]:
            clave = fila["claves"][0]
        if grupos and not clave:
            modo = "manual"   # alternativas que no se corrigen solas: las puntúa Andrés
        elif clave:
            modo = "alternativas"
        else:
            modo = "oral" if oral else "escrito"
        lineas = texto.count('class="lineas"') + texto.count('class="cuadricula"')
        html_item = md(texto)
        for i, _ in enumerate(grupos):
            html_item = html_item.replace(f"<!--ALT{i}-->", f'<div class="alts" data-grupo="{i}"></div>')
        bloques.append({
            "tipo": "item", "n": n, "pts": fila["pts"], "modo": modo, "clave": clave,
            "alternativas": grupos, "html": html_item,
            "alto": max(3, lineas) if modo in ("escrito", "manual") else 0,
            "escribe": modo == "escrito" or (modo == "manual" and lineas > 0),
            "pauta": {"respuesta": md("\n\n".join(fila["respuestas"])) if fila["respuestas"] else "",
                      "oa": " · ".join(o for o in fila["oa"] if o)},
        })

    items = [b for b in bloques if b["tipo"] == "item"]
    total = int(meta.get("puntaje_total", 0))
    if sum(i["pts"] for i in items) != total:
        avisos.append(f"suma de ítems {sum(i['pts'] for i in items)} ≠ puntaje_total {total}")
    faltan = sorted(set(filas) - {i["n"] for i in items})
    if faltan:
        avisos.append(f"la pauta tiene ítems que no están en la prueba: {faltan}")

    return {
        "id": f"{nivel}-{materia}-{sesion}", "nivel": nivel, "materia": materia, "sesion": sesion,
        "tipo": meta.get("tipo"), "titulo": meta.get("titulo", ""), "fecha": meta.get("fecha", ""),
        "duracion": meta.get("duracion", ""), "puntajeTotal": total,
        "exigencia": int(pmeta.get("exigencia", meta.get("exigencia", 60))),
        "notaMinima": float(pmeta.get("nota_minima", meta.get("nota_minima", 2.0))),
        "bloques": bloques,
        "pautaHtml": md(pcuerpo),
    }, avisos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fuente", type=pathlib.Path, default=FUENTE)
    args = ap.parse_args()
    datos = RAIZ / "data"
    indice = {"niveles": dict(NIVELES), "materias": dict(MATERIAS), "sesiones": SESIONES, "pruebas": {}}
    archivos, problemas = [], 0
    for nivel, _ in NIVELES:
        for materia, _ in MATERIAS:
            for sesion in SESIONES:
                prueba, avisos = convertir(args.fuente, materia, nivel, sesion)
                destino = datos / nivel / materia / f"{sesion}.json"
                destino.parent.mkdir(parents=True, exist_ok=True)
                destino.write_text(json.dumps(prueba, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                rel = destino.relative_to(RAIZ).as_posix()
                archivos.append(rel)
                items = [b for b in prueba["bloques"] if b["tipo"] == "item"]
                modos = {}
                for i in items:
                    modos[i["modo"]] = modos.get(i["modo"], 0) + 1
                indice["pruebas"][prueba["id"]] = {
                    "archivo": rel, "titulo": prueba["titulo"], "puntajeTotal": prueba["puntajeTotal"],
                    "items": len(items), "modos": modos}
                for a in avisos:
                    problemas += 1
                    print(f"  aviso {prueba['id']}: {a}", file=sys.stderr)
    (datos / "index.json").write_text(json.dumps(indice, ensure_ascii=False, indent=1), encoding="utf-8")
    # Versión de los datos: cambia cuando cambia cualquier archivo, para renovar la caché offline.
    h = hashlib.sha256()
    for rel in archivos + ["data/index.json"]:
        h.update((RAIZ / rel).read_bytes())
    (RAIZ / "sw-archivos.js").write_text(
        "// Generado por tools/convertir.py: no editar a mano.\n"
        f"self.VERSION_DATOS = {json.dumps(h.hexdigest()[:12])};\n"
        f"self.ARCHIVOS_DATOS = {json.dumps(['data/index.json'] + archivos, indent=0)};\n", encoding="utf-8")
    print(f"{len(archivos)} pruebas convertidas · {problemas} avisos · datos {h.hexdigest()[:12]}")


if __name__ == "__main__":
    main()
