export interface Invocation {
  account?: string;
  service?: string;
  args: string[];
  command?: 'login' | 'logout' | 'whoami' | 'update' | 'telemetry';
  telemetryAction?: 'status' | 'enable' | 'disable';
  noBrowser?: boolean;
  all?: boolean;
}
export function parseInvocation(input: string[], env: NodeJS.ProcessEnv = process.env): Invocation {
  if (env.JUICED_MODE && env.JUICED_MODE !== 'managed')
    throw new Error('JUICED_MODE is no longer supported. Sign in with juiced login.');
  const result: Invocation = { args: [] };
  let n = 0;
  while (n < input.length) {
    const arg = input[n]!;
    if (arg === '--self-managed') {
      throw new Error('--self-managed is no longer supported. Sign in with juiced login.');
    } else if (arg === '--service' || arg.startsWith('--service=')) {
      if (result.service !== undefined) throw new Error('Pass --service only once.');
      result.service = arg === '--service' ? (input[++n] ?? '') : arg.slice(10);
      n++;
      if (!result.service) throw new Error('--service requires an HTTPS URL.');
    } else if (arg === '--account' || arg.startsWith('--account=')) {
      if (result.account !== undefined) throw new Error('Pass --account only once.');
      result.account = arg === '--account' ? (input[++n] ?? '') : arg.slice(10);
      n++;
      if (!/^acc_[a-f0-9]{32}$/.test(result.account)) throw new Error('Invalid Juiced account ID.');
    } else if (arg === '--workspace') {
      result.args.push(arg, input[n + 1] ?? '');
      n += 2;
    } else if (arg.startsWith('--workspace=')) {
      result.args.push(arg);
      n++;
    } else break;
  }
  const rest = input.slice(n);
  if (['login', 'logout', 'whoami', 'update', 'telemetry'].includes(rest[0] ?? '')) {
    if (result.args.length) throw new Error('Account commands do not accept --workspace.');
    result.command = rest[0] as NonNullable<Invocation['command']>;
    if (result.command === 'telemetry') {
      if (rest.length > 2 || (rest[1] !== undefined && !['status', 'enable', 'disable'].includes(rest[1])))
        throw new Error('Usage: juiced telemetry [status|enable|disable]');
      result.telemetryAction = (rest[1] ?? 'status') as 'status' | 'enable' | 'disable';
      return result;
    }
    const flags = rest.slice(1),
      allowed =
        result.command === 'login'
          ? '--no-browser'
          : result.command === 'logout'
            ? '--all'
            : undefined;
    if (flags.length > 1 || (flags.length === 1 && flags[0] !== allowed))
      throw new Error(`Usage: juiced ${result.command}${allowed ? ` [${allowed}]` : ''}`);
    if (allowed === '--no-browser') result.noBrowser = flags.length === 1;
    if (allowed === '--all') result.all = flags.length === 1;
  } else result.args.push(...rest);
  return result;
}
