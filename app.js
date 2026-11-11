"use strict";
// Pruebas en iPad — Javier (5º básico) y Lourdes (2º básico).
// Los datos viven en el iPad (IndexedDB) y, si se activa, se sincronizan entre iPads por Google Drive.
// Las pruebas y pautas vienen de data/ (tools/convertir.py).

const VERSION = "2026-11-11.2";
let hayVersionNueva = false; // el service worker trajo otra versión (ver route)
const NINOS = {
  javier: { nombre: "Javier", nivel: "5b", curso: "5º básico" },
  lourdes: { nombre: "Lourdes", nivel: "2b", curso: "2º básico" },
};
// PIN de administración: se guarda sólo su huella (SHA-256 de "pruebas-ipad:" + PIN). Se cambia en Ajustes.
const PIN_HUELLA_INICIAL = "e917ab2bc6189032be07582233692efe49ce1492c6a43e4ca5af817c7539f865";
const SESION_NOMBRE = { S1: "Semana 1", S2: "Semana 2", S3: "Semana 3", S4: "Semana 4", S5: "Semana 5", EX: "Examen" };
const ANCHO = 1000; // ancho lógico del lienzo: los trazos se guardan en esta escala
// Claves propias de cada iPad: no viajan en los respaldos ni en la sincronización.
const LOCALES = ["respaldo", "sync"];
const ahora = () => new Date().toISOString();

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
    set: (k, v) => tx("readwrite", (s) => s.put(v, k)).then((x) => { if (!LOCALES.includes(k)) marcarCambio(); return x; }),
    poner: (k, v) => tx("readwrite", (s) => s.put(v, k)),
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
    claves: () => tx("readonly", (s) => s.getAllKeys()),
  };
})();

async function config() {
  const c = (await almacen.get("config")) || {};
  c.habilitadas = c.habilitadas || { javier: {}, lourdes: {} };
  c.pinHuella = c.pinHuella || PIN_HUELLA_INICIAL;
  return c;
}
// Cada cambio del config anota la fecha de los campos que tocó («pinHuella», «dedo», «hab:<niño>:<materia>:<sesión>»):
// al sincronizar, gana el cambio más reciente de cada campo.
function guardarConfig(cfg, ...campos) {
  const t = cfg.actualizado = ahora();
  cfg.mods = cfg.mods || {};
  for (const c of campos) cfg.mods[c] = t;
  return almacen.set("config", cfg);
}
const claveResp = (nino, materia, sesion) => `r:${nino}:${materia}:${sesion}`;
async function respuesta(nino, materia, sesion) {
  const r = (await almacen.get(claveResp(nino, materia, sesion))) || { estado: "nueva", items: {}, puntajes: {}, observaciones: "" };
  r.items = r.items || {}; r.puntajes = r.puntajes || {};
  return r;
}
// parte = "respuesta" (lo que hace el niño, y reabrir) o "correccion" (puntajes y observaciones del adulto):
// cada parte lleva su fecha para que la sincronización no pise una con la otra.
function guardarResp(nino, materia, sesion, r, parte = "respuesta") {
  // una respuesta de antes de la sincronización no tiene respondidoEn: se conserva cuándo se respondió
  if (parte === "correccion" && !r.respondidoEn && !r.corregidoEn && r.actualizado && r.estado !== "nueva") r.respondidoEn = r.actualizado;
  r.actualizado = ahora();
  if (parte === "correccion") r.corregidoEn = r.actualizado; else r.respondidoEn = r.actualizado;
  return almacen.set(claveResp(nino, materia, sesion), r);
}
const nuevoIntento = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

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
      h("button", { class: `nino ${id}`, onclick: () => { syncConToque(); ir(`/n/${id}`); } }, n.nombre, h("small", {}, n.curso)))),
    h("div", { class: "pie-sync" }, chipSync),
    h("div", { class: "pie-admin" }, h("button", { onclick: () => ir("/admin") }, "Administración")),
    h("div", { class: "pie-version" }, `Versión ${VERSION}`));
}

const habilitada = (cfg, nino, materia, sesion) => !!cfg.habilitadas[nino]?.[`${materia}:${sesion}`];

async function vistaMaterias(nino) {
  const n = NINOS[nino]; if (!n) return ir("/");
  nivelVisual(n.nivel);
  const [cfg, ind] = [await config(), await indice()];
  const materias = Object.entries(ind.materias).filter(([m]) => ind.sesiones.some((s) => habilitada(cfg, nino, m, s)));
  pintar(
    h("div", { class: "barra" }, volver("/"), h("span", { class: "espacio" }), chipSync),
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
    h("div", { class: "barra" }, volver(`/n/${nino}`), h("span", { class: "espacio" }), chipSync),
    h("h1", {}, ind.materias[materia] || materia),
    botones.length ? h("div", { class: "grilla" }, botones) : h("p", { class: "vacio" }, "No hay pruebas habilitadas en esta materia."));
}

