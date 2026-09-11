/* ============================================================
   Ingesta del banco fotográfico
   Uso:  node ingestar.js <empresa> [carpeta_origen]
     - Sin carpeta: reindexa lo que ya está en banco/<empresa>/
     - Con carpeta: copia las fotos a banco/<empresa>/fotos/ y las indexa
   Por cada foto guarda: id, archivo, descripción (automática si hay MODELO_VISION),
   etiquetas, vector (si hay VOYAGE_API_KEY), origen "propia", uso "aprobado".
   Es incremental: no repite fotos ya indexadas ni recalcula vectores existentes.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { DIR, env, uid, log, leerJson, escribirJson, aDataUrl, tokens } from "./lib/comun.js";
import { embeddingImagen, rutaIndice } from "./lib/imagenes.js";

const [empresa, origen] = process.argv.slice(2);
if(!empresa){ console.log("Uso: node ingestar.js <empresa> [carpeta_con_fotos]"); process.exit(1); }

const dirEmpresa = path.join(DIR.banco, empresa);
const dirFotos = path.join(dirEmpresa, "fotos");
fs.mkdirSync(dirFotos, { recursive: true });
const EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

if(origen){
  for(const f of fs.readdirSync(origen)){
    if(!EXT.has(path.extname(f).toLowerCase())) continue;
    const dest = path.join(dirFotos, f);
    if(!fs.existsSync(dest)) fs.copyFileSync(path.join(origen, f), dest);
  }
}

async function describir(dataUrl){
  const key = env("OPENAI_API_KEY"), modelo = env("MODELO_VISION");
  if(!key || !modelo) return null;
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelo, input: [{ role: "user", content: [
      { type: "input_text", text: "Describe esta fotografía en español en una sola frase útil para buscarla después: quién aparece, qué hace, dónde, qué luz y qué emoción transmite. Luego, en una segunda línea, 8 a 12 etiquetas separadas por coma." },
      { type: "input_image", image_url: dataUrl }] }] })
  });
  if(!r.ok){ log("visión error", r.status); return null; }
  const j = await r.json();
  const texto = (j.output || []).flatMap(o => o.content || []).filter(c => c.type === "output_text").map(c => c.text).join("\n");
  const [desc, tags] = texto.split("\n").map(s => s.trim()).filter(Boolean);
  return { descripcion: desc || null, etiquetas: (tags || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean) };
}

const idx = leerJson(rutaIndice(empresa), { empresa, activos: [] });
const porArchivo = new Map(idx.activos.map(a => [a.archivo, a]));
const archivos = fs.readdirSync(dirFotos).filter(f => EXT.has(path.extname(f).toLowerCase())).map(f => "fotos/" + f);

let nuevos = 0, vectores = 0;
for(const rel of archivos){
  let a = porArchivo.get(rel);
  const ruta = path.join(dirEmpresa, rel);
  const dataUrl = aDataUrl(ruta);
  if(!a){
    a = { id: uid("img"), archivo: rel, descripcion: null, etiquetas: [], origen: "propia", uso: "aprobado", creado: new Date().toISOString() };
    idx.activos.push(a); nuevos++;
  }
  if(!a.descripcion){
    const d = await describir(dataUrl);
    if(d){ a.descripcion = d.descripcion; a.etiquetas = d.etiquetas; }
    else { a.descripcion = path.basename(rel, path.extname(rel)).replace(/[-_]+/g, " "); a.etiquetas = tokens(a.descripcion); }
  }
  if(!a.vector){
    const v = await embeddingImagen(dataUrl);
    if(v){ a.vector = v; vectores++; }
  }
  log(a.id, "·", rel, "·", (a.descripcion || "").slice(0, 70), a.vector ? "· vector" : "");
  escribirJson(rutaIndice(empresa), idx);   // guardado incremental
}
log(`Listo: ${archivos.length} fotos en el índice, ${nuevos} nuevas, ${vectores} vectores calculados.`);
if(!env("VOYAGE_API_KEY")) log("Sin VOYAGE_API_KEY: la búsqueda será por palabras. Añade la clave y vuelve a ejecutar para activar la búsqueda semántica.");
