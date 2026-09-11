# Consola de diseño · orquestador

Recibe solicitudes del agente cerebro, consigue la fotografía, produce las piezas con el motor v6 y las devuelve. Lee `ARQUITECTURA.md` para entender las decisiones; esto es para ponerlo a andar.

## Requisitos
- Node.js 20 o superior (https://nodejs.org).
- Un Chrome/Chromium. Si no tienes, el paso 2 lo descarga.

## Ponerlo en marcha (10 minutos)

```bash
# 1. dependencias
npm install

# 2. navegador sin pantalla (una sola vez). Si ya tienes Chrome, en vez de esto pon su ruta en RUTA_CHROMIUM del .env
npm run instalar-navegador

# 3. configuración
cp .env.ejemplo .env      # en Windows: copy .env.ejemplo .env
#   edita .env: pon API_KEY_ORQUESTADOR (cualquier clave larga) y, si las tienes, OPENAI_API_KEY y VOYAGE_API_KEY

# 4. prueba sin servidor: produce tres piezas con el banco de ejemplo
npm run probar
#   las piezas quedan en salidas/<id>/

# 5. servidor
npm start
#   http://localhost:3000          → cerebro web (pedir una pieza)
#   http://localhost:3000/revision → bandeja de revisión
```

Sin ninguna clave de API el sistema funciona: busca fotos por palabras y no genera imágenes. Con `VOYAGE_API_KEY` la búsqueda pasa a ser semántica. Con `OPENAI_API_KEY` se activan la generación de fotos y el cerebro web.

## Estructura

```
motor/       motor-render-piezas-v6.html   ← tu consola, sin cambios; el orquestador la usa tal cual
plantillas/  <empresa>/<clave>.json        ← lo que guardas con "Descargar .json" en la consola
banco/       <empresa>/fotos/*.jpg         ← fotografía real de cada marca
             <empresa>/indice.json         ← lo crea `node ingestar.js`
             <empresa>/politica.json       ← estilo fotográfico y prohibiciones (para generar)
             <empresa>/generadas/          ← lo que generó la IA, pendiente de aprobación
solicitudes/ una ficha por solicitud (estado, eventos, procedencia de la foto)
salidas/     <id>/*.png                    ← las piezas
cerebro/     instrucciones.md (prompt del agente) · openapi.yaml (Action del GPT)
schema/      solicitud.schema.json         ← el contrato
lib/         imagenes.js · render.js · pipeline.js · cerebro.js · comun.js
public/      index.html (cerebro web) · revision.html (bandeja)
```

## Agregar una empresa

1. Crea `plantillas/<empresa>/` y guarda ahí los `.json` de la consola. El nombre del archivo es la clave de plantilla (`post_promo.json`, `evento.json`…).
2. Pon sus fotos en una carpeta y ejecuta `node ingestar.js <empresa> <carpeta>`. Vuelve a ejecutarlo cada vez que agregues fotos: solo procesa las nuevas.
3. Copia `banco/ejemplo/politica.json` a `banco/<empresa>/` y ajústalo.
4. Reinicia el servidor. El cerebro la verá en el catálogo.

La clave de empresa va en minúsculas y sin espacios: `coomeva_recreacion`, `bancoomeva`.

## De dónde sale la foto de cada pieza

Tres caminos, siempre en este orden:
1. **La foto que adjunta la persona.** En el chat, con el clip (o pegándola, o arrastrándola). Se usa tal cual en esa pieza.
2. **El banco de la empresa.** Si nadie adjuntó, la consola busca la que más se parece a la descripción. Para alimentarlo: carpeta `banco/<empresa>/fotos/` + `node ingestar.js <empresa>`, o el botón *Subir fotos al banco* en la bandeja de revisión (quedan pendientes hasta que alguien las apruebe ahí mismo).
3. **Generada con IA.** Solo si el banco no tiene nada parecido y `politica.json` lo permite; usa fotos reales del banco como referencia. Lo generado queda pendiente de aprobación en la bandeja. Requiere `OPENAI_API_KEY` y que la organización esté verificada en OpenAI.

En el chat se puede forzar: "usa solo el banco", "genera la imagen", "muéstrame opciones del banco".

## Conectar el GPT personalizado

1. El servidor debe estar en una URL pública con HTTPS (`URL_PUBLICA` en el `.env`).
2. En ChatGPT → Crear GPT → Instrucciones: pega `cerebro/instrucciones.md`.
3. Acciones → Importar desde URL: `https://tu-dominio/openapi.yaml`. Autenticación: API Key, tipo Custom, nombre de cabecera `X-API-Key`, valor el de tu `.env`.
4. Prueba: "Necesito un post para el 20% del plan familiar hasta el 30 de septiembre".

## La API, por si conectas otra cosa (Slack, n8n, un formulario)

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/catalogo` | empresas, plantillas, campos, formatos |
| GET | `/banco/{empresa}?q=texto` | buscar fotos |
| POST | `/solicitudes` | crear; responde `202 {id}` |
| GET | `/solicitudes/{id}` | estado, piezas, control de calidad, procedencia de la foto |
| POST | `/banco/{empresa}/{id}/uso` | `{"uso":"aprobado"}` o `"bloqueado"` |
| POST | `/subidas` | subir una foto (`{nombre, base64, empresa?, descripcion?}`); devuelve `id` para usar en `imagen.asset_id` |

Todas con cabecera `X-API-Key`. Si en la solicitud pones `callback_url`, al terminar se hace POST ahí con el mismo objeto que devuelve `GET /solicitudes/{id}`.

## Problemas frecuentes
- **"Falta motor/motor-render-piezas-v6.html"**: copia ahí tu consola (ya viene incluida; si la actualizas, reemplázala).
- **Las piezas salen con otra tipografía**: el servidor no llega a Google Fonts. Ver "Fuentes" en `ARQUITECTURA.md`.
- **"Executable doesn't exist"** al renderizar: ejecuta `npm run instalar-navegador` o pon `RUTA_CHROMIUM`.
- **En ChatGPT no puedo adjuntar fotos**: las Actions no envían archivos. Súbelas desde el cerebro web o la bandeja y dile al GPT el `id` que te devuelve.
- **El cerebro web dice que falta la clave**: `OPENAI_API_KEY` en el `.env`. Mientras tanto usa el GPT.
