import { getVercelOidcToken } from "@vercel/oidc";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";

/**
 * Vercel AI Gateway: un solo punto para Jev (decisiones tipadas) y Claude
 * (redacción). En Vercel autentica con el token OIDC del proyecto, así que no
 * hay llave de proveedor que mantener; en local sirve `vercel env pull`.
 */

const BASE_URL = "https://ai-gateway.vercel.sh/v1";

export function isGatewayConfigured(): boolean {
  return !!(env.AI_GATEWAY_API_KEY || env.HAS_VERCEL_OIDC || env.IS_VERCEL);
}

async function authToken(): Promise<string> {
  if (env.AI_GATEWAY_API_KEY) return env.AI_GATEWAY_API_KEY;
  try {
    return await getVercelOidcToken();
  } catch {
    throw new CustomError(
      "El AI Gateway no está configurado (falta AI_GATEWAY_API_KEY o el token OIDC de Vercel)",
      503,
    );
  }
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await authToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    // 401/403 es de configuración: quien llama puede caer al respaldo.
    const status = response.status === 401 || response.status === 403 ? 503 : 502;
    throw new CustomError(`AI Gateway respondió ${response.status}: ${detail}`, status);
  }
  return (await response.json()) as T;
}

// ——— Jev: evaluación tipada

export type JevQuestion =
  | { type: "boolean"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> }
  | { type: "score"; score: number; probabilities: Record<string, number> };

export async function evaluate(
  state: unknown,
  questions: Record<string, JevQuestion>,
): Promise<Record<string, JevAnswer>> {
  const data = await post<{ answers: Record<string, JevAnswer> }>(
    "/evaluate",
    { model: env.JEV_MODEL, state, questions },
    30_000,
  );
  return data.answers;
}

// ——— Redacción con salida JSON validada

export async function chatJson<T>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}): Promise<T> {
  const data = await post<{
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  }>(
    "/chat/completions",
    {
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "respuesta", strict: true, schema: opts.schema },
      },
    },
    150_000,
  );
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new CustomError("La respuesta de la IA quedó incompleta", 502);
  }
  try {
    return JSON.parse(choice?.message?.content ?? "") as T;
  } catch {
    throw new CustomError("La IA devolvió un formato inválido", 502);
  }
}
