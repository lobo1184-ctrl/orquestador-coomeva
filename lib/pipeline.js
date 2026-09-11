/* ============================================================
   Pipeline de una solicitud
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import { DIR, env, uid, slug, log, leerJson, escribirJson } from "./comun.js";
import { resolverImagen } from "./imagenes.js";
import { renderizar } from "./render.js";

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const esquema = leerJson(path.join(DIR.schema, "solicitud.schema.json"));
const validar = ajv.compile(esquema);

export function validarSolicitud(obj){
  const ok = validar(obj);
  return { ok, errores: ok ? [] : (validar.errors || []).map(e => (e.instancePath || "/") + " " + e.message) };
}

/* ---------- catálogo ---------- */

export function catalogo(){
  const empresas = fs.existsSync(DIR.plantillas) ? fs.readdirSync(DIR.plantillas).filter(d => fs.statSync(path.join(DIR.plantillas, d)).isDirectory()) : [];
  return empresas.map(empresa => {
    const dir = path.join(DIR.plantillas, empresa);
    const plantillas = fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => {
      const d = leerJson(path.join(dir, f), {});
      return {
        clave: f.replace(/\.json$/, ""),
        nombre: d.name || f,
        campos: (d.fields || []).filter(x => x.kind !== "image").map(x => ({ clave: x.key, nombre: x.label })),
        formatos: (d.formats || []).map(x => ({ id: x.id, nombre: x.name, ancho: x.w, alto: x.h })),
        tiene_imagen: (d.fields || []).some(x => x.kind === "image")
      };
    });
    const banco = leerJson(path.join(DIR.banco, empresa, "indice.json"), { activos: [] });
    return { empresa, plantillas, fotos_en_banco: (banco.activos || []).filter(a => a.uso !== "bloqueado").length };
  });
}

export function cargarPlantilla(empresa, clave){
  const p = path.join(DIR.plantillas, empresa, clave + ".json");
  const d = leerJson(p);
  if(!d || !d.formats) throw new Error(`No existe la plantilla ${empresa}/${clave}. Guarda el .json de la consola en plantillas/${empresa}/${clave}.json`);
  return d;
}

/* ---------- solicitudes ---------- */

const rutaSol = id => path.join(DIR.solicitudes, id + ".json");
export const leerSolicitud = id => leerJson(rutaSol(id));
export const listarSolicitudes = (n = 50) => fs.existsSync(DIR.solicitudes)
  ? fs.readdirSync(DIR.solicitudes).filter(f => f.endsWith(".json")).map(f => leerJson(path.join(DIR.solicitudes, f)))
      .filter(Boolean).sort((a, b) => (b.creado || "").localeCompare(a.creado || "")).slice(0, n)
  : [];

function guardar(s){ escribirJson(rutaSol(s.id), s); return s; }

export function crearSolicitud(entrada){
  const s = {
    id: uid("sol"),
    estado: "en_cola",             // en_cola → procesando → lista | error
    creado: new Date().toISOString(),
    entrada,
    eventos: [],
    piezas: [],
    qa: [],
    imagen: null
  };
  return guardar(s);
}

const cola = [];
let ocupado = false;
export function encolar(id){
  cola.push(id);
  procesarCola();
}
async function procesarCola(){
  if(ocupado) return;
  ocupado = true;
  while(cola.length){
    const id = cola.shift();
    try{ await procesar(id); }
    catch(e){ log("Error inesperado en", id, e); }
  }
  ocupado = false;
}

function evento(s, msg, extra){ s.eventos.push({ t: new Date().toISOString(), msg, ...(extra || {}) }); guardar(s); log(s.id, msg); }

