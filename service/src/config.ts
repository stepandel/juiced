export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export function required(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}
export function origin(value: string, development = false) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/' ||
    (u.protocol !== 'https:' &&
      !(
        development &&
        u.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
      ))
  )
    throw new Error('Invalid service origin');
  return u.origin;
}
export function config(env: NodeJS.ProcessEnv = process.env) {
  const development = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  if (
    !development &&
    [
      'JUICED_GITHUB_CLIENT_ID',
      'JUICED_GITHUB_CLIENT_SECRET',
      'JUICED_GOOGLE_CLIENT_ID',
      'JUICED_GOOGLE_CLIENT_SECRET',
    ].some((k) => !env[k])
  )
    throw new Error('GitHub and Google sign-in must both be configured');
  const secret = required(env, 'JUICED_AUTH_SECRET');
  if (secret.length < 32) throw new Error('JUICED_AUTH_SECRET must contain at least 32 characters');
  return {
    origin: origin(required(env, 'JUICED_SERVICE_URL'), development),
    secret,
    databaseUrl: required(env, 'JUICED_DATABASE_URL'),
    githubId: env.JUICED_GITHUB_CLIENT_ID,
    githubSecret: env.JUICED_GITHUB_CLIENT_SECRET,
    googleId: env.JUICED_GOOGLE_CLIENT_ID,
    googleSecret: env.JUICED_GOOGLE_CLIENT_SECRET,
    development,
    admissionEnabled:
      env.JUICED_ADMISSION_ENABLED === 'true' ||
      (development && env.JUICED_ADMISSION_ENABLED !== 'false'),
  };
}
export type Config = ReturnType<typeof config>;
export async function readText(request: Request, max: number) {
  if (!request.body) return '';
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > max) {
        await reader.cancel();
        throw new ServiceError('request_too_large', 413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
