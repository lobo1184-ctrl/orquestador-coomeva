# Arquitectura: cerebro → orquestador → consola de diseño → cerebro

## La decisión sobre fotografía

Las tres opciones que planteaste no compiten: son tres capas de una misma política, y la respuesta correcta es **las tres, en este orden**.

| Capa | Qué resuelve | Qué no resuelve |
|---|---|---|
| **1. Banco por empresa** con búsqueda semántica | Fidelidad de marca real (personas, sedes, uniformes, luz), derechos ya negociados, coste cero por pieza, velocidad | Pide mantenimiento: si el banco no tiene "piscina en la noche", no aparece |
| **2. Generación anclada al banco** (`gpt-image-2` con hasta 5 fotos reales como referencia) | Cubrir lo que el banco no tiene sin salirse del estilo de la marca | Derechos de imagen de personas "inventadas", riesgo de artefactos, coste por imagen, siempre exige un ojo humano |
| **3. Curaduría humana** en la bandeja de revisión | Que lo generado se apruebe o se bloquee, y que lo aprobado vuelva al banco | Nada: es la red de seguridad |

Por qué no "solo generador": una marca como una cooperativa financiera comunica con **sus** afiliados, **sus** sedes, **sus** uniformes. Un generador, por bueno que sea, produce gente genérica en lugares genéricos. Y las políticas de una marca regulada suelen prohibir mostrar personas que no existen como si fueran clientes.

Por qué no "solo banco": el cerebro va a pedir cosas que nadie fotografió. Sin el escalón 2, la solicitud se frena y vuelve a la persona con "no hay foto", que es justo lo que el sistema quería evitar.

**Lo que hace el resolvedor** (`lib/imagenes.js`), en orden:
1. Si el solicitante adjuntó o eligió una foto concreta (`asset_id`, que puede ser `img_…` del banco o `sub_…` subida en el chat o la bandeja), esa. Lo subido para una empresa entra a su banco como pendiente: se usa en esa pieza y espera aprobación para reutilizarse.
2. Busca en el banco de la empresa con la descripción en español. Si hay `VOYAGE_API_KEY`, la búsqueda es semántica (texto contra imágenes en el mismo espacio vectorial: "familia en piscina" encuentra una foto de familia en piscina aunque el archivo se llame `IMG_4021.jpg`). Sin clave, busca por palabras contra descripciones y etiquetas.
3. Si la mejor candidata supera el umbral (`UMBRAL_BANCO`), se usa. Queda registrado el puntaje.
4. Si no, y la política lo permite, genera con `gpt-image-2` pasando las 3 fotos reales más parecidas como referencia de estilo (`/images/edits` con varias imágenes). El prompt incorpora la política de fotografía de la marca (`banco/<empresa>/politica.json`). La imagen generada entra al banco como **pendiente**: no se reutiliza sola hasta que alguien la apruebe.
5. Si tampoco se puede generar, usa la mejor del banco aunque no llegue al umbral y lo dice en voz alta en el control de calidad.

Cada solicitud guarda la **procedencia** completa: qué se buscó, qué candidatas hubo, con qué puntaje, si se generó y con qué prompt. Eso es lo que permite auditar una pieza seis meses después.

### Costos y umbrales, para que calibres
- Embeddings: se calcula un vector por foto una sola vez al ingestar, y uno por consulta. Costo despreciable.
- Generación: entre centavos y algunas décimas de dólar por imagen según calidad y tamaño. `CALIDAD_IMAGEN=medium` es el punto razonable para redes.
- `UMBRAL_BANCO=0.42` es un punto de partida. Súbelo si el sistema entrega fotos poco relacionadas; bájalo si genera demasiado. Míralo en la bandeja de revisión durante las primeras semanas: cada pieza muestra la similitud obtenida.

## El flujo completo

```
persona ──(entrevista)──► CEREBRO ──POST /solicitudes──► ORQUESTADOR ──► resolver foto
   ▲                        │  ◄── {id} inmediato            │             (banco → generar)
   │                        │                                 ▼
   │                        │                             MOTOR v6 en Chromium sin pantalla
   │                        │                             (mismo código que "Descargar")
   │                        │                                 │
   └──(piezas + QA)────────┘ ◄──GET /solicitudes/{id}────────┘  (o POST a callback_url)
```

Dos cosas del diseño que importan:

**Es asíncrono a propósito.** Las Actions de un GPT y cualquier chat tienen un tiempo de espera corto; una pieza con foto generada puede tardar 60–90 s. Por eso `POST /solicitudes` responde en milisegundos con un ticket, y el cerebro consulta el estado. Si el cerebro es el web propio (`/`), el navegador vigila el ticket y pinta la hoja de contactos en cuanto está; si es un GPT, consulta cuando la persona escribe.

