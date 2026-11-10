"use strict";
// Pruebas en iPad — Javier (5º básico) y Lourdes (2º básico).
// Los datos viven sólo en este iPad (IndexedDB). Las pruebas y pautas vienen de data/ (tools/convertir.py).

const VERSION = "2026-11-10.2";
const NINOS = {
  javier: { nombre: "Javier", nivel: "5b", curso: "5º básico" },
  lourdes: { nombre: "Lourdes", nivel: "2b", curso: "2º básico" },
};
// PIN de administración: se guarda sólo su huella (SHA-256 de "pruebas-ipad:" + PIN). Se cambia en Ajustes.
const PIN_HUELLA_INICIAL = "e917ab2bc6189032be07582233692efe49ce1492c6a43e4ca5af817c7539f865";
const SESION_NOMBRE = { S1: "Semana 1", S2: "Semana 2", S3: "Semana 3", S4: "Semana 4", S5: "Semana 5", EX: "Examen" };
const ANCHO = 1000; // ancho lógico del lienzo: los trazos se guardan en esta escala

// ---------- almacenamiento (IndexedDB, una tabla clave → valor) ----------
const almacen = (() => {
  let conexion;
  const abrir = () => conexion || (conexion = new Promise((ok, mal) => {
    const r = indexedDB.open("pruebas-ipad", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
  }));
  const tx = async (modo, fn) => {
    const d = await abrir();
    return new Promise((ok, mal) => {
      const t = d.transaction("kv", modo);
      const res = fn(t.objectStore("kv"));
      t.oncomplete = () => ok(res && "result" in res ? res.result : undefined);
      t.onerror = () => mal(t.error);
    });
  };
  return {
    get: (k) => tx("readonly", (s) => s.get(k)),
    set: (k, v) => tx("readwrite", (s) => s.put(v, k)),
    del: (k) => tx("readwrite", (s) => s.delete(k)),
    todo: async () => {
      const d = await abrir();
      return new Promise((ok, mal) => {
        const out = {};
        const c = d.transaction("kv").objectStore("kv").openCursor();
        c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } else ok(out); };
        c.onerror = () => mal(c.error);
      });
    },
    limpiar: () => tx("readwrite", (s) => s.clear()),
  };
})();

async function config() {
  const c = (await almacen.get("config")) || {};
  c.habilitadas = c.habilitadas || { javier: {}, lourdes: {} };
  c.pinHuella = c.pinHuella || PIN_HUELLA_INICIAL;
  return c;
}
const claveResp = (nino, materia, sesion) => `r:${nino}:${materia}:${sesion}`;
async function respuesta(nino, materia, sesion) {
  const r = (await almacen.get(claveResp(nino, materia, sesion))) || { estado: "nueva", items: {}, puntajes: {}, observaciones: "" };
  r.items = r.items || {}; r.puntajes = r.puntajes || {};
  return r;
}
const guardarResp = (nino, materia, sesion, r) => { r.actualizado = new Date().toISOString(); return almacen.set(claveResp(nino, materia, sesion), r); };

// ---------- datos de las pruebas ----------
let INDICE;
const pruebas = {};
async function indice() {
  if (!INDICE) INDICE = await (await fetch("data/index.json")).json();
  return INDICE;
}
async function prueba(nivel, materia, sesion) {
  const id = `${nivel}-${materia}-${sesion}`;
  if (!pruebas[id]) pruebas[id] = await (await fetch(`data/${nivel}/${materia}/${sesion}.json`)).json();
  return pruebas[id];
}

// ---------- notas (escala chilena 2,0–7,0, misma fórmula que las pautas) ----------
function nota(p, total, exig = 60, nmin = 2.0) {
  const corte = (total * exig) / 100;
  const n = p <= corte ? nmin + (4 - nmin) * (corte ? p / corte : 1)
    : 4 + 3 * (total > corte ? (p - corte) / (total - corte) : 1);
  return Math.round((n + 1e-9) * 10) / 10;
}
const fmt = (n) => (n == null || n === "" ? "—" : Number(n).toFixed(1).replace(".", ","));

// ---------- ítems de elegir / marcar: corrección según las reglas de la pauta ----------
const normal = (t) => String(t ?? "").toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
function aciertosSeleccion(sel, elegidas) {
  return sel.respuestas.map((r, i) => elegidas?.[i] != null && normal(elegidas[i]) === normal(r));
}
function puntajeSeleccion(sel, elegidas, pts) {
  const bien = aciertosSeleccion(sel, elegidas);
  const n = bien.filter(Boolean).length;
  if (!sel.reglas) return Math.min(n, pts);
  for (const [tipo, a, b] of sel.reglas) {
    if (tipo === "aciertos" && n >= a) return b;
    if (tipo === "filas" && a.every((i) => bien[i - 1])) return b;
    if (tipo === "intercambio") {
      const mal = bien.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
      if (mal.length === 2 && normal(elegidas[mal[0]]) === normal(sel.respuestas[mal[1]])
        && normal(elegidas[mal[1]]) === normal(sel.respuestas[mal[0]])) return a;
    }
    if (tipo === "uno_fuera") {
      // un solo valor fuera de lugar: al sacarlo, los demás quedan en el orden correcto
      const pos = sel.respuestas.map((_, i) => sel.respuestas.findIndex((r) => normal(r) === normal(elegidas?.[i])));
      if (pos.every((x) => x >= 0) && new Set(pos).size === pos.length) {
        for (let k = 0; k < pos.length; k++) {
          const resto = pos.filter((_, j) => j !== k);
          if (resto.every((x, j) => j === 0 || x > resto[j - 1])) return a;
        }
      }
    }
  }
  return 0;
}

