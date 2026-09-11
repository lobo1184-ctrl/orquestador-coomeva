/* ============================================================
   Orquestador · servidor HTTP
   Rutas:
     GET  /catalogo                       empresas, plantillas, campos, formatos
     GET  /banco/:empresa?q=...           buscar fotos por descripción
     GET  /banco/:empresa/archivo/:id     ver una foto del banco
     POST /banco/:empresa/:id/uso         curar: {uso:"aprobado"|"bloqueado"|"pendiente"}
     POST /solicitudes                    crear (202 → {id})
     GET  /solicitudes/:id                estado + piezas + QA
     GET  /solicitudes                    últimas
     GET  /piezas/:id/:archivo            descargar pieza
     GET  /openapi.yaml                   esquema para la Action del GPT
     POST /subidas                        foto adjuntada (chat o bandeja)
     POST /cerebro/mensaje                chat con el cerebro propio
     GET  /                               interfaz del cerebro
     GET  /revision                       bandeja de revisión
   ============================================================ */
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { DIR, env, log, leerJson, escribirJson } from "./lib/comun.js";
import { catalogo, validarSolicitud, crearSolicitud, encolar, leerSolicitud, listarSolicitudes, resumenPublico } from "./lib/pipeline.js";
import { buscarEnBanco, cargarIndice, rutaIndice, guardarSubida, buscarActivo } from "./lib/imagenes.js";
import { conversar } from "./lib/cerebro.js";
import { cerrarNavegador } from "./lib/render.js";

const app = express();
app.use(express.json({ limit: "20mb" }));   // las fotos adjuntas viajan en base64
app.use((req, _res, next) => { log(req.method, req.path); next(); });

/* --- autenticación simple por clave --- */
const CLAVE = env("API_KEY_ORQUESTADOR");
const auth = (req, res, next) => {
  if(!CLAVE) return next();
  const k = req.get("X-API-Key") || (req.get("Authorization") || "").replace(/^Bearer\s+/i, "") || req.query.key;
  if(k === CLAVE) return next();
  res.status(401).json({ error: "Clave inválida. Envía X-API-Key." });
};
/* Las piezas y las fotos se sirven sin clave: el id es imposible de adivinar y así
   ChatGPT puede mostrarlas en línea. Si necesitas cerrarlas, pon auth aquí también. */

/* --- interfaz --- */
app.use(express.static(DIR.public));
app.get("/", (_req, res) => res.sendFile(path.join(DIR.public, "index.html")));
app.get("/revision", (_req, res) => res.sendFile(path.join(DIR.public, "revision.html")));

/* --- catálogo --- */
app.get("/catalogo", auth, (_req, res) => res.json(catalogo()));

/* --- banco --- */
app.get("/banco/:empresa", auth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const base = env("URL_PUBLICA", "http://localhost:" + env("PUERTO", 3000)).replace(/\/$/, "");
  if(!q){
    const idx = cargarIndice(req.params.empresa);
    return res.json({ total: idx.activos.length, activos: idx.activos.map(a => ({
      id: a.id, descripcion: a.descripcion, etiquetas: a.etiquetas, origen: a.origen || "propia", uso: a.uso || "aprobado",
      url: `${base}/banco/${req.params.empresa}/archivo/${a.id}` })) });
  }
  const { resultados, metodo } = await buscarEnBanco(req.params.empresa, q, { n: +req.query.n || 8 });
  res.json({ metodo, umbral: +env("UMBRAL_BANCO", 0.42), candidatas: resultados.map(r => ({
    id: r.activo.id, puntaje: +r.puntaje.toFixed(3), descripcion: r.activo.descripcion, origen: r.activo.origen || "propia",
    uso: r.activo.uso || "aprobado", url: `${base}/banco/${req.params.empresa}/archivo/${r.activo.id}` })) });
});
app.get("/banco/:empresa/archivo/:id", (req, res) => {
  const hit = buscarActivo(req.params.empresa, req.params.id);   // banco de la empresa o subidas del chat
  if(!hit) return res.status(404).send("No existe");
  res.sendFile(hit.ruta);
});
app.post("/banco/:empresa/:id/uso", auth, (req, res) => {
  const idx = cargarIndice(req.params.empresa);
  const a = idx.activos.find(x => x.id === req.params.id);
  if(!a) return res.status(404).json({ error: "No existe" });
  if(!["aprobado", "bloqueado", "pendiente"].includes(req.body?.uso)) return res.status(400).json({ error: "uso inválido" });
  a.uso = req.body.uso; escribirJson(rutaIndice(req.params.empresa), idx);
  res.json({ id: a.id, uso: a.uso });
});

