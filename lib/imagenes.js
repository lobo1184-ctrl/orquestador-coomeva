/* ============================================================
   Resolución de fotografía
   1. Banco de la empresa (búsqueda semántica; respaldo por palabras)
   2. Generación anclada a la fotografía real de la marca
   Cada decisión queda registrada en `procedencia` para auditoría.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { DIR, env, coseno, tokens, aDataUrl, log, leerJson, escribirJson, uid } from "./comun.js";

/* ---------- índice del banco ---------- */

export function rutaIndice(empresa){ return path.join(DIR.banco, empresa, "indice.json"); }

export function cargarIndice(empresa){
  const idx = leerJson(rutaIndice(empresa), { empresa, activos: [] });
  idx.activos = (idx.activos || []).filter(a => fs.existsSync(path.join(DIR.banco, empresa, a.archivo)));
  return idx;
}

export function politicaBanco(empresa){
  /* banco/<empresa>/politica.json: reglas de la marca para fotografía */
  return leerJson(path.join(DIR.banco, empresa, "politica.json"), {
    permitir_generacion: true,
    estilo: "Fotografía real, luz natural, personas auténticas, tonos cálidos. Sin texto, sin logotipos.",
    prohibido: "Texto dentro de la imagen, logotipos, marcas de agua, celebridades, menores identificables, armas."
  });
}

/* ---------- embeddings multimodales (Voyage) ---------- */

async function embeddingVoyage(contenido, tipo){
  const key = env("VOYAGE_API_KEY");
  if(!key) return null;
  const r = await fetch("https://api.voyageai.com/v1/multimodalembeddings", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env("MODELO_EMBEDDINGS", "voyage-multimodal-3.5"),
      input_type: tipo,                       // "query" | "document"
      inputs: [{ content: contenido }]
    })
  });
  if(!r.ok){ log("Voyage error", r.status, await r.text()); return null; }
  const j = await r.json();
  return j.data?.[0]?.embedding || null;
}
export const embeddingTexto  = t => embeddingVoyage([{ type: "text", text: t }], "query");
export const embeddingImagen = dataUrl => embeddingVoyage([{ type: "image_base64", image_base64: dataUrl }], "document");

/* ---------- búsqueda ---------- */

export async function buscarEnBanco(empresa, descripcion, { n = 5, excluir = [] } = {}){
  const idx = cargarIndice(empresa);
  const candidatos = idx.activos.filter(a => !excluir.includes(a.id) && a.uso !== "bloqueado");
  if(!candidatos.length) return { resultados: [], metodo: "vacio" };

  /* 1) semántico, si hay embeddings en el índice y clave de API */
  const conVector = candidatos.filter(a => Array.isArray(a.vector));
  if(conVector.length){
    const q = await embeddingTexto(descripcion);
    if(q){
      const res = conVector.map(a => ({ activo: a, puntaje: coseno(q, a.vector) }))
        .sort((x, y) => y.puntaje - x.puntaje).slice(0, n);
      return { resultados: res, metodo: "semantico" };
    }
  }
  /* 2) respaldo: coincidencia de palabras contra descripción y etiquetas */
  /* raíz aproximada: "familiar", "familias" y "familia" cuentan como la misma palabra */
  const raiz = w => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/(ciones|cion|mente|idad|ales|ares|es|as|os|ar|er|ir|a|o|s)$/, "").slice(0, 5);
  const qt = new Set(tokens(descripcion).map(raiz).filter(w => w.length >= 3));
  const res = candidatos.map(a => {
    const bolsa = new Set(tokens((a.descripcion || "") + " " + (a.etiquetas || []).join(" ") + " " + a.archivo).map(raiz));
    const hits = [...qt].filter(w => bolsa.has(w)).length;
    return { activo: a, puntaje: qt.size ? Math.min(1, hits / Math.min(3, qt.size)) : 0 };
  }).filter(r => r.puntaje > 0).sort((x, y) => y.puntaje - x.puntaje).slice(0, n);
  return { resultados: res, metodo: "palabras" };
}

/* ---------- generación anclada ---------- */

function tamanoGeneracion(ancho, alto){
  /* gpt-image-2 acepta cualquier tamaño múltiplo de 16 entre 1:3 y 3:1. Se pide el lado
     mayor a 1536 px, suficiente para un post de 1080 a 1× y razonable en costo. */
  const ar = Math.max(1/3, Math.min(3, ancho / alto));
  let w, h;
  if(ar >= 1){ w = 1536; h = Math.round(1536 / ar); } else { h = 1536; w = Math.round(1536 * ar); }
  const r16 = v => Math.max(256, Math.round(v / 16) * 16);
  return `${r16(w)}x${r16(h)}`;
}

