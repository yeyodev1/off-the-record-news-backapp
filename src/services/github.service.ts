import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";
import { McpRepo } from "../models/mcpChange.model";

/**
 * Acceso a los dos repos del sitio por el API de GitHub, para el conector de
 * gerencia. Un commit a main despliega solo en Vercel; si el build falla,
 * Vercel no promueve ese deploy y el sitio sigue con el anterior.
 */

const API = "https://api.github.com";
const BRANCH = "main";
const MAX_FILE_BYTES = 400_000;

export const REPO_LABELS: Record<McpRepo, string> = {
  back: "Backend (API, mesa de redacción, agentes)",
  front: "Frontend (otr.com.ec)",
};

function repoName(repo: McpRepo): string {
  return repo === "back" ? env.GITHUB_BACK_REPO : env.GITHUB_FRONT_REPO;
}

/**
 * Lo que el conector no toca: secretos, CI y el propio conector (si pudiera
 * editarse, podría ampliar su acceso).
 */
const PROTECTED: Record<McpRepo, RegExp[]> = {
  back: [
    /(^|\/)\.env/,
    /^\.github\//,
    /^src\/(services|controllers|routes|models)\/(mcp|github)[^/]*\.ts$/,
    /^src\/config\/env\.ts$/,
    /^src\/middlewares\/(auth|admin)\.middleware\.ts$/,
  ],
  front: [/(^|\/)\.env/, /^\.github\//],
};

export function isProtected(repo: McpRepo, path: string): boolean {
  return PROTECTED[repo].some((re) => re.test(path));
}

function cleanPath(path: string): string {
  const clean = path.trim().replace(/^\.?\/+/, "");
  if (!clean || clean.split("/").includes("..")) {
    throw new CustomError(`Ruta inválida: "${path}"`, 400);
  }
  return clean;
}

async function gh<T>(repo: McpRepo, route: string, init: RequestInit = {}): Promise<T> {
  if (!env.GITHUB_TOKEN) throw new CustomError("Falta GITHUB_TOKEN en el servidor", 503);
  const response = await fetch(`${API}/repos/${repoName(repo)}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const status = response.status === 404 ? 404 : 502;
    throw new CustomError(`GitHub ${response.status}: ${body.slice(0, 200)}`, status);
  }
  return (await response.json()) as T;
}

export async function headSha(repo: McpRepo): Promise<string> {
  const ref = await gh<{ object: { sha: string } }>(repo, `/git/ref/heads/${BRANCH}`);
  return ref.object.sha;
}

/** Archivos del repo (sin carpetas), filtrados por prefijo. */
export async function listFiles(repo: McpRepo, prefix = ""): Promise<string[]> {
  const sha = await headSha(repo);
  const tree = await gh<{ tree: { path: string; type: string }[]; truncated: boolean }>(
    repo,
    `/git/trees/${sha}?recursive=1`,
  );
  const start = prefix ? cleanPath(prefix).replace(/\/?$/, "/") : "";
  return tree.tree
    .filter((item) => item.type === "blob" && item.path.startsWith(start))
    .map((item) => item.path);
}

export async function readFile(repo: McpRepo, path: string): Promise<string> {
  const clean = cleanPath(path);
  if (isProtected(repo, clean)) throw new CustomError(`"${clean}" está protegido`, 403);
  const file = await gh<{ content?: string; encoding?: string; size: number; type: string }>(
    repo,
    `/contents/${encodeURI(clean)}?ref=${BRANCH}`,
  );
  if (file.type !== "file") throw new CustomError(`"${clean}" no es un archivo`, 400);
  if (file.size > MAX_FILE_BYTES || !file.content) {
    throw new CustomError(`"${clean}" es muy grande para leerlo por el conector`, 413);
  }
  return Buffer.from(file.content, "base64").toString("utf8");
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Búsqueda de texto en el código. El buscador de GitHub indica con retraso y
 * no ve los commits recientes, así que se recorren los archivos de texto del
 * repo (filtrados por carpeta) y se busca línea por línea.
 */
export async function search(
  repo: McpRepo,
  query: string,
  prefix = "",
  limit = 60,
): Promise<SearchHit[]> {
  const needle = query.toLowerCase();
  const files = (await listFiles(repo, prefix)).filter(
    (p) =>
      /\.(ts|vue|js|scss|css|json|md|html|csv)$/.test(p) &&
      !/(^|\/)(pnpm-lock|package-lock)\.|\.min\./.test(p) &&
      !isProtected(repo, p),
  );
  if (files.length > 400) {
    throw new CustomError(
      `El repo tiene ${files.length} archivos: acota la búsqueda con una carpeta (por ejemplo src/views)`,
      400,
    );
  }
  const hits: SearchHit[] = [];
  for (let i = 0; i < files.length && hits.length < limit; i += 8) {
    const batch = files.slice(i, i + 8);
    const contents = await Promise.all(batch.map((p) => readFile(repo, p).catch(() => "")));
    batch.forEach((path, j) => {
      contents[j].split("\n").forEach((text, k) => {
        if (hits.length < limit && text.toLowerCase().includes(needle)) {
          hits.push({ path, line: k + 1, text: text.trim().slice(0, 200) });
        }
      });
    });
  }
  return hits;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export async function recentCommits(repo: McpRepo, limit = 10): Promise<CommitInfo[]> {
  const list = await gh<any[]>(repo, `/commits?sha=${BRANCH}&per_page=${Math.min(limit, 30)}`);
  return list.map((c) => ({
    sha: c.sha,
    message: String(c.commit.message).split("\n")[0],
    author: c.commit.author?.name ?? "",
    date: c.commit.author?.date ?? "",
    url: c.html_url,
  }));
}

export interface FileChange {
  path: string;
  /** Contenido completo nuevo. Sin contenido y con `delete`, se borra. */
  content?: string;
  delete?: boolean;
}

/** Un solo commit con todos los archivos, directo a main. */
export async function commitFiles(
  repo: McpRepo,
  message: string,
  changes: FileChange[],
): Promise<CommitInfo> {
  if (!changes.length) throw new CustomError("No hay archivos para guardar", 400);
  const files = changes.map((c) => ({ ...c, path: cleanPath(c.path) }));
  for (const file of files) {
    if (isProtected(repo, file.path)) {
      throw new CustomError(`"${file.path}" está protegido y no se puede cambiar por aquí`, 403);
    }
    if (!file.delete && typeof file.content !== "string") {
      throw new CustomError(`Falta el contenido de "${file.path}"`, 400);
    }
    if (Buffer.byteLength(file.content ?? "") > MAX_FILE_BYTES) {
      throw new CustomError(`"${file.path}" es muy grande`, 413);
    }
  }

  const parent = await headSha(repo);
  const parentCommit = await gh<{ tree: { sha: string } }>(repo, `/git/commits/${parent}`);
  const tree = await gh<{ sha: string }>(repo, "/git/trees", {
    method: "POST",
    body: JSON.stringify({
      base_tree: parentCommit.tree.sha,
      tree: files.map((f) =>
        f.delete
          ? { path: f.path, mode: "100644", type: "blob", sha: null }
          : { path: f.path, mode: "100644", type: "blob", content: f.content },
      ),
    }),
  });
  const commit = await gh<{ sha: string; html_url: string }>(repo, "/git/commits", {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }),
  });
  // Sin force: si alguien commiteó en el medio, GitHub rechaza y no se pisa nada.
  await gh(repo, `/git/refs/heads/${BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return {
    sha: commit.sha,
    message,
    author: "",
    date: new Date().toISOString(),
    url: commit.html_url,
  };
}

/**
 * Deshace un commit volviendo al árbol de su padre. Solo el último de main:
 * deshacer uno viejo pisaría lo que vino después.
 */
export async function revertHead(repo: McpRepo, sha: string, message: string): Promise<CommitInfo> {
  const head = await headSha(repo);
  if (!head.startsWith(sha.trim()) || sha.trim().length < 7) {
    throw new CustomError(
      "Solo se puede deshacer el último cambio de main. Para uno anterior, pide la corrección como un cambio nuevo.",
      409,
    );
  }
  const target = await gh<{ parents: { sha: string }[] }>(repo, `/git/commits/${head}`);
  const parent = target.parents[0]?.sha;
  if (!parent) throw new CustomError("Ese commit no tiene uno anterior", 409);
  const parentCommit = await gh<{ tree: { sha: string } }>(repo, `/git/commits/${parent}`);
  const commit = await gh<{ sha: string; html_url: string }>(repo, "/git/commits", {
    method: "POST",
    body: JSON.stringify({ message, tree: parentCommit.tree.sha, parents: [head] }),
  });
  await gh(repo, `/git/refs/heads/${BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return {
    sha: commit.sha,
    message,
    author: "",
    date: new Date().toISOString(),
    url: commit.html_url,
  };
}

export interface DeployStatus {
  sha: string;
  state: string;
  details: { context: string; state: string; description: string; url: string }[];
}

/** Lo que Vercel reporta a GitHub sobre el deploy de un commit. */
export async function deployStatus(repo: McpRepo, sha?: string): Promise<DeployStatus> {
  const ref = sha?.trim() || (await headSha(repo));
  const status = await gh<{ sha: string; state: string; statuses: any[] }>(
    repo,
    `/commits/${ref}/status`,
  );
  return {
    sha: status.sha,
    state: status.statuses.length ? status.state : "sin_reporte",
    details: status.statuses.map((s) => ({
      context: s.context,
      state: s.state,
      description: s.description ?? "",
      url: s.target_url ?? "",
    })),
  };
}
