/** Compare SemVer CLI versions, including release candidates. Invalid input
 * fails closed, and a prerelease cannot satisfy its stable release's minimum. */
export function cliVersionAtLeast(version: string, minimum: string): boolean {
  const current = parse(version), required = parse(minimum);
  if (!current || !required) return false;
  for (let n = 0; n < 3; n++) {
    if (current.core[n] !== required.core[n]) return current.core[n]! > required.core[n]!;
  }
  if (!current.pre.length) return true;
  if (!required.pre.length) return false;
  for (let n = 0; n < Math.max(current.pre.length, required.pre.length); n++) {
    const a = current.pre[n], b = required.pre[n];
    if (a === b) continue;
    if (a === undefined) return false;
    if (b === undefined) return true;
    const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
    if (numericA !== numericB) return !numericA;
    if (numericA && a.length !== b.length) return a.length > b.length;
    return a > b;
  }
  return true;
}

export function isCliVersion(value: string): boolean {
  return parse(value) !== undefined;
}

function parse(value: string) {
  if (value.length > 128) return;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match[0] !== value) return;
  const core = match.slice(1, 4).map(Number), pre = match[4]?.split('.') ?? [];
  if (!core.every(Number.isSafeInteger) || pre.some(part => /^0\d+$/.test(part))) return;
  return { core, pre };
}
