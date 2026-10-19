# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Dev server:** `pnpm dev` (ts-node-dev con auto-restart, puerto 8130)
- **Build:** `pnpm build` (tsc → `dist/`)
- **Start prod:** `pnpm start`
- **Format:** `pnpm format` (Prettier)
- **Seed admin:** `pnpm seed:admin`
- **No hay linter ni tests.** `pnpm build` es la única verificación.

## Tech Stack

- Express 5 + TypeScript (CommonJS, target ES2024)
- MongoDB via Mongoose (`DB_URI`)
- JWT Bearer (`JWT_SECRET`, 30 días)
- Resend para correo (opcional: sin key no envía)
- Vercel: `api/index.ts` es la función; `vercel.json` reescribe todo a `/api`

## Architecture

### Request Flow

`Express app → CORS → JSON parser (50mb) → /api router → handlers → globalErrorHandler`

### Layered Structure

- **Routes** (`src/routes/`) — definen endpoints, aplican `authMiddleware`, delegan al controller
- **Controllers** (`src/controllers/`) — parsean req, llaman al service, responden. Sin lógica de negocio.
- **Services** (`src/services/`) — lógica de negocio y APIs externas. Lanzan `CustomError`.
- **Models** (`src/models/`) — schemas Mongoose

### Key Patterns

- **Env:** solo `src/config/env.ts` lee `process.env`. No lo leas en otro archivo.
- **Errores:** `throw new CustomError("Mensaje en español", 404)`; `globalErrorHandler` responde `{ message }` y avisa a Slack en 5xx.
- **Auth:** `authMiddleware` verifica el Bearer y deja `req.user` (`AuthRequest`). Gates de rol van después (`adminMiddleware`).
- **Respuestas:** cuerpo desnudo (`res.json(item)`), paginación `{ items, total, page, pages }`, login `{ token, user }`.
- **Mongo serverless:** `dbConnect()` cachea la promesa; nunca `process.exit` en Vercel.

## Convenciones

- Comillas dobles, punto y coma, 2 espacios. Prettier lo aplica.
- Exports nombrados. La única excepción son los routers (`export default router`).
- Archivos camelCase + sufijo con punto: `product.controller.ts`, `product.routes.ts`, `product.service.ts`, `product.model.ts`, `auth.middleware.ts`.
- Controllers se importan como namespace: `import * as productController from "../controllers/product.controller"`.
- Identificadores genéricos en inglés; dominio, comentarios, mensajes y commits en español.
- Comentarios explican el porqué, no el qué.

## Modos de lectura

- Tres miradas (reunión del 13/10/2026): `noboista`, `correista`, `independiente`. `anti_ambos` ya no existe; `parseMode` lo lleva a independiente.
- Pesos, modos y posturas en `src/config/modes.ts`. Agregar un modo = una fila en `MODE_WEIGHTS` (y en `FRAMED_MODES` si tiene encuadre).
- `lens.service.ts`: la IA solo clasifica (presencia de orillas, solidez, documentos, contradicción, postura por fuente); `computeRelevance` saca los números por modo.
- Definición (Andersson, 13/10): el noboísta no tuerce los hechos pero va primero a los que reafirman la narrativa oficial; el correísta busca la visión de la oposición; el independiente equilibra ambos. La lente mide `refuerzaOficial` y `refuerzaOposicion` (0–10) y pesan fuerte en `MODE_WEIGHTS`. "Las 5 cosas" sale entera del orden del modo.
- `framing.service.ts`: noboísta y correísta tienen su titular, entrada, "Por qué importa", detalles y cuerpo (`article.framing`, `FRAMING_VERSION`; subirla hace que el cron rehaga las notas recientes). Si el cuerpo no pasa el verificador se descarta solo el cuerpo. Independiente es el texto base. Cada encuadre se verifica contra la nota base: si trae una cifra o un nombre que la nota no tiene, se descarta. Se encuadra al publicar (o en el cron, `framingService.backfill`). `toCard(doc, mode)` y `applyFraming` lo aplican en el API público.
- `modeRelevanceAuto` (propuesta) + `modeRelevance` corregida por la Mesa = par del golden set (`/admin/modes/golden`).
- El modo del lector vive en su navegador. En el servidor solo hay contadores anónimos (`ModeMetric`, `viewsByMode`) y, con consentimiento separado, el modo cifrado del suscriptor (`readingModeSealed`, AES-GCM con `MODE_ENCRYPTION_KEY`), que no sale nunca en el API.

