import { AgentFirewall } from '../../../src/network/firewall';
import { normalizeSystemFirewallRules } from '../../../src/api/network';
import { RuleAction, type Rule } from '../../../src/lib/iptables';
import type { AgentLogger } from '../../../src/logging/agent-logger';

describe('AgentFirewall', () => {
	it('allows SSH through the active firewall', () => {
		const firewall = new AgentFirewall({
			enabled: true,
			mode: 'on',
			deviceApiPort: 48484,
		}, {} as AgentLogger);
		const rules = (firewall as unknown as { getBaseRules: () => Rule[] }).getBaseRules();

		expect(rules).toContainEqual(expect.objectContaining({
			action: '-A',
			proto: 'tcp',
			matches: ['--dport 22'],
			target: 'ACCEPT',
		}));
	});

	it('returns inactive rules until enabled firewall initialization succeeds', async () => {
		const firewall = new AgentFirewall({
			enabled: true,
			mode: 'on',
			deviceApiPort: 48484,
			mqttPort: 1883,
			allowedLanNetworks: ['192.0.2.0/24'],
			allowedLanNetworksV6: ['2001:db8:1::/64'],
			allowedDockerNetworks: ['172.17.0.0/16'],
		}, {} as AgentLogger);

		const inactiveRules = await firewall.getSystemRules();
		expect(inactiveRules.at(-1)?.target).toBe('RETURN');
		expect(inactiveRules.some((rule) => rule.comment?.includes('Device API'))).toBe(false);

		(firewall as unknown as { initialized: boolean }).initialized = true;
		const activeRules = await firewall.getSystemRules();

		expect(activeRules).toContainEqual(expect.objectContaining({
			comment: 'Allow Device API IPv4 LAN 192.0.2.0/24',
			family: 4,
			matches: ['--dport 48484', '-s 192.0.2.0/24'],
			target: 'ACCEPT',
		}));
		expect(activeRules).toContainEqual(expect.objectContaining({
			comment: 'Allow Device API IPv6 LAN 2001:db8:1::/64',
			family: 6,
			matches: ['--dport 48484', '-s 2001:db8:1::/64'],
			target: 'ACCEPT',
		}));
		expect(activeRules).toContainEqual(expect.objectContaining({
			comment: 'MQTT Docker 172.17.0.0/16',
			family: 4,
			proto: 'tcp',
			matches: ['-i docker0', '--dport 1883', '-s 172.17.0.0/16'],
			target: 'ACCEPT',
		}));
		expect(activeRules.at(-1)?.target).toBe('REJECT');
	});

	it('normalizes generated rules for the firewall grid', () => {
		const rules = normalizeSystemFirewallRules([
			{
				comment: 'Allow IPv6 service',
				action: RuleAction.Append,
				family: 6,
				matches: ['--dport 8443', '-s 2001:db8::/32'],
				target: 'ACCEPT',
			},
			{
				comment: 'Allow MQTT from Docker',
				action: RuleAction.Append,
				family: 4,
				proto: 'tcp',
				matches: ['-i docker0', '--dport 1883', '-s 172.17.0.0/16'],
				target: 'ACCEPT',
			},
			{
				comment: 'Firewall disabled',
				action: RuleAction.Append,
				target: 'RETURN',
			},
		]);

		expect(rules[0]).toMatchObject({
			id: 'system-1',
			source: 'system',
			port: '8443',
			protocol: 'ALL',
			action: 'ACCEPT',
			interface_name: null,
			description: 'Allow IPv6 service (source 2001:db8::/32)',
			created_at: null,
			isFinal: false,
		});
		expect(rules[1]).toMatchObject({
			port: '1883',
			protocol: 'TCP',
			interface_name: 'docker0',
			description: 'Allow MQTT from Docker (IPv4, source 172.17.0.0/16)',
			isFinal: false,
		});
		expect(rules[2]).toMatchObject({
			port: 'Any',
			protocol: 'ALL',
			action: 'RETURN',
			isFinal: true,
		});
	});
});