export async function generarImagen(empresa, descripcion, { ancho = 1080, alto = 1080, evitar = "", referencias = [] } = {}){
  const key = env("OPENAI_API_KEY");
  if(!key) return { error: "Sin OPENAI_API_KEY: no se puede generar." };
  const pol = politicaBanco(empresa);
  if(pol.permitir_generacion === false) return { error: "La política de la marca no permite imágenes generadas." };

  const prompt = [
    `Fotografía publicitaria real para una marca colombiana. Escena: ${descripcion}.`,
    `Estilo de marca: ${pol.estilo}`,
    referencias.length ? "Mantén la misma paleta, luz, tratamiento de color y tipo de personas de las fotografías de referencia; no copies sus sujetos ni composiciones." : "",
    "Composición con espacio limpio para superponer texto. Sin texto, sin logotipos, sin marcas de agua.",
    `Evitar: ${pol.prohibido}${evitar ? "; " + evitar : ""}.`
  ].filter(Boolean).join(" ");

  const size = tamanoGeneracion(ancho, alto);
  const modelo = env("MODELO_IMAGEN", "gpt-image-2");
  const calidad = env("CALIDAD_IMAGEN", "medium");
  let r;
  if(referencias.length){
    /* /images/edits con varias referencias: ancla el estilo a la fotografía real de la marca */
    const fd = new FormData();
    fd.append("model", modelo);
    fd.append("prompt", prompt);
    fd.append("size", size);
    fd.append("quality", calidad);
    fd.append("output_format", "png");
    for(const ruta of referencias.slice(0, 5)){
      fd.append("image[]", new Blob([fs.readFileSync(ruta)], { type: "image/jpeg" }), path.basename(ruta));
    }
    r = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST", headers: { "Authorization": "Bearer " + key }, body: fd
    });
  } else {
    r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelo, prompt, size, quality: calidad, output_format: "png", n: 1 })
    });
  }
  if(!r.ok) return { error: `Generación falló (${r.status}): ${(await r.text()).slice(0, 300)}` };
  const j = await r.json();
  const b64 = j.data?.[0]?.b64_json;
  if(!b64) return { error: "La API no devolvió imagen." };

  /* Se guarda en el banco como activo "generado, pendiente de aprobación" para que
     un humano pueda promoverla o bloquearla; así el banco crece con cada campaña. */
  const id = uid("gen");
  const archivo = `generadas/${id}.png`;
  const destino = path.join(DIR.banco, empresa, archivo);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, Buffer.from(b64, "base64"));
  const idx = cargarIndice(empresa);
  idx.activos.push({ id, archivo, descripcion, etiquetas: tokens(descripcion), origen: "generada",
                     modelo, prompt, referencias: referencias.map(p => path.basename(p)),
                     uso: "pendiente", creado: new Date().toISOString() });
  escribirJson(rutaIndice(empresa), idx);
  return { ruta: destino, id, prompt, size };
}

/* ---------- fotos subidas por la persona ---------- */

const SUBIDAS = "_subidas";   // carpeta común para fotos adjuntadas en el chat antes de saber la empresa

/**
 * Guarda una foto que la persona adjuntó. Si se conoce la empresa, entra a su banco
 * como "pendiente" (se usa para esta pieza y queda a la espera de aprobación para reutilizarse);
 * si no, va a la carpeta común y solo se usa por asset_id.
 */
export async function guardarSubida({ empresa, nombre, base64, descripcion = "", conVector = false }){
  const ext = (path.extname(nombre || "").toLowerCase() || ".jpg").replace("jpeg", "jpg");
  if(![".jpg", ".png", ".webp"].includes(ext)) throw new Error("Formato no admitido: usa JPG, PNG o WEBP");
  const buf = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ""), "base64");
  if(buf.length < 1000) throw new Error("Archivo vacío o dañado");
  if(buf.length > 12 * 1024 * 1024) throw new Error("La foto pesa más de 12 MB");
  const carpeta = empresa || SUBIDAS;
  const id = "sub_" + uid().replace(/^[a-z]+_/, "");
  const archivo = path.join("subidas", id + ext);
  const destino = path.join(DIR.banco, carpeta, archivo);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, buf);
  const desc = descripcion || path.basename(nombre || "", ext).replace(/[-_]+/g, " ");
  const activo = { id, archivo, descripcion: desc, etiquetas: tokens(desc), origen: "subida",
                   nombre_original: nombre || null, uso: "pendiente", creado: new Date().toISOString() };
  if(conVector && env("VOYAGE_API_KEY")){ try{ activo.vector = await embeddingImagen(destino); }catch(e){ log("Sin vector para la subida:", e.message); } }
  const idx = cargarIndice(carpeta);
  idx.activos.push(activo);
  escribirJson(rutaIndice(carpeta), idx);
  return { id, empresa: empresa || null, archivo, descripcion: desc };
}

