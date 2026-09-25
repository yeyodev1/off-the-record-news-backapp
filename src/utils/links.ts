import { env } from "../config/env";

export function articleUrl(slug: string): string {
  return `${env.FRONTEND_URL.replace(/\/+$/, "")}/nota/${slug}`;
}

/** La baja pasa por el API (que marca `canceled`) y luego redirige al front. */
export function unsubscribeUrl(token: string): string {
  const base = (env.PUBLIC_API_URL || `http://localhost:${env.PORT}`).replace(/\/+$/, "");
  return `${base}/api/subscribers/unsubscribe/${token}`;
}