**La consola no cambió.** El orquestador abre tu `motor-render-piezas-v6.html` tal cual en Chromium sin pantalla, carga la plantilla, inyecta contenido y foto, y llama a la misma función `capture()` que usa el botón Descargar. Lo que exporta un diseñador a mano y lo que exporta el robot es byte a byte el mismo código. Cuando mejores el motor, el orquestador hereda la mejora sin tocar nada.

## El contrato (JSON)

`schema/solicitud.schema.json` es la única frontera entre cerebro y consola. Lo esencial:

```json
{
  "empresa": "coomeva_recreacion",
  "plantilla": "post_promo",
  "formatos": ["post", "story"],
  "contenido": { "titular": "…", "subtitular": "…", "cta": "…", "legal": "…" },
  "por_formato": { "story": { "titular": "versión corta" } },
  "imagen": { "descripcion": "familia en piscina, luz natural, alegría", "politica": "banco_luego_generar" },
  "salida": { "formato": "png", "escala": 2 },
  "callback_url": null
}
```

Las claves de `contenido` son las de los **campos** de la plantilla (las que creas en la consola: titular, precio, vigencia…). `plantilla` es una clave semántica (`post_promo`), no un archivo. `GET /catalogo` le dice al cerebro exactamente qué claves existen para que nunca invente.

## Dos cerebros posibles

1. **GPT personalizado (ChatGPT).** Pegas `cerebro/instrucciones.md` como instrucciones y `https://tu-dominio/openapi.yaml` como Action con autenticación por API key (`X-API-Key`). El GPT entrevista, envía, consulta y muestra las URLs de las piezas. Limitación: necesita que el servidor tenga dominio público con HTTPS, y el GPT solo consulta cuando la persona escribe.
2. **Cerebro web propio** (`http://tu-servidor/`). Mismo protocolo de entrevista, pero corre en tu servidor con la Responses API de OpenAI y las funciones del orquestador como herramientas. Ventajas: sin límite de tiempo, la pieza aparece sola en el chat, puedes ponerle tu marca, y funciona sin exponer nada a internet (intranet). Es el que recomiendo para operar.

Ambos usan el mismo texto de instrucciones, así que el comportamiento es idéntico.

## Límites que conviene saber

- **Fuentes.** El motor carga Google Fonts. En un servidor sin salida a internet, las piezas salen con fuentes de respaldo. Solución definitiva: descargar las familias de la marca (Goldplay o la que sea) y referenciarlas con `@font-face` desde `motor/fuentes/`.
- **html2canvas.** Sigue siendo el rasterizador. Ya se sirve desde `node_modules`, así que no depende del CDN. Sus puntos ciegos son los mismos de la consola: `clip-path` y algunas sombras.
- **Generación.** `gpt-image-2` exige verificación de organización en OpenAI. Las imágenes generadas siempre nacen "pendientes"; que una persona las apruebe no es un paso opcional del proceso, es la política.
- **Concurrencia.** Las solicitudes se procesan de una en una en un solo Chromium. Para decenas de piezas por minuto se pondrían varios procesos detrás de una cola (Redis/BullMQ); el código ya está separado para eso (`encolar` → `procesar`).
- **Piezas públicas por URL.** Las descargas no piden clave para que ChatGPT pueda mostrarlas en línea. El id es imposible de adivinar, pero si la política de la empresa lo exige, añade `auth` a `/piezas` y sirve las imágenes solo al cerebro web.

## Bancos externos (Shutterstock / Getty), si se quiere después

Ambos tienen API oficial con historial de licencias y búsqueda por texto. No se conectan con usuario y contraseña sino con acceso a la API ligado a la cuenta corporativa (hay que pedirlo al ejecutivo de cuenta). Encajaría como un escalón entre el banco propio y la generación: buscar primero en lo ya licenciado (costo cero) y, si no hay nada, proponer una del catálogo para licenciar con aprobación humana. No está construido; el punto de enganche es `buscarEnBanco` en `lib/imagenes.js`.

## Próximos pasos naturales

1. Reemplazar el banco de ejemplo por fotos reales de cada empresa y ejecutar `node ingestar.js <empresa> <carpeta>` con `VOYAGE_API_KEY` y `MODELO_VISION` puestos: cada foto queda descrita y vectorizada sola.
2. Guardar desde la consola una plantilla por arquetipo en `plantillas/<empresa>/<clave>.json`.
3. Escribir `banco/<empresa>/politica.json` con el estilo fotográfico y lo prohibido de cada marca.
4. Poner el servidor detrás de HTTPS (Caddy o nginx) y conectar el GPT, o usar el cerebro web directamente.
