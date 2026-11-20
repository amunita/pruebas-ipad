// El mapa: exploración de lo que Javier ya sabe. Sin reloj, sin nota.
// Todo se guarda en este navegador (localStorage). Nada se envía a ninguna parte.
const CLAVE = "mapa-2027";
const $ = (s) => document.querySelector(s);
const vista = $("#vista");
let datos = cargar();
const cache = {};

function cargar() {
  try { return JSON.parse(localStorage.getItem(CLAVE)) || { r: {} }; } catch { return { r: {} }; }
}
function guardar() {
  datos.modificado = new Date().toISOString();
  localStorage.setItem(CLAVE, JSON.stringify(datos));
  const g = $("#guardado"); g.textContent = "Guardado ✓";
  clearTimeout(guardar.t); guardar.t = setTimeout(() => (g.textContent = ""), 1500);
}
function reg(mapa, codigo) {
  const k = `${mapa}:${codigo}`;
  return (datos.r[k] ||= { estado: null, partes: {}, visibles: 1 });
}
function hecho(r) {
  return r && (r.estado !== null || Object.values(r.partes || {}).some((t) => t && t.trim()));
}
async function traer(id) {
  return (cache[id] ||= await (await fetch(`data/${id}.json`, { cache: "no-cache" })).json());
}
function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function portada() {
  location.hash = "";
  $("#miga").textContent = "";
  const indice = await traer("indice");
  vista.innerHTML = `<h1>El mapa de lo que ya sabes</h1>
    <p>No es una prueba. No tiene nota ni reloj. Es para dibujar el mapa de por dónde has pasado, y así escribirte sólo los libros que valgan la pena.</p>
    <div class="tarjetas" id="t"></div>
    <details><summary>Para el adulto: respaldo de las respuestas</summary>
      <p>Las respuestas viven sólo en este navegador. Descarga el archivo al terminar cada sesión.</p>
      <p><button id="bajar">Descargar respuestas</button> <button id="subir">Restaurar desde archivo</button>
      <input type="file" id="archivo" accept="application/json" hidden></p>
    </details>`;
  for (const m of indice) {
    const d = await traer(m.id);
    const cods = d.etapas.flatMap((e) => e.items.map((i) => i.codigo));
    const n = cods.filter((c) => hecho(datos.r[`${m.id}:${c}`])).length;
    const b = el(`<button class="tarjeta"><b>${m.emoji} ${esc(m.titulo)}</b><small>${n} de ${cods.length} exploradas</small>
      <div class="barra"><i style="width:${(100 * n) / cods.length}%"></i></div></button>`);
    b.onclick = () => mapa(m.id);
    $("#t").append(b);
  }
  $("#bajar").onclick = descargar;
  $("#subir").onclick = () => $("#archivo").click();
  $("#archivo").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const nuevo = JSON.parse(await f.text());
    if (!nuevo.r || !confirm("Esto reemplaza las respuestas de este navegador por las del archivo. ¿Seguir?")) return;
    datos = nuevo; guardar(); portada();
  };
}

