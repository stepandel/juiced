import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createCantelopCompilerPlugin } from '@cantelop/sdk/build';
import { CredentialStore } from '../src/account/store.js';
const execute = promisify(execFile);
test(
  'built managed CLI pins account, installation, device token and compiled runtime without Cantelop credentials',
  { timeout: 60_000 },
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
      define: { JUICED_VERSION: JSON.stringify('0.2.1'), JUICED_INSTALLER_SOURCE: JSON.stringify('exec "$FIXTURE_NODE" "$FIXTURE_INSTALLER" "$@"\n') },
      plugins: [createCantelopCompilerPlugin({ definition: join(projectRoot, 'src/cantelop.ts') })],
      outfile: join(output, 'cli.mjs'),
    });
    const origin = 'https://managed.example',
      account = 'acc_' + 'a'.repeat(32),
      other = 'acc_' + 'b'.repeat(32);
    const env = {
      PATH: '',
      HOME: root,
      JUICED_SERVICE_URL: origin,
      JUICED_CONFIG_HOME: join(root, 'config'),
      GH_TOKEN: 'fixture-token',
    };
    const store = new CredentialStore(origin, env);
    const offlineEnv = { ...env, JUICED_SERVICE_URL: '', JUICED_CONFIG_HOME: join(root, 'offline-config') };
    const built = join(output, 'cli.mjs');
    const version = await execute(process.execPath, [built, '--version'], { env: offlineEnv });
    assert.equal(version.stdout, 'juiced 0.2.1\n');
    assert.equal(version.stderr, '');
    await execute(process.execPath, [built, '--help'], { env: offlineEnv });
    await assert.rejects(readFile(join(offlineEnv.JUICED_CONFIG_HOME, 'telemetry.json')), { code: 'ENOENT' });
    for (const [action, expected] of [['disable', 'disabled'], ['status', 'disabled'], ['enable', 'enabled']]) {
      const result = await execute(process.execPath, [built, 'telemetry', action!], { env: offlineEnv });
      assert.equal(result.stdout, `Juiced telemetry is ${expected}.\n`);
      assert.equal(result.stderr, '');
    }
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
 if(u.pathname==='/v1/telemetry')return new Response(null,{status:204});
 if(u.origin==='https://api.github.com')return Response.json({login:'octocat'});
 assert.equal(u.origin,${JSON.stringify(origin)});assert.equal(r.headers.get('authorization'),'Bearer '+'a'.repeat(40));
 if(u.pathname==='/v1/me')return Response.json({userId:'user',deviceId:'device',accounts:[{id:${JSON.stringify(account)},status:'active',entitlement:'active'},{id:${JSON.stringify(other)},status:'active',entitlement:'active'}]});
 if(u.pathname==='/v1/logout'){const body=await r.json();calls.push({type:'logout',all:body.all});return process.env.TEST_LOGOUT_FAILURE?Response.json({error:'service_unavailable'},{status:503}):Response.json({revoked:true});}
 const selected=u.pathname.split('/')[3],installation='jin_'+(selected===${JSON.stringify(account)}?'a':'b').repeat(32);
 if(u.pathname.endsWith('/bootstrap')){if(process.env.TEST_UPGRADE_REQUIRED)return Response.json({error:'cli_upgrade_required'},{status:409});const body=await r.json();runtime=body.runtimeId;assert.equal(typeof runtime,'string');assert.ok(runtime.length>20);return Response.json({id:installation,status:'ready',runtimeId:runtime,minimumCli:'0.2.0',error:null,operationId:'provision:'+installation});}
 assert.equal(r.headers.get('x-juiced-installation'),installation);assert.equal(r.headers.get('x-cantelop-session-runtime'),runtime);
 const body=await r.json();assert.equal(body.workspace,null);assert.equal(body.session,null);assert.ok(['app.environment.set','app.environment.status'].includes(body.command.type));if(process.env.TEST_RUNTIME_MISMATCH)return Response.json({error:'session_runtime_mismatch'},{status:409,headers:{'X-Juiced-Error':'1'}});calls.push({account:selected,installation,type:body.command.type});
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
    for (const failure of ['TEST_UPGRADE_REQUIRED', 'TEST_RUNTIME_MISMATCH']) {
      await assert.rejects(execute(process.execPath, [bootstrap, 'claude', 'github-configure'], {
        cwd: root, env: { ...env, [failure]: '1' }, timeout: 6000,
      }), error => {
        assert.match((error as { stderr: string }).stderr, /CLI and the service runtime are incompatible[\s\S]*source or package-manager installation[\s\S]*juiced update[\s\S]*curl -fsSL/);
        return true;
      });
    }
    await t.test('installed inspection uses the bootstrap release and keeps the config fallback for old services', async () => {
      const project = join(root, 'inspection');
      await mkdir(project);
      const git = async (...args: string[]) => execute('git', ['-C', project, ...args]);
      await git('init', '-b', 'main');
      await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test');
      await writeFile(join(project, 'README.md'), 'fixture\n');
      await git('add', '.'); await git('commit', '-m', 'fixture');
      const installed = join(output, 'inspection-data/releases/old'), bin = join(output, 'inspection-bin');
      await mkdir(join(installed, 'bin'), { recursive: true }); await mkdir(bin);
      await copyFile(built, join(installed, 'bin/juiced.mjs'));
      await writeFile(join(installed, 'release.json'), JSON.stringify({ version: '0.2.1', platform: process.platform, arch: process.arch }));
      await writeFile(join(installed, 'install-paths'), `${join(output, 'inspection-data')}\0${bin}\0`);
      await writeFile(join(installed, 'bin/juiced'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await symlink(join(installed, 'bin/juiced'), join(bin, 'juiced'));
      const mock = join(output, 'inspection-fetch.mjs');
      await writeFile(mock, `
import assert from 'node:assert/strict';const calls=[],fetcher=globalThis.fetch;let runtime;
globalThis.fetch=async(input,init)=>{const r=new Request(input,init),u=new URL(r.url);if(u.protocol==='data:')return fetcher(input,init);calls.push(u.pathname);
if(u.pathname==='/v1/config'){assert.equal(process.env.TEST_OLD_SERVICE,'1');return Response.json({cliVersion:'0.2.1'});}
if(u.pathname.endsWith('/bootstrap')){runtime=(await r.json()).runtimeId;return Response.json({id:'jin_'+'a'.repeat(32),status:'ready',runtimeId:runtime,minimumCli:'0.2.0',error:null,operationId:'test',...(process.env.TEST_OLD_SERVICE?{}:{cliVersion:'0.2.1'})});}
const body=await r.json();assert.equal(body.command.type,'workspace.inspect');assert.equal(r.headers.get('x-cantelop-session-runtime'),runtime);return Response.json({protocolVersion:2,workspace:null});};
process.on('exit',()=>process.stderr.write(JSON.stringify(calls)+'\\n'));
`);
      for (const old of [false, true]) {
        await assert.rejects(execute(process.execPath, ['--import', mock, join(installed, 'bin/juiced.mjs'), 'claude', 'peek'], {
          cwd: project, env: { ...env, PATH: process.env.PATH, JUICED_TELEMETRY_DISABLED: '1', ...(old ? { TEST_OLD_SERVICE: '1' } : {}) }, timeout: 6000,
        }), error => {
          const result = error as { code: number; stdout: string; stderr: string };
          assert.equal(result.code, 2, result.stderr);
          assert.match(result.stdout, /does not exist/);
          const calls = JSON.parse(result.stderr.trim());
          assert.equal(calls.length, old ? 3 : 2);
          assert.equal(calls[0], '/v1/accounts/' + account + '/bootstrap');
          assert.equal(calls.includes('/v1/config'), old);
          return true;
        });
      }
    });
    await t.test('installed CLI updates before work, retries bootstrap and avoids replaying started commands', async () => {
      const install = join(output, 'data'), old = join(install, 'releases/old'), bin = join(output, 'bin');
      await mkdir(join(old, 'bin'), { recursive: true });
      await mkdir(bin);
      await copyFile(join(output, 'cli.mjs'), join(old, 'bin/juiced.mjs'));
      await writeFile(join(old, 'release.json'), JSON.stringify({ version: '0.2.1', platform: process.platform, arch: process.arch }));
      await writeFile(join(old, 'install-paths'), `${install}\0${bin}\0`);
      await writeFile(join(old, 'bin/juiced'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const installer = join(output, 'install.mjs'), replacement = join(output, 'replacement.mjs');
      await writeFile(installer, `
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';import {join} from 'node:path';
const version=process.argv[2],root=join(process.env.JUICED_INSTALL_DIR,'releases',version);
await mkdir(join(root,'bin'),{recursive:true});
await writeFile(join(root,'release.json'),JSON.stringify({version,platform:process.platform,arch:process.arch}));
await writeFile(join(root,'bin/juiced'),'#!/bin/sh\\nexec "$FIXTURE_NODE" "$FIXTURE_REPLACEMENT" "$@"\\n',{mode:0o755});
const temp=join(process.env.JUICED_BIN_DIR,'new-link');await symlink(join(root,'bin/juiced'),temp);await rename(temp,join(process.env.JUICED_BIN_DIR,'juiced'));
`);
      await writeFile(replacement, `let input='';for await(const chunk of process.stdin)input+=chunk;process.stdout.write(JSON.stringify({args:process.argv.slice(2),input}));process.exitCode=7;`);
      const mock = join(output, 'update-fetch.mjs');
      await writeFile(mock, `
import assert from 'node:assert/strict';let checks=0,runtime;
globalThis.fetch=async(input,init)=>{const r=new Request(input,init),u=new URL(r.url),mode=process.env.FIXTURE_MODE;
if(u.pathname==='/v1/config'){assert.notEqual(mode,'inspection','Inspection must use the bootstrap recommendation');assert.equal(r.headers.has('authorization'),false);return Response.json({cliVersion:mode==='startup'||++checks>1?'0.2.2':'0.2.1'});}
assert.notEqual(mode,'startup','Update must precede authenticated work');
if(u.origin==='https://api.github.com')return Response.json({login:'octocat'});
if(u.pathname==='/v1/me')return Response.json({userId:'user',deviceId:'device',accounts:[{id:${JSON.stringify(account)},status:'active',entitlement:'active'}]});
if(u.pathname.endsWith('/bootstrap')){if(mode==='bootstrap')return Response.json({error:'cli_upgrade_required'},{status:409});runtime=(await r.json()).runtimeId;return Response.json({id:'jin_'+'a'.repeat(32),status:'ready',runtimeId:runtime,minimumCli:'0.2.0',error:null,operationId:'provision:test',...(mode==='inspection'?{cliVersion:'0.2.2'}:{})});}
return Response.json({error:'session_runtime_mismatch'},{status:409,headers:{'X-Juiced-Error':'1'}});
};
`);
      for (const mode of ['startup', 'bootstrap', 'runtime', 'inspection']) {
        await rm(join(bin, 'juiced'), { force: true });
        await symlink(join(old, 'bin/juiced'), join(bin, 'juiced'));
        const args = mode === 'startup' ? ['env', 'set', 'EXAMPLE', '--stdin'] : mode === 'inspection' ? ['claude', 'peek'] : ['claude', 'github-configure'];
        const child = spawn(process.execPath, ['--import', mock, join(old, 'bin/juiced.mjs'), ...args], {
          cwd: root, env: { ...env, FIXTURE_MODE: mode, FIXTURE_NODE: process.execPath, FIXTURE_INSTALLER: installer, FIXTURE_REPLACEMENT: replacement },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdin.end('piped secret\n');
        const code = await new Promise((accept, reject) => { child.on('error', reject); child.on('close', accept); });
        if (mode === 'runtime') {
          assert.equal(code, 1, stderr);
          assert.equal(stdout, '', 'A started command must not be replayed');
          assert.match(stderr, /Updated successfully.*Run your command again/);
        } else {
          assert.equal(code, 7, stderr);
          assert.deepEqual(JSON.parse(stdout), { args, input: 'piped secret\n' });
        }
      }
    });
    await t.test('login reuses the computer sign-in and logout removes it for other terminals', async () => {
      const login = await execute(process.execPath, [bootstrap, 'login', '--no-browser'], { cwd: root, env, timeout: 6000 });
      assert.match(login.stderr, /Already signed in to Juiced/);
      assert.match(login.stderr, /juiced logout/);
      assert.equal((await store.read())?.account, account);

      for (const all of [false, true]) {
        await store.write({ origin, accessToken: 'a'.repeat(40), refreshToken: 'b'.repeat(40), expiresAt: Date.now() + 300000, account });
        const logout = await execute(process.execPath, [bootstrap, 'logout', ...(all ? ['--all'] : [])], { cwd: root, env, timeout: 6000 });
        assert.deepEqual(JSON.parse(logout.stdout), [{ type: 'logout', all }]);
        assert.match(logout.stderr, all ? /Signed out of all Juiced CLI sessions/ : /Signed out of Juiced on this computer/);
        assert.equal(await new CredentialStore(origin, env).read(), undefined);
      }

      await store.write({ origin, accessToken: 'a'.repeat(40), refreshToken: 'b'.repeat(40), expiresAt: Date.now() + 300000, account });
      await assert.rejects(
        execute(process.execPath, [bootstrap, 'logout'], { cwd: root, env: { ...env, TEST_LOGOUT_FAILURE: '1' }, timeout: 6000 }),
        (error) => {
          assert.match((error as { stderr: string }).stderr, /Local credentials removed; server revocation could not be confirmed/);
          return true;
        },
      );
      assert.equal(await store.read(), undefined);
    });
  },
);
