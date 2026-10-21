export function page(title: string, body: string, script = '') {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>
<meta name="color-scheme" content="dark"><link rel="icon" href="/favicon.svg">
<style>body{margin:0;background:#0b0d0b;color:#e4e9e4;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}main{max-width:520px;margin:0 auto;padding:56px 24px 80px}
.brand{display:inline-flex;gap:10px;align-items:center;margin-bottom:48px;color:inherit;font-size:22px;font-weight:800;letter-spacing:-1px;text-decoration:none}
h1{font-size:34px;line-height:1.15;letter-spacing:-.04em;font-weight:650;margin:0 0 16px}h2{font-size:20px;letter-spacing:-.02em;font-weight:600;margin:44px 0 8px;padding-top:28px;border-top:1px solid #1f2620}p,li{color:#7f8a80}#status{color:#e4e9e4}a{color:#4eba65;text-underline-offset:4px}
button,input{font:inherit;font-size:14px;margin:6px 0;border-radius:6px}button{cursor:pointer;color:#e4e9e4;background:#111511;border:1px solid #2f3830;padding:10px 16px}button:hover{border-color:#4eba65}button:disabled{opacity:.6;cursor:default}
button.primary{color:#0b0d0b;background:#4eba65;border-color:#4eba65;font-weight:600}button.primary:hover{background:#6fd987}button.danger{color:#ec8a78}button.danger:hover{border-color:#ec8a78}button.wide{display:block;width:100%}
input{display:block;width:100%;box-sizing:border-box;margin-top:8px;padding:12px 14px;color:#e4e9e4;background:#111511;border:1px solid #2f3830;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.08em}input:focus{outline:none;border-color:#4eba65}label{font-size:14px;color:#7f8a80}
a:focus-visible,button:focus-visible{outline:2px solid #4eba65;outline-offset:3px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.8 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#111511;border:1px solid #1f2620;border-radius:8px;padding:16px 18px}ul{padding-left:20px}li button{margin-left:8px;padding:4px 10px;font-size:13px}</style>
<main><a href="/" class="brand" aria-label="Juiced home"><svg width="22" height="26" viewBox="0 0 26 30" fill="none" aria-hidden="true"><path d="M5 10h16l-2 16H7L5 10Z" fill="#4eba65"/><path d="m14 3-2 7M5 7h16" stroke="#4eba65" stroke-width="3" stroke-linecap="round"/><path d="m14 14-4 6h4l-1 4 5-7h-4l1-3Z" fill="#0b0d0b"/></svg>juiced</a><h1>${escape(title)}</h1>${body}<p id="status" role="status"></p></main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`,
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
export function accountPage() {
  return page(
    'Your Juiced account',
    `<p>Each account has isolated workspaces. Your subscription includes a fixed compute allowance; Juiced pauses new work at the cap.</p>
<p id="account"></p><pre id="usage"></pre><button id="subscribe" class="primary">Subscribe</button> <button id="billing">Manage billing</button>
<h2>Signed-in devices</h2><ul id="devices"></ul><h2>Sign-in providers</h2><p>Link a provider while signed in to use either provider for the same Juiced account.</p><button data-provider="github">Link GitHub</button> <button data-provider="google">Link Google</button>
<h2>Delete account</h2><p>Deleting cancels billing, signs out devices, stops compute and deletes workspace files and databases. This cannot be undone.</p><button id="delete" class="danger">Delete my account</button>`,
    `let account;const status=document.querySelector('#status');
async function api(path,method='GET',body){const r=await fetch(path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d;}
async function load(){try{const me=await api('/v1/me');account=me.accounts[0]?.id;if(!account)throw new Error('No active account');document.querySelector('#account').textContent='Account '+account;
const usage=await api('/v1/accounts/'+account+'/usage');document.querySelector('#usage').textContent='Subscription: '+usage.entitlement+'\nIncluded credits: '+usage.included+'\nSettled usage: '+usage.used+' (recent usage may still be pending)\nAllowance renews: '+(usage.periodEnd||'After subscribing');
const list=await api('/v1/devices');const ul=document.querySelector('#devices');ul.replaceChildren();for(const device of list.items){const li=document.createElement('li');li.textContent=device.label+' — '+(device.revoked_at?'signed out':'active')+' ';if(!device.revoked_at){const b=document.createElement('button');b.textContent='Sign out';b.onclick=async()=>{await api('/v1/devices/'+device.id,'DELETE');await load();};li.append(b);}ul.append(li);}}
catch(e){status.textContent=e.message;const a=document.createElement('a');a.href='/sign-in';a.textContent='Sign in';status.append(' ',a);}}
for(const action of ['subscribe','billing'])document.querySelector('#'+action).onclick=async()=>{try{const d=await api('/v1/accounts/'+account+'/billing/'+(action==='subscribe'?'checkout':'portal'),'POST');location.assign(d.url);}catch(e){status.textContent=e.message;}};
document.querySelectorAll('[data-provider]').forEach(b=>b.onclick=async()=>{try{const d=await api('/api/auth/link-social','POST',{provider:b.dataset.provider,callbackURL:'/account'});if(d.url)location.assign(d.url);}catch(e){status.textContent=e.message;}});
document.querySelector('#delete').onclick=async()=>{if(!account||!confirm('Cancel billing and permanently delete all Juiced workspaces?'))return;try{await api('/v1/accounts/'+account,'DELETE',{confirmation:account});document.querySelector('main').textContent='Deletion requested. Billing cancellation and data deletion will continue in the background.';}catch(e){status.textContent=e.message;}};load();`,
  );
}
