/**
 * Agent Firewall Manager
 * 
 * Provides network-level security for the IoT agent by managing iptables rules.
 * Protects sensitive services (Device API, MQTT) from unauthorized access.
 * 
 * Modes:
 * - 'on': Strict firewall - only allow whitelisted traffic
 * - 'off': Firewall disabled - allow all traffic
 * - 'auto': Enable firewall only if host-network services are running
 */

import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { build, getDefaultRuleAdaptor, RuleAction, type Rule } from '../lib/iptables';
import { FirewallRuleModel, type FirewallRule } from '../db/models/firewall-rule.model';

export interface FirewallConfig {
  enabled: boolean;
  mode: 'on' | 'off' | 'auto' | 'disabled';
  deviceApiPort: number;
  mqttPort?: number;
  allowedLanNetworks?: string[];
  allowedDockerNetworks?: string[];
}

const FIREWALL_CHAIN = 'IOTISTIC-FIREWALL';
const _USER_CHAIN = 'IOTISTIC-USER';

// Default LAN ranges. Keep Docker separate so container access can be controlled independently.
const DEFAULT_ALLOWED_LAN_NETWORKS = [
	'10.0.0.0/8',
	'192.168.0.0/16',
];

// Default Docker bridge. User-defined bridge networks should be configured explicitly.
const DEFAULT_ALLOWED_DOCKER_NETWORKS = [
	'172.17.0.0/16',
];

export class AgentFirewall {
	private logger: AgentLogger;
	private config: FirewallConfig;
	private initialized: boolean = false;

	constructor(config: FirewallConfig, logger: AgentLogger) {
		this.config = {
			...config,
			allowedLanNetworks: config.allowedLanNetworks || DEFAULT_ALLOWED_LAN_NETWORKS,
			allowedDockerNetworks: config.allowedDockerNetworks || DEFAULT_ALLOWED_DOCKER_NETWORKS,
		};
		this.logger = logger;
	}

