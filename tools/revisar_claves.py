"""Revisa las claves de alternativas de Matemática que se pueden calcular (sin IA).

Lee data/*/matematica/*.json (ya convertidos, con las correcciones de pauta aplicadas),
reconoce el enunciado con reglas fijas, calcula el resultado y lo busca entre las
alternativas. Informa cuántas claves revisó, cuáles no calzan y cuáles no pudo calcular.
Sale con código 1 si alguna clave no calza.

    .venv/bin/python tools/revisar_claves.py
"""
import glob
import html
import json
import pathlib
import re
import sys
from fractions import Fraction

RAIZ = pathlib.Path(__file__).resolve().parent.parent
NUM = r"\d{1,3}(?:\.\d{3})+|\d+(?:,\d+)?"


def texto(h):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", h)).split())


def numero(s):
    """'1.250' → 1250, '0,75' → 0.75, '3/4' → 3/4, '2 1/3' → 7/3."""
    s = s.strip().replace("$", "")
    m = re.fullmatch(r"(\d+) (\d+)/(\d+)", s)
    if m:  # un número mixto bien escrito tiene la fracción menor que 1 («1 4/3» no lo es)
        return Fraction(int(m[1])) + Fraction(int(m[2]), int(m[3])) if int(m[2]) < int(m[3]) else None
    m = re.fullmatch(r"(\d+)/(\d+)", s)
    if m:
        return Fraction(int(m[1]), int(m[2]))
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", s):
        return Fraction(int(s.replace(".", "")))
    if re.fullmatch(r"\d+(?:,\d+)?", s):
        return Fraction(s.replace(",", "."))
    return None


def valor_alternativa(t):
    """Valor numérico de una alternativa: '8 cm' → 8, '$8.000' → 8000, '3/8' → 3/8."""
    t = re.sub(r"\s*(cm³|cm²|cm|m|km|°C)$", "", t.strip())
    if re.search(r"\d\s*[+×÷−]\s*\d", t) and "=" not in t:
        return expresion(t)  # «3 × 5», «4.000 + 600 + 9»
    return numero(t)


def nums(t):
    return [numero(x) for x in re.findall(NUM, t)]


def expresion(e):
    """Evalúa '7 + 5 × 4 − 2' o '100 ÷ (3 + 2) × 4' con fracciones exactas."""
    e = e.replace("×", "*").replace("÷", "/").replace("−", "-").replace(":", "/")
    partes = re.findall(rf"{NUM}|[-+*/()]", e)
    if "".join(partes) != re.sub(r"\s", "", e):
        return None
    py = "".join(f"Fraction({str(numero(p).numerator)},{str(numero(p).denominator)})" if re.match(r"\d", p) else p for p in partes)
    return eval(py, {"Fraction": Fraction, "__builtins__": {}})


