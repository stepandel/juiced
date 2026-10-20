import { BlockList, isIP } from 'node:net';
/** The socket peer is authoritative. Forwarded chains are usable only when
 * that peer belongs to an explicitly configured proxy CIDR. */
export function clientIP(peer: string | undefined, forwarded: string | null, trusted: string[]) {
  const list = new BlockList();
  for (const entry of trusted) {
    const [address, prefix] = entry.split('/');
    const kind = isIP(address ?? '');
    if (!kind) throw new Error('Invalid trusted proxy CIDR');
    const n = prefix === undefined ? (kind === 4 ? 32 : 128) : Number(prefix);
    if (!Number.isInteger(n) || n < 0 || n > (kind === 4 ? 32 : 128))
      throw new Error('Invalid trusted proxy CIDR');
    list.addSubnet(address!, n, kind === 4 ? 'ipv4' : 'ipv6');
  }
  const normalized = (v: string) => (v.startsWith('::ffff:') ? v.slice(7) : v);
  const address = normalized(peer ?? '');
  if (!isIP(address)) return undefined;
  const isTrusted = (v: string) => list.check(v, isIP(v) === 4 ? 'ipv4' : 'ipv6');
  if (!isTrusted(address) || !forwarded) return address;
  const chain = forwarded.split(',').map((v) => normalized(v.trim()));
  if (chain.length > 20 || chain.some((v) => !isIP(v))) return address;
  let current = address;
  for (let n = chain.length - 1; n >= 0 && isTrusted(current); n--) current = chain[n]!;
  return current;
}