// ---------- utilidades de interfaz ----------
function h(tag, attrs = {}, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of hijos.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
const app = () => document.getElementById("app");
function pintar(...nodos) { const a = app(); a.replaceChildren(...nodos); window.scrollTo(0, 0); }
function avisar(texto) {
  const a = document.getElementById("aviso");
  a.textContent = texto; a.classList.add("ver");
  clearTimeout(avisar.t); avisar.t = setTimeout(() => a.classList.remove("ver"), 2600);
}
const ir = (ruta) => { location.hash = ruta; };
const volver = (ruta, texto = "‹ Volver") => h("button", { class: "volver", onclick: () => ir(ruta) }, texto);
function nivelVisual(nivel) { document.body.className = nivel ? `nivel-${nivel}` : ""; }

// Prepara el HTML de un ítem o texto: las instrucciones para el adulto quedan plegadas.
function cuerpoHTML(html) {
  const d = h("div", { class: "cuerpo-item", html });
  d.querySelectorAll(".nota-adulto").forEach((n) => {
    const det = h("details", { class: "adulto" }, h("summary", {}, "Para el adulto"), h("div", { html: n.innerHTML }));
    n.replaceWith(det);
  });
  return d;
}

// ---------- lienzo para escribir con el lápiz ----------
class Lienzo {
  constructor(datos, { editable, lineas, nivel, dedo, alCambiar }) {
    this.d = datos; this.d.trazos = this.d.trazos || []; this.d.extra = this.d.extra || 0;
    this.editable = editable; this.lineas = lineas; this.dedo = dedo; this.alCambiar = alCambiar || (() => {});
    this.paso = nivel === "2b" ? 115 : 95; // alto lógico de cada renglón
    this.herr = "lapiz"; this.historia = []; this.activo = null;
    this.canvas = h("canvas");
    const barra = editable ? h("div", { class: "herramientas" },
      this.bLapiz = h("button", { class: "activa", onclick: () => this.usar("lapiz") }, "✏️ Lápiz"),
      this.bGoma = h("button", { onclick: () => this.usar("borrar") }, "🧽 Borrar"),
      h("button", { onclick: () => this.deshacer() }, "↩︎ Deshacer"),
      h("button", { onclick: () => this.hojaExtra() }, "➕ Hoja extra"),
      h("button", { class: "peligro", onclick: () => this.limpiar() }, "Borrar todo")) : null;
    this.el = h("div", { class: "lienzo" + (editable ? "" : " solo-lectura") }, barra, this.canvas);
    if (editable) this.eventos();
    new ResizeObserver(() => this.medir()).observe(this.canvas);
  }
  altoLogico() { return (this.lineas + this.d.extra) * this.paso + 30; }
  medir() {
    const w = this.canvas.clientWidth; if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    this.escala = w / ANCHO;
    const hCss = this.altoLogico() * this.escala;
    this.canvas.style.height = hCss + "px";
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(hCss * dpr);
    this.ctx = this.canvas.getContext("2d");
    this.ctx.setTransform(dpr * this.escala, 0, 0, dpr * this.escala, 0, 0);
    this.dibujar();
  }
  dibujar() {
    const c = this.ctx; if (!c) return;
    c.clearRect(0, 0, ANCHO, this.altoLogico());
    c.strokeStyle = "#cfe0ee"; c.lineWidth = 2;
    for (let y = this.paso; y < this.altoLogico(); y += this.paso) { c.beginPath(); c.moveTo(14, y); c.lineTo(ANCHO - 14, y); c.stroke(); }
    c.strokeStyle = "#1a2b4a"; c.lineCap = "round"; c.lineJoin = "round";
    for (const t of this.d.trazos) this.trazo(t);
  }
  trazo(t) {
    const p = t.p, c = this.ctx;
    c.lineWidth = t.w || 4;
    c.beginPath(); c.moveTo(p[0], p[1]);
    if (p.length === 2) c.lineTo(p[0] + 0.1, p[1]);
    for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
    c.stroke();
  }
  punto(e) {
    const r = this.canvas.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / this.escala) * 10) / 10, Math.round(((e.clientY - r.top) / this.escala) * 10) / 10];
  }
  usar(herr) {
    this.herr = herr;
    this.bLapiz.classList.toggle("activa", herr === "lapiz");
    this.bGoma.classList.toggle("activa", herr === "borrar");
  }
  guardarHistoria() { this.historia.push(this.d.trazos.slice()); if (this.historia.length > 60) this.historia.shift(); }
  eventos() {
    const cv = this.canvas;
    const acepta = (e) => e.pointerType !== "touch" || this.dedo; // la palma (touch) no escribe
    cv.addEventListener("pointerdown", (e) => {
      if (!acepta(e) || this.activo != null) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      this.activo = e.pointerId;
      this.guardarHistoria();
      if (this.herr === "borrar") { this.borrarEn(this.punto(e)); return; }
      this.actual = { w: 4, p: this.punto(e) };
      this.d.trazos.push(this.actual);
      this.dibujar();
    });
    cv.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.activo) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) {
        const pt = this.punto(ev);
        if (this.herr === "borrar") this.borrarEn(pt);
        else this.actual.p.push(pt[0], pt[1]);
      }
      if (this.herr !== "borrar") {
        const p = this.actual.p, n = p.length, c = this.ctx;
        c.lineWidth = this.actual.w; c.beginPath();
        const desde = Math.max(0, n - 2 * (evs.length + 1));
        c.moveTo(p[desde], p[desde + 1]);
        for (let i = desde + 2; i < n; i += 2) c.lineTo(p[i], p[i + 1]);
        c.stroke();
      }
    });
    const fin = (e) => {
      if (e.pointerId !== this.activo) return;
      this.activo = null; this.actual = null;
      this.alCambiar();
    };
    cv.addEventListener("pointerup", fin);
    cv.addEventListener("pointercancel", fin);
    // Safari: evita que el toque del lápiz seleccione texto o haga zoom
    cv.addEventListener("touchstart", (e) => { if (this.dedo || [...e.touches].some((t) => t.touchType === "stylus")) e.preventDefault(); }, { passive: false });
  }
  borrarEn([x, y]) {
    const r2 = 22 * 22;
    const antes = this.d.trazos.length;
    this.d.trazos = this.d.trazos.filter((t) => {
      for (let i = 0; i < t.p.length; i += 2) { const dx = t.p[i] - x, dy = t.p[i + 1] - y; if (dx * dx + dy * dy < r2) return false; }
      return true;
    });
    if (this.d.trazos.length !== antes) this.dibujar();
  }
  deshacer() { if (!this.historia.length) return; this.d.trazos = this.historia.pop(); this.dibujar(); this.alCambiar(); }
  limpiar() {
    if (!this.d.trazos.length || !confirm("¿Borrar todo lo escrito en este recuadro?")) return;
    this.guardarHistoria(); this.d.trazos = []; this.dibujar(); this.alCambiar();
  }
  hojaExtra() { this.d.extra += 6; this.medir(); this.alCambiar(); this.canvas.scrollIntoView({ block: "end", behavior: "smooth" }); }
}

