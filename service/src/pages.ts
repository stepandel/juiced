export function page(
  title: string,
  body: string,
  script = '',
  layout: { wide?: boolean; nav?: string } = {},
) {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>
<meta name="color-scheme" content="dark"><link rel="icon" href="/favicon.svg">
<style>:root{--bg:#0b0e0c;--ink:#e8ece4;--muted:#8b948a;--line:#232b25;--panel:#121613;--green:#bff04d;--green-bright:#d3ff6a;--edge:#2e382f;--field-edge:#5f6b60;--danger:#ec8a78;--warn:#e0b85c;--green-wash:rgba(191,240,77,.12);--warn-edge:#5c4a2a;--warn-wash:#1a160e}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}main{max-width:520px;margin:0 auto;padding:56px 24px 80px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:48px}.brand{display:inline-flex;gap:10px;align-items:center;color:inherit;font-size:22px;font-weight:800;letter-spacing:-1px;text-decoration:none}.brand svg{color:var(--green)}.brand .cutout{fill:var(--bg)}
h1{font-size:34px;line-height:1.15;letter-spacing:-.04em;font-weight:650;margin:0 0 16px}h2{font-size:20px;letter-spacing:-.02em;font-weight:600;margin:44px 0 8px;padding-top:28px;border-top:1px solid var(--line)}p,li{color:var(--muted)}#status{color:var(--ink)}a{color:var(--green);text-underline-offset:4px}
button,input{font:inherit;font-size:14px;margin:6px 0;border-radius:6px}button{cursor:pointer;color:var(--ink);background:var(--panel);border:1px solid var(--edge);padding:10px 16px}button:hover{border-color:var(--green)}button:disabled{opacity:.6;cursor:default}
button.primary{color:var(--bg);background:var(--green);border-color:var(--green);font-weight:600}button.primary:hover{background:var(--green-bright)}button.danger{color:var(--danger)}button.danger:hover{border-color:var(--danger)}button.wide{display:block;width:100%}
input{display:block;width:100%;box-sizing:border-box;margin-top:8px;padding:12px 14px;color:var(--ink);background:var(--panel);border:1px solid var(--field-edge);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;letter-spacing:.08em}input:focus{outline:none;border-color:var(--green)}label{font-size:14px;color:var(--muted)}
a:focus-visible,button:focus-visible{outline:2px solid var(--green);outline-offset:3px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.8 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px}ul{padding-left:20px}li button{margin-left:8px;padding:4px 10px;font-size:13px}
main.wide{max-width:760px}.who{display:flex;align-items:center;gap:12px;font-size:14px;color:var(--muted)}.who button{margin:0;padding:6px 12px;font-size:13px}.avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--green-wash);color:var(--green-bright);font-weight:700;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:32px 0 8px}.card{border:1px solid var(--line);border-radius:10px;background:var(--panel);padding:20px 22px}.card h3{margin:0 0 12px;font-size:12px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.card .big{font-size:24px;font-weight:600;letter-spacing:-.02em;color:var(--ink);margin:0 0 6px;display:flex;align-items:center;gap:10px}.card p{margin:0;font-size:14px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex-shrink:0}.dot.ok{background:var(--green);box-shadow:0 0 8px var(--green)}.dot.busy{background:var(--warn)}.dot.bad{background:var(--danger)}
code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:1px 5px;overflow-wrap:anywhere}.card code{background:var(--bg)}
.rows{list-style:none;padding:0;margin:12px 0 0;border-top:1px solid var(--line)}.rows li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--line);color:var(--ink)}.rows li button{margin:0;flex-shrink:0}.rows small{display:block;color:var(--muted);font-size:13px}.ok-text{color:var(--green);font-size:14px}
.notice{border:1px solid var(--warn-edge);background:var(--warn-wash);border-radius:10px;padding:16px 20px;margin:24px 0}.notice p{margin:0;color:var(--warn)}
@media(max-width:640px){.grid{grid-template-columns:1fr}.who span{display:none}}</style>
<main${layout.wide ? ' class="wide"' : ''}><div class="top"><a href="/" class="brand" aria-label="Juiced home"><svg width="22" height="26" viewBox="0 0 26 30" fill="none" aria-hidden="true"><path d="M5 10h16l-2 16H7L5 10Z" fill="currentColor"/><path d="m14 3-2 7M5 7h16" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path class="cutout" d="m14 14-4 6h4l-1 4 5-7h-4l1-3Z"/></svg>juiced</a>${layout.nav ?? ''}</div><h1>${escape(title)}</h1>${body}<p id="status" role="status"></p></main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Content-Security-Policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
export function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
export function signIn(callback: string) {
  // callback is always a local path constructed by this service.
  return page(
    'Sign in to Juiced',
    `<p>Use your Juiced account to access your isolated workspaces.</p><button class="wide" data-provider="github">Continue with GitHub</button><button class="wide" data-provider="google">Continue with Google</button>`,
    `const callback=${JSON.stringify(callback).replaceAll('<', '\\u003c')};document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{b.disabled=true;const r=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:b.dataset.provider,callbackURL:callback})});const d=await r.json();if(r.ok&&d.url)location.assign(d.url);else{document.querySelector('#status').textContent='Sign-in is unavailable. Try again.';b.disabled=false;}});`,
  );
}
export function devicePage(code: string) {
  return page(
    'Authorize Juiced CLI',
    `<p>Approve only a device you are signing in to. Check that this code matches your terminal.</p><label>Device code<br><input id="code" autocomplete="off" value="${escape(code)}" maxlength="32"></label><br><button id="approve" class="primary">Approve this device</button> <button id="deny">Deny</button>`,
    `for(const kind of ['approve','deny'])document.querySelector('#'+kind).onclick=async()=>{const code=document.querySelector('#code').value;const verified=await fetch('/api/auth/device?user_code='+encodeURIComponent(code));if(!verified.ok){document.querySelector('#status').textContent='Check the code and sign in again.';return;}const r=await fetch('/api/auth/device/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userCode:code})});document.querySelector('#status').textContent=r.ok?(kind==='approve'?'Device authorized. Return to your terminal.':'Device denied.'):'Unable to authorize this code. Check the code or sign in again.';};`,
  );
}
export interface AccountView {
  user: { name: string; email: string };
  account: {
    id: string;
    status: string;
    entitlement: string;
    period_id: string | null;
    period_end: Date | null;
    created_at: Date;
  };
  installation: { status: string; error: string | null } | undefined;
  devices: { id: string; label: string; created_at: Date; expires_at: Date }[];
  providers: string[];
}
const day = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const providerNames: Record<string, string> = { github: 'GitHub', google: 'Google' };
function host(i: AccountView['installation']) {
  if (!i)
    return [
      '',
      'Not created yet',
      'Your private workspace host is created the first time you run <code>juiced claude</code>.',
    ];
  const states: Record<string, [string, string, string]> = {
    ready: ['ok', 'Ready', 'Your workspaces run here, even when your laptop is closed.'],
    pending: ['busy', 'Setting up', 'Juiced is creating your workspace host. This takes a minute.'],
    provisioning: ['busy', 'Setting up', 'Juiced is creating your workspace host. This takes a minute.'],
    upgrading: ['busy', 'Updating', 'Juiced is moving your workspace host to the latest release.'],
    failed: ['bad', 'Needs attention', 'Setup did not finish. Run <code>juiced claude</code> to retry.'],
    deleting: ['bad', 'Deleting', 'Workspace files and databases are being deleted.'],
    deleted: ['', 'Deleted', 'Workspace files and databases were deleted.'],
  };
  const [tone, label, detail] = states[i.status] ?? ['', i.status, ''];
  return [tone, label, detail + (i.error ? ` <code>${escape(i.error)}</code>` : '')];
}
export function accountPage(view: AccountView) {
  const { user, account } = view;
  const nav = `<div class="who"><div class="avatar" aria-hidden="true">${escape((user.name || user.email).trim().charAt(0).toUpperCase())}</div><span>${escape(user.email)}</span><button data-sign-out>Sign out</button></div>`;
  const script = `const status=document.querySelector('#status');
async function api(path,method='GET',body){const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'request_failed');return d;}
function act(b,run){if(b)b.onclick=async()=>{b.disabled=true;status.textContent='';try{await run();}catch(e){status.textContent='That did not work ('+e.message+'). Refresh and try again.';b.disabled=false;}};}
document.querySelectorAll('[data-sign-out]').forEach(b=>act(b,async()=>{await api('/api/auth/sign-out','POST',{});location.assign('/');}));`;
  if (account.status === 'deleting' || account.status === 'deleted')
    return page(
      'Your Juiced account',
      `<div class="notice"><p>${account.status === 'deleting' ? 'Account deletion is in progress. Workspace files and databases are being deleted in the background.' : 'This account was deleted.'}</p></div>`,
      script,
      { wide: true, nav },
    );
  const [tone, label, detail] = host(view.installation);
  const free = account.period_id === 'free';
  const plan =
    account.status === 'suspended'
      ? ['bad', 'Suspended']
      : account.entitlement === 'active'
        ? ['ok', free ? 'Free' : 'Active']
        : account.entitlement === 'exhausted'
          ? ['bad', 'Allowance used']
          : ['bad', 'Inactive'];
  const devices = view.devices.length
    ? `<ul class="rows">${view.devices.map((d) => `<li><div>${escape(d.label)}<small>Signed in ${day(d.created_at)} · expires ${day(d.expires_at)}</small></div><button data-device="${escape(d.id)}">Sign out</button></li>`).join('')}</ul><button id="logout-all" class="danger">Sign out all CLI sessions</button>`
    : '<p>No CLI sessions are signed in. Run <code>juiced login</code> to connect this computer.</p>';
  const providers = `<ul class="rows">${Object.entries(providerNames)
    .map(([id, name]) =>
      view.providers.includes(id)
        ? `<li><div>${name}</div><span class="ok-text">Connected</span></li>`
        : `<li><div>${name}<small>Connect to sign in with either provider.</small></div><button data-provider="${id}">Connect</button></li>`,
    )
    .join('')}</ul>`;
  return page(
    'Your console',
    `<p>Your Juiced account, workspace host and CLI sign-ins.</p>
<div class="grid"><section class="card"><h3>Plan</h3><p class="big"><span class="dot ${plan[0]}"></span>${plan[1]}</p><p>${free ? 'Workspace compute is included.' : account.period_end ? `Renews ${day(account.period_end)}.` : ''} Access follows subscription status and workspace resource limits.</p></section>
<section class="card"><h3>Workspace host</h3><p class="big"><span class="dot ${tone}"></span>${label}</p><p>${detail}</p></section></div>
<p>Account <code>${escape(account.id)}</code> · member since ${day(account.created_at)}</p>
<h2>CLI sign-ins</h2><p>Sign in once per computer. All terminal windows for the same user share that sign-in. Run <code>juiced logout</code> to sign out on this computer.</p>${devices}
<h2>Sign-in methods</h2>${providers}
<h2>Sign out</h2><p>Sign out of this browser. Your CLI sessions stay signed in.</p><button data-sign-out>Sign out of browser</button>
<h2>Delete account</h2><p>Deleting signs out all CLI sessions, stops compute and deletes workspace files and databases. This cannot be undone.</p><button id="delete" class="danger" data-account="${escape(account.id)}">Delete my account</button>`,
    `${script}
document.querySelectorAll('[data-device]').forEach(b=>act(b,async()=>{await api('/v1/devices/'+encodeURIComponent(b.dataset.device),'DELETE');location.reload();}));
const all=document.querySelector('#logout-all');act(all,async()=>{if(!confirm('Sign out all CLI sessions? Run juiced login again on each computer to reconnect.')){all.disabled=false;return;}await api('/v1/logout','POST',{all:true});location.reload();});
document.querySelectorAll('[data-provider]').forEach(b=>act(b,async()=>{const d=await api('/api/auth/link-social','POST',{provider:b.dataset.provider,callbackURL:'/account'});if(d.url)location.assign(d.url);}));
const del=document.querySelector('#delete');act(del,async()=>{const id=del.dataset.account;if(!confirm('Permanently delete your account and all Juiced workspaces?')){del.disabled=false;return;}await api('/v1/accounts/'+id,'DELETE',{confirmation:id});location.reload();});`,
    { wide: true, nav },
  );
}
