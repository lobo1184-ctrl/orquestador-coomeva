/* Prueba de humo sin servidor: node probar.js
   Envía una solicitud de ejemplo por todo el pipeline y deja las piezas en salidas/. */
import { validarSolicitud, crearSolicitud, procesar, resumenPublico } from "./lib/pipeline.js";
import { cerrarNavegador } from "./lib/render.js";

const solicitud = {
  empresa: "ejemplo",
  plantilla: "post_promo",
  formatos: ["post", "story", "banner"],
  contenido: {
    titular: "20% en el plan familiar",
    subtitular: "Hasta el 30 de septiembre en todas las sedes",
    cta: "Quiero el plan",
    legal: "Aplican términos y condiciones. Promoción válida hasta el 30 de septiembre de 2026."
  },
  por_formato: { story: { titular: "20% en tu plan familiar" } },
  imagen: { descripcion: "familia disfrutando en la piscina, luz natural de verano, alegría", politica: "solo_banco" },
  salida: { formato: "png", escala: 1 },
  solicitante: { nombre: "Prueba", canal: "api" }
};

const v = validarSolicitud(solicitud);
if(!v.ok){ console.error("Solicitud inválida:", v.errores); process.exit(1); }
const s = crearSolicitud(solicitud);
console.log("Solicitud", s.id);
const r = await procesar(s.id);
console.log(JSON.stringify(resumenPublico(r), null, 2));
await cerrarNavegador();
process.exit(r.estado === "lista" ? 0 : 1);
