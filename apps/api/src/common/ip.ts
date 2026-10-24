import { isIP } from 'node:net';

/** Dependency-free IPv4/IPv6 math on BigInt. */

export interface ParsedCidr {
  version: 4 | 6;
  network: bigint;
  prefixLength: number;
  bits: number;
}

export function ipToBigInt(addr: string): { version: 4 | 6; value: bigint } {
  const v = isIP(addr);
  if (v === 4) {
    return { version: 4, value: addr.split('.').reduce((acc, o) => (acc << 8n) + BigInt(Number(o)), 0n) };
  }
  if (v === 6) {
    let [head, tail] = addr.split('::') as [string, string | undefined];
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
    // embedded IPv4 in last group
    const expandV4 = (parts: string[]) => {
      const last = parts[parts.length - 1];
      if (last && last.includes('.')) {
        const n = ipToBigInt(last).value;
        parts.splice(parts.length - 1, 1, ((n >> 16n) & 0xffffn).toString(16), (n & 0xffffn).toString(16));
      }
      return parts;
    };
    expandV4(t.length ? t : h);
    const fill = addr.includes('::') ? 8 - h.length - t.length : 0;
    const groups = [...h, ...Array(fill).fill('0'), ...t];
    if (groups.length !== 8) throw new Error(`Invalid IPv6 address: ${addr}`);
    return { version: 6, value: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n) };
  }
  throw new Error(`Invalid IP address: ${addr}`);
}

export function bigIntToIp(value: bigint, version: 4 | 6): string {
  if (version === 4) {
    return [24n, 16n, 8n, 0n].map((s) => ((value >> s) & 0xffn).toString()).join('.');
  }
  const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt((7 - i) * 16)) & 0xffffn));
  // RFC 5952: compress the longest run (>=2) of zero groups.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/** Canonical textual form (lowercase, compressed IPv6). */
export function normalizeIp(addr: string): string {
  const { version, value } = ipToBigInt(addr.trim());
  return bigIntToIp(value, version);
}

export function parseCidr(cidr: string): ParsedCidr {
  const [addr, prefixStr] = cidr.trim().split('/');
  const { version, value } = ipToBigInt(addr);
  const bits = version === 4 ? 32 : 128;
  const prefixLength = Number(prefixStr);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > bits) throw new Error(`Invalid prefix in ${cidr}`);
  const hostBits = BigInt(bits - prefixLength);
  const network = (value >> hostBits) << hostBits;
  if (network !== value) throw new Error(`${cidr} has host bits set; did you mean ${bigIntToIp(network, version)}/${prefixLength}?`);
  return { version, network, prefixLength, bits };
}

export function cidrContains(cidr: string, addr: string): boolean {
  const c = parseCidr(cidr);
  const a = ipToBigInt(addr);
  if (a.version !== c.version) return false;
  const hostBits = BigInt(c.bits - c.prefixLength);
  return a.value >> hostBits === c.network >> hostBits;
}

export interface EnumerateOptions {
  start?: string;
  end?: string;
  exclude?: string[];
  limit: number;
}

/**
 * Lists usable host addresses in a subnet (or a sub-range of it).
 * IPv4: skips network/broadcast for prefixes < 31. IPv6: skips the subnet-router anycast (::0).
 * Throws if the range exceeds `limit`, so large IPv6 prefixes must be imported as explicit ranges.
 */
export function enumerateHosts(cidr: string, opts: EnumerateOptions): string[] {
  const c = parseCidr(cidr);
  const size = 1n << BigInt(c.bits - c.prefixLength);
  let first = c.network;
  let last = c.network + size - 1n;
  if (c.version === 4 && c.prefixLength < 31) {
    first += 1n;
    last -= 1n;
  }
  if (c.version === 6) first += 1n;
  if (opts.start) {
    if (!cidrContains(cidr, opts.start)) throw new Error(`${opts.start} is outside ${cidr}`);
    first = ipToBigInt(opts.start).value > first ? ipToBigInt(opts.start).value : first;
  }
  if (opts.end) {
    if (!cidrContains(cidr, opts.end)) throw new Error(`${opts.end} is outside ${cidr}`);
    last = ipToBigInt(opts.end).value < last ? ipToBigInt(opts.end).value : last;
  }
  if (last < first) return [];
  if (last - first + 1n > BigInt(opts.limit)) {
    throw new Error(`Range contains ${last - first + 1n} addresses; limit is ${opts.limit}. Import a narrower start/end range.`);
  }
  const excluded = new Set((opts.exclude ?? []).map((e) => ipToBigInt(e).value));
  const out: string[] = [];
  for (let v = first; v <= last; v++) if (!excluded.has(v)) out.push(bigIntToIp(v, c.version));
  return out;
}