# (nombre, patrón, cálculo). El primero que reconoce el enunciado calcula; el orden importa.
REGLAS = [
    ("operación escrita", rf"[Cc]uánto es ((?:{NUM}|[\s+×÷−()])+?)\s*\?",
     lambda m, t: expresion(m[1]) if re.search(r"[+×÷−]", m[1]) else None),
    ("porcentaje", rf"(\d+) % de ({NUM})", lambda m, t: numero(m[1]) * numero(m[2]) / 100),
    ("ecuación", rf"[a-z] ([+−]) ({NUM}) = ({NUM})",
     lambda m, t: numero(m[3]) - numero(m[2]) if m[1] == "+" else numero(m[3]) + numero(m[2])),
    ("promedio", rf"promedio de ((?:{NUM})(?:, (?:{NUM}))* y (?:{NUM}))", lambda m, t: sum(nums(m[1])) / len(nums(m[1]))),
    ("área de triángulo", rf"triángulo de base ({NUM}) cm y altura ({NUM}) cm", lambda m, t: numero(m[1]) * numero(m[2]) / 2),
    ("volumen", rf"({NUM}) cm de largo, ({NUM}) cm de ancho y ({NUM}) cm de alto",
     lambda m, t: numero(m[1]) * numero(m[2]) * numero(m[3])),
    ("fracción de una cantidad", rf"\$?({NUM}) y gasta (\d+/\d+)", lambda m, t: numero(m[1]) * numero(m[2])),
    ("fracción a decimal o mixto", r"escribe (\d+/\d+) como (?:número )?(?:decimal|mixto)", lambda m, t: numero(m[1])),
    ("decimal a fracción", rf"escribe ({NUM}) como fracción", lambda m, t: numero(m[1])),
    ("secuencia aritmética", rf"sigue(?: en el patrón)?\?? ((?:{NUM}), (?:{NUM}), (?:{NUM})(?:, (?:{NUM}))*)",
     lambda m, t: (lambda v: v[-1] + (v[1] - v[0]) if all(v[i + 1] - v[i] == v[1] - v[0] for i in range(len(v) - 1)) else None)(nums(m[1]))),
    ("equivalente", r"equivalente a (\d+/\d+)", lambda m, t: numero(m[1])),
    ("igual a una suma", rf"igual a ((?:{NUM})(?: \+ (?:{NUM}))+)", lambda m, t: expresion(m[1])),
    ("descomposición", rf"(?:descomposición correcta|forma expandida) de ({NUM})", lambda m, t: numero(m[1])),
    ("fracción que queda", r"comió (\d+/\d+) .* comió (\d+/\d+)\. ¿Qué fracción .* queda", lambda m, t: 1 - numero(m[1]) - numero(m[2])),
    ("el mayor", r"[Cc]uál (?:número|de estos números) es (?:el )?mayor", lambda m, t: max(v for v in map(valor_alternativa, ALTS.values()) if v is not None)),
    ("el menor", r"[Cc]uál (?:número|de estos números) es (?:el )?menor", lambda m, t: min(v for v in map(valor_alternativa, ALTS.values()) if v is not None)),
    # Problemas con dos números: la palabra clave decide la operación.
    ("problema de resta", r"[Cc]uánt\w+ (?:\w+ )?más|[Ss]e fueron|perdió|faltan|[Ss]e corta|son niñas", lambda m, t: abs(dos(t)[0] - dos(t)[1]) if dos(t) else None),
    ("problema de multiplicación", r"cada|platos con|en \d+ manos|dedos", lambda m, t: dos(t)[0] * dos(t)[1] if dos(t) else None),
    ("problema de suma", r"más\b|en total", lambda m, t: dos(t)[0] + dos(t)[1] if dos(t) else None),
]


ALTS = {}


def dos(t):
    v = nums(re.sub(r"\(\d+ pts?\)", "", t))
    return v if len(v) == 2 else None


def main():
    revisadas, malas, sin_calculo = 0, [], []
    for f in sorted(glob.glob(str(RAIZ / "data/*/matematica/*.json"))):
        p = json.loads(pathlib.Path(f).read_text(encoding="utf-8"))
        for b in p["bloques"]:
            if b.get("modo") != "alternativas":
                continue
            t = texto(b["html"])
            t = re.sub(r"\(\d+ pts?\).*", "", t)  # sólo el enunciado
            alts = {a["letra"]: texto(a["html"]) for a in b["alternativas"][0]}
            ALTS.clear(); ALTS.update(alts)
            nombre = r = None
            for nombre, patron, calc in REGLAS:
                m = re.search(patron, t)
                if m:
                    try:
                        r = calc(m, t)
                    except (TypeError, ZeroDivisionError):
                        r = None
                    break
            id_item = f"{p['id']}#{b['n']}"
            if r is None:
                sin_calculo.append(id_item)
                continue
            calzan = [l for l, a in alts.items() if valor_alternativa(a) == r]
            revisadas += 1
            if "-v" in sys.argv:
                print(f"  {id_item:24} {nombre:28} {str(r):>8} → {calzan} clave {b['clave']}")
            if calzan != [b["clave"]]:
                esperado = calzan[0] if len(calzan) == 1 else "?"
                malas.append(f"{id_item} ({nombre}): «{t}» da {float(r):g}; la pauta dice {b['clave']}) "
                             f"{alts.get(b['clave'])}, debería ser {esperado}) {alts.get(esperado, 'ninguna alternativa calza')}")
    print(f"{revisadas} claves revisadas · {len(malas)} no calzan · {len(sin_calculo)} sin cálculo automático")
    for x in malas:
        print("  MAL", x)
    if "-v" in sys.argv:
        print("  sin cálculo:", " ".join(sin_calculo))
    sys.exit(1 if malas else 0)


if __name__ == "__main__":
    main()