// ---------- pantallas del niño ----------
function vistaPortada() {
  nivelVisual(null);
  pintar(
    h("h1", { style: "text-align:center;margin-top:1.2em" }, "¿Quién va a dar la prueba?"),
    h("div", { class: "ninos" }, Object.entries(NINOS).map(([id, n]) =>
      h("button", { class: `nino ${id}`, onclick: () => ir(`/n/${id}`) }, n.nombre, h("small", {}, n.curso)))),
    h("div", { class: "pie-admin" }, h("button", { onclick: () => ir("/admin") }, "Administración")));
}

const habilitada = (cfg, nino, materia, sesion) => !!cfg.habilitadas[nino]?.[`${materia}:${sesion}`];

async function vistaMaterias(nino) {
  const n = NINOS[nino]; if (!n) return ir("/");
  nivelVisual(n.nivel);
  const [cfg, ind] = [await config(), await indice()];
  const materias = Object.entries(ind.materias).filter(([m]) => ind.sesiones.some((s) => habilitada(cfg, nino, m, s)));
  pintar(
    h("div", { class: "barra" }, volver("/")),
    h("h1", {}, `Hola, ${n.nombre}. ¿Qué materia?`),
    materias.length ? h("div", { class: "grilla" }, materias.map(([m, nombre]) => h("button", { onclick: () => ir(`/n/${nino}/${m}`) }, nombre)))
      : h("p", { class: "vacio" }, "Todavía no hay pruebas listas. Pídele al adulto que las habilite."));
}

async function vistaSesiones(nino, materia) {
  const n = NINOS[nino]; if (!n) return ir("/");
  nivelVisual(n.nivel);
  const [cfg, ind] = [await config(), await indice()];
  const sesiones = ind.sesiones.filter((s) => habilitada(cfg, nino, materia, s));
  const botones = [];
  for (const s of sesiones) {
    const r = await respuesta(nino, materia, s);
    const hecha = r.estado === "entregada";
    botones.push(h("button", { class: hecha ? "hecha" : "", onclick: () => ir(`/p/${nino}/${materia}/${s}`) },
      SESION_NOMBRE[s], h("small", {}, hecha ? "✓ Guardada" : r.estado === "curso" ? "Empezada" : "Por hacer")));
  }
  pintar(
    h("div", { class: "barra" }, volver(`/n/${nino}`)),
    h("h1", {}, ind.materias[materia] || materia),
    botones.length ? h("div", { class: "grilla" }, botones) : h("p", { class: "vacio" }, "No hay pruebas habilitadas en esta materia."));
}

