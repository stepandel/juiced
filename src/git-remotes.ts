import { git, gitText, GitError } from './git.js';

export type GitRemoteConfiguration = {
  branch: string | null;
  remotes: { name: string; urls: string[]; pushUrls: string[] }[];
  tracking: { remote?: string; merge?: string; pushRemote?: string };
  pushDefault?: string;
};
const remoteName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);

/** Convert GitHub SSH URLs for token authentication; never transfer embedded credentials or local paths. */
function portableRemoteURL(value: string): string {
  const scp = /^git@github\.com:([^\s?#]+)$/i.exec(value);
  if (scp) return portableRemoteURL(`https://github.com/${scp[1]}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Git remotes must use portable HTTPS or SSH URLs.'); }
  if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash ||
      /[\0\r\n]/.test(value) || (url.protocol === 'https:' && url.username)) throw new Error('Git remote URLs must not contain credentials, query strings, or local paths.');
  if (url.protocol === 'ssh:' && url.hostname.toLowerCase() === 'github.com' && url.username === 'git' && !url.port) return portableRemoteURL(`https://github.com${url.pathname}`);
  return url.href;
}

export function validateRemoteConfiguration(value: GitRemoteConfiguration): void {
  if (!value || (value.branch !== null && (typeof value.branch !== 'string' || !value.branch || value.branch.length > 1024 || /[\0\r\n]/.test(value.branch))) ||
      !Array.isArray(value.remotes) || value.remotes.length > 32 || !value.tracking || typeof value.tracking !== 'object' ||
      JSON.stringify(value).length > 64 * 1024 || new Set(value.remotes.map(remote => remote.name)).size !== value.remotes.length) throw new Error('Invalid Git remote configuration');
  for (const remote of value.remotes) {
    if (!remoteName(remote.name) || !Array.isArray(remote.urls) || !remote.urls.length || remote.urls.length > 8 || !Array.isArray(remote.pushUrls) || remote.pushUrls.length > 8) throw new Error('Invalid Git remote');
    for (const url of [...remote.urls, ...remote.pushUrls]) if (typeof url !== 'string' || portableRemoteURL(url) !== url) throw new Error('Invalid Git remote URL');
  }
  const names = new Set(value.remotes.map(remote => remote.name));
  for (const name of [value.tracking.remote, value.tracking.pushRemote, value.pushDefault]) if (name !== undefined && (!remoteName(name) || !names.has(name))) throw new Error('Git tracking configuration refers to an unavailable remote');
  if (value.tracking.merge !== undefined && (typeof value.tracking.merge !== 'string' || !value.tracking.merge.startsWith('refs/heads/') || /[\0\r\n]/.test(value.tracking.merge))) throw new Error('Invalid Git upstream branch');
  if (value.branch === null && Object.keys(value.tracking).length) throw new Error('Detached Git snapshots cannot have branch tracking settings');
}

export async function readRemoteConfiguration(root: string, branch: string | null): Promise<GitRemoteConfiguration> {
  const config = async (key: string) => gitText(root, ['config', '--get', key]).catch(error => { if (error instanceof GitError && error.code === 1) return undefined; throw error; });
  const names = (await gitText(root, ['remote'])).split('\n').filter(Boolean);
  const remotes: GitRemoteConfiguration['remotes'] = [];
  for (const name of names) {
    if (!remoteName(name)) throw new Error('Git remote names must contain only letters, numbers, dots, underscores, or hyphens.');
    const urls = (await gitText(root, ['remote', 'get-url', '--all', name])).split('\n').map(portableRemoteURL);
    const push = await gitText(root, ['config', '--get-all', `remote.${name}.pushurl`]).catch(error => { if (error instanceof GitError && error.code === 1) return ''; throw error; });
    const pushUrls = push ? (await gitText(root, ['remote', 'get-url', '--push', '--all', name])).split('\n').map(portableRemoteURL) : [];
    remotes.push({ name, urls, pushUrls });
  }
  const tracking: GitRemoteConfiguration['tracking'] = {};
  if (branch) {
    for (const field of ['remote', 'merge', 'pushRemote'] as const) {
      const value = await config(`branch.${branch}.${field}`);
      // A local upstream (remote='.') has no equivalent in the separate checkout.
      if (value !== undefined && value !== '.') tracking[field] = value;
    }
    if (!tracking.remote) delete tracking.merge;
  }
  const pushDefault = await config('remote.pushDefault');
  const result: GitRemoteConfiguration = { branch, remotes, tracking, ...(pushDefault ? { pushDefault } : {}) };
  validateRemoteConfiguration(result);
  return result;
}

export async function applyRemoteConfiguration(root: string, next: GitRemoteConfiguration, previous?: GitRemoteConfiguration, signal?: AbortSignal) {
  validateRemoteConfiguration(next);
  if (previous) validateRemoteConfiguration(previous);
  const run = (args: string[]) => git(root, args, signal ? { signal } : {});
  if (next.branch) await run(['check-ref-format', '--branch', next.branch]);
  if (next.tracking.merge) await run(['check-ref-format', next.tracking.merge]);
  const set = async (key: string, values: string[]) => {
    await run(['config', '--local', '--unset-all', key]).catch(error => { if (!(error instanceof GitError) || ![1, 5].includes(error.code)) throw error; });
    for (const value of values) await run(['config', '--local', '--add', key, value]);
  };
  const existing = new Set((await gitText(root, ['remote'])).split('\n'));
  for (const remote of previous?.remotes ?? []) if (!next.remotes.some(item => item.name === remote.name) && existing.has(remote.name)) await run(['remote', 'remove', remote.name]);
  for (const remote of next.remotes) {
    await set(`remote.${remote.name}.url`, remote.urls);
    await set(`remote.${remote.name}.pushurl`, remote.pushUrls);
    await set(`remote.${remote.name}.fetch`, [`+refs/heads/*:refs/remotes/${remote.name}/*`]);
  }
  if (next.branch) for (const field of ['remote', 'merge', 'pushRemote'] as const) await set(`branch.${next.branch}.${field}`, next.tracking[field] ? [next.tracking[field]!] : []);
  if (next.pushDefault || previous?.pushDefault) await set('remote.pushDefault', next.pushDefault ? [next.pushDefault] : []);
}
