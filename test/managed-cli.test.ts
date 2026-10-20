import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';
import { CredentialStore } from '../src/account/store.js';
const execute = promisify(execFile);
test(
  'built managed CLI pins account, installation, device token and compiled runtime without Cantelop credentials',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'juiced-managed-cli-')),
      projectRoot = fileURLToPath(new URL('../', import.meta.url));
    await mkdir(join(projectRoot, '.cantelop'), { recursive: true });
    const output = await mkdtemp(join(projectRoot, '.cantelop', 'managed-cli-'));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(output, { recursive: true, force: true });
    });
    await build({
      entryPoints: [join(projectRoot, 'src/cli.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      packages: 'external',
      plugins: [createCantelopCompilerPlugin({ definition: join(projectRoot, 'src/cantelop.ts') })],
      outfile: join(output, 'cli.mjs'),
    });
    const origin = 'https://managed.example',
      account = 'acc_' + 'a'.repeat(32),
      other = 'acc_' + 'b'.repeat(32);
    const env = {
      PATH: '',
      HOME: root,
      JUICED_MODE: 'managed',
      JUICED_SERVICE_URL: origin,
      JUICED_CONFIG_HOME: join(root, 'config'),
      JUICED_CREDENTIAL_STORE: 'file',
      GH_TOKEN: 'fixture-token',
    };
    const store = new CredentialStore(origin, env);
    await store.write({
      origin,
      accessToken: 'a'.repeat(40),
      refreshToken: 'b'.repeat(40),
      expiresAt: Date.now() + 300000,
      account,
    });
    const bootstrap = join(output, 'run.mjs');
    await writeFile(
      bootstrap,
      `
 import assert from 'node:assert/strict';let runtime;const calls=[];
 globalThis.fetch=async(input,init)=>{
 const r=new Request(input,init),u=new URL(r.url);
 if(u.origin==='https://api.github.com')return Response.json({login:'octocat'});
 assert.equal(u.origin,${JSON.stringify(origin)});assert.equal(r.headers.get('authorization'),'Bearer '+'a'.repeat(40));
 if(u.pathname==='/v1/me')return Response.json({userId:'user',deviceId:'device',accounts:[{id:${JSON.stringify(account)},status:'active',entitlement:'active'},{id:${JSON.stringify(other)},status:'active',entitlement:'active'}]});
 const selected=u.pathname.split('/')[3],installation='jin_'+(selected===${JSON.stringify(account)}?'a':'b').repeat(32);
 if(u.pathname.endsWith('/bootstrap')){const body=await r.json();runtime=body.runtimeId;assert.equal(typeof runtime,'string');assert.ok(runtime.length>20);return Response.json({id:installation,status:'ready',runtimeId:runtime,minimumCli:'0.2.0',error:null,operationId:'provision:'+installation});}
 assert.equal(r.headers.get('x-juiced-installation'),installation);assert.equal(r.headers.get('x-cantelop-session-runtime'),runtime);
 const body=await r.json();assert.equal(body.workspace,null);assert.equal(body.session,null);assert.ok(['app.environment.set','app.environment.status'].includes(body.command.type));calls.push({account:selected,installation,type:body.command.type});
 return Response.json({protocolVersion:2,id:body.id,revision:2,status:body.command.type==='app.environment.set'?'pending':'applied'});
 };
 process.on('exit',()=>process.stdout.write(JSON.stringify(calls)+'\\n'));await import('./cli.mjs');
 `,
    );
    for (const selected of [account, other]) {
      const result = await execute(
        process.execPath,
        [bootstrap, '--account', selected, 'claude', 'github-configure'],
        { cwd: root, env, timeout: 6000 },
      );
      const calls = JSON.parse(result.stdout) as { account: string; installation: string }[];
      assert.equal(calls.length, 2);
      assert.ok(calls.every((c) => c.account === selected));
      assert.equal(calls[0]!.installation, 'jin_' + (selected === account ? 'a' : 'b').repeat(32));
      assert.doesNotMatch(result.stderr, /fixture-token|aaaaaaaaaaaaaaaaaaaa/);
    }
  },
);