	/**
   * Initialize firewall and apply rules
   */
	async initialize(): Promise<void> {
		if (!this.config.enabled) {
			this.logger.debugSync('Firewall disabled by configuration', {
				component: LogComponents.firewall,
			});
			return;
		}


		try {
			await this.applyFirewallRules();
			this.initialized = true;
      
			this.logger.debugSync('Firewall initialized successfully', {
				component: LogComponents.firewall,
				mode: this.config.mode,
			});
		} catch (error) {
			this.logger.errorSync(
				'Failed to initialize firewall',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.firewall,
					note: 'Agent will continue without firewall protection',
				}
			);
		}
	}

	/**
   * Apply iptables firewall rules (protection + user-defined)
   */
	private async applyFirewallRules(): Promise<void> {
		const adaptor = getDefaultRuleAdaptor();

		const isActive = this.config.mode === 'on' ||
                     (this.config.mode === 'auto' && await this.shouldEnableFirewall());

		this.logger.debugSync('Applying firewall rules', {
			component: LogComponents.firewall,
			mode: this.config.mode,
			isActive,
		});

		const { getRulePosition } = await import('../lib/iptables.js');
		const v4Position = await getRulePosition('INPUT', FIREWALL_CHAIN, 4);
		const v6Position = await getRulePosition('INPUT', FIREWALL_CHAIN, 6);

		let userRules: FirewallRule[] = [];
		try {
			userRules = FirewallRuleModel.getAll();
		} catch {
			// DB may not be ready during early init
		}

		await build()
			.forTable('filter', (filter) =>
				filter
					.forChain('INPUT', (chain) => {
						if (v4Position !== -1) {
							chain.addRule({ action: RuleAction.Delete, target: FIREWALL_CHAIN, family: 4 });
						}
						if (v6Position !== -1) {
							chain.addRule({ action: RuleAction.Delete, target: FIREWALL_CHAIN, family: 6 });
						}
						chain.addRule({ action: RuleAction.Insert, id: v4Position > 0 ? v4Position : 1, target: FIREWALL_CHAIN, family: 4 });
						chain.addRule({ action: RuleAction.Insert, id: v6Position > 0 ? v6Position : 1, target: FIREWALL_CHAIN, family: 6 });
						return chain;
					})
					.forChain(FIREWALL_CHAIN, (chain) =>
						chain
							.addRule({ action: RuleAction.Flush })
							.addRule(this.getBaseRules())
							.addRule(this.getUserIptablesRules(userRules))
							.addRule(this.getDeviceApiRules())
							.addRule(this.getMqttRules())
							.addRule(this.getFinalRule(isActive))
					)
			)
			.apply(adaptor);
	}

	/**
   * Base firewall rules (always applied)
   */
	private getBaseRules(): Rule[] {
		return [
			// Allow locally-originated traffic
			{
				comment: 'Allow local traffic',
				action: RuleAction.Append,
				matches: ['-m addrtype', '--src-type LOCAL'],
				target: 'ACCEPT',
			},
			// Allow established/related connections
			{
				comment: 'Allow established connections',
				action: RuleAction.Append,
				matches: ['-m state', '--state ESTABLISHED,RELATED'],
				target: 'ACCEPT',
			},
			// Allow loopback
			{
				comment: 'Allow loopback',
				action: RuleAction.Append,
				matches: ['-i lo'],
				target: 'ACCEPT',
			},
			// Allow ICMP (ping, etc.)
			{
				comment: 'Allow ICMP',
				action: RuleAction.Append,
				proto: 'icmp',
				target: 'ACCEPT',
			},
			// Allow mDNS (multicast DNS)
			{
				comment: 'Allow mDNS',
				action: RuleAction.Append,
				matches: ['-m addrtype', '--dst-type MULTICAST'],
				target: 'ACCEPT',
			},
		];
	}

	/**
   * Device API protection rules
   * Device API is host-local only.
   */
	private getDeviceApiRules(): Rule[] {
		return [
			// Base rules already allow loopback and locally-originated traffic.
			// Reject any non-local attempt to reach the Device API.
			{
				comment: 'Block Device API from external networks',
				action: RuleAction.Append,
				proto: 'tcp',
				matches: [`--dport ${this.config.deviceApiPort}`],
				target: 'REJECT',
			},
		];
	}

	/**
   * MQTT protection rules
   * Only allow from explicitly trusted LAN and Docker networks.
   */
	private getMqttRules(): Rule[] {
		if (!this.config.mqttPort) {
			return [];
		}

		const rules: Rule[] = [];
		const allowedLanNetworks = this.config.allowedLanNetworks!;
		const allowedDockerNetworks = this.config.allowedDockerNetworks!;

		// Allow MQTT from each trusted LAN network.
		allowedLanNetworks.forEach((network) => {
			rules.push({
				comment: `MQTT from LAN ${network}`,
				action: RuleAction.Append,
				family: 4,
				proto: 'tcp',
				matches: [`--dport ${this.config.mqttPort}`, `-s ${network}`],
				target: 'ACCEPT',
			});
		});

		// Allow MQTT from explicitly trusted Docker bridge networks.
		allowedDockerNetworks.forEach((network) => {
			rules.push({
				comment: `MQTT from Docker ${network}`,
				action: RuleAction.Append,
				family: 4,
				proto: 'tcp',
				matches: [`--dport ${this.config.mqttPort}`, `-s ${network}`],
				target: 'ACCEPT',
			});
		});

		// Block MQTT from all other networks
		rules.push({
			comment: 'Block MQTT from public networks',
			action: RuleAction.Append,
			proto: 'tcp',
			matches: [`--dport ${this.config.mqttPort}`],
			target: 'REJECT',
		});

		return rules;
	}

	/**
   * Final rule in the chain
   * RETURN if firewall is inactive (allow all), REJECT if active (deny all)
   */
	private getFinalRule(isActive: boolean): Rule {
		if (!isActive) {
			return {
				comment: `Firewall disabled (mode: ${this.config.mode})`,
				action: RuleAction.Append,
				target: 'RETURN',
			};
		}

		return {
			comment: 'Reject all other traffic',
			action: RuleAction.Append,
			target: 'REJECT',
		};
	}

	/**
   * Determine if firewall should be enabled in auto mode
   * 
   * In auto mode, firewall is enabled if there are services using host networking,
   * which exposes them to the host's network interfaces.
   */
	private async shouldEnableFirewall(): Promise<boolean> {
		// In auto mode, always enable firewall for security
		// In the future, this could detect host-network services and enable accordingly
		return true;
	}

	/**
   * Update firewall mode dynamically
   */
	async updateMode(mode: 'on' | 'off' | 'auto'): Promise<void> {
		this.logger.debugSync('Updating firewall mode', {
			component: LogComponents.firewall,
			from: this.config.mode,
			to: mode,
		});

		this.config.mode = mode;
		await this.applyFirewallRules();
	}

	/**
   * Update firewall configuration dynamically
   */
	async updateConfig(config: Partial<FirewallConfig>): Promise<void> {
		this.logger.debugSync('Updating firewall configuration', {
			component: LogComponents.firewall,
			changes: Object.keys(config),
		});

		this.config = {
			...this.config,
			...config,
		};

		if (this.initialized) {
			await this.applyFirewallRules();
		}
	}

	/**
   * Stop firewall and remove all rules
   */
	async stop(): Promise<void> {
		if (!this.initialized) {
			return;
		}

		this.logger.debugSync('Stopping firewall', {
			component: LogComponents.firewall,
		});

		try {
			const adaptor = getDefaultRuleAdaptor();
			const { getRulePosition } = await import('../lib/iptables.js');
      
			const v4Position = await getRulePosition('INPUT', FIREWALL_CHAIN, 4);
			const v6Position = await getRulePosition('INPUT', FIREWALL_CHAIN, 6);

			await build()
				.forTable('filter', (filter) =>
					filter
						.forChain('INPUT', (chain) => {
							// Remove jump to our chain
							if (v4Position !== -1) {
								chain.addRule({
									action: RuleAction.Delete,
									target: FIREWALL_CHAIN,
									family: 4,
								});
							}
							if (v6Position !== -1) {
								chain.addRule({
									action: RuleAction.Delete,
									target: FIREWALL_CHAIN,
									family: 6,
								});
							}
							return chain;
						})
						.forChain(FIREWALL_CHAIN, (chain) =>
						// Flush our chain
							chain.addRule({ action: RuleAction.Flush })
						)
				)
				.apply(adaptor);

			this.initialized = false;
			this.logger.debugSync('Firewall stopped', {
				component: LogComponents.firewall,
			});
		} catch (error) {
			this.logger.errorSync(
				'Error stopping firewall',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.firewall,
				}
			);
		}
	}

	/**
   * Convert persisted user rules to iptables ACCEPT rules
   */
	private getUserIptablesRules(userRules: FirewallRule[]): Rule[] {
		return userRules.map((r) => {
			const matches: string[] = [];
			if (r.port.includes('-')) {
				matches.push('-m multiport', `--dports ${r.port}`);
			} else {
				matches.push(`--dport ${r.port}`);
			}
			if (r.interface_name) {
				matches.push(`-i ${r.interface_name}`);
			}
			return {
				comment: r.description || `User rule ${r.id}`,
				action: RuleAction.Append,
				proto: r.protocol,
				matches,
				target: 'ACCEPT',
			} as Rule;
		});
	}

	/**
   * Get reserved ports that cannot be opened by user rules
   */
	getReservedPorts(): { port: number; service: string }[] {
		const reserved: { port: number; service: string }[] = [
			{ port: this.config.deviceApiPort, service: 'Device API' },
		];
		if (this.config.mqttPort) {
			reserved.push({ port: this.config.mqttPort, service: 'MQTT Broker' });
		}
		return reserved;
	}

	/**
   * CRUD for user-defined firewall rules
   */
	getUserRules(): FirewallRule[] {
		return FirewallRuleModel.getAll();
	}

	async addUserRule(rule: { port: string; protocol: string; interface_name?: string | null; description?: string | null }): Promise<FirewallRule> {
		const created = FirewallRuleModel.create(rule);
		this.logger.debugSync('User firewall rule added', { component: LogComponents.firewall, ruleId: created.id, port: rule.port });
		if (this.initialized) await this.applyFirewallRules();
		return created;
	}

	async updateUserRule(id: number, fields: { port?: string; protocol?: string; interface_name?: string | null; description?: string | null }): Promise<FirewallRule | null> {
		const updated = FirewallRuleModel.update(id, fields);
		if (updated) {
			this.logger.debugSync('User firewall rule updated', { component: LogComponents.firewall, ruleId: id });
			if (this.initialized) await this.applyFirewallRules();
		}
		return updated;
	}

	async deleteUserRule(id: number): Promise<boolean> {
		const deleted = FirewallRuleModel.delete(id);
		if (deleted) {
			this.logger.debugSync('User firewall rule deleted', { component: LogComponents.firewall, ruleId: id });
			if (this.initialized) await this.applyFirewallRules();
		}
		return deleted;
	}

	/**
   * Whether iptables is available (false in container mode without NET_ADMIN)
   */
	get available(): boolean {
		return this.config.enabled;
	}

	/**
   * Get current firewall status
   */
	getStatus(): {
    enabled: boolean;
    initialized: boolean;
    mode: string;
    deviceApiPort: number;
    mqttPort?: number;
    } {
		return {
			enabled: this.config.enabled,
			initialized: this.initialized,
			mode: this.config.mode,
			deviceApiPort: this.config.deviceApiPort,
			mqttPort: this.config.mqttPort,
		};
	}
}
