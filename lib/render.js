/* ============================================================
   Render sin pantalla
   Abre motor/motor-render-piezas-v6.html en Chromium (Playwright), carga la
   plantilla, inyecta contenido e imagen y llama a las mismas funciones que usa
   el botón "Descargar". Lo que exporta la consola a mano y lo que exporta esto
   es idéntico: es el mismo código.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { DIR, RAIZ, env, log } from "./comun.js";

let navegador = null;
async function obtenerNavegador(){
  if(navegador && navegador.isConnected()) return navegador;
  /* RUTA_CHROMIUM permite usar un Chrome ya instalado en vez de descargar uno con
     `npx playwright install chromium`. */
  const executablePath = env("RUTA_CHROMIUM") || undefined;
  navegador = await chromium.launch({ headless: true, executablePath, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  return navegador;
}
export async function cerrarNavegador(){ if(navegador){ await navegador.close(); navegador = null; } }

export function rutaMotor(){
  const p = path.join(DIR.motor, "motor-render-piezas-v6.html");
  if(!fs.existsSync(p)) throw new Error("Falta motor/motor-render-piezas-v6.html. Copia ahí el archivo de la consola de diseño.");
  return p;
}

/**
 * @param {object} plantilla  documento v6 (el .json que guarda la consola)
 * @param {object} opts  { contenido, porFormato, imagenDataUrl, imagenPorFormato, formatos, escala, formato }
 * @returns {Promise<{piezas:Array<{id,nombre,w,h,png:Buffer}>, qa:string[]}>}
 */
export async function renderizar(plantilla, opts = {}){
  const b = await obtenerNavegador();
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("dialog", d => d.accept());
  page.on("pageerror", e => log("motor: error en página →", e.message));
  /* Las librerías que el motor carga de cdnjs se sirven desde node_modules:
     el render funciona sin internet y no depende de un CDN externo. */
  const locales = {
    "html2canvas.min.js": path.join(RAIZ, "node_modules/html2canvas/dist/html2canvas.min.js"),
    "jszip.min.js":       path.join(RAIZ, "node_modules/jszip/dist/jszip.min.js"),
    "jspdf.umd.min.js":   path.join(RAIZ, "node_modules/jspdf/dist/jspdf.umd.min.js")
  };
  await page.route("**/cdnjs.cloudflare.com/**", route => {
    const nombre = route.request().url().split("/").pop();
    const local = locales[nombre];
    if(local && fs.existsSync(local)) return route.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(local) });
    return route.continue();
  });
  /* Si no hay internet, las fuentes de Google fallan rápido y el motor usa las de respaldo. */
  await page.route("**/fonts.g*apis.com/**", route => route.continue().catch(() => route.abort()));
  await page.route("**/fonts.gstatic.com/**", route => route.continue().catch(() => route.abort()));
  try{
    await page.goto("file://" + rutaMotor(), { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => typeof loadDoc === "function" && typeof capture === "function", null, { timeout: 30000 });

    const escala = Math.max(1, Math.min(3, +(opts.escala ?? 2)));
    const tipo = opts.formato === "jpg" ? "image/jpeg" : "image/png";

    const resultado = await page.evaluate(async ({ plantilla, contenido, porFormato, imagenDataUrl, imagenPorFormato, formatos, escala, tipo }) => {
      const espera = ms => new Promise(r => setTimeout(r, ms));
      hist.lock = true;
      loadDoc(plantilla);

      /* textos globales y por formato */
      for(const [k, v] of Object.entries(contenido || {})) if(v !== undefined) doc.content[k] = v;
      for(const [fid, campos] of Object.entries(porFormato || {})){
        const f = doc.formats.find(x => x.id === fid || x.name === fid); if(!f) continue;
        for(const [k, v] of Object.entries(campos || {})) if(v !== undefined) f.ov[k] = v;
      }
      /* imagen principal */
      const campoImg = (doc.fields.find(x => x.kind === "image") || { key: "img" }).key;
      if(imagenDataUrl !== undefined) doc.content[campoImg] = imagenDataUrl;
      for(const [fid, d] of Object.entries(imagenPorFormato || {})){
        const f = doc.formats.find(x => x.id === fid || x.name === fid); if(f && d) f.ov[campoImg] = d;
      }
      render();

      /* esperar fuentes, metadatos de imagen y tratamientos horneados */
      try{ await document.fonts.ready; }catch(e){}
      const srcs = new Set();
      doc.formats.forEach(f => { const s = val(f, campoImg); if(s) srcs.add(s); });
      const t0 = Date.now();
      while(Date.now() - t0 < 15000){
        const metaOk = [...srcs].every(s => imgMeta.get(s));
        if(metaOk && fxPending.size === 0) break;
        await espera(120);
      }
      renderStage(); runQA();
      await espera(150);

      const elegidos = doc.formats.filter(f => !formatos || !formatos.length || formatos.includes(f.id) || formatos.includes(f.name));
      const piezas = [];
      for(const f of elegidos){
        const c = await capture(f, escala);
        piezas.push({ id: f.id, nombre: f.name, w: c.width, h: c.height, dataUrl: c.toDataURL(tipo, 0.92) });
      }
      /* Solo las observaciones de los formatos producidos: el QA del motor revisa todos los de la plantilla.
         Las líneas del QA terminan en "en: Formato A, Formato B." */
      const producidos = new Set(elegidos.map(f => f.name));
      const todos = new Set(doc.formats.map(f => f.name));
      const filtrar = (txt) => {
        const m = txt.match(/^(.*\ben:\s*)(.+?)\.?$/);
        if(!m) return txt;
        const lista = m[2].split(/,\s*/).map(x => x.trim());
        if(!lista.every(x => todos.has(x))) return txt;
        const quedan = lista.filter(x => producidos.has(x));
        return quedan.length ? m[1] + quedan.join(", ") + "." : null;
      };
      const qa = [...document.querySelectorAll("#qa-list li")]
        .map(li => ({ cls: li.className || "info", txt: filtrar(li.textContent) }))
        .filter(x => x.txt)
        .map(x => x.cls + ": " + x.txt);
      return { piezas, qa };
    }, { plantilla, contenido: opts.contenido, porFormato: opts.porFormato, imagenDataUrl: opts.imagenDataUrl,
         imagenPorFormato: opts.imagenPorFormato, formatos: opts.formatos, escala, tipo });

    return {
      qa: resultado.qa,
      piezas: resultado.piezas.map(p => ({ id: p.id, nombre: p.nombre, w: p.w, h: p.h,
                                            buffer: Buffer.from(p.dataUrl.split(",")[1], "base64") }))
    };
  } finally {
    await ctx.close();
  }
}
