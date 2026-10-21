export function page(title: string, body: string, script = '') {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>
<style>body{font:16px/1.6 system-ui;max-width:640px;margin:64px auto;padding:0 24px;background:#fbfbfa;color:#17171a}button,input{font:inherit;padding:10px;margin:6px 0}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:inherit}</style>
<main><h1>${escape(title)}</h1>${body}<p id="status" role="status"></p></main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</html>`,
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
    `<p>Use your Juiced account to access your isolated workspaces.</p><button data-provider="github">Continue with GitHub</button><br><button data-provider="google">Continue with Google</button>`,
    `const callback=${JSON.stringify(callback).replaceAll('<', '\\u003c')};document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{b.disabled=true;const r=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:b.dataset.provider,callbackURL:callback})});const d=await r.json();if(r.ok&&d.url)location.assign(d.url);else{document.querySelector('#status').textContent='Sign-in is unavailable. Try again.';b.disabled=false;}});`,
  );
}
export function devicePage(code: string) {
  return page(
    'Authorize Juiced CLI',
    `<p>Approve only a device you are signing in to. Check that this code matches your terminal.</p><label>Device code<br><input id="code" autocomplete="off" value="${escape(code)}" maxlength="32"></label><br><button id="approve">Approve this device</button> <button id="deny">Deny</button>`,
    `for(const kind of ['approve','deny'])document.querySelector('#'+kind).onclick=async()=>{const code=document.querySelector('#code').value;const verified=await fetch('/api/auth/device?user_code='+encodeURIComponent(code));if(!verified.ok){document.querySelector('#status').textContent='Check the code and sign in again.';return;}const r=await fetch('/api/auth/device/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userCode:code})});document.querySelector('#status').textContent=r.ok?(kind==='approve'?'Device authorized. Return to your terminal.':'Device denied.'):'Unable to authorize this code. Check the code or sign in again.';};`,
  );
}
export function accountPage() {
  return page(
    'Your Juiced account',
    `<p>Each account has isolated workspaces. Your subscription includes a fixed compute allowance; Juiced pauses new work at the cap.</p>
<p id="account"></p><pre id="usage"></pre><button id="subscribe">Subscribe</button> <button id="billing">Manage billing</button>
<h2>Signed-in devices</h2><ul id="devices"></ul><h2>Sign-in providers</h2><p>Link a provider while signed in to use either provider for the same Juiced account.</p><button data-provider="github">Link GitHub</button> <button data-provider="google">Link Google</button>
<h2>Delete account</h2><p>Deleting cancels billing, signs out devices, stops compute and deletes workspace files and databases. This cannot be undone.</p><button id="delete">Delete my account</button>`,
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
