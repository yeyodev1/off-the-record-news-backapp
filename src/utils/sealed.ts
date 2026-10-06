import crypto from "crypto";
import { env } from "../config/env";

/**
 * AES-256-GCM para datos sensibles en reposo (el modo de lectura es orientación
 * política bajo la LOPDP). El texto guardado es "iv.tag.cifrado" en base64url.
 */
function key(): Buffer {
  return crypto.createHash("sha256").update(env.MODE_ENCRYPTION_KEY || `modo:${env.JWT_SECRET}`).digest();
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

/** Devuelve "" si el dato no se puede abrir (llave rotada o dato corrupto). */
export function unseal(sealed: string): string {
  try {
    const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