async function vistaPrueba(nino, materia, sesion) {
  const n = NINOS[nino]; if (!n) return ir("/");
  nivelVisual(n.nivel);
  const cfg = await config();
  if (!habilitada(cfg, nino, materia, sesion)) return ir(`/n/${nino}`);
  const [p, r] = [await prueba(n.nivel, materia, sesion), await respuesta(nino, materia, sesion)];
  const cerrada = r.estado === "entregada";
  let espera;
  const guardarBorrador = () => {
    if (r.estado === "nueva") r.estado = "curso";
    clearTimeout(espera); espera = setTimeout(() => guardarResp(nino, materia, sesion, r), 400);
  };
  const nodos = [
    h("div", { class: "barra" }, volver(`/n/${nino}/${materia}`)),
    h("div", { class: "cabecera" }, h("h1", {}, p.titulo), h("p", {}, `${n.nombre} · ${p.duracion} · ${p.puntajeTotal} puntos`)),
  ];
  if (cerrada) nodos.push(h("div", { class: "sello" }, "✓ Esta prueba ya está guardada."));
  for (const b of p.bloques) {
    if (b.tipo === "seccion") nodos.push(h("h2", {}, b.titulo));
    else if (b.tipo === "libre") nodos.push(h("div", { class: "bloque" }, cuerpoHTML(b.html)));
    else nodos.push(itemNino(b, r.items[b.n] = r.items[b.n] || {}, { editable: !cerrada, nivel: n.nivel, dedo: !!cfg.dedo, alCambiar: guardarBorrador }));
  }
  if (!cerrada) {
    nodos.push(h("div", { class: "guardar" }, h("button", { class: "primario", onclick: async () => {
      if (!confirm("¿Terminaste la prueba? Al guardarla ya no se puede cambiar.")) return;
      clearTimeout(espera);
      r.estado = "entregada"; r.entregadaEn = new Date().toISOString();
      await guardarResp(nino, materia, sesion, r);
      avisar("¡Prueba guardada! Muy bien.");
      ir(`/n/${nino}/${materia}`);
    } }, "Guardar prueba")));
  }
  pintar(...nodos);
}

function itemNino(b, resp, op) {
  const cont = h("div", { class: "item", id: `item-${b.n}` }, h("div", { class: "num" }, String(b.n)));
  const cuerpo = cuerpoHTML(b.html);
  cont.append(cuerpo);
  resp.alt = resp.alt || {};
  cuerpo.querySelectorAll(".alts").forEach((zona) => {
    const g = zona.dataset.grupo;
    const botones = b.alternativas[g].map((a) => {
      const bt = h("button", { class: "alt" + (resp.alt[g] === a.letra ? " marcada" : ""), disabled: !op.editable,
        onclick: () => {
          resp.alt[g] = resp.alt[g] === a.letra ? undefined : a.letra;
          botones.forEach((x, i) => x.classList.toggle("marcada", resp.alt[g] === b.alternativas[g][i].letra));
          op.alCambiar();
        } }, h("span", { class: "letra" }, a.letra), h("span", { html: a.html }));
      return bt;
    });
    zona.append(...botones);
  });
  if (b.seleccion) armarSeleccion(cuerpo, b.seleccion, resp, op);
  if (b.modo === "oral") cont.append(h("div", { class: "oral" }, "🗣️ Esta parte la haces en voz alta con el adulto."));
  if (b.escribe) {
    resp.lienzo = resp.lienzo || {};
    const l = new Lienzo(resp.lienzo, { ...op, lineas: Math.max(4, Math.ceil(b.alto * 1.5)) });
    cont.append(l.el);
  }
  return cont;
}

function armarSeleccion(cuerpo, sel, resp, op) {
  resp.sel = resp.sel || {};
  const cambiar = (i, v) => { resp.sel[i] = resp.sel[i] === v ? undefined : v; op.alCambiar(); };
  cuerpo.querySelectorAll(".sel").forEach((zona) => {
    const i = Number(zona.dataset.s);
    if (sel.tipo === "elegir") {
      const s = h("select", { class: "desplegable", disabled: !op.editable, "data-s": i },
        h("option", { value: "" }, "—"), sel.opciones.map((o) => h("option", { value: o }, o)));
      s.value = resp.sel[i] ?? "";
      s.addEventListener("change", () => { resp.sel[i] = s.value || undefined; op.alCambiar(); });
      zona.replaceWith(s);
    } else {
      const grupo = h("span", { class: "casillas", "data-s": i });
      const pintar = () => grupo.querySelectorAll("button").forEach((x) => x.classList.toggle("marcada", resp.sel[i] === x.dataset.o));
      grupo.append(...sel.porEspacio[i].map((o) => h("button", { class: "casilla", "data-o": o, disabled: !op.editable,
        onclick: () => { cambiar(i, o); pintar(); } }, h("span", { class: "cuadro" }), o)));
      pintar();
      zona.replaceWith(grupo);
    }
  });
  const celdas = [...cuerpo.querySelectorAll(".marca")];
  const pintarMatriz = () => celdas.forEach((m) => {
    const td = m.closest("td");
    const on = resp.sel[m.dataset.s] === m.dataset.o;
    td.classList.toggle("marcada", on);
    m.textContent = on ? "✗" : "";
  });
  celdas.forEach((m) => {
    const td = m.closest("td");
    td.classList.add("celda-marca");
    td.dataset.s = m.dataset.s; td.dataset.o = m.dataset.o;
    if (op.editable) td.addEventListener("click", () => { cambiar(Number(m.dataset.s), m.dataset.o); pintarMatriz(); });
  });
  pintarMatriz();
}

