/* Utilidades compartidas. Sin dependencias externas. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIR = {
  plantillas:  path.join(RAIZ, "plantillas"),
  banco:       path.join(RAIZ, "banco"),
  salidas:     path.join(RAIZ, "salidas"),
  solicitudes: path.join(RAIZ, "solicitudes"),
  motor:       path.join(RAIZ, "motor"),
  schema:      path.join(RAIZ, "schema"),
  cerebro:     path.join(RAIZ, "cerebro"),
  public:      path.join(RAIZ, "public")
};

/* .env mínimo: KEY=valor, ignora comentarios. No pisa variables ya definidas. */
export function cargarEnv(){
  const p = path.join(RAIZ, ".env");
  if(!fs.existsSync(p)) return;
  for(const linea of fs.readFileSync(p, "utf8").split(/\r?\n/)){
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if(!m || linea.trim().startsWith("#")) continue;
    if(process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
cargarEnv();

export const env = (k, def) => (process.env[k] === undefined || process.env[k] === "") ? def : process.env[k];

export const uid = (p = "s") =>
  p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const slug = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

export function log(...a){
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

export const leerJson = (p, def = null) => {
  try{ return JSON.parse(fs.readFileSync(p, "utf8")); }catch(e){ return def; }
};
export const escribirJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
};

export const mime = f => ({
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml"
})[path.extname(f).toLowerCase()] || "application/octet-stream";

export const aDataUrl = (ruta) =>
  `data:${mime(ruta)};base64,${fs.readFileSync(ruta).toString("base64")}`;

export const dataUrlABuffer = (d) => Buffer.from(d.split(",")[1], "base64");

/* Similitud coseno entre dos vectores. */
export function coseno(a, b){
  let s = 0, na = 0, nb = 0;
  for(let i = 0; i < a.length; i++){ s += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return na && nb ? s / Math.sqrt(na*nb) : 0;
}

/* Tokens de un texto en español para búsqueda por palabras (respaldo sin embeddings). */
const VACIAS = new Set(("de la que el en y a los del se las por un para con no una su al lo como más pero sus le ya o este " +
  "sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni " +
  "contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes " +
  "nada muchos cual poco ella estar estas algunas algo nosotros foto imagen fotografia con sin").split(" "));
export function tokens(t){
  return String(t ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/).filter(w => w.length > 2 && !VACIAS.has(w))
    .map(w => w.replace(/(es|s)$/, ""));   // plural simple
}
