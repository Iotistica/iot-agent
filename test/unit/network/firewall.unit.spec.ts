import { AgentFirewall } from '../../../src/network/firewall';
import type { Rule } from '../../../src/lib/iptables';
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
});