// ---------- administración ----------
let adminOk = false;
async function huella(pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pruebas-ipad:" + pin));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function vistaPin(destino) {
  nivelVisual(null);
  let pin = "", espera;
  const puntos = h("div", { class: "puntos" });
  const tecla = (t) => h("button", { onclick: async () => {
    clearTimeout(espera);
    if (t === "⌫") pin = pin.slice(0, -1); else if (pin.length < 8) pin += t;
    puntos.textContent = "●".repeat(pin.length);
    if (pin.length >= 4) {
      const cfg = await config();
      if ((await huella(pin)) === cfg.pinHuella) { adminOk = true; ir(destino); route(); return; }
      // PIN incorrecto: si no sigue escribiendo (PIN de hasta 8 números), se limpia solo
      espera = setTimeout(() => { pin = ""; puntos.textContent = ""; avisar("PIN incorrecto"); }, pin.length >= 8 ? 0 : 1500);
    }
  } }, t);
  pintar(h("div", { class: "barra" }, volver("/")),
    h("div", { class: "pin" }, h("h1", {}, "Administración"), h("p", {}, "Escribe el PIN"), puntos,
      h("div", { class: "teclado" }, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((t) => t ? tecla(t) : h("span")))));
}

function pestanas(activa) {
  const p = [["javier", "Javier"], ["lourdes", "Lourdes"], ["libreta", "Libreta de notas"], ["ajustes", "Ajustes"]];
  return h("div", { class: "pestanas" }, p.map(([id, t]) =>
    h("button", { class: id === activa ? "activa" : "", onclick: () => ir(id === "libreta" || id === "ajustes" ? `/admin/${id}` : `/admin/n/${id}`) }, t)),
    h("button", { onclick: () => { adminOk = false; ir("/"); } }, "Salir"));
}

const ESTADO_TXT = { nueva: "", curso: "empezada", entregada: "entregada" };
async function vistaAdminNino(nino) {
  nivelVisual(null);
  const n = NINOS[nino]; if (!n) return ir("/admin/n/javier");
  const [cfg, ind] = [await config(), await indice()];
  const libreta = (await almacen.get(`l:${nino}`)) || {};
  const hab = cfg.habilitadas[nino] = cfg.habilitadas[nino] || {};
  const tabla = h("table", { class: "tabla" });
  const cab = h("tr", {}, h("th", {}, "Materia"));
  for (const s of ind.sesiones) {
    cab.append(h("th", { class: "centro" }, h("button", { title: "Habilitar o quitar en todas las materias", onclick: async () => {
      const todas = Object.keys(ind.materias).every((m) => hab[`${m}:${s}`]);
      Object.keys(ind.materias).forEach((m) => { hab[`${m}:${s}`] = !todas; });
      await almacen.set("config", cfg); vistaAdminNino(nino);
    } }, s)));
  }
  tabla.append(cab);
  for (const [m, nombre] of Object.entries(ind.materias)) {
    const fila = h("tr", {}, h("th", {}, nombre));
    for (const s of ind.sesiones) {
      const k = `${m}:${s}`;
      const r = await almacen.get(claveResp(nino, m, s));
      const enLib = libreta[k];
      const celda = h("td", { class: "centro" },
        h("button", { class: "toggle" + (hab[k] ? " si" : ""), onclick: async () => {
          hab[k] = !hab[k]; await almacen.set("config", cfg); vistaAdminNino(nino);
        } }, hab[k] ? "Visible" : "Oculta"));
      if (r || enLib) {
        const est = enLib ? `nota ${fmt(enLib.nota)}` : ESTADO_TXT[r.estado] || "";
        celda.append(h("div", { style: "margin-top:6px" }, h("button", { onclick: () => ir(`/admin/c/${nino}/${m}/${s}`) },
          h("span", { class: "estado " + (enLib ? "libreta" : r.estado) }, est || "abrir"))));
      } else if (hab[k]) {
        celda.append(h("div", { style: "margin-top:6px" }, h("button", { onclick: () => ir(`/admin/c/${nino}/${m}/${s}`) }, "Corregir")));
      }
      fila.append(celda);
    }
    tabla.append(fila);
  }
  pintar(pestanas(nino), h("h1", {}, `${n.nombre} · ${n.curso}`),
    h("p", {}, "«Visible» = la prueba aparece en la portada de ", n.nombre, ". Toca S1…EX para habilitar una semana en todas las materias. Toca el estado para ver y corregir la prueba."),
    h("div", { style: "overflow-x:auto" }, tabla));
}

function puntajeItem(b, resp, punt) {
  if (b.modo === "alternativas") return { valor: resp.alt?.[0] === b.clave ? b.pts : 0, auto: true };
  if (b.modo === "seleccion") return { valor: puntajeSeleccion(b.seleccion, resp.sel, b.pts), auto: true };
  const v = punt[b.n];
  return { valor: v == null ? null : v, auto: false };
}

