import crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { McpAccess } from "../models/mcpAccess.model";
import { McpChange, MCP_REPOS, McpRepo } from "../models/mcpChange.model";
import { User } from "../models/user.model";
import { layout, sendEmail } from "./email.service";
import * as githubService from "./github.service";

/**
 * Conector de gerencia: un servidor MCP para que la gerencia, desde Claude,
 * cambie el sitio y la mesa pidiéndolo en lenguaje normal. Lee y commitea en
 * los repos del back y el front; cada commit va a main (despliega solo), queda
 * en la bitácora y se avisa por correo a MCP_NOTIFY_EMAILS.
 */

const INSTRUCTIONS = `Conector de Off the Record (otr.com.ec) para la gerencia. Edita el código del sitio con commits directos a la rama main de GitHub; cada commit se despliega solo en Vercel en 1 o 2 minutos.

Repos:
- "front": el sitio otr.com.ec (Vue 3 + Vite + TypeScript + Pinia + SCSS).
- "back": la API y la mesa de redacción automática (Express 5 + Mongoose + TypeScript).

Antes de cambiar nada:
1. Lee CLAUDE.md del repo que vas a tocar y respeta sus convenciones.
2. Ubica el archivo con "buscar" o "ver_archivos" y léelo completo con "leer_archivo".
3. Explica a la persona qué vas a cambiar, en lenguaje sencillo, y espera su confirmación.

Reglas:
- Los textos del sitio viven en src/config/site.ts del front (y los del panel en src/config/admin.ts). Cambia el texto ahí, no en el componente.
- Un archivo .vue no pasa de 300 líneas: si crece, sepáralo en componentes.
- Comillas y estilo como el archivo que editas. Mensajes de commit en español, en presente, que digan qué cambia para el lector ("feat: ...", "fix: ...").
- Un cambio por commit. Para varios archivos de un mismo cambio, usa un solo "guardar_cambios".
- Prefiere "ediciones" (buscar y reemplazar exacto) a reescribir un archivo entero.
- El comportamiento de los agentes (qué es noticia, cómo se redacta, los modos, las fotos) se ajusta mejor desde el panel: otr.com.ec/admin/mesa/agentes y /admin/mesa. Las fuentes, desde la Google Sheet de fuentes. Sugiérelo antes de tocar código para eso.
- Después de guardar, revisa "estado_del_despliegue" hasta que diga success. Si falla, lee el error, corrige con un cambio nuevo o usa "deshacer_ultimo_cambio".
- No inventes datos, cifras ni nombres en el contenido del sitio.
- Archivos protegidos (secretos, CI y este conector) no se pueden leer ni cambiar.`;

const repoSchema = z.enum(MCP_REPOS).describe('"front" (sitio otr.com.ec) o "back" (API y mesa)');

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

function failure(error: unknown) {
  return { ...text(`Error: ${(error as Error).message}`), isError: true };
}

// ——— Llaves de acceso

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export function canUse(email: string | undefined | null): boolean {
  return !!email && env.MCP_ALLOWED_EMAILS.includes(email.toLowerCase());
}

function connectorUrl(token: string): string {
  const base = (env.PUBLIC_API_URL || "https://off-the-record-news-backapp.vercel.app").replace(
    /\/(api\/?)?$/,
    "",
  );
  return `${base}/api/mcp/${token}`;
}

function assertAllowed(email: string) {
  if (!canUse(email)) throw new CustomError("Esta cuenta no tiene acceso al conector", 403);
}

export async function status(user: { userId: string; email: string }) {
  assertAllowed(user.email);
  const [access, changes] = await Promise.all([
    McpAccess.findOne({ user: user.userId, revokedAt: null }).sort({ createdAt: -1 }),
    McpChange.find().sort({ createdAt: -1 }).limit(30),
  ]);
  return {
    access: access ? access.toJSON() : null,
    ready: !!env.GITHUB_TOKEN,
    repos: githubService.REPO_LABELS,
    changes,
  };
}

/** Genera una llave nueva y apaga las anteriores de esa cuenta. La URL se ve solo esta vez. */
export async function rotate(user: { userId: string; email: string }) {
  assertAllowed(user.email);
  await McpAccess.updateMany({ user: user.userId, revokedAt: null }, { revokedAt: new Date() });
  const token = `otr_${crypto.randomBytes(24).toString("base64url")}`;
  const access = await McpAccess.create({
    user: user.userId,
    email: user.email,
    tokenHash: hash(token),
    tokenHint: token.slice(-4),
  });
  return { access: access.toJSON(), url: connectorUrl(token) };
}