/** Busca un activo por id en el banco de la empresa y, si no está, en la carpeta común de subidas. */
export function buscarActivo(empresa, id){
  for(const carpeta of [empresa, SUBIDAS]){
    const a = cargarIndice(carpeta).activos.find(x => x.id === id);
    if(a) return { activo: a, ruta: path.join(DIR.banco, carpeta, a.archivo), carpeta };
  }
  return null;
}

/* ---------- resolución completa ---------- */

export async function resolverImagen(empresa, imagen, { ancho, alto } = {}){
  const procedencia = { politica: imagen?.politica || "banco_luego_generar", pasos: [] };
  if(!imagen || procedencia.politica === "ninguna") return { dataUrl: null, procedencia };
  const umbral = +env("UMBRAL_BANCO", 0.42);
  const dirEmpresa = path.join(DIR.banco, empresa);

  /* a) activo elegido explícitamente */
  if(imagen.asset_id){
    const hit = buscarActivo(empresa, imagen.asset_id);
    if(hit){
      procedencia.pasos.push({ paso: "asset_id", id: hit.activo.id, origen: hit.activo.origen });
      procedencia.origen = hit.activo.origen === "subida" ? "subida" : "banco"; procedencia.activo = hit.activo.id;
      return { dataUrl: aDataUrl(hit.ruta), procedencia };
    }
    procedencia.pasos.push({ paso: "asset_id", id: imagen.asset_id, error: "no existe; se continúa por descripción" });
  }

  const desc = imagen.descripcion || "";
  let mejores = [];

  /* b) banco */
  if(procedencia.politica !== "solo_generar" && desc){
    const { resultados, metodo } = await buscarEnBanco(empresa, desc, { n: 5 });
    mejores = resultados;
    procedencia.pasos.push({ paso: "banco", metodo, umbral,
      candidatos: resultados.map(r => ({ id: r.activo.id, puntaje: +r.puntaje.toFixed(3) })) });
    const top = resultados[0];
    if(top && top.puntaje >= umbral && top.activo.uso !== "pendiente"){
      procedencia.origen = "banco"; procedencia.activo = top.activo.id; procedencia.puntaje = +top.puntaje.toFixed(3);
      return { dataUrl: aDataUrl(path.join(dirEmpresa, top.activo.archivo)), procedencia };
    }
  }

  /* c) generación anclada a las fotos reales más parecidas */
  if(procedencia.politica !== "solo_banco"){
    const nRef = Math.max(0, Math.min(5, +env("REFERENCIAS_ESTILO", 3)));
    const refs = mejores.filter(r => r.activo.origen !== "generada").slice(0, nRef)
                        .map(r => path.join(dirEmpresa, r.activo.archivo));
    const g = await generarImagen(empresa, desc, { ancho, alto, evitar: imagen.evitar, referencias: refs });
    if(g.error){ procedencia.pasos.push({ paso: "generar", error: g.error }); }
    else{
      procedencia.pasos.push({ paso: "generar", id: g.id, size: g.size, referencias: refs.length });
      procedencia.origen = "generada"; procedencia.activo = g.id; procedencia.prompt = g.prompt;
      return { dataUrl: aDataUrl(g.ruta), procedencia };
    }
  }

  /* d) nada: se usa la mejor del banco aunque no llegue al umbral, y se avisa */
  if(mejores[0]){
    procedencia.origen = "banco_bajo_umbral"; procedencia.activo = mejores[0].activo.id;
    procedencia.puntaje = +mejores[0].puntaje.toFixed(3);
    procedencia.aviso = "Ninguna foto superó el umbral y no fue posible generar; se usó la más cercana. Revisar.";
    return { dataUrl: aDataUrl(path.join(dirEmpresa, mejores[0].activo.archivo)), procedencia };
  }
  /* e) el banco no coincide en nada: se usa una foto aprobada cualquiera antes que dejar la pieza vacía */
  const aprobadas = (cargarIndice(empresa).activos || []).filter(a => a.uso === "aprobado");
  if(aprobadas.length){
    const a = aprobadas[Math.floor(Math.random() * aprobadas.length)];
    procedencia.origen = "banco_sin_coincidencia"; procedencia.activo = a.id; procedencia.puntaje = 0;
    procedencia.aviso = "Ninguna foto del banco coincide con la descripción; se puso una foto aprobada al azar. Cambiarla en revisión.";
    return { dataUrl: aDataUrl(path.join(dirEmpresa, a.archivo)), procedencia };
  }
  procedencia.origen = "ninguna";
  procedencia.aviso = "No hay fotografía disponible. La pieza sale sin imagen.";
  return { dataUrl: null, procedencia };
}