async function vistaCorregir(nino, materia, sesion) {
  nivelVisual(null);
  const n = NINOS[nino]; if (!n) return ir("/admin");
  const [p, r, ind] = [await prueba(n.nivel, materia, sesion), await respuesta(nino, materia, sesion), await indice()];
  const libreta = (await almacen.get(`l:${nino}`)) || {};
  const items = p.bloques.filter((b) => b.tipo === "item");
  const resumen = h("div", { class: "resumen" });
  const tarjetas = {};

  const calcular = () => {
    let suma = 0, faltan = 0;
    for (const b of items) {
      const { valor } = puntajeItem(b, r.items[b.n] || {}, r.puntajes);
      if (valor == null) faltan++; else suma += valor;
      tarjetas[b.n]?.classList.toggle("pendiente", valor == null);
    }
    const pct = p.puntajeTotal ? Math.round((suma / p.puntajeTotal) * 100) : 0;
    return { suma, faltan, pct, nota: nota(suma, p.puntajeTotal, p.exigencia, p.notaMinima) };
  };
  const refrescar = () => {
    const c = calcular();
    resumen.replaceChildren(
      h("div", {}, h("div", {}, `Puntaje ${c.suma} / ${p.puntajeTotal} · ${c.pct}%`),
        h("div", { style: "font-size:.8rem;opacity:.8" }, c.faltan ? `Faltan ${c.faltan} ítem(s) por puntuar` : "Todo puntuado")),
      h("div", { class: "nota" }, `Nota ${fmt(c.nota)}`),
      h("div", { style: "flex:1" }),
      h("button", { class: "primario", onclick: guardarLibreta }, "Guardar en libreta"));
  };
  const obs = h("textarea", { placeholder: "Observaciones (opcional)" });
  obs.value = libreta[`${materia}:${sesion}`]?.observaciones ?? r.observaciones ?? "";
  obs.addEventListener("input", () => { r.observaciones = obs.value; guardarResp(nino, materia, sesion, r); });

  async function guardarLibreta() {
    const c = calcular();
    if (c.faltan && !confirm(`Faltan ${c.faltan} ítem(s) sin puntaje: cuentan como 0. ¿Guardar igual?`)) return;
    const lib = (await almacen.get(`l:${nino}`)) || {};
    lib[`${materia}:${sesion}`] = { obtenido: c.suma, total: p.puntajeTotal, porcentaje: c.pct, nota: c.nota,
      observaciones: obs.value, fecha: new Date().toISOString(), titulo: p.titulo };
    await almacen.set(`l:${nino}`, lib);
    await guardarResp(nino, materia, sesion, r);
    avisar(`Guardado en la libreta: nota ${fmt(c.nota)}`);
  }

  const nodos = [pestanas(nino), h("div", { class: "barra" }, volver(`/admin/n/${nino}`)),
    h("div", { class: "cabecera" }, h("h1", {}, p.titulo),
      h("p", {}, `${n.nombre} · ${ind.materias[materia]} · ${SESION_NOMBRE[sesion]} · ${p.puntajeTotal} puntos · `,
        r.estado === "entregada" ? `entregada ${new Date(r.entregadaEn).toLocaleString("es-CL")}` : r.estado === "curso" ? "aún no la entrega" : "sin empezar"))];
  if (r.estado === "entregada") {
    nodos.push(h("div", { class: "barra" }, h("button", { onclick: async () => {
      if (!confirm(`¿Reabrir la prueba para que ${n.nombre} la siga respondiendo?`)) return;
      r.estado = "curso"; await guardarResp(nino, materia, sesion, r); avisar("Prueba reabierta");
      vistaCorregir(nino, materia, sesion);
    } }, "Reabrir para el niño")));
  }
  nodos.push(h("details", {}, h("summary", { class: "boton", style: "margin:10px 0" }, "Ver pauta completa"),
    h("div", { class: "pauta-completa", html: p.pautaHtml }, tablaNotas(p))));

  for (const b of p.bloques) {
    if (b.tipo === "seccion") { nodos.push(h("h2", {}, b.titulo)); continue; }
    if (b.tipo === "libre") continue;
    const resp = r.items[b.n] || {};
    const t = itemNino(b, JSON.parse(JSON.stringify(resp)), { editable: false, nivel: n.nivel });
    t.querySelectorAll(".alts").forEach((zona) => {
      const g = zona.dataset.grupo;
      zona.querySelectorAll(".alt").forEach((bt, i) => {
        const letra = b.alternativas[g][i].letra;
        if (b.clave && letra === b.clave) bt.classList.add("correcta");
        if (b.clave && resp.alt?.[g] === letra && letra !== b.clave) bt.classList.add("incorrecta");
      });
    });
    if (b.seleccion) {
      const bien = aciertosSeleccion(b.seleccion, resp.sel);
      t.querySelectorAll("[data-s]").forEach((el) => {
        if (el.tagName === "SPAN" && el.classList.contains("marca")) return;
        const i = Number(el.dataset.s);
        if (el.tagName === "TD" && resp.sel?.[i] !== el.dataset.o && normal(el.dataset.o) !== normal(b.seleccion.respuestas[i])) return;
        el.classList.add(bien[i] ? "ok" : "error");
        if (!bien[i] && el.tagName !== "TD") el.after(h("span", { class: "esperada" }, ` → ${b.seleccion.respuestas[i]}`));
        if (!bien[i] && el.tagName === "TD" && normal(el.dataset.o) === normal(b.seleccion.respuestas[i])) { el.classList.remove("error"); el.classList.add("esperada-celda"); }
      });
    }
    t.querySelector(".oral")?.replaceChildren("🗣️ Oral: lo evalúas tú (ver rúbrica en la pauta).");
    t.append(h("div", { class: "pauta-item" }, h("strong", {}, "Pauta: "), h("span", { html: b.pauta.respuesta || "(sin fila en la pauta)" }),
      b.pauta.oa ? h("div", { style: "color:var(--suave)" }, b.pauta.oa) : null));
    const zona = h("div", { class: "puntaje" });
    const pintarPuntaje = () => {
      const { valor, auto } = puntajeItem(b, resp, r.puntajes);
      if (auto && b.modo === "seleccion") {
        const bien = aciertosSeleccion(b.seleccion, resp.sel);
        zona.replaceChildren(h("span", { class: "auto " + (valor === b.pts ? "bien" : "mal") },
          `${valor === b.pts ? "✓" : "✗"} ${bien.filter(Boolean).length} de ${bien.length} bien · ${valor}/${b.pts} (regla de la pauta)`));
        return;
      }
      if (auto) {
        zona.replaceChildren(h("span", { class: "auto " + (valor ? "bien" : "mal") },
          resp.alt?.[0] ? (valor ? `✓ Correcta · ${valor}/${b.pts}` : `✗ Marcó ${resp.alt[0]} (era ${b.clave}) · 0/${b.pts}`) : `Sin marcar · 0/${b.pts}`));
        return;
      }
      zona.replaceChildren(h("span", {}, `Puntaje (máx. ${b.pts}):`),
        ...Array.from({ length: b.pts + 1 }, (_, v) => h("button", { class: valor === v ? "elegido" : "", onclick: async () => {
          r.puntajes[b.n] = v; pintarPuntaje(); refrescar(); await guardarResp(nino, materia, sesion, r);
        } }, String(v))));
    };
    pintarPuntaje();
    t.append(zona);
    tarjetas[b.n] = t;
    nodos.push(t);
  }
  nodos.push(h("h2", {}, "Observaciones"), obs, h("div", { style: "height:20px" }), resumen);
  pintar(...nodos);
  refrescar();
}

