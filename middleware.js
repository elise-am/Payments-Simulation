/**
 * Password gate for the whole site (Vercel Routing Middleware).
 *
 * Once DASHBOARD_PASSWORD is set in Vercel, visitors are sent to a branded /login page
 * (login-page.js). A correct password sets a signed, HttpOnly session cookie for 30 days;
 * /logout (the Sign out button) clears it. DASHBOARD_USER, if set, adds a username field that must match.
 * Changing the password signs everyone out. Until it is set, the site stays open but
 * /api/live refuses to return real data.
 * This is a shared-password gate for the demo; Microsoft sign-in can replace it later.
 */
import { next } from "@vercel/functions";
import { loginPage } from "./login-page.js";

export const config = { matcher: "/((?!favicon.ico).*)" };

const COOKIE = "sfm_session";
const FLAG = "sfm_auth"; // readable by the page, only to show the Sign out button
const MAX_AGE = 60 * 60 * 24 * 30;
const enc = new TextEncoder();

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Session value = HMAC of the configured user, keyed by the password.
async function sessionToken(password, user) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("sfm-session-v1:" + user));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

// Only same-site paths, never protocol-relative or back to the auth routes.
function safeNext(v) {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return "/";
  if (v === "/login" || v.startsWith("/login?") || v === "/logout") return "/";
  return v;
}

const NO_STORE = { "cache-control": "no-store" };
const page = (html, status = 200) =>
  new Response(html, { status, headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" } });
// Headers may repeat set-cookie, so build them as a list.
const redirect = (location, cookies = []) =>
  new Response(null, { status: 303, headers: [...Object.entries(NO_STORE), ["location", location], ...cookies.map((c) => ["set-cookie", c])] });

export default async function middleware(request) {
  const password = (process.env.DASHBOARD_PASSWORD ?? "").trim();
  if (!password) return next();
  const wantUser = (process.env.DASHBOARD_USER ?? "").trim();
  const url = new URL(request.url);
  const path = url.pathname;
  const secure = url.protocol === "https:" ? "; Secure" : "";

  if (path === "/logout") {
    return redirect("/login", [
      `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
      `${FLAG}=; Path=/; SameSite=Lax; Max-Age=0${secure}`,
    ]);
  }

  const expected = await sessionToken(password, wantUser);
  const signedIn = same(readCookie(request, COOKIE), expected);

  if (path === "/login") {
    if (request.method === "POST") {
      let form;
      try {
        form = await request.formData();
      } catch {
        form = new FormData();
      }
      const pass = String(form.get("password") ?? "");
      const user = String(form.get("user") ?? "").trim();
      const nextPath = safeNext(String(form.get("next") ?? "/"));
      if (same(pass, password) && (!wantUser || same(user, wantUser))) {
        return redirect(nextPath, [
          `${COOKIE}=${expected}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`,
          `${FLAG}=1; Path=/; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`,
        ]);
      }
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      const error = wantUser ? "That username and password don't match." : "That password isn't right. Try again.";
      return page(loginPage({ next: nextPath, error, askUser: !!wantUser, user }), 401);
    }
    if (signedIn) return redirect(safeNext(url.searchParams.get("next")));
    return page(loginPage({ next: safeNext(url.searchParams.get("next")), askUser: !!wantUser }));
  }

  if (signedIn) return next();

  if (path.startsWith("/api/")) {
    return new Response(JSON.stringify({ ok: false, reason: "signed_out", message: "Sign in to view the Seamless dashboard." }), {
      status: 401,
      headers: { ...NO_STORE, "content-type": "application/json" },
    });
  }
  const target = path + url.search;
  return redirect(target === "/" ? "/login" : "/login?next=" + encodeURIComponent(target));
}