export async function procesar(id){
  const s = leerSolicitud(id);
  if(!s) return;
  const e = s.entrada;
  s.estado = "procesando"; evento(s, "Inicio");
  try{
    const plantilla = cargarPlantilla(e.empresa, e.plantilla);
    evento(s, `Plantilla ${e.plantilla} · ${plantilla.formats.length} formatos`);

    /* campos desconocidos: se avisa pero no se bloquea */
    const conocidos = new Set(plantilla.fields.map(f => f.key));
    const desconocidos = Object.keys(e.contenido).filter(k => !conocidos.has(k));
    if(desconocidos.length) evento(s, "Campos que la plantilla no usa: " + desconocidos.join(", "));

    /* fotografía: se resuelve una vez (global) y, si se pidió, por formato */
    const f0 = plantilla.formats.reduce((a, f) => (f.w*f.h > a.w*a.h ? f : a), plantilla.formats[0]);
    let imagenDataUrl;
    const imagenPorFormato = {};
    if(plantilla.fields.some(x => x.kind === "image")){
      /* Si el cerebro no describió la foto, se deduce del contenido: la pieza nunca sale sin buscar en el banco. */
      let imagen = e.imagen || {};
      if(!imagen.asset_id && !imagen.descripcion && imagen.politica !== "ninguna"){
        const textos = Object.values(e.contenido || {}).filter(v => typeof v === "string" && v.length > 3);
        imagen = { ...imagen, descripcion: textos.slice(0, 2).join(". ").slice(0, 300), politica: imagen.politica || "solo_banco" };
        evento(s, "Sin descripción de foto: se busca en el banco a partir del contenido");
      }
      const r = await resolverImagen(e.empresa, imagen, { ancho: f0.w, alto: f0.h });
      imagenDataUrl = r.dataUrl;
      s.imagen = r.procedencia;
      evento(s, "Imagen: " + (r.procedencia.origen || "sin imagen") + (r.procedencia.aviso ? " · " + r.procedencia.aviso : ""));
      for(const [fid, d] of Object.entries(e.imagen?.por_formato || {})){
        const f = plantilla.formats.find(x => x.id === fid); if(!f) continue;
        const rf = await resolverImagen(e.empresa, { ...imagen, ...d, por_formato: undefined }, { ancho: f.w, alto: f.h });
        if(rf.dataUrl){ imagenPorFormato[fid] = rf.dataUrl; s.imagen.por_formato = s.imagen.por_formato || {}; s.imagen.por_formato[fid] = rf.procedencia; }
      }
    }

    /* render */
    evento(s, "Renderizando…");
    const out = await renderizar(plantilla, {
      contenido: e.contenido, porFormato: e.por_formato, imagenDataUrl, imagenPorFormato,
      formatos: e.formatos, escala: e.salida?.escala ?? 2, formato: e.salida?.formato || "png"
    });

    /* guardar archivos */
    const dir = path.join(DIR.salidas, s.id);
    fs.mkdirSync(dir, { recursive: true });
    const ext = (e.salida?.formato || "png") === "jpg" ? "jpg" : "png";
    const base = env("URL_PUBLICA", "http://localhost:" + env("PUERTO", 3000)).replace(/\/$/, "");
    s.piezas = out.piezas.map(p => {
      const nombre = `${slug(e.empresa)}_${slug(e.plantilla)}_${slug(p.nombre)}_${p.w}x${p.h}.${ext}`;
      fs.writeFileSync(path.join(dir, nombre), p.buffer);
      return { formato: p.id, nombre: p.nombre, ancho: p.w, alto: p.h, archivo: nombre, url: `${base}/piezas/${s.id}/${nombre}` };
    });
    s.qa = out.qa;
    const graves = out.qa.filter(q => q.startsWith("err")).length;
    s.estado = "lista";
    s.terminado = new Date().toISOString();
    s.resumen = `${s.piezas.length} pieza(s) lista(s)` + (graves ? ` · ${graves} observación(es) grave(s) de control de calidad` : " · sin observaciones graves");
    evento(s, s.resumen);
  }catch(err){
    s.estado = "error"; s.error = String(err.message || err);
    evento(s, "Error: " + s.error);
  }

  /* avisar al cerebro si dejó una URL de retorno */
  if(e.callback_url){
    try{
      await fetch(e.callback_url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resumenPublico(s)) });
      evento(s, "Callback enviado");
    }catch(err){ evento(s, "Callback falló: " + err.message); }
  }
  return s;
}

/* Lo que ve el cerebro: sin datos internos ni rutas del disco. */
export function resumenPublico(s){
  return {
    id: s.id, estado: s.estado, creado: s.creado, terminado: s.terminado || null,
    empresa: s.entrada.empresa, plantilla: s.entrada.plantilla,
    resumen: s.resumen || null, error: s.error || null,
    piezas: s.piezas, control_calidad: s.qa,
    imagen: s.imagen ? { origen: s.imagen.origen, activo: s.imagen.activo || null, puntaje: s.imagen.puntaje ?? null,
                         aviso: s.imagen.aviso || null, prompt: s.imagen.prompt || null } : null,
    ultimo_evento: s.eventos.at(-1)?.msg || null
  };
}