function tablaNotas(p) {
  const filas = [];
  for (let i = 0; i <= p.puntajeTotal; i++) filas.push([i, nota(i, p.puntajeTotal, p.exigencia, p.notaMinima)]);
  const col = Math.ceil(filas.length / 3);
  const t = h("table", { class: "tabla notas-tabla" }, h("tr", {}, [0, 1, 2].map(() => [h("th", {}, "Puntaje"), h("th", {}, "Nota")])));
  for (let i = 0; i < col; i++) {
    const tr = h("tr");
    for (let k = 0; k < 3; k++) { const f = filas[i + k * col]; tr.append(h("td", {}, f ? String(f[0]) : ""), h("td", { class: f && f[1] < 4 ? "rojo" : "" }, f ? fmt(f[1]) : "")); }
    t.append(tr);
  }
  return h("div", {}, h("h2", {}, "Tabla puntaje → nota"), t);
}

async function vistaLibreta() {
  nivelVisual(null);
  const ind = await indice();
  const nodos = [pestanas("libreta"), h("h1", {}, "Libreta de notas"),
    h("p", {}, "Nota del período = 40% promedio de las semanales + 60% examen. Escala 2,0–7,0 con 60% de exigencia.")];
  for (const [nino, n] of Object.entries(NINOS)) {
    const lib = (await almacen.get(`l:${nino}`)) || {};
    const t = h("table", { class: "tabla notas-tabla" },
      h("tr", {}, h("th", {}, "Materia"), ind.sesiones.map((s) => h("th", {}, s)), h("th", {}, "Prom. semanales"), h("th", {}, "Nota período")));
    const periodos = [];
    for (const [m, nombre] of Object.entries(ind.materias)) {
      const sem = ["S1", "S2", "S3", "S4", "S5"].map((s) => lib[`${m}:${s}`]?.nota).filter((x) => x != null);
      const prom = sem.length ? Math.round((sem.reduce((a, b) => a + b, 0) / sem.length) * 10) / 10 : null;
      const ex = lib[`${m}:EX`]?.nota;
      const per = prom != null && ex != null ? Math.round((0.4 * prom + 0.6 * ex + 1e-9) * 10) / 10 : null;
      if (per != null) periodos.push(per);
      t.append(h("tr", {}, h("th", {}, nombre),
        ind.sesiones.map((s) => { const e = lib[`${m}:${s}`]; return h("td", { class: e && e.nota < 4 ? "rojo" : "" },
          e ? h("button", { onclick: () => ir(`/admin/c/${nino}/${m}/${s}`) }, fmt(e.nota)) : "—"); }),
        h("td", {}, fmt(prom)), h("td", { class: per != null && per < 4 ? "rojo" : "" }, h("strong", {}, fmt(per)))));
    }
    const general = periodos.length === Object.keys(ind.materias).length ? Math.round((periodos.reduce((a, b) => a + b, 0) / periodos.length + 1e-9) * 10) / 10 : null;
    t.append(h("tr", {}, h("th", {}, "Promedio general"), h("td", { colspan: ind.sesiones.length + 1 }), h("td", {}, h("strong", {}, fmt(general)))));
    const detalle = h("table", { class: "tabla" }, h("tr", {}, ["Materia", "Instrumento", "Obtenido", "Total", "%", "Nota", "Observaciones"].map((x) => h("th", {}, x))));
    for (const [m, nombre] of Object.entries(ind.materias)) for (const s of ind.sesiones) {
      const e = lib[`${m}:${s}`]; if (!e) continue;
      detalle.append(h("tr", {}, h("td", {}, nombre), h("td", {}, SESION_NOMBRE[s]), h("td", { class: "centro" }, String(e.obtenido)),
        h("td", { class: "centro" }, String(e.total)), h("td", { class: "centro" }, `${e.porcentaje}%`), h("td", { class: "centro" }, fmt(e.nota)), h("td", {}, e.observaciones || "")));
    }
    nodos.push(h("h2", {}, `${n.nombre} · ${n.curso}`), h("div", { style: "overflow-x:auto" }, t),
      detalle.children.length > 1 ? h("details", {}, h("summary", { class: "boton", style: "margin:8px 0" }, "Detalle"), h("div", { style: "overflow-x:auto" }, detalle)) : null);
  }
  pintar(...nodos);
}

