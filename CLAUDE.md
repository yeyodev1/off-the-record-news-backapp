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
- `framing.service.ts`: noboísta y correísta tienen su titular, entrada y "Por qué importa" (`article.framing`). Independiente es el texto base. Cada encuadre se verifica contra la nota base: si trae una cifra o un nombre que la nota no tiene, se descarta. Se encuadra al publicar (o en el cron, `framingService.backfill`). `toCard(doc, mode)` y `applyFraming` lo aplican en el API público.
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
