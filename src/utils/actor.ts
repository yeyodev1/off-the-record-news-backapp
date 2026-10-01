import { User } from "../models/user.model";
import { AuthRequest } from "../types/AuthRequest";

/** Nombre de quien hace la acción en el panel, para el historial y el descargo. */
export async function actorName(req: AuthRequest): Promise<string> {
  if (!req.user) return "";
  const user = await User.findById(req.user.userId).select("name email");
  return user?.name?.trim() || user?.email || req.user.email;
}