function descargar() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(datos, null, 1)], { type: "application/json" }));
  a.download = `mapa-respuestas-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
}

async function mapa(id) {
  const d = await traer(id);
  location.hash = id;
  $("#miga").textContent = d.titulo;
  vista.innerHTML = `<h1>${d.emoji} ${esc(d.titulo)}</h1><div class="caja">${d.intro}</div>
    <p class="leyenda"><span><i style="background:var(--verde)"></i>${esc(d.estados[0])}</span><span><i style="background:var(--ambar)"></i>${esc(d.estados[1])}</span><span><i style="background:var(--azul)"></i>${esc(d.estados[2])}</span></p>
    <div id="e"></div>`;
  let grupo = "";
  d.etapas.forEach((e, i) => {
    if (e.grupo !== grupo && d.etapas.filter((x) => x.grupo === e.grupo).length > 1) {
      grupo = e.grupo; $("#e").append(el(`<h2>${esc(grupo)}</h2>`));
    }
    const n = e.items.filter((it) => hecho(datos.r[`${id}:${it.codigo}`])).length;
    const b = el(`<button class="tarjeta" style="margin-bottom:.6rem"><b>${esc(e.titulo)}</b><small>${n} de ${e.items.length}</small>
      <div class="barra"><i style="width:${(100 * n) / e.items.length}%"></i></div></button>`);
    b.onclick = () => pregunta(id, i, 0);
    $("#e").append(b);
  });
}

async function pregunta(id, ie, ii) {
  const d = await traer(id), e = d.etapas[ie];
  if (ii >= e.items.length) return cierre(id, ie);
  const it = e.items[ii], r = reg(id, it.codigo);
  location.hash = `${id}/${ie}/${ii}`;
  $("#miga").textContent = `${d.titulo} › ${e.titulo}`;
  window.scrollTo(0, 0);
  const puntos = e.items.map((x, k) => {
    const rx = datos.r[`${id}:${x.codigo}`];
    const c = rx && rx.estado !== null ? `e${rx.estado}` : "";
    return `<button data-k="${k}" class="${c} ${k === ii ? "aqui" : ""}">${esc(x.codigo)}</button>`;
  }).join("");
  vista.innerHTML = `<div class="puntos">${puntos}</div>
    ${ii === 0 && e.intro ? `<div class="nota">${e.intro}</div>` : ""}
    <div class="caja"><div class="codigo">${esc(it.codigo)}</div>
      ${it.titulo ? `<h2 style="margin-top:.2rem">${esc(it.titulo)}</h2>` : ""}
      ${it.enunciado}<div id="partes"></div></div>
    <div class="estados" id="estados"></div>
    <p class="nota">Aunque elijas la segunda o la tercera, puedes intentarla igual si te tienta.</p>
    <div id="extras"></div>
    <details ${r.nota ? "open" : ""}><summary>📝 Nota del adulto</summary><textarea id="nota" spellcheck="false">${esc(r.nota || "")}</textarea></details>
    <div class="pie"><button id="ant">← Anterior</button><button id="lista">Ver la etapa</button><button id="sig" class="principal">Siguiente →</button></div>`;

  const pintarPartes = () => {
    const cont = $("#partes"); cont.innerHTML = "";
    it.partes.slice(0, r.visibles).forEach((p) => {
      const caja = el(`<div class="parte">${p.letra ? `<span class="letra">${p.letra})</span>` : ""}${p.html}
        <textarea spellcheck="false" placeholder="Escribe aquí, o cuéntalo en voz alta y que lo anoten.">${esc(r.partes[p.letra] || "")}</textarea></div>`);
      caja.querySelector("textarea").oninput = (ev) => { r.partes[p.letra] = ev.target.value; guardar(); };
      cont.append(caja);
    });
    if (r.visibles < it.partes.length) {
      const b = el(`<p><button>Ver la parte que sigue</button></p>`);
      b.firstChild.onclick = () => { r.visibles++; guardar(); pintarPartes(); };
      cont.append(b);
    }
  };
  pintarPartes();

  const pintarEstados = () => {
    $("#estados").innerHTML = "";
    d.estados.forEach((t, k) => {
      const b = el(`<button class="${r.estado === k ? "on" + k : ""}">${esc(t)}</button>`);
      b.onclick = () => { r.estado = r.estado === k ? null : k; guardar(); pintarEstados(); };
      $("#estados").append(b);
    });
  };
  pintarEstados();

  if (d.extras) {
    const grupos = [["fuente", "¿Cómo lo sabes?", ["Lo leí", "Lo vi", "Me lo contaron", "Lo pensé recién"]],
      ["seguro", "¿Qué tan seguro estás?", ["Seguro", "Más o menos", "Adivinando"]]];
    const pintar = () => {
      $("#extras").innerHTML = "";
      for (const [campo, titulo, ops] of grupos) {
        const fila = el(`<div><span class="nota">${titulo}</span><div class="chips"></div></div>`);
        ops.forEach((o) => {
          const b = el(`<button class="${r[campo] === o ? "on" : ""}">${o}</button>`);
          b.onclick = () => { r[campo] = r[campo] === o ? null : o; guardar(); pintar(); };
          fila.querySelector(".chips").append(b);
        });
        $("#extras").append(fila);
      }
    };
    pintar();
  }
  $("#nota").oninput = (ev) => { r.nota = ev.target.value; guardar(); };
  vista.querySelectorAll(".puntos button").forEach((b) => (b.onclick = () => pregunta(id, ie, +b.dataset.k)));
  $("#ant").disabled = ii === 0;
  $("#ant").onclick = () => pregunta(id, ie, ii - 1);
  $("#sig").onclick = () => pregunta(id, ie, ii + 1);
  $("#lista").onclick = () => mapa(id);
}

async function cierre(id, ie) {
  const d = await traer(id), e = d.etapas[ie];
  location.hash = `${id}/${ie}/fin`;
  const cuenta = [0, 1, 2].map((k) => e.items.filter((it) => (datos.r[`${id}:${it.codigo}`] || {}).estado === k).length);
  vista.innerHTML = `<h1>Fin de esta etapa</h1>
    <div class="caja"><p>Así quedó este pedazo del mapa:</p>
      <p class="leyenda"><span><i style="background:var(--verde)"></i>${cuenta[0]} · ${esc(d.estados[0])}</span><br>
      <span><i style="background:var(--ambar)"></i>${cuenta[1]} · ${esc(d.estados[1])}</span><br>
      <span><i style="background:var(--azul)"></i>${cuenta[2]} · ${esc(d.estados[2])}</span></p>
      <p><b>${esc(d.cierre)}</b></p>${e.manos ? `<div class="nota">${e.manos}</div>` : ""}</div>
    <div class="pie"><button id="rev">← Revisar esta etapa</button><button id="baj">Descargar respuestas</button>
      <button id="sig" class="principal">${ie + 1 < d.etapas.length ? "Etapa siguiente →" : "Volver al mapa"}</button></div>
    <p class="nota">No hay apuro: se puede seguir otro día. Todo queda guardado en este computador.</p>`;
  $("#rev").onclick = () => pregunta(id, ie, 0);
  $("#baj").onclick = descargar;
  $("#sig").onclick = () => (ie + 1 < d.etapas.length ? pregunta(id, ie + 1, 0) : mapa(id));
}

$("#inicio").onclick = portada;
(function arranque() {
  const [id, ie, ii] = location.hash.slice(1).split("/");
  if (id && ie !== undefined && ii !== undefined && ii !== "fin") pregunta(id, +ie, +ii).catch(portada);
  else if (id) mapa(id).catch(portada);
  else portada();
})();
