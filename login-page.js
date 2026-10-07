/** Sign-in page served by middleware.js. Uses the dashboard's tokens, fonts and brand header. */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function loginPage({ next = "/", error = "", askUser = false, user = "" } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Sign in · Seamless Technician Payouts</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@500;600;700;800&display=swap">
<style>
:root{
  color-scheme:dark;
  --bg:#050505; --surface:#0c0d0e; --surface-2:#141619;
  --border:rgba(255,255,255,.09); --border-strong:rgba(255,255,255,.16);
  --ink:#f2f3f5; --ink-2:#9aa0ab; --ink-3:#80848d;
  --accent:#35b8f3; --accent-fill:#35b8f3; --accent-soft:rgba(53,184,243,.14); --on-accent:#00121c;
  --good:#3ddc97;
  --danger:#ff6b6a; --danger-soft:rgba(255,107,106,.12);
  --glow:rgba(53,184,243,.10);
  --font-body:'Barlow',system-ui,-apple-system,'Segoe UI',sans-serif;
  --font-num:'Barlow Condensed','Arial Narrow',system-ui,sans-serif;
  --radius:6px;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
    color-scheme:light;
    --bg:#f2f4f6; --surface:#ffffff; --surface-2:#f1f3f6;
    --border:#e3e6ea; --border-strong:#d4d9df;
    --ink:#191c21; --ink-2:#555c68; --ink-3:#6c727b;
    --accent:#0d6e97; --accent-fill:#1a9fd4; --accent-soft:#e5f5fd; --on-accent:#ffffff;
    --good:#13804f;
    --danger:#c92a29; --danger-soft:#fdecec;
    --glow:rgba(26,159,212,.08);
  }
}
:root[data-theme="light"]{
  color-scheme:light;
  --bg:#f2f4f6; --surface:#ffffff; --surface-2:#f1f3f6;
  --border:#e3e6ea; --border-strong:#d4d9df;
  --ink:#191c21; --ink-2:#555c68; --ink-3:#6c727b;
  --accent:#0d6e97; --accent-fill:#1a9fd4; --accent-soft:#e5f5fd; --on-accent:#ffffff;
  --good:#13804f;
  --danger:#c92a29; --danger-soft:#fdecec;
  --glow:rgba(26,159,212,.08);
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);background-image:radial-gradient(900px 480px at 50% -10%,var(--glow),transparent 70%);color:var(--ink);font-family:var(--font-body);font-size:14px;line-height:1.45;
  min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px 16px}
main{width:100%;max-width:380px}
.brand{display:flex;flex-direction:column;gap:1px;margin-bottom:22px}
.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700}
h1{margin:0;font-family:var(--font-num);font-weight:700;font-size:30px;letter-spacing:.01em;line-height:1.1}
.card{background:var(--surface);border:1px solid var(--border);border-radius:calc(var(--radius) + 4px);padding:24px;box-shadow:0 12px 40px rgba(0,0,0,.18)}
.card h2{margin:0 0 4px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:700}
.card p.lead{margin:0 0 18px;color:var(--ink-2)}
label{display:block;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);font-weight:700;margin:0 0 6px}
.field{margin-bottom:14px}
input{width:100%;appearance:none;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:var(--radius);color:var(--ink);
  font:500 16px var(--font-body);padding:10px 12px;transition:border-color .15s ease,box-shadow .15s ease}
input:focus{outline:none;border-color:var(--accent-fill);box-shadow:0 0 0 3px var(--accent-soft)}
.err{display:flex;gap:8px;align-items:flex-start;background:var(--danger-soft);color:var(--danger);border-radius:var(--radius);padding:9px 12px;margin:0 0 14px;font-weight:600;font-size:13px}
button{width:100%;appearance:none;border:0;border-radius:var(--radius);background:var(--accent-fill);color:var(--on-accent);font:700 14px var(--font-body);
  letter-spacing:.02em;padding:11px 14px;margin-top:4px;cursor:pointer;transition:filter .15s ease,transform .1s ease}
button:hover{filter:brightness(1.07)}
button:active{transform:scale(.98)}
button:focus-visible{outline:2px solid var(--accent-fill);outline-offset:2px}
button[disabled]{opacity:.7;cursor:default}
.foot{margin:16px 2px 0;font-size:12px;color:var(--ink-3);display:flex;align-items:center;gap:6px}
.foot .dot{width:7px;height:7px;border-radius:50%;background:var(--good);flex:none}
@media (prefers-reduced-motion: reduce){input,button{transition:none}}
</style>
</head>
<body>
<main>
  <div class="brand">
    <span class="eyebrow">Seamless FM</span>
    <h1>Technician Payouts</h1>
  </div>
  <form class="card" method="post" action="/login" autocomplete="on">
    <h2>Sign in</h2>
    <p class="lead">Enter the team password to open the dashboard.</p>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
    <input type="hidden" name="next" value="${esc(next)}">
    ${askUser ? `<div class="field"><label for="user">Username</label>
      <input id="user" name="user" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${esc(user)}"${error ? "" : " autofocus"}></div>` : ""}
    <div class="field"><label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required${!askUser || error ? " autofocus" : ""}></div>
    <button type="submit">Sign in</button>
  </form>
  <p class="foot"><span class="dot" aria-hidden="true"></span>Access is limited to the Seamless team. Ask your admin for the password.</p>
</main>
<script>
const f=document.querySelector('form'),b=f.querySelector('button');
f.addEventListener('submit',()=>{b.disabled=true;b.textContent='Signing in…';});
addEventListener('pageshow',()=>{b.disabled=false;b.textContent='Sign in';});
</script>
</body>
</html>`;
}
