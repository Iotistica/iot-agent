/**
 * Network interface discovery for Network tab and firewall rule editor.
 * Server-side only: systeminformation requires Node.js.
 */
import systeminformation from 'systeminformation';

export interface NetworkInterfaceInfo {
	name: string;
	ip4: string | null;
	ip6: string | null;
	mac: string | null;
	type: string | null;
	default: boolean;
	virtual: boolean;
	operstate: string | null;
	ssid?: string;
	signalLevel?: number;
}

export interface NetworkInterfaceOption {
  value: string;
  label: string;
  disabled: boolean;
}

// Cache network interfaces briefly so state changes become visible.
let cachedNetworkInterfaces: { ts: number; data: NetworkInterfaceInfo[] } | null = null;

/** Get network interfaces and details. */
export async function getNetworkInterfaces(): Promise<NetworkInterfaceInfo[]> {
	const now = Date.now();
	if (cachedNetworkInterfaces && now - cachedNetworkInterfaces.ts < 30_000) {
		return cachedNetworkInterfaces.data;
	}
	
	try {
		const interfaces = await systeminformation.networkInterfaces();
		const defaultIface = await systeminformation.networkInterfaceDefault();

		const formatted = interfaces.map((iface) => {
			const base: NetworkInterfaceInfo = {
				name: iface.iface,
				ip4: iface.ip4 || null,
				ip6: iface.ip6 || null,
				mac: iface.mac || null,
				type: iface.type || null,
				default: iface.iface === defaultIface,
				virtual: iface.virtual || false,
				operstate: iface.operstate || null,
			};

			// Add Wi-Fi details when present.
			if ('ssid' in iface && typeof iface.ssid === 'string') {
				base.ssid = iface.ssid;
			}
			if ('signalLevel' in iface && typeof iface.signalLevel === 'number') {
				base.signalLevel = iface.signalLevel;
			}

			return base;
		});

		// Cache with timestamp for TTL.
		cachedNetworkInterfaces = { ts: now, data: formatted };
		return formatted;
	} catch (_error) {
		// Do not cache failures.
		return [];
	}
}

/** Options for the Add Inbound Rule interface dropdown.
 * Include all interfaces, including docker0 and loopback, for visibility.
 * Blank value in the form means no interface restriction.
 */
export async function getFirewallInterfaceOptions(): Promise<NetworkInterfaceOption[]> {
	const interfaces = await getNetworkInterfaces();
	return interfaces.map((iface) => ({
		value: iface.name,
		label: `${iface.name}${iface.ip4 ? ` (${iface.ip4})` : ''}${iface.operstate ? ` — ${iface.operstate}` : ''}`,
		disabled: false,
	}));
}
