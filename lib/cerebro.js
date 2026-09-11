/* ============================================================
   Cerebro propio (alternativa al GPT personalizado)
   Usa la Responses API de OpenAI con las funciones del orquestador como
   herramientas. Mantiene el hilo por sesión con previous_response_id.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { DIR, env, log } from "./comun.js";
import { catalogo, validarSolicitud, crearSolicitud, encolar, leerSolicitud, resumenPublico } from "./pipeline.js";
import { buscarEnBanco } from "./imagenes.js";

const sesiones = new Map();   // sesion_id -> { previous_response_id, ultimo }

export function instrucciones(){
  const p = path.join(DIR.cerebro, "instrucciones.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "Eres el agente cerebro de producción de piezas gráficas.";
}

const HERRAMIENTAS = [
  { type: "function", name: "consultar_catalogo", description: "Lista empresas, plantillas disponibles, sus campos de texto y formatos. Llámala antes de proponer nada.",
    parameters: { type: "object", properties: {}, additionalProperties: false } },
  { type: "function", name: "buscar_fotos", description: "Busca en el banco fotográfico de una empresa por descripción. Devuelve candidatas con puntaje para que la persona elija o para decidir si generar.",
    parameters: { type: "object", required: ["empresa", "descripcion"], additionalProperties: false,
      properties: { empresa: { type: "string" }, descripcion: { type: "string" } } } },
  { type: "function", name: "crear_solicitud", description: "Envía la solicitud validada a la consola de diseño. Devuelve un id para consultar el avance. Solo cuando la persona haya confirmado el resumen.",
    parameters: { type: "object", required: ["solicitud"], additionalProperties: false,
      properties: { solicitud: { type: "object", description: "Objeto conforme al esquema solicitud-pieza.v1", additionalProperties: true } } } },
  { type: "function", name: "consultar_solicitud", description: "Consulta el estado y, si está lista, las URLs de las piezas y el control de calidad.",
    parameters: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string" } } } }
];

async function ejecutar(nombre, args, sesion){
  switch(nombre){
    case "consultar_catalogo": return catalogo();
    case "buscar_fotos": {
      const { resultados, metodo } = await buscarEnBanco(args.empresa, args.descripcion, { n: 6 });
      const base = env("URL_PUBLICA", "http://localhost:" + env("PUERTO", 3000)).replace(/\/$/, "");
      return { metodo, umbral: +env("UMBRAL_BANCO", 0.42),
        candidatas: resultados.map(r => ({ id: r.activo.id, puntaje: +r.puntaje.toFixed(3), descripcion: r.activo.descripcion,
          origen: r.activo.origen || "propia", url: `${base}/banco/${args.empresa}/archivo/${r.activo.id}` })) };
    }
    case "crear_solicitud": {
      const sol = args.solicitud;
      sol.solicitante = { ...(sol.solicitante || {}), canal: "web" };
      const v = validarSolicitud(sol);
      if(!v.ok) return { error: "Solicitud inválida", detalles: v.errores };
      const s = crearSolicitud(sol);
      encolar(s.id);
      sesion.ultimo = s.id;
      return { id: s.id, estado: s.estado, mensaje: "En cola. Consulta el avance con consultar_solicitud en unos segundos." };
    }
    case "consultar_solicitud": {
      const s = leerSolicitud(args.id);
      return s ? resumenPublico(s) : { error: "No existe la solicitud " + args.id };
    }
  }
  return { error: "Herramienta desconocida " + nombre };
}

/**
 * Envía un mensaje del usuario y resuelve todas las llamadas a herramientas hasta obtener texto.
 * @returns {Promise<{texto:string, herramientas:Array, solicitud_id?:string}>}
 */
export async function conversar(sesionId, mensaje){
  const key = env("OPENAI_API_KEY");
  if(!key) return { texto: "Falta OPENAI_API_KEY en el .env para usar el cerebro web. Puedes usar el GPT personalizado con la Action mientras tanto.", herramientas: [] };
  const sesion = sesiones.get(sesionId) || { previous_response_id: null, ultimo: null };
  sesiones.set(sesionId, sesion);
  const modelo = env("MODELO_CEREBRO", "gpt-5.4");
  const usadas = [];

  let input = [{ role: "user", content: mensaje }];
  for(let vuelta = 0; vuelta < 8; vuelta++){
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelo, instructions: instrucciones(), tools: HERRAMIENTAS, input,
        previous_response_id: sesion.previous_response_id || undefined, store: true
      })
    });
    if(!r.ok) return { texto: `Error del modelo (${r.status}): ${(await r.text()).slice(0, 300)}`, herramientas: usadas };
    const j = await r.json();
    sesion.previous_response_id = j.id;

    const llamadas = (j.output || []).filter(o => o.type === "function_call");
    if(!llamadas.length){
      const texto = (j.output || []).filter(o => o.type === "message")
        .flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("\n").trim();
      return { texto: texto || "(sin respuesta)", herramientas: usadas, solicitud_id: sesion.ultimo || undefined };
    }
    input = [];
    for(const c of llamadas){
      let args = {}; try{ args = JSON.parse(c.arguments || "{}"); }catch(e){}
      log("cerebro →", c.name, JSON.stringify(args).slice(0, 160));
      let out; try{ out = await ejecutar(c.name, args, sesion); }catch(e){ out = { error: e.message }; }
      usadas.push({ nombre: c.name, argumentos: args, resultado: out });
      input.push({ type: "function_call_output", call_id: c.call_id, output: JSON.stringify(out) });
    }
  }
  return { texto: "Se alcanzó el límite de pasos automáticos. Pídeme que continúe.", herramientas: usadas };
}
