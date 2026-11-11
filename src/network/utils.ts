import { networkInterfaces } from 'node:os';

export interface LocalLanNetworks {
    ipv4: string[];
    ipv6: string[];
}

// Normalize a ULA IPv6 host address and prefix to its actual network CIDR.
function ipv6NetworkCidr(address: string, prefix: number): string | null {
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
	const ip = address.split('%')[0].toLowerCase();
	if (ip.includes('.')) return null; // Ignore IPv4-mapped addresses.
	const halves = ip.split('::');
	if (halves.length > 2) return null;
	const left = halves[0] ? halves[0].split(':') : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	if (halves.length === 1 && left.length !== 8) return null;
	const missing = 8 - left.length - right.length;
	if (missing < (halves.length === 2 ? 1 : 0)) return null;
	const words = [...left, ...Array(missing).fill('0'), ...right];
	if (words.length !== 8 || words.some(w => !/^[0-9a-f]{1,4}$/.test(w))) return null;
	const first = parseInt(words[0], 16);
	if ((first & 0xfe00) !== 0xfc00) return null; // ULA fc00::/7 only.
	let value = words.reduce((n, w) => (n << 16n) | BigInt(parseInt(w, 16)), 0n);
	const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
	value &= mask;
	const normalized = Array.from({ length: 8 }, (_, i) =>
		Number((value >> BigInt((7 - i) * 16)) & 0xffffn).toString(16)
	).join(':');
	return `${normalized}/${prefix}`;
}

/** Detect RFC1918 IPv4 and ULA IPv6 subnets on likely physical LAN interfaces. */
export function getLocalLanNetworks(): LocalLanNetworks {
	const ipv4 = new Set<string>();
	const ipv6 = new Set<string>();
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		// Heuristic only: admins should override detected networks where needed.
		if (/^(lo|docker|br-|veth|tun|tap|wg|tailscale|zt)/i.test(name)) continue;
		for (const address of addresses ?? []) {
			if (address.internal) continue;
			if (address.family === 'IPv4') {
				const parts = address.address.split('.').map(Number);
				const mask = address.netmask.split('.').map(Number);
				if (parts.length !== 4 || mask.length !== 4 ||
                    [...parts, ...mask].some(n => !Number.isInteger(n) || n < 0 || n > 255)) continue;
				const privateIp = parts[0] === 10 ||
                    (parts[0] === 192 && parts[1] === 168) ||
                    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
				if (!privateIp) continue;
				const maskValue = mask.reduce((n, octet) => ((n << 8) | octet) >>> 0, 0);
				const prefix = maskValue.toString(2).padStart(32, '0');
				if (!/^1*0*$/.test(prefix)) continue;
				ipv4.add(`${parts.map((p, i) => p & mask[i]).join('.')}/${prefix.indexOf('0') === -1 ? 32 : prefix.indexOf('0')}`);
			} else if (address.family === 'IPv6') {
				const prefix = Number(address.cidr?.split('/')[1]);
				if (!address.cidr) continue;
				const cidr = ipv6NetworkCidr(address.address, prefix);
				if (cidr) ipv6.add(cidr);
			}
		}
	}
	return { ipv4: [...ipv4], ipv6: [...ipv6] };
}