async function vistaAjustes() {
  nivelVisual(null);
  const cfg = await config();
  const ind = await indice();
  const pin1 = h("input", { type: "password", inputmode: "numeric", pattern: "[0-9]*", placeholder: "PIN nuevo (4 a 8 números)", style: "font:inherit;padding:12px;border-radius:10px;border:2px solid var(--linea)" });
  const archivo = h("input", { type: "file", accept: "application/json,.json", style: "display:none", onchange: async () => {
    const f = archivo.files[0]; if (!f) return;
    try {
      const datos = JSON.parse(await f.text());
      if (datos.app !== "pruebas-ipad" || !datos.datos) throw new Error("no es un respaldo de esta app");
      if (!confirm("Esto reemplaza todo lo que hay en este iPad por el respaldo. ¿Seguir?")) return;
      await almacen.limpiar();
      for (const [k, v] of Object.entries(datos.datos)) await almacen.set(k, v);
      avisar("Respaldo restaurado"); vistaAjustes();
    } catch (e) { alert("No se pudo leer el respaldo: " + e.message); }
  } });
  pintar(pestanas("ajustes"), h("h1", {}, "Ajustes"),
    h("h2", {}, "PIN de administración"),
    h("div", { class: "barra" }, pin1, h("button", { onclick: async () => {
      if (!/^\d{4,8}$/.test(pin1.value)) return avisar("El PIN debe tener de 4 a 8 números");
      cfg.pinHuella = await huella(pin1.value); await almacen.set("config", cfg); pin1.value = ""; avisar("PIN cambiado");
    } }, "Cambiar PIN")),
    h("h2", {}, "Escritura"),
    h("div", { class: "barra" }, h("button", { class: "toggle" + (cfg.dedo ? " si" : ""), onclick: async () => {
      cfg.dedo = !cfg.dedo; await almacen.set("config", cfg); vistaAjustes();
    } }, cfg.dedo ? "También se escribe con el dedo" : "Sólo se escribe con el lápiz"),
      h("span", { style: "color:var(--suave);font-size:.85rem" }, "Con «sólo lápiz», la palma apoyada no raya la hoja.")),
    h("h2", {}, "Respaldo"),
    h("p", {}, "Los datos viven sólo en este iPad. Descarga un respaldo de vez en cuando (por ejemplo, a Archivos o iCloud Drive)."),
    h("div", { class: "barra" },
      h("button", { onclick: exportar }, "Descargar respaldo"),
      h("button", { onclick: () => archivo.click() }, "Restaurar respaldo"), archivo),
    h("h2", {}, "Versión"),
    h("p", { style: "color:var(--suave)" }, `App ${VERSION} · ${Object.keys(ind.pruebas).length} pruebas cargadas`));
}

async function exportar() {
  const datos = await almacen.todo();
  const texto = JSON.stringify({ app: "pruebas-ipad", version: VERSION, fecha: new Date().toISOString(), datos });
  const nombre = `respaldo-pruebas-${new Date().toISOString().slice(0, 10)}.json`;
  const archivo = new File([texto], nombre, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
    try { await navigator.share({ files: [archivo], title: nombre }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = h("a", { href: URL.createObjectURL(archivo), download: nombre });
  document.body.append(a); a.click(); a.remove();
}

// ---------- rutas ----------
async function route() {
  const partes = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  try {
    if (!partes.length) return vistaPortada();
    if (partes[0] === "n" && partes.length === 2) return await vistaMaterias(partes[1]);
    if (partes[0] === "n" && partes.length === 3) return await vistaSesiones(partes[1], partes[2]);
    if (partes[0] === "p" && partes.length === 4) return await vistaPrueba(partes[1], partes[2], partes[3]);
    if (partes[0] === "admin") {
      if (!adminOk) return vistaPin(location.hash.slice(1));
      if (partes.length === 1) return ir("/admin/n/javier");
      if (partes[1] === "n") return await vistaAdminNino(partes[2]);
      if (partes[1] === "c") return await vistaCorregir(partes[2], partes[3], partes[4]);
      if (partes[1] === "libreta") return await vistaLibreta();
      if (partes[1] === "ajustes") return await vistaAjustes();
    }
    ir("/");
  } catch (e) {
    console.error(e);
    pintar(h("p", { class: "vacio" }, "Algo falló al abrir esta pantalla: " + e.message), volver("/", "Ir al inicio"));
  }
}
window.addEventListener("hashchange", route);
route();
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
