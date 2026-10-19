import { Request, Response, NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AuthRequest } from "../types/AuthRequest";
import * as mcpService from "../services/mcp.service";

/**
 * POST /api/mcp/:token — el conector de gerencia. Sin sesiones: en Vercel
 * cada petición puede caer en otra instancia, así que cada una arma su
 * servidor y responde en JSON.
 */
export async function handle(req: Request, res: Response, next: NextFunction) {
  try {
    const email = await mcpService.authenticate(String(req.params.token ?? ""));
    if (!email) {
      res.status(401).json({ message: "Conector no autorizado o llave apagada" });
      return;
    }
    const server = mcpService.buildServer(email);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    next(error);
  }
}

/** GET y DELETE /api/mcp/:token — sin sesiones ni stream del servidor. */
export function notAllowed(_req: Request, res: Response) {
  res.status(405).set("Allow", "POST").json({ message: "Usa POST" });
}

// ——— Panel (solo cuentas de MCP_ALLOWED_EMAILS)

const who = (req: AuthRequest) => ({ userId: req.user!.userId, email: req.user!.email });

/** GET /api/admin/mcp */
export async function status(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await mcpService.status(who(req)));
  } catch (error) {
    next(error);
  }
}

/** POST /api/admin/mcp/token — llave nueva; la URL viaja solo en esta respuesta. */
export async function rotate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await mcpService.rotate(who(req)));
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/admin/mcp/token */
export async function revoke(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await mcpService.revoke(who(req));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
