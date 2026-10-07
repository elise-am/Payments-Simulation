/**
 * Password gate for the whole site (Vercel Routing Middleware).
 *
 * Once DASHBOARD_PASSWORD is set in Vercel, every page and /api route asks for it
 * (browser sign-in box; any user name works unless DASHBOARD_USER is set). Until it
 * is set, the site stays open but /api/live refuses to return real data.
 * This is a shared-password gate for the demo; Microsoft sign-in can replace it later.
 */
import { next } from "@vercel/functions";

export const config = { matcher: "/((?!favicon.ico).*)" };

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default function middleware(request) {
  const password = (process.env.DASHBOARD_PASSWORD ?? "").trim();
  if (!password) return next();
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(header.slice(6));
    } catch {}
    const i = decoded.indexOf(":");
    const user = decoded.slice(0, i), pass = decoded.slice(i + 1);
    const wantUser = (process.env.DASHBOARD_USER ?? "").trim();
    if (i >= 0 && same(pass, password) && (!wantUser || same(user, wantUser))) return next();
  }
  return new Response("Sign in to view the Seamless dashboard.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Seamless Technician Payouts", charset="UTF-8"', "cache-control": "no-store" },
  });
}