export async function revoke(user: { userId: string; email: string }) {
  assertAllowed(user.email);
  await McpAccess.updateMany({ user: user.userId, revokedAt: null }, { revokedAt: new Date() });
}

/** La llave vale mientras no esté apagada, la cuenta siga activa y siga en la lista. */
export async function authenticate(token: string): Promise<string | null> {
  if (!/^otr_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const access = await McpAccess.findOne({ tokenHash: hash(token), revokedAt: null });
  if (!access || !canUse(access.email)) return null;
  const user = await User.findById(access.user).select("isActive accountType");
  if (!user?.isActive || user.accountType !== "admin") return null;
  await McpAccess.updateOne({ _id: access._id }, { lastUsedAt: new Date() });
  return access.email;
}

// ——— Bitácora y aviso

async function record(
  email: string,
  repo: McpRepo,
  kind: "cambio" | "deshacer",
  commit: githubService.CommitInfo,
  files: string[],
) {
  await McpChange.create({
    email,
    repo,
    kind,
    message: commit.message,
    sha: commit.sha,
    url: commit.url,
    files,
  });
  const to = env.MCP_NOTIFY_EMAILS;
  if (!to.length) return;
  const label = kind === "deshacer" ? "deshizo un cambio" : "hizo un cambio";
  const body = `
    <p><b>${email}</b> ${label} en <b>${githubService.REPO_LABELS[repo]}</b> desde el conector de gerencia.</p>
    <p style="font-size:16px"><b>${escapeHtml(commit.message)}</b></p>
    <p>Archivos:</p>
    <ul>${files.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join("")}</ul>
    <p><a href="${commit.url}">Ver el commit en GitHub</a></p>`;
  await Promise.all(
    to.map((address) =>
      sendEmail(
        address,
        `OTR · ${label}: ${commit.message.slice(0, 80)}`,
        layout("Cambio desde el conector", body),
      ),
    ),
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

// ——— Herramientas

const editSchema = z.object({
  buscar: z.string().min(1).describe("Texto exacto que hoy está en el archivo (una sola vez)"),
  reemplazar: z.string().describe("Texto que lo reemplaza"),
});

const fileSchema = z.object({
  ruta: z.string().min(1).describe("Ruta dentro del repo, por ejemplo src/config/site.ts"),
  ediciones: z.array(editSchema).optional().describe("Buscar y reemplazar exacto, en orden"),
  contenido: z
    .string()
    .optional()
    .describe("Contenido completo del archivo (para archivos nuevos)"),
  borrar: z.boolean().optional().describe("true para borrar el archivo"),
});

interface FileArgs {
  ruta: string;
  ediciones?: { buscar: string; reemplazar: string }[];
  contenido?: string;
  borrar?: boolean;
}

/** Aplica buscar/reemplazar sobre la versión actual de main. Cada búsqueda debe aparecer una sola vez. */
async function resolveChange(repo: McpRepo, file: FileArgs): Promise<githubService.FileChange> {
  if (file.borrar) return { path: file.ruta, delete: true };
  if (file.ediciones?.length) {
    let content = await githubService.readFile(repo, file.ruta);
    for (const edit of file.ediciones) {
      const count = content.split(edit.buscar).length - 1;
      if (count !== 1) {
        throw new CustomError(
          `En ${file.ruta}, el texto a buscar aparece ${count} veces (debe ser 1): "${edit.buscar.slice(0, 80)}"`,
          400,
        );
      }
      content = content.replace(edit.buscar, () => edit.reemplazar);
    }
    return { path: file.ruta, content };
  }
  if (typeof file.contenido === "string") return { path: file.ruta, content: file.contenido };
  throw new CustomError(`Para ${file.ruta} manda "ediciones", "contenido" o "borrar"`, 400);
}

/**
 * registerTool con esquemas zod revienta la memoria de tsc (inferencia del SDK
 * sobre zod 3): se registra sin inferir y cada handler declara su tipo.
 */
function register<T>(
  server: McpServer,
  name: string,
  config: Record<string, unknown>,
  handler: (args: T) => Promise<unknown>,
) {
  (server as any).registerTool(name, config, handler);
}

type RepoArgs = { repo: McpRepo };

export function buildServer(email: string): McpServer {
  const server = new McpServer(
    { name: "otr-gerencia", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  register<RepoArgs & { carpeta?: string }>(
    server,
    "ver_archivos",
    {
      title: "Ver archivos",
      description: "Lista los archivos de un repo, opcionalmente dentro de una carpeta.",
      inputSchema: {
        repo: repoSchema,
        carpeta: z.string().optional().describe("Por ejemplo src/views"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, carpeta }) => {
      try {
        const files = await githubService.listFiles(repo, carpeta ?? "");
        return text(
          files.filter((f) => !githubService.isProtected(repo, f)).join("\n") || "(vacío)",
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  register<RepoArgs & { ruta: string }>(
    server,
    "leer_archivo",
    {
      title: "Leer archivo",
      description: "Devuelve el contenido actual de un archivo en main.",
      inputSchema: { repo: repoSchema, ruta: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, ruta }) => {
      try {
        return text(await githubService.readFile(repo, ruta));
      } catch (error) {
        return failure(error);
      }
    },
  );

  register<RepoArgs & { texto: string; carpeta?: string }>(
    server,
    "buscar",
    {
      title: "Buscar en el código",
      description:
        "Busca un texto (sin distinguir mayúsculas) en los archivos del repo y devuelve archivo, línea y contenido. Sirve para encontrar dónde está un texto del sitio.",
      inputSchema: {
        repo: repoSchema,
        texto: z.string().min(2),
        carpeta: z.string().optional().describe("Acota la búsqueda, por ejemplo src"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, texto, carpeta }) => {
      try {
        const hits = await githubService.search(repo, texto, carpeta ?? "");
        return text(
          hits.length
            ? hits.map((h) => `${h.path}:${h.line}  ${h.text}`).join("\n")
            : "Sin resultados",
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  register<RepoArgs & { cantidad?: number }>(
    server,
    "ultimos_cambios",
    {
      title: "Últimos cambios",
      description: "Los commits más recientes de main en un repo.",
      inputSchema: { repo: repoSchema, cantidad: z.number().int().min(1).max(30).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, cantidad }) => {
      try {
        return text(await githubService.recentCommits(repo, cantidad ?? 10));
      } catch (error) {
        return failure(error);
      }
    },
  );

  register<RepoArgs & { mensaje: string; archivos: FileArgs[] }>(
    server,
    "guardar_cambios",
    {
      title: "Guardar cambios",
      description:
        "Hace un commit a main con uno o más archivos y lo despliega. Confirma con la persona antes de usarla. Cada archivo lleva 'ediciones' (buscar/reemplazar exacto, recomendado), 'contenido' completo o 'borrar'.",
      inputSchema: {
        repo: repoSchema,
        mensaje: z
          .string()
          .min(8)
          .max(200)
          .describe('Mensaje del commit en español, ej. "fix: corrige el titular de la portada"'),
        archivos: z.array(fileSchema).min(1).max(20),
      },
      annotations: { destructiveHint: true },
    },
    async ({ repo, mensaje, archivos }) => {
      try {
        const changes = [];
        for (const file of archivos) changes.push(await resolveChange(repo, file));
        const message = `${mensaje.trim()}\n\nPedido por ${email} desde el conector de gerencia.`;
        const commit = await githubService.commitFiles(repo, message, changes);
        commit.message = mensaje.trim();
        await record(
          email,
          repo,
          "cambio",
          commit,
          changes.map((c) => c.path),
        );
        return text({
          guardado: true,
          commit: commit.sha.slice(0, 7),
          url: commit.url,
          siguiente: "Revisa estado_del_despliegue en 1 o 2 minutos.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  register<RepoArgs & { commit?: string }>(
    server,
    "estado_del_despliegue",
    {
      title: "Estado del despliegue",
      description:
        "Cómo va el deploy en Vercel de un commit (por defecto, el último de main): pending, success o failure.",
      inputSchema: { repo: repoSchema, commit: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ repo, commit }) => {
      try {
        return text(await githubService.deployStatus(repo, commit));
      } catch (error) {
        return failure(error);
      }
    },
  );

  register<RepoArgs & { commit: string; motivo: string }>(
    server,
    "deshacer_ultimo_cambio",
    {
      title: "Deshacer el último cambio",
      description:
        "Vuelve main al estado anterior al último commit (solo si es el último). Confirma con la persona antes de usarla.",
      inputSchema: {
        repo: repoSchema,
        commit: z.string().min(7).describe("Sha del último commit, de ultimos_cambios"),
        motivo: z.string().min(4).max(200),
      },
      annotations: { destructiveHint: true },
    },
    async ({ repo, commit, motivo }) => {
      try {
        const message = `revert: ${motivo.trim()}`;
        const result = await githubService.revertHead(
          repo,
          commit,
          `${message}\n\nDeshace ${commit.slice(0, 7)}. Pedido por ${email} desde el conector de gerencia.`,
        );
        result.message = message;
        await record(email, repo, "deshacer", result, [`deshace ${commit.slice(0, 7)}`]);
        return text({ deshecho: true, commit: result.sha.slice(0, 7), url: result.url });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
