import { utimes, writeFile } from 'node:fs/promises';
import { nulStrings, type inspectionGit } from './inspection-git.js';

type Run = Awaited<ReturnType<typeof inspectionGit>>['run'];

/** Reuse ordinary Git stat entries without inheriting flags that hide changes. */
export async function seedInspectionIndex(
  run: Run,
  { staged, original, indexMtime, paths, env, flagged, autocrlf }: {
    staged: Buffer; original: Buffer; indexMtime: bigint | undefined;
    paths: Buffer; env: NodeJS.ProcessEnv; flagged: string[]; autocrlf: Buffer;
  },
) {
  const entries = nulStrings(staged);
  // Filters can depend on attributes, configuration, or external state even when
  // a file's stat is unchanged. Keep the fresh-hash path for converted contents.
  const automatic = autocrlf.length > 0 && autocrlf.toString().trim().toLowerCase() !== 'false';
  const attributes = automatic ? Buffer.alloc(0) : await run(['check-attr', '--all', '-z', '--stdin'], { input: paths });
  const converts = automatic || /\0(?:filter|text|eol|crlf|ident|working-tree-encoding)\0/.test(attributes.toString());
  if (!original.length || indexMtime === undefined || converts || entries.some(entry => !/^\d+ [a-f0-9]+ 0\t/.test(entry))) {
    await run(['update-index', '-z', '--index-info'], { input: staged, env });
    return;
  }
  await writeFile(env.GIT_INDEX_FILE!, original);
  // A newly written copy would make racy source entries look older than the
  // index. Start no later than the source mtime; Git's index writer then smudges
  // those entries normally when clearing flags. Round down with a 1 ms margin.
  const timestamp = Number(indexMtime / 1_000_000n - 1n) / 1000;
  await utimes(env.GIT_INDEX_FILE!, timestamp, timestamp);
  await run(['update-index', '--no-split-index', '--no-fsmonitor', '--no-untracked-cache'], { env });
  // ls-files -v reports these flags alongside the stage data we already need.
  // Ordinary checkouts need neither of these index rewrites.
  for (const [option, selected] of [
    ['--no-assume-unchanged', flagged.filter(entry => /^[a-z]/.test(entry))],
    ['--no-skip-worktree', flagged.filter(entry => /^[Ss]/.test(entry))],
  ] as const) {
    if (selected.length) await run(['update-index', option, '-z', '--stdin'], {
      input: Buffer.from(selected.map(entry => entry.slice(entry.indexOf('\t') + 1)).join('\0') + '\0'), env,
    });
  }
}
