#!/usr/bin/env python3
"""Convierte las pruebas y pautas (.md) del sistema nov-dic 2026 en JSON para la app.

Uso:
  .venv/bin/python tools/convertir.py [--fuente RUTA_A_contenido]   (o variable PRUEBAS_FUENTE)

Lee  <fuente>/<materia>/<2b|5b>/S{1..5}-prueba.md, S{n}-pauta.md, EX-examen.md, EX-pauta.md
     y las guías de estudio S{1..5}-guia.md y EX-guia.md
Escribe data/index.json, data/<nivel>/<materia>/<S1..S5|EX>.json, data/<nivel>/<materia>/<S1..S5|EX>-guia.json y la lista de
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


BLANCO = re.compile(r"(?:\\_|_){3,}")
SEPARADOR = re.compile(r"^\|[\s\-:|]+\|$")
CORRECCIONES = json.loads((pathlib.Path(__file__).parent / "correcciones-pauta.json").read_text(encoding="utf-8"))
SELECCIONES = json.loads((pathlib.Path(__file__).parent / "selecciones.json").read_text(encoding="utf-8"))


def normal(t):
    import unicodedata
    t = unicodedata.normalize("NFD", str(t).lower().strip())
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


def espacios(texto, conf):
    """Cambia los espacios para responder (rayas, celdas vacías, ☐) por marcadores que la app
    convierte en desplegables o casillas. Devuelve (texto, cuántos espacios, opciones por espacio)."""
    por_espacio, salida, cabecera = [], [], None

    def marcador(opciones=None):
        por_espacio.append(opciones)
        return f'<span class="sel" data-s="{len(por_espacio) - 1}"></span>'

    for linea in texto.split("\n"):
        s = linea.strip()
        if s.startswith("|"):
            celdas = s.strip("|").split("|")
            if cabecera is None:
                cabecera = [c.strip() for c in celdas]
                linea = BLANCO.sub(lambda m: marcador(), linea)  # rayas en la fila de arriba
            elif not SEPARADOR.match(s):
                nuevas, marcas = [], []
                for j, c in enumerate(celdas):
                    vacia = (c.strip() == "" and not conf.get("rayas")) or BLANCO.fullmatch(c.strip())
                    if conf.get("columna") and j != conf["columna"] - 1:
                        nuevas.append(c)
                        continue
                    if conf.get("matriz") and vacia:
                        marcas.append(cabecera[j])
                        nuevas.append(f' <span class="marca" data-s="{len(por_espacio)}" data-o="{html.escape(cabecera[j])}"></span> ')
                    elif vacia:
                        nuevas.append(" " + marcador() + " ")
                    else:
                        nuevas.append(BLANCO.sub(lambda m: marcador(), c))
                if marcas:
                    por_espacio.append(marcas)
                linea = "|" + "|".join(nuevas) + "|"
            salida.append(linea)
            continue
        cabecera = None
        if conf.get("lineas") and re.match(r"^[a-z]\) .+ – .+", s):
            # «a) cat – dog – pig»: se toca una de las palabras de la línea
            antes, resto = s.split(" ", 1)
            salida.append(antes + " " + marcador([o.strip() for o in resto.split("–")]))
            continue
        if "☐" in s:
            antes, *opciones = s.replace("&nbsp;", " ").split("☐")
            salida.append(antes.strip() + " " + marcador([o.strip() for o in opciones]))
            continue
        salida.append(BLANCO.sub(lambda m: marcador(), linea))
    texto = "\n".join(salida)
    if conf.get("ultimos"):
        # sólo los últimos N espacios se responden; los anteriores vuelven a ser rayas
        sobran = len(por_espacio) - conf["ultimos"]
        for k in range(len(por_espacio)):
            nuevo = '<span class="blanco" style="width:4em"></span>' if k < sobran else f'<span class="sel" data-s="{k - sobran}"></span>'
            texto = texto.replace(f'<span class="sel" data-s="{k}"></span>', nuevo, 1)
        por_espacio = por_espacio[max(sobran, 0):]
    if conf.get("agregar"):
        # ítems sin espacios marcados (p. ej. «ordena estas palabras»): se agregan al final
        texto += "\n\n" + " ".join(marcador() for _ in range(conf["agregar"]))
    return texto, por_espacio


def seleccion(clave, texto, conf, pts):
    texto, por_espacio = espacios(texto, conf)
    resp = conf["respuestas"]
    if len(por_espacio) != len(resp):
        raise SystemExit(f"{clave}: {len(por_espacio)} espacios en la prueba y {len(resp)} respuestas en selecciones.json")
    if conf.get("matriz"):
        tipo, opciones = "matriz", None
    elif any(por_espacio):
        tipo, opciones = "marcar", None
    else:
        tipo = "elegir"
        opciones = conf.get("opciones") or [str(i) for i in range(1, len(resp) + 1)]
    for i, r in enumerate(resp):
        validas = por_espacio[i] if tipo != "elegir" else opciones
        if normal(r) not in map(normal, validas):
            raise SystemExit(f"{clave}: la respuesta {r!r} del espacio {i + 1} no está entre las opciones {validas}")
    reglas = conf.get("reglas")
    tope = max(r[-1] for r in reglas) if reglas else len(resp)
    if tope != pts:
        raise SystemExit(f"{clave}: las reglas dan como máximo {tope} pts y la pauta dice {pts}")
    return texto, {"tipo": tipo, "opciones": opciones, "porEspacio": por_espacio if tipo != "elegir" else None,
                   "respuestas": resp, "reglas": reglas}


def convertir(fuente, materia, nivel, sesion):
    carpeta = fuente / materia / nivel
    instrumento = carpeta / ("EX-examen.md" if sesion == "EX" else f"{sesion}-prueba.md")
    pauta_md = carpeta / f"{sesion}-pauta.md"
    meta, cuerpo = frontmatter(instrumento.read_text(encoding="utf-8"))
    pmeta, pcuerpo, filas = leer_pauta(pauta_md.read_text(encoding="utf-8"))
    avisos = []
    pcuerpo = corregir_pauta(f"{nivel}-{materia}-{sesion}", pcuerpo, filas)

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
        sel = None
        clave_sel = f"{nivel}-{materia}-{sesion}#{n}"
        if clave_sel in SELECCIONES:
            texto, sel = seleccion(clave_sel, texto, SELECCIONES[clave_sel], fila["pts"])
            modo = "seleccion"
            usadas.add(clave_sel)
        lineas = texto.count('class="lineas"') + texto.count('class="cuadricula"')
        html_item = md(texto)
        for i, _ in enumerate(grupos):
            html_item = html_item.replace(f"<!--ALT{i}-->", f'<div class="alts" data-grupo="{i}"></div>')
        bloques.append({
            "tipo": "item", "n": n, "pts": fila["pts"], "modo": modo, "clave": clave,
            "alternativas": grupos, "html": html_item, "seleccion": sel,
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


usadas = set()


def corregir_pauta(id_prueba, pcuerpo, filas):
    """Aplica tools/correcciones-pauta.json a la fila del ítem y a la pauta completa."""
    for clave, c in CORRECCIONES.items():
        if not clave.startswith(id_prueba + "#"):
            continue
        n = int(clave.split("#")[1])
        f = filas.get(n)
        if not f or f["respuestas"] != [c["dice"]]:
            raise SystemExit(f"{clave}: la pauta fuente ya no dice {c['dice']!r} (dice {f and f['respuestas']}); revisa correcciones-pauta.json")
        nota = f" *(corregida; la pauta fuente decía {c['dice']})*"
        f["respuestas"] = [c["debe"] + nota]
        letra = re.match(r"^([A-E])\)", c["debe"])
        f["claves"] = [letra.group(1) if letra else None]
        fila_md = re.compile(rf"^(\|\s*{n}\s*\|\s*){re.escape(c['dice'])}(\s*\|)", re.M)
        pcuerpo, k = fila_md.subn(lambda m: m[1] + c["debe"] + nota + m[2], pcuerpo)
        if k != 1:
            raise SystemExit(f"{clave}: no encontré la fila en la pauta completa")
        usadas.add(clave)
    return pcuerpo


# ---------- guías de estudio ----------
# Las guías no llevan nota: el niño escribe con el lápiz en los ejercicios y toca las ☐. Cada espacio para
# responder tiene una clave estable dentro de la guía («e1», «e2»… para escribir; «c1»… para las casillas).
MESES = {m: i for i, m in enumerate(["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
                                      "septiembre", "octubre", "noviembre", "diciembre"], 1)}
# Secciones donde cada ítem numerado es un ejercicio con su recuadro para escribir.
PRACTICA = re.compile(r"^(practica|práctica|practice|reto|retos)\b", re.I)
# Secciones con las respuestas: en la app quedan plegadas («Ver respuestas»), sin espacios para responder.
RESPUESTAS = re.compile(r"^(respuestas|practice answers|answers)\b", re.I)
ESPACIOS = re.compile(r'(?:<div class="(?:lineas|cuadricula)"></div>\s*)+')
ILUS = re.compile(r'<div class="ilus[^"]*"[^>]*>.*?</div>', re.S)


def fecha_iso(texto):
    m = re.search(r"(\d{1,2}) de ([a-záéíóú]+) de (\d{4})", texto or "", re.I)
    return f"{int(m.group(3)):04d}-{MESES[m.group(2).lower()]:02d}-{int(m.group(1)):02d}" if m else ""


class Claves:
    def __init__(self):
        self.lista, self.opciones, self.e, self.c = [], {}, 0, 0

    def escribir(self, lineas):
        self.e += 1
        k = f"e{self.e}"
        self.lista.append(k)
        return f'<div class="escribir" data-k="{k}" data-lineas="{lineas}"></div>'

    def casillas(self, opciones):
        self.c += 1
        k = f"c{self.c}"
        self.lista.append(k)
        self.opciones[k] = opciones
        return f'<span class="opciones" data-k="{k}"></span>'


def sin_ilustraciones(texto):
    """Los bloques de ilustración (y sus prompts) no se muestran: queda un marcador discreto."""
    texto = re.sub(r"<!--.*?-->", "", texto, flags=re.S)
    return ILUS.sub('<div class="ilus-marca" aria-hidden="true">🖼️</div>', texto)


def casillas_guia(texto, claves):
    """Cada línea (o celda de tabla) con ☐ pasa a ser un grupo de casillas para tocar."""
    def grupo(t):
        if "☐" not in t:
            return t
        antes, *opciones = t.replace("&nbsp;", " ").split("☐")
        return antes.rstrip() + " " + claves.casillas([o.strip() for o in opciones if o.strip()])

    salida = []
    for linea in texto.split("\n"):
        if linea.strip().startswith("|") and "☐" in linea:
            linea = "|".join(grupo(c) for c in linea.split("|"))
        else:
            linea = grupo(linea)
        salida.append(linea)
    return "\n".join(salida)


def espacios_guia(texto, claves):
    """Las líneas y cuadrículas para escribir del PDF pasan a ser un recuadro para el lápiz."""
    def recuadro(m):
        lineas = m.group(0).count('class="lineas"')
        cuadros = m.group(0).count('class="cuadricula"')
        return "\n\n" + claves.escribir(max(2, -(-lineas * 3 // 2)) + 5 * cuadros) + "\n\n"
    return ESPACIOS.sub(recuadro, texto)


def numerar_practica(cuerpo):
    """En la práctica, «**3.** texto» es el ejercicio 3, igual que «3. texto»."""
    seccion, salida = "", []
    for linea in cuerpo.split("\n"):
        if linea.startswith("## "):
            seccion = linea[3:].strip()
        elif PRACTICA.match(seccion):
            linea = re.sub(r"^\*\*(\d+)\.\*\*\s*", r"\1. ", linea)
        salida.append(linea)
    return "\n".join(salida)


def convertir_guia(fuente, materia, nivel, sesion):
    archivo = fuente / materia / nivel / f"{sesion}-guia.md"
    meta, cuerpo = frontmatter(archivo.read_text(encoding="utf-8"))
    cuerpo = numerar_practica(sin_ilustraciones(cuerpo).replace('<div class="salto"></div>', ""))
    claves, bloques, seccion, en_respuestas = Claves(), [], "", False
    for b in partir_prueba(cuerpo):
        if b["tipo"] == "seccion":
            seccion = b["titulo"]
            en_respuestas = bool(RESPUESTAS.match(seccion))
            bloques.append({"tipo": "seccion", "titulo": seccion, "respuestas": en_respuestas})
            continue
        texto = "\n".join(b["lineas"])
        if en_respuestas:
            if b["tipo"] == "item":
                texto = f"{b['n']}. {texto}"
            bloques.append({"tipo": "libre", "html": md(ESPACIOS.sub("", texto))})
            continue
        texto = casillas_guia(texto, claves)
        tenia_espacio = bool(ESPACIOS.search(texto))
        texto = espacios_guia(texto, claves)
        if b["tipo"] == "item" and PRACTICA.match(seccion) and not tenia_espacio and 'class="opciones"' not in texto:
            texto += "\n\n" + claves.escribir(2 if nivel == "2b" else 3)
        if b["tipo"] == "item":
            bloques.append({"tipo": "ejercicio", "n": b["n"], "html": md(texto)})
        else:
            bloques.append({"tipo": "libre", "html": md(texto)})
    return {
        "id": f"{nivel}-{materia}-{sesion}-guia", "nivel": nivel, "materia": materia, "sesion": sesion,
        "titulo": meta.get("titulo", ""), "fecha": meta.get("fecha", ""), "fechaISO": fecha_iso(meta.get("fecha", "")),
        "bloques": bloques, "claves": claves.lista, "opciones": claves.opciones,
    }


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
    indice["guias"] = {}
    guias = 0
    for nivel, _ in NIVELES:
        for materia, _ in MATERIAS:
            for sesion in SESIONES:
                if not (args.fuente / materia / nivel / f"{sesion}-guia.md").exists():
                    print(f"  aviso: falta la guía {nivel}/{materia}/{sesion}-guia.md", file=sys.stderr)
                    problemas += 1
                    continue
                guia = convertir_guia(args.fuente, materia, nivel, sesion)
                if not guia["fechaISO"]:
                    raise SystemExit(f"{guia['id']}: no entiendo la fecha {guia['fecha']!r}")
                destino = datos / nivel / materia / f"{sesion}-guia.json"
                destino.write_text(json.dumps(guia, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                rel = destino.relative_to(RAIZ).as_posix()
                archivos.append(rel)
                guias += 1
                indice["guias"][f"{nivel}-{materia}-{sesion}"] = {
                    "archivo": rel, "titulo": guia["titulo"], "fecha": guia["fechaISO"], "espacios": len(guia["claves"])}
    sobran = (set(SELECCIONES) | set(CORRECCIONES)) - usadas - {"_formato"}
    if sobran:
        raise SystemExit(f"selecciones.json nombra ítems que no existen: {sorted(sobran)}")
    (datos / "index.json").write_text(json.dumps(indice, ensure_ascii=False, indent=1), encoding="utf-8")
    # Versión de los datos: cambia cuando cambia cualquier archivo, para renovar la caché offline.
    h = hashlib.sha256()
    for rel in archivos + ["data/index.json"]:
        h.update((RAIZ / rel).read_bytes())
    (RAIZ / "sw-archivos.js").write_text(
        "// Generado por tools/convertir.py: no editar a mano.\n"
        f"self.VERSION_DATOS = {json.dumps(h.hexdigest()[:12])};\n"
        f"self.ARCHIVOS_DATOS = {json.dumps(['data/index.json'] + archivos, indent=0)};\n", encoding="utf-8")
    print(f"{len(archivos) - guias} pruebas y {guias} guías convertidas · {problemas} avisos · datos {h.hexdigest()[:12]}")


if __name__ == "__main__":
    main()