## Criterio editorial y cobertura

- `NEWS_CRITERIA` (anthropic.service) es la lista del fundador de qué es y qué no es noticia; la usan el redactor y el valorador. Jev tiene la pregunta `vetado` (narco vago contra Correa/Noboa, vida sexual sin delito).
- Solo `COVERED_SECTIONS` (política, economía, Asamblea, seguridad, negocios): lo demás se descarta al valorar.
- El redactor devuelve `followUps` ("patitas" de la noticia) para la Mesa; nunca salen al público.

## Fuentes y costo

- Repositorio de fuentes en un Google Sheet publicado como CSV (`SOURCES_SHEET_CSV_URL`), sincronizado cada hora (`/api/cron/sources`) o desde el panel. Plantilla y carga inicial: `docs/fuentes-otr.csv` + `pnpm sources:import`. El sync solo toca fuentes con `fromSheet`.
- `sourceSchedule.service.ts`: RSS en cada ciclo; búsquedas de Perplexity según `everyMinutes` (o `AI_SOURCE_EVERY_MINUTES` / `PEOPLE_EVERY_MINUTES`), las más atrasadas primero y con tope `MAX_AI_QUERIES_PER_RUN`. Las personas sin consulta se buscan de a 5 en una sola búsqueda.

## OTR PRO

- `ProTeaser`: tráiler de una nota PRO para la portada gratuita (la IA lo arma desde el texto pegado; `sourceText` nunca sale en el API). `GET /api/pro/teasers`.
- `ProLead`: empresa interesada (plan semanal/diario, pide reunión). Avisa por correo a `ADMIN_EMAIL`. `POST /api/pro/leads`.

## Fotos

- `imageReview.service.ts` valora la foto (lenguajes visuales: documental, archivo, grafico, generica) mirando la imagen con la IA. La redacción la valora antes de publicar y prueba otra fuente si es genérica; el cron revisa las recientes. La IA nunca genera ni altera imágenes.

## La mesa por dentro (portal de entrenamiento)

- `/admin/mesa` en el front. `training.service.ts`: `live()` cuenta qué hizo cada agente (salud de IA y Perplexity leída de los errores de los últimos ciclos, fuentes, embudo, señales con el porqué de cada decisión); `tryHeadline()` valora un titular como el ciclo, sin guardar.
- `Lesson` (`lesson.service.ts`): instrucciones de la Mesa en lenguaje normal por área (`general`, `valoracion`, `redaccion`, `modos`, `fotos`). `callJson({ area })` las suma al prompt de sistema; Jev las recibe en el estado como `instrucciones_de_la_mesa` y responde `mesa_no` / `mesa_si` (sí fuerza el umbral, no descarta). Caché de 60 s por instancia.
- Corregir una señal desde el panel crea una lección `valoracion` con el caso de ejemplo.
- Comportamiento base de los agentes (`config/agents.ts` + `AgentConfig`, `agentConfig.service.ts`): valorador, redactor, modos y fotos en secciones de reglas que la Mesa edita, agrega, quita y restaura desde `/admin/mesa/agentes`. Los prompts se arman con `agentConfig.bullets(agente, sección)`; fijos en código quedan los formatos del esquema JSON y "no inventar datos". Jev recibe `criterio_de_otr` en el estado y la pregunta `vetado` lo usa.

## Conector de gerencia (MCP)

- `POST /api/mcp/:token`: servidor MCP sin sesiones (Streamable HTTP, respuesta JSON) para que la gerencia pida cambios desde Claude. La llave va en la URL porque claude.ai no deja poner encabezados en un conector propio; se guarda solo su hash (`McpAccess`).
- Acceso: solo cuentas admin en `MCP_ALLOWED_EMAILS`. Panel en `/admin/conector` (front): generar, rotar y apagar la llave, guía y bitácora (`McpChange`).
- `github.service.ts`: lee, busca y commitea directo a `main` de los dos repos con `GITHUB_TOKEN`. Sin force. `PROTECTED` bloquea `.env`, `.github/`, `env.ts`, middlewares de auth y el propio conector.
- Cada commit avisa por correo a `MCP_NOTIFY_EMAILS`. `deshacer_ultimo_cambio` solo deshace el último commit de main.
- `registerTool` se llama sin inferir tipos (`register()` en `mcp.service.ts`): la inferencia del SDK sobre zod deja a tsc sin memoria.