async function vistaPrueba(nino, materia, sesion) {
  const n = NINOS[nino]; if (!n) return ir("/");
  nivelVisual(n.nivel);
  const cfg = await config();
  if (!habilitada(cfg, nino, materia, sesion)) return ir(`/n/${nino}`);
  await syncAntesDeAbrir(); // trae lo que se haya hecho en otro iPad
  if (!location.hash.startsWith(`#/p/${nino}/${materia}/${sesion}`)) return; // se fue mientras sincronizaba
  const [p, r] = [await prueba(n.nivel, materia, sesion), await respuesta(nino, materia, sesion)];
  const cerrada = r.estado === "entregada";
  let espera;
  const guardarBorrador = () => {
    if (r.estado === "nueva") { r.estado = "curso"; r.intento = nuevoIntento(); }
    clearTimeout(espera); espera = setTimeout(() => guardarResp(nino, materia, sesion, r), 400);
  };
  const nodos = [
    h("div", { class: "barra" }, volver(`/n/${nino}/${materia}`), h("span", { class: "espacio" }), chipSync),
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
      const permiso = permisoSync(); // dentro del toque, por si Google tiene que abrir su ventana
      clearTimeout(espera);
      r.estado = "entregada"; r.entregadaEn = ahora(); r.intento = r.intento || nuevoIntento();
      await guardarResp(nino, materia, sesion, r);
      avisar("¡Prueba guardada! Muy bien.");
      ir(`/n/${nino}/${materia}`);
      permiso.then((ok) => ok && sincronizar().then(trasSync));
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
  const recordatorio = h("div");
  avisoRespaldo(recordatorio, activa);
  return h("div", {}, h("div", { class: "pestanas" }, p.map(([id, t]) =>
    h("button", { class: id === activa ? "activa" : "", onclick: () => ir(id === "libreta" || id === "ajustes" ? `/admin/${id}` : `/admin/n/${id}`) }, t)),
    h("button", { onclick: () => { adminOk = false; ir("/"); } }, "Salir"), h("span", { class: "espacio" }), chipSync), recordatorio);
}

const ESTADO_TXT = { nueva: "", curso: "empezada", entregada: "entregada" };
async function vistaAdminNino(nino) {
  nivelVisual(null);
  const n = NINOS[nino]; if (!n) return ir("/admin/n/javier");
  const [cfg, ind] = [await config(), await indice()];
  const libreta = await libretaAlDia(nino);
  const hab = cfg.habilitadas[nino] = cfg.habilitadas[nino] || {};
  const tabla = h("table", { class: "tabla" });
  const cab = h("tr", {}, h("th", {}, "Materia"));
  for (const s of ind.sesiones) {
    cab.append(h("th", { class: "centro" }, h("button", { title: "Habilitar o quitar en todas las materias", onclick: async () => {
      const todas = Object.keys(ind.materias).every((m) => hab[`${m}:${s}`]);
      Object.keys(ind.materias).forEach((m) => { hab[`${m}:${s}`] = !todas; });
      await guardarConfig(cfg, ...Object.keys(ind.materias).map((m) => `hab:${nino}:${m}:${s}`)); vistaAdminNino(nino);
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
          hab[k] = !hab[k]; await guardarConfig(cfg, `hab:${nino}:${k}`); vistaAdminNino(nino);
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

// Si se corrigió una pauta (tools/correcciones-pauta.json), las notas ya guardadas se recalculan
// con las respuestas guardadas. Lo puntuado a mano no cambia; lo que falte cuenta 0, como al guardar.
async function libretaAlDia(nino) {
  const lib = (await almacen.get(`l:${nino}`)) || {};
  let cambio = false;
  for (const [k, e] of Object.entries(lib)) {
    const [materia, sesion] = k.split(":");
    if (!(await almacen.get(claveResp(nino, materia, sesion)))) continue;
    let p;
    try { p = await prueba(NINOS[nino].nivel, materia, sesion); } catch { continue; }
    const r = await respuesta(nino, materia, sesion);
    if ((e.intento || "0") !== (r.intento || "0")) continue; // la nota es de otro intento
    const suma = p.bloques.filter((b) => b.tipo === "item")
      .reduce((s, b) => s + (puntajeItem(b, r.items[b.n] || {}, r.puntajes).valor ?? 0), 0);
    if (suma === e.obtenido && p.puntajeTotal === e.total) continue;
    lib[k] = { ...e, obtenido: suma, total: p.puntajeTotal,
      porcentaje: p.puntajeTotal ? Math.round((suma / p.puntajeTotal) * 100) : 0,
      nota: nota(suma, p.puntajeTotal, p.exigencia, p.notaMinima),
      recalculada: new Date().toISOString(), antes: e.antes || { obtenido: e.obtenido, nota: e.nota } };
    cambio = true;
  }
  if (cambio) await almacen.set(`l:${nino}`, lib);
  return lib;
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
  const libreta = await libretaAlDia(nino);
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
  obs.addEventListener("input", () => { r.observaciones = obs.value; guardarResp(nino, materia, sesion, r, "correccion"); });

  async function guardarLibreta() {
    const c = calcular();
    if (c.faltan && !confirm(`Faltan ${c.faltan} ítem(s) sin puntaje: cuentan como 0. ¿Guardar igual?`)) return;
    const lib = (await almacen.get(`l:${nino}`)) || {};
    lib[`${materia}:${sesion}`] = { obtenido: c.suma, total: p.puntajeTotal, porcentaje: c.pct, nota: c.nota,
      observaciones: obs.value, fecha: ahora(), titulo: p.titulo, intento: r.intento || "0" };
    await almacen.set(`l:${nino}`, lib);
    await guardarResp(nino, materia, sesion, r, "correccion");
    avisar(`Guardado en la libreta: nota ${fmt(c.nota)}`);
  }

  const nodos = [pestanas(nino), h("div", { class: "barra" }, volver(`/admin/n/${nino}`)),
    h("div", { class: "cabecera" }, h("h1", {}, p.titulo),
      h("p", {}, `${n.nombre} · ${ind.materias[materia]} · ${SESION_NOMBRE[sesion]} · ${p.puntajeTotal} puntos · `,
        r.estado === "entregada" ? `entregada ${new Date(r.entregadaEn).toLocaleString("es-CL")}` : r.estado === "curso" ? "aún no la entrega" : "sin empezar"))];
  if (r.estado === "entregada") {
    nodos.push(h("div", { class: "barra" }, h("button", { onclick: async () => {
      if (!confirm(`¿Reabrir la prueba para que ${n.nombre} la siga respondiendo?`)) return;
      r.estado = "curso"; r.reabiertaEn = ahora(); await guardarResp(nino, materia, sesion, r); avisar("Prueba reabierta");
      vistaCorregir(nino, materia, sesion);
    } }, "Reabrir para el niño")));
  }
  for (const o of r.otros || []) {
    const cuando = (t) => (t ? new Date(t).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short", hourCycle: "h23" }) : "");
    nodos.push(h("div", { class: "otro-intento" },
      h("span", {}, `Hay otro intento de esta prueba, hecho en otro iPad: ${o.estado === "entregada" ? `entregado ${cuando(o.entregadaEn)}` : `empezado, último cambio ${cuando(o.respondidoEn)}`}. Aquí se muestra el de ${r.estado === "entregada" ? `entregado ${cuando(r.entregadaEn)}` : `último cambio ${cuando(r.respondidoEn || r.actualizado)}`}.`),
      h("button", { onclick: async () => {
        if (!confirm("¿Mostrar y corregir el otro intento? El actual queda guardado como «otro intento».")) return;
        const { otros = [], ...actual } = r;
        const nuevo = { ...o, otros: [...otros.filter((x) => x !== o), resumenIntento(actual)], elegidoEn: ahora() };
        await guardarResp(nino, materia, sesion, nuevo, "correccion");
        avisar("Intento cambiado: vuelve a guardar en la libreta"); vistaCorregir(nino, materia, sesion);
      } }, "Usar ese intento")));
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
          r.puntajes[b.n] = v; pintarPuntaje(); refrescar(); await guardarResp(nino, materia, sesion, r, "correccion");
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
    const lib = await libretaAlDia(nino);
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
        h("td", { class: "centro" }, String(e.total)), h("td", { class: "centro" }, `${e.porcentaje}%`), h("td", { class: "centro" }, fmt(e.nota)),
        h("td", {}, e.observaciones || "", e.antes ? h("div", { style: "color:var(--suave);font-size:.8rem" },
          `Recalculada con la pauta corregida (antes ${e.antes.obtenido} pts, nota ${fmt(e.antes.nota)})`) : null)));
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
  const resp = await estadoRespaldo();
  cargarGis().catch(() => {});
  const pin1 = h("input", { type: "password", inputmode: "numeric", pattern: "[0-9]*", placeholder: "PIN nuevo (4 a 8 números)", style: "font:inherit;padding:12px;border-radius:10px;border:2px solid var(--linea)" });
  const archivo = h("input", { type: "file", accept: "application/json,.json", style: "display:none", onchange: async () => {
    const f = archivo.files[0]; if (!f) return;
    try { if (await restaurar(JSON.parse(await f.text()))) vistaAjustes(); }
    catch (e) { alert("No se pudo leer el respaldo: " + e.message); }
  } });
  const msgDrive = h("p", { class: "msg-drive" });
  const conMensaje = (fn) => async (ev) => {
    const b = ev.currentTarget; b.disabled = true; msgDrive.textContent = "Conectando con Google Drive…";
    try { msgDrive.textContent = await fn(); } catch (e) { msgDrive.textContent = "⚠️ " + e.message; }
    b.disabled = false;
  };
  const listaDrive = h("div");
  const msgSync = h("p", { class: "msg-drive" });
  const sinGoogle = () => "⚠️ " + (SYNC.error || "No se pudo conectar con Google: vuelve a tocar.");
  const textoSync = (res) => (res.ok ? `✅ Sincronizado${res.cambios ? `: ${res.cambios} cambio(s) traídos de otro iPad` : ""}.` : "⚠️ " + res.error);
  const cuando = (t) => new Date(t).toLocaleString("es-CL");
  pintar(pestanas("ajustes"), h("h1", {}, "Ajustes"),
    h("h2", {}, "PIN de administración"),
    h("div", { class: "barra" }, pin1, h("button", { onclick: async () => {
      if (!/^\d{4,8}$/.test(pin1.value)) return avisar("El PIN debe tener de 4 a 8 números");
      cfg.pinHuella = await huella(pin1.value); await guardarConfig(cfg, "pinHuella"); pin1.value = ""; avisar("PIN cambiado");
    } }, "Cambiar PIN")),
    h("h2", {}, "Escritura"),
    h("div", { class: "barra" }, h("button", { class: "toggle" + (cfg.dedo ? " si" : ""), onclick: async () => {
      cfg.dedo = !cfg.dedo; await guardarConfig(cfg, "dedo"); vistaAjustes();
    } }, cfg.dedo ? "También se escribe con el dedo" : "Sólo se escribe con el lápiz"),
      h("span", { style: "color:var(--suave);font-size:.85rem" }, "Con «sólo lápiz», la palma apoyada no raya la hoja.")),
    h("h2", {}, "Sincronización entre iPads"),
    h("p", {}, "Para que los niños den las pruebas en cualquier iPad y el avance se vea en todos: actívala en cada iPad, entrando con la misma cuenta de Google. Se comparten respuestas, libreta, PIN y pruebas habilitadas, sin pisar resultados. Se sincroniza al abrir la app, al abrir y al guardar cada prueba, y al tocar ☁️."),
    SYNC.activo
      ? h("div", { class: "barra" },
        h("button", { class: "primario", onclick: (ev) => {
          const b = ev.currentTarget; b.disabled = true; msgSync.textContent = "Sincronizando…";
          syncConToque().then((res) => { msgSync.textContent = res ? textoSync(res) : sinGoogle(); b.disabled = false; });
        } }, "Sincronizar ahora"),
        h("button", { onclick: async () => {
          if (!confirm("¿Desactivar la sincronización en este iPad? Lo que hay aquí y en Drive se queda donde está.")) return;
          await guardarEstadoSync({ activo: false }); vistaAjustes();
        } }, "Desactivar en este iPad"))
      : h("div", { class: "barra" }, h("button", { class: "primario", onclick: (ev) => {
        const permiso = permisoSync(true); // en el mismo toque, por la ventana de Google
        const b = ev.currentTarget; b.disabled = true; msgSync.textContent = "Conectando con Google Drive…";
        permiso.then(async (ok) => {
          if (!ok) { msgSync.textContent = sinGoogle(); b.disabled = false; return; }
          await guardarEstadoSync({ activo: true, error: "" });
          const res = await sincronizar();
          msgSync.textContent = textoSync(res);
          if (res.ok) setTimeout(vistaAjustes, 1500); else b.disabled = false;
        });
      } }, "Activar en este iPad")),
    msgSync,
    h("p", { style: "font-size:.85rem;color:var(--suave)" }, SYNC.activo
      ? `Activa en este iPad. ${SYNC.ultimo ? `Última sincronización: ${cuando(SYNC.ultimo)}.` : "Todavía no se sincroniza."}${SYNC.error ? ` Último problema: ${SYNC.error}` : ""}`
      : "Desactivada en este iPad: sus datos sólo quedan aquí."),
    h("h2", {}, "Respaldo"),
    h("p", {}, "Los datos (respuestas, libreta, PIN y pruebas habilitadas) viven en este iPad y, si la sincronización está activa, en Drive. Si se borra la app sin respaldo ni sincronización, se pierden: respáldalos seguido. ",
      h("strong", {}, resp.ultimo ? `Último respaldo: ${new Date(resp.ultimo).toLocaleString("es-CL")} (${resp.via === "drive" ? "Google Drive" : "archivo"}).` : "Todavía no hay respaldos.")),
    h("h3", {}, "Google Drive"),
    h("p", { style: "font-size:.85rem;color:var(--suave)" }, `Guarda «${DRIVE_ARCHIVO}» en tu Drive y una copia con la fecha de cada día. La app sólo ve sus propios archivos. La primera vez, Google te pide entrar con tu cuenta.`),
    h("div", { class: "barra" },
      h("button", { class: "primario", onclick: conMensaje(guardarEnDrive) }, "Guardar en Drive"),
      h("button", { onclick: conMensaje(async () => {
        const lista = await respaldosEnDrive();
        if (!lista.length) return "Todavía no hay respaldos en Drive: usa «Guardar en Drive» primero.";
        listaDrive.replaceChildren(h("p", {}, "Elige cuál restaurar (reemplaza todo lo de este iPad):"),
          h("div", { class: "barra" }, lista.slice(0, 12).map((f) => h("button", { onclick: conMensaje(async () => {
            const datos = await leerDeDrive(f.id);
            if (await restaurar(datos)) { setTimeout(vistaAjustes, 1200); return "✅ Respaldo de Drive restaurado."; }
            return "No se restauró.";
          }) }, f.name === DRIVE_ARCHIVO ? `El más reciente (${new Date(f.modifiedTime).toLocaleString("es-CL")})` : f.name.replace(/^pruebas-ipad-respaldo-|\.json$/g, "")))));
        return "";
      }) }, "Restaurar desde Drive")),
    msgDrive, listaDrive,
    h("h3", {}, "Archivo en el iPad"),
    h("p", { style: "font-size:.85rem;color:var(--suave)" }, "Descarga un archivo (por ejemplo, a Archivos o iCloud Drive) y restáuralo desde ahí si hace falta."),
    h("div", { class: "barra" },
      h("button", { onclick: exportar }, "Descargar respaldo"),
      h("button", { onclick: () => archivo.click() }, "Restaurar respaldo"), archivo),
    h("h3", {}, "Recordatorio"),
    h("div", { class: "barra" }, h("span", {}, "Avisarme en Administración si pasan más de"),
      [3, 7, 14, 30].map((d) => h("button", { class: "toggle" + (resp.cadaDias === d ? " si" : ""), onclick: async () => {
        await almacen.set(CLAVE_RESPALDO, { ...resp, cadaDias: d }); vistaAjustes();
      } }, `${d} días`)), h("span", {}, "sin respaldo.")),
    h("h2", {}, "Versión"),
    h("p", { style: "color:var(--suave)" }, `App ${VERSION} · ${Object.keys(ind.pruebas).length} pruebas cargadas`));
}

// ---------- respaldo ----------
// La marca del último respaldo vive aparte y no viaja en el respaldo: restaurar uno viejo no la retrocede.
const CLAVE_RESPALDO = "respaldo";
async function estadoRespaldo() {
  return { cadaDias: 7, ...((await almacen.get(CLAVE_RESPALDO)) || {}) };
}
async function marcarRespaldo(via) {
  await almacen.set(CLAVE_RESPALDO, { ...(await estadoRespaldo()), ultimo: new Date().toISOString(), via });
}
async function textoRespaldo() {
  const datos = await almacen.todo();
  for (const k of LOCALES) delete datos[k];
  return JSON.stringify({ app: "pruebas-ipad", version: VERSION, fecha: new Date().toISOString(), datos });
}
async function restaurar(r) {
  if (!r || r.app !== "pruebas-ipad" || !r.datos) throw new Error("no es un respaldo de esta app");
  const fecha = r.fecha ? new Date(r.fecha).toLocaleString("es-CL") : "sin fecha";
  const conSync = SYNC.activo ? "\n\nLa sincronización está activa: en la próxima, lo que sea más reciente en Drive se vuelve a sumar." : "";
  if (!confirm(`Esto reemplaza todo lo que hay en este iPad por el respaldo del ${fecha}. ¿Seguir?${conSync}`)) return false;
  const propias = await Promise.all(LOCALES.map((k) => almacen.get(k)));
  await almacen.limpiar();
  for (const [k, v] of Object.entries(r.datos)) if (!LOCALES.includes(k)) await almacen.set(k, v);
  for (const [i, k] of LOCALES.entries()) if (propias[i]) await almacen.poner(k, propias[i]);
  avisar("Respaldo restaurado");
  return true;
}
async function avisoRespaldo(zona, activa) {
  const r = await estadoRespaldo();
  const dias = r.ultimo ? (Date.now() - new Date(r.ultimo)) / 864e5 : Infinity;
  if (dias <= r.cadaDias) return;
  const hayDatos = (await almacen.claves()).some((k) => k.startsWith("r:") || k.startsWith("l:"));
  if (!hayDatos) return;
  cargarGis().catch(() => {});
  const msg = h("span", {}, r.ultimo ? `⚠️ Hace ${Math.floor(dias)} días que no se respalda.` : "⚠️ Todavía no hay ningún respaldo.");
  zona.replaceChildren(h("div", { class: "recordatorio" }, msg,
    h("button", { class: "primario", onclick: async (ev) => {
      const b = ev.currentTarget; b.disabled = true; msg.textContent = "Conectando con Google Drive…";
      try { msg.textContent = await guardarEnDrive(); setTimeout(() => zona.replaceChildren(), 2500); }
      catch (e) { msg.textContent = "⚠️ " + e.message; b.disabled = false; }
    } }, "Guardar en Drive"),
    activa === "ajustes" ? null : h("button", { onclick: () => ir("/admin/ajustes") }, "Otras opciones")));
}

async function exportar() {
  const texto = await textoRespaldo();
  const nombre = `respaldo-pruebas-${new Date().toISOString().slice(0, 10)}.json`;
  const archivo = new File([texto], nombre, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
    try { await navigator.share({ files: [archivo], title: nombre }); await marcarRespaldo("archivo"); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = h("a", { href: URL.createObjectURL(archivo), download: nombre });
  document.body.append(a); a.click(); a.remove();
  await marcarRespaldo("archivo");
}

// Google Drive con Google Identity Services y scope drive.file (la app sólo ve los archivos que crea).
// El client ID es público (no es un secreto) y es el mismo de amunita/curso-guitarra: su origen
// autorizado, https://amunita.github.io, es también el de esta app.
const DRIVE_CLIENT_ID = "217925521670-bkjei1es6u3lc6q253hvs43qh89gkpqp.apps.googleusercontent.com";
const DRIVE_ARCHIVO = "pruebas-ipad-respaldo.json";
let driveToken = null, driveVence = 0, gisCargado = null;
// El permiso de Google dura una hora: se recuerda en este iPad para no pedirlo en cada recarga.
try { const t = JSON.parse(localStorage.getItem("pruebas-ipad:google")); if (t?.vence > Date.now()) [driveToken, driveVence] = [t.token, t.vence]; } catch {}
function recordarToken() {
  try { localStorage.setItem("pruebas-ipad:google", JSON.stringify(driveToken ? { token: driveToken, vence: driveVence } : null)); } catch {}
}
const tokenVigente = () => !!driveToken && Date.now() < driveVence;
function cargarGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return gisCargado || (gisCargado = new Promise((ok, mal) => {
    const s = h("script", { src: "https://accounts.google.com/gsi/client" });
    s.onload = ok;
    s.onerror = () => { gisCargado = null; mal(new Error("No se pudo cargar Google (¿sin internet?).")); };
    document.head.append(s);
  }));
}
// Safari sólo abre la ventana de Google si se pide en el mismo toque: por eso Google se precarga al
// mostrar los botones y el permiso se pide antes de cualquier otra espera.
function tokenDrive() {
  if (tokenVigente()) return Promise.resolve(driveToken);
  return window.google?.accounts?.oauth2 ? pedirToken() : cargarGis().then(pedirToken);
}
function pedirToken() {
  return new Promise((ok, mal) => {
    const cliente = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CLIENT_ID, scope: "https://www.googleapis.com/auth/drive.file",
      callback: (t) => {
        if (t?.access_token) { driveToken = t.access_token; driveVence = Date.now() + ((t.expires_in || 3600) - 60) * 1000; recordarToken(); ok(driveToken); }
        else mal(new Error("Google no dio permiso" + (t?.error ? ` (${t.error})` : "") + "."));
      },
      error_callback: (e) => mal(new Error(e?.type === "popup_closed" ? "Se cerró la ventana de Google."
        : e?.type === "popup_failed_to_open" ? "El iPad no dejó abrir la ventana de Google: toca el botón otra vez." : e?.message || "Conexión cancelada.")),
    });
    cliente.requestAccessToken({ prompt: "" }); // Google pide el consentimiento sólo la primera vez
  });
}
async function drive(url, opciones = {}) {
  const tok = await tokenDrive();
  const r = await fetch(url, { ...opciones, headers: { ...(opciones.headers || {}), Authorization: "Bearer " + tok } });
  if (r.status === 401) { driveToken = null; recordarToken(); throw new Error("La sesión de Google venció: vuelve a intentarlo."); }
  if (!r.ok) {
    let por = "";
    try { por = (await r.json()).error?.message || ""; } catch {}
    if (/has not been used|is disabled/i.test(por)) por = "la API de Google Drive no está habilitada en el proyecto de Google Cloud";
    throw new Error(`Drive respondió ${r.status}${por ? ": " + por : ""}`);
  }
  return r;
}
async function buscarEnDrive(nombre) {
  const q = encodeURIComponent(`name = '${nombre}' and trashed = false`);
  const j = await (await drive(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)`)).json();
  return j.files?.[0] || null;
}
async function subirADrive(nombre, cuerpo) {
  const f = await buscarEnDrive(nombre);
  return f ? actualizarEnDrive(f.id, cuerpo) : crearEnDrive(nombre, cuerpo);
}
function actualizarEnDrive(id, cuerpo) {
  return drive(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: cuerpo });
}
function crearEnDrive(nombre, cuerpo) {
  const borde = "respaldo" + Date.now();
  const meta = JSON.stringify({ name: nombre, mimeType: "application/json" });
  return drive("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${borde}` },
    body: `--${borde}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${borde}\r\nContent-Type: application/json\r\n\r\n${cuerpo}\r\n--${borde}--`,
  });
}
async function guardarEnDrive() {
  await tokenDrive();
  const cuerpo = await textoRespaldo();
  await subirADrive(DRIVE_ARCHIVO, cuerpo);
  await subirADrive(`pruebas-ipad-respaldo-${new Date().toISOString().slice(0, 10)}.json`, cuerpo); // histórico, uno por día
  await marcarRespaldo("drive");
  return `✅ Respaldo guardado en Google Drive (${Math.round(cuerpo.length / 1024)} KB).`;
}
async function respaldosEnDrive() {
  const q = encodeURIComponent("name contains 'pruebas-ipad-respaldo' and trashed = false");
  const j = await (await drive(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=40&fields=files(id,name,modifiedTime)`)).json();
  const fs = j.files || [];
  return [...fs.filter((f) => f.name === DRIVE_ARCHIVO), ...fs.filter((f) => f.name !== DRIVE_ARCHIVO).sort((a, b) => b.name.localeCompare(a.name))];
}
async function leerDeDrive(id) {
  return (await drive(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json();
}

// ---------- sincronización entre iPads ----------
// Todos los iPads con la sincronización activa comparten «pruebas-ipad-sync.json» en el Drive de la misma
// cuenta de Google (scope drive.file). Sincronizar = leer el archivo, fusionarlo con lo de este iPad sin
// pisar resultados, guardar lo fusionado aquí y subirlo. Si dos iPads suben a la vez y uno pisa al otro,
// lo de ese iPad sigue aquí y sube en la sincronización siguiente: la fusión no pierde nada por repetirse.
const SYNC_ARCHIVO = "pruebas-ipad-sync.json";
let SYNC = { activo: false };          // clave «sync» (propia del iPad): { activo, ultimo, error }
let syncTrabajo = null, syncUlt = 0, syncCambios = 0;
let pendiente = (() => { try { return localStorage.getItem("pruebas-ipad:pendiente") === "1"; } catch { return false; } })();
const chipSync = h("button", { class: "sync", onclick: () => syncConToque(true) });

function marcarCambio() {
  syncCambios++;
  if (!pendiente) { pendiente = true; try { localStorage.setItem("pruebas-ipad:pendiente", "1"); } catch {} }
  pintarSync();
}
function pintarSync() {
  chipSync.hidden = !SYNC.activo;
  const hora = SYNC.ultimo ? new Date(SYNC.ultimo).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "";
  const [clase, texto] = syncTrabajo ? ["", "☁️ Sincronizando…"]
    : SYNC.error ? ["mal", "⚠️ Sin sincronizar · tocar"]
    : pendiente || !SYNC.ultimo ? ["pendiente", "☁️ Sin sincronizar · tocar"]
    : ["ok", `☁️ Sincronizado ${hora}`];
  chipSync.className = "sync " + clase;
  chipSync.textContent = texto;
  chipSync.title = SYNC.error || (SYNC.ultimo ? `Última sincronización: ${new Date(SYNC.ultimo).toLocaleString("es-CL")}` : "");
}
async function guardarEstadoSync(cambios) {
  Object.assign(SYNC, cambios);
  await almacen.poner("sync", SYNC);
  pintarSync();
}

// --- fusión (pura: no toca el almacén ni la red) ---
const ts = (x) => x || "";
// Orden estable de las claves, para comparar dos versiones de los datos.
const canonico = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((c) => [c, x[c]])) : x));
function fusionar(local, remoto) {
  const out = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remoto)])) {
    if (LOCALES.includes(k)) continue;
    const a = local[k], b = remoto[k];
    if (a == null || b == null) { out[k] = a ?? b; continue; }
    out[k] = k === "config" ? fusionarConfig(a, b) : k.startsWith("l:") ? fusionarLibreta(a, b)
      : k.startsWith("r:") ? fusionarResp(a, b) : ts(b.actualizado) > ts(a.actualizado) ? b : a;
  }
  return out;
}
const leerCampo = (c, campo) => {
  if (!campo.startsWith("hab:")) return c[campo];
  const [, nino, ...ms] = campo.split(":");
  return c.habilitadas?.[nino]?.[ms.join(":")];
};
const ponerCampo = (c, campo, v) => {
  if (!campo.startsWith("hab:")) return void (c[campo] = v);
  const [, nino, ...ms] = campo.split(":");
  ((c.habilitadas = c.habilitadas || {})[nino] = c.habilitadas[nino] || {})[ms.join(":")] = v;
};
// Config: campo a campo gana el cambio más reciente (habilitar en un iPad y cambiar el PIN en otro no se pisan).
function fusionarConfig(a, b) {
  const out = JSON.parse(JSON.stringify(ts(b.actualizado) > ts(a.actualizado) ? b : a));
  out.mods = { ...(out.mods || {}) };
  for (const campo of new Set([...Object.keys(a.mods || {}), ...Object.keys(b.mods || {})])) {
    const g = ts(b.mods?.[campo]) > ts(a.mods?.[campo]) ? b : a;
    ponerCampo(out, campo, leerCampo(g, campo));
    out.mods[campo] = g.mods[campo];
  }
  return out;
}
// Libreta: por prueba, la nota guardada más tarde (y, con la misma fecha, la recalculada más tarde).
function fusionarLibreta(a, b) {
  const out = { ...a };
  const cuando = (e) => ts(e.fecha) + "|" + ts(e.recalculada);
  for (const [k, e] of Object.entries(b)) if (!out[k] || cuando(e) > cuando(out[k])) out[k] = e;
  return out;
}
// Respuestas: cada intento tiene su id. Del mismo intento queda una sola copia (lo respondido de la que
// manda, lo corregido de la corrección más reciente). Si son intentos distintos, uno queda como principal
// y el otro se guarda en «otros» para que el adulto lo vea y pueda elegirlo: no se pierde ninguno.
const idIntento = (r) => (r.estado === "entregada" || r.estado === "curso" ? r.intento || "0" : null);
const respondido = (r) => ts(r.respondidoEn || (r.corregidoEn ? "" : r.actualizado)); // sólo lo hecho por el niño
const claveIntento = (r) => `${r.intento || "0"}|${respondido(r)}`;
function hayRespuestas(r) {
  return Object.values(r.items || {}).some((i) => Object.values(i.alt || {}).some(Boolean)
    || Object.values(i.sel || {}).some((x) => x != null && x !== "") || i.lienzo?.trazos?.length);
}
const resumenIntento = (r) => ({ intento: r.intento || "0", estado: r.estado, entregadaEn: r.entregadaEn, reabiertaEn: r.reabiertaEn,
  respondidoEn: respondido(r), items: r.items || {}, puntajes: r.puntajes || {}, observaciones: r.observaciones || "", corregidoEn: r.corregidoEn });
function manda(a, b, mismo) {
  if (!mismo && ts(a.elegidoEn) !== ts(b.elegidoEn)) return ts(b.elegidoEn) > ts(a.elegidoEn) ? b : a; // el adulto eligió uno
  const ea = a.estado === "entregada", eb = b.estado === "entregada";
  if (ea !== eb) { // la entregada gana, salvo que la otra copia sea la misma prueba reabierta después
    const [ent, otra] = ea ? [a, b] : [b, a];
    return mismo && ts(otra.reabiertaEn) > ts(ent.entregadaEn) ? otra : ent;
  }
  if (respondido(a) !== respondido(b)) return respondido(b) > respondido(a) ? b : a;
  return canonico(b) > canonico(a) ? b : a; // empate: igual en los dos iPads, para que la fusión dé lo mismo en ambos
}
function fusionarResp(a, b) {
  const [ia, ib] = [idIntento(a), idIntento(b)];
  const mismo = ia == null || ib == null || ia === ib;
  const g = manda(a, b, mismo), p = g === a ? b : a;
  const out = JSON.parse(JSON.stringify(g));
  const extra = [];
  if (mismo) {
    const c = ts(b.corregidoEn) > ts(a.corregidoEn) ? b : a;
    out.puntajes = { ...(c === a ? b : a).puntajes, ...c.puntajes };
    out.observaciones = c.observaciones ?? out.observaciones;
    out.corregidoEn = c.corregidoEn;
    out.elegidoEn = [a.elegidoEn, b.elegidoEn].sort().pop();
    if (!out.intento && p.intento) out.intento = p.intento;
    // la copia perdedora siguió respondiendo después de la entrega (otro iPad sin conexión): se guarda aparte
    if (g.estado === "entregada" && p.estado === "curso" && respondido(p) > ts(g.entregadaEn) && hayRespuestas(p)) extra.push(resumenIntento(p));
  } else if (p.estado === "entregada" || hayRespuestas(p)) extra.push(resumenIntento(p));
  const vistos = new Set([claveIntento(out)]);
  out.otros = [...(a.otros || []), ...(b.otros || []), ...extra].filter((o) => !vistos.has(claveIntento(o)) && vistos.add(claveIntento(o)));
  if (!out.otros.length) delete out.otros;
  out.actualizado = [a.actualizado, b.actualizado].sort().pop();
  return out;
}

// --- con Drive ---
async function sincronizar() {
  if (!SYNC.activo) return { ok: false, cambios: 0 };
  if (syncTrabajo) return syncTrabajo;
  syncTrabajo = (async () => {
    pintarSync();
    const marca = syncCambios;
    try {
      const q = encodeURIComponent(`name = '${SYNC_ARCHIVO}' and trashed = false`);
      const lista = (await (await drive(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime&fields=files(id,name,createdTime)`)).json()).files || [];
      let remoto = {};
      for (const f of lista) remoto = fusionar(remoto, (await leerDeDrive(f.id)).datos || {}); // dos iPads crearon el archivo a la vez
      const local = await almacen.todo();
      const datos = fusionar(local, remoto);
      let cambios = 0;
      for (const [k, v] of Object.entries(datos)) {
        if (canonico(v) === canonico(local[k])) continue;
        if (canonico(await almacen.get(k)) !== canonico(local[k])) continue; // cambió mientras sincronizaba: va en la próxima
        await almacen.poner(k, v); cambios++;
      }
      const cuerpo = JSON.stringify({ app: "pruebas-ipad", version: VERSION, fecha: ahora(), datos });
      if (!lista.length) await crearEnDrive(SYNC_ARCHIVO, cuerpo);
      else if (canonico(datos) !== canonico(remoto) || lista.length > 1) await actualizarEnDrive(lista[0].id, cuerpo);
      for (const f of lista.slice(1)) await drive(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: "DELETE" });
      if (syncCambios === marca) { pendiente = false; try { localStorage.removeItem("pruebas-ipad:pendiente"); } catch {} }
      syncUlt = Date.now();
      await guardarEstadoSync({ ultimo: ahora(), error: "" });
      return { ok: true, cambios };
    } catch (e) {
      await guardarEstadoSync({ error: e.message });
      return { ok: false, cambios: 0, error: e.message };
    }
  })().finally(() => { syncTrabajo = null; pintarSync(); });
  pintarSync();
  return syncTrabajo;
}
// Si llegaron datos de otro iPad, se vuelve a pintar la pantalla, salvo donde se está escribiendo.
function trasSync(res) {
  const ruta = location.hash.replace(/^#\/?/, "");
  if (res?.cambios && !/^(p\/|admin\/c\/|admin\/ajustes)/.test(ruta) && !(ruta.startsWith("admin") && !adminOk)) route();
  return res;
}
// Permiso de Google sin abrir ventanas: sólo si ya hay uno vigente.
function syncEnFondo(minimoMs = 0) {
  if (!SYNC.activo || syncTrabajo || !tokenVigente() || Date.now() - syncUlt < minimoMs) return pintarSync();
  sincronizar().then(trasSync);
}
// Dentro de un toque: si el permiso venció, Google puede abrir su ventana (Safari sólo lo deja en el mismo toque).
function permisoSync(forzar = false) {
  if (!SYNC.activo && !forzar) return Promise.resolve(false);
  if (tokenVigente()) return Promise.resolve(true);
  if (!window.google?.accounts?.oauth2) { cargarGis().catch(() => {}); return Promise.resolve(false); }
  return pedirToken().then(() => true, (e) => guardarEstadoSync({ error: e.message }).then(() => false));
}
function syncConToque(avisarFin = false) {
  return permisoSync().then((ok) => ok && sincronizar()).then((res) => {
    if (avisarFin && !res && !tokenVigente()) avisar(SYNC.error ? "⚠️ " + SYNC.error : "Conectando con Google… vuelve a tocar ☁️");
    if (avisarFin && res) avisar(res.ok ? (res.cambios ? `Sincronizado: ${res.cambios} cambio(s) de otro iPad` : "Sincronizado") : "⚠️ " + res.error);
    return trasSync(res);
  });
}
// Al abrir una prueba: espera (hasta 8 s) a traer lo que haya en Drive.
async function syncAntesDeAbrir() {
  if (!SYNC.activo || !(syncTrabajo || tokenVigente())) return;
  await Promise.race([syncTrabajo || sincronizar(), new Promise((ok) => setTimeout(ok, 8000))]);
}
async function cargarSync() {
  SYNC = { activo: false, ...((await almacen.get("sync")) || {}) };
  pintarSync();
  if (!SYNC.activo) return;
  cargarGis().catch(() => {});
  syncEnFondo(); // al abrir la app
}

// ---------- rutas ----------
let rutaAnterior = "";
async function route() {
  const partes = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  // Al moverse por la app se sincroniza en segundo plano (al salir de una prueba, siempre; si no, cada 30 s como mucho).
  if (partes[0] !== "p") syncEnFondo(rutaAnterior.startsWith("p/") ? 0 : 30000);
  rutaAnterior = partes.join("/");
  // Versión nueva lista: se aplica en la portada o antes del PIN, nunca en medio de una prueba.
  if (hayVersionNueva && (!partes.length || (partes[0] === "admin" && !adminOk))) return location.reload();
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
cargarSync().finally(route);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncEnFondo(30000); // volvió a la app
  else if (pendiente) syncEnFondo(); // se va: sube lo pendiente si alcanza
});
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  const habiaVersion = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (habiaVersion) hayVersionNueva = true; });
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