/* --- solicitudes --- */
app.post("/solicitudes", auth, (req, res) => {
  const v = validarSolicitud(req.body);
  if(!v.ok) return res.status(400).json({ error: "Solicitud inválida", detalles: v.errores });
  const s = crearSolicitud(req.body);
  encolar(s.id);
  const base = env("URL_PUBLICA", "http://localhost:" + env("PUERTO", 3000)).replace(/\/$/, "");
  res.status(202).json({ id: s.id, estado: s.estado, consultar: `${base}/solicitudes/${s.id}`,
    mensaje: "Solicitud en cola. Consulta el estado en unos segundos; la producción tarda entre 10 y 90 segundos según la fotografía." });
});
app.get("/solicitudes", auth, (req, res) => res.json(listarSolicitudes(+req.query.n || 30).map(resumenPublico)));
app.get("/solicitudes/:id", auth, (req, res) => {
  const s = leerSolicitud(req.params.id);
  if(!s) return res.status(404).json({ error: "No existe la solicitud" });
  res.json(resumenPublico(s));
});
app.get("/solicitudes/:id/detalle", auth, (req, res) => {
  const s = leerSolicitud(req.params.id);
  s ? res.json(s) : res.status(404).json({ error: "No existe" });
});
app.get("/piezas/:id/:archivo", (req, res) => {
  const p = path.join(DIR.salidas, req.params.id, path.basename(req.params.archivo));
  fs.existsSync(p) ? res.sendFile(p) : res.status(404).send("No existe");
});

/* --- OpenAPI para la Action del GPT, con la URL pública ya puesta --- */
app.get("/openapi.yaml", (_req, res) => {
  const y = fs.readFileSync(path.join(DIR.cerebro, "openapi.yaml"), "utf8")
    .replace("https://TU-DOMINIO", env("URL_PUBLICA", "http://localhost:" + env("PUERTO", 3000)).replace(/\/$/, ""));
  res.type("text/yaml").send(y);
});

/* --- fotos subidas por la persona --- */
/* Desde el chat (sin empresa todavía) o desde la bandeja (con empresa). Cuerpo: { nombre, base64, empresa?, descripcion? } */
app.post("/subidas", async (req, res) => {
  const { nombre, base64, empresa, descripcion } = req.body || {};
  if(!base64) return res.status(400).json({ error: "Falta base64" });
  if(empresa && !/^[a-z0-9_-]+$/.test(empresa)) return res.status(400).json({ error: "Clave de empresa inválida" });
  try{
    const r = await guardarSubida({ empresa: empresa || null, nombre, base64, descripcion, conVector: !!empresa });
    const base = env("URL_PUBLICA", "http://localhost:" + env("PUERTO", 3000)).replace(/\/$/, "");
    res.status(201).json({ ...r, url: empresa ? `${base}/banco/${empresa}/archivo/${r.id}` : `${base}/subidas/${r.id}` });
  }catch(e){ res.status(400).json({ error: e.message }); }
});
app.get("/subidas/:id", (req, res) => {
  const hit = buscarActivo("_subidas", req.params.id);
  if(!hit) return res.status(404).end();
  res.sendFile(hit.ruta);
});

/* --- cerebro propio --- */
app.post("/cerebro/mensaje", async (req, res) => {
  const { sesion, mensaje } = req.body || {};
  if(!sesion || !mensaje) return res.status(400).json({ error: "Faltan sesion y mensaje" });
  try{ res.json(await conversar(String(sesion), String(mensaje))); }
  catch(e){ res.status(500).json({ error: e.message }); }
});

/* --- arranque --- */
for(const d of Object.values(DIR)) fs.mkdirSync(d, { recursive: true });
const puerto = +env("PUERTO", 3000);
app.listen(puerto, () => {
  log(`Orquestador escuchando en http://localhost:${puerto}`);
  log(`Cerebro web: http://localhost:${puerto}/   ·   Revisión: http://localhost:${puerto}/revision`);
  if(!fs.existsSync(path.join(DIR.motor, "motor-render-piezas-v6.html"))) log("AVISO: falta motor/motor-render-piezas-v6.html");
  if(!env("VOYAGE_API_KEY")) log("Sin VOYAGE_API_KEY: el banco se busca por palabras.");
  if(!env("OPENAI_API_KEY")) log("Sin OPENAI_API_KEY: no se generan imágenes ni funciona el cerebro web.");
});
for(const s of ["SIGINT", "SIGTERM"]) process.on(s, async () => { await cerrarNavegador(); process.exit(0); });
