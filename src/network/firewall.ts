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
import { getLocalLanNetworks, type LocalLanNetworks } from './utils';

export type FirewallMode = 'on' | 'off' | 'auto' | 'disabled';

export interface FirewallStatus {
	enabled: boolean;
	initialized: boolean;
	mode: FirewallMode;
	deviceApiPort: number;
	mqttPort?: number;
}

export interface FirewallConfig {
  enabled: boolean;
  mode: FirewallMode;
  deviceApiPort: number;
  mqttPort?: number;
  allowedLanNetworks?: string[];
  allowedLanNetworksV6?: string[];
  allowedDockerNetworks?: string[];
}

export type FirewallRuleAction = 'ACCEPT' | 'REJECT' | 'DROP';

function normalizeFirewallAction(value: unknown): FirewallRuleAction {
	if (value === undefined || value === null) return 'ACCEPT';
	if (value === 'ACCEPT' || value === 'REJECT' || value === 'DROP') return value;
	throw new Error('Invalid firewall action: expected ACCEPT, REJECT, or DROP');
}

const FIREWALL_CHAIN = 'IOTISTIC-FIREWALL';
const DEFAULT_MQTT_PORT = 1883;
const _USER_CHAIN = 'IOTISTIC-USER';


// Default Docker bridge. User-defined bridge networks should be configured explicitly.
const DEFAULT_ALLOWED_DOCKER_NETWORKS = [
	'172.17.0.0/16',
];

export class AgentFirewall {
	private logger: AgentLogger;
	private config: FirewallConfig;
	private initialized: boolean = false;
	private modeChangeQueue: Promise<void> = Promise.resolve();

	constructor(config: FirewallConfig, logger: AgentLogger) {
		this.config = {
			...config,
			mqttPort: config.mqttPort ?? DEFAULT_MQTT_PORT,
			allowedDockerNetworks:
				config.allowedDockerNetworks ?? DEFAULT_ALLOWED_DOCKER_NETWORKS,
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
							.addRule(isActive ? this.getDeviceApiRules() : [])
							.addRule(isActive ? this.getMqttRules() : [])
							.addRule(this.getUserIptablesRules(userRules))
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
			// Allow SSH so enabling the firewall does not lock out remote administration
			{
				comment: 'Allow SSH access',
				action: RuleAction.Append,
				proto: 'tcp',
				matches: ['--dport 22'],
				target: 'ACCEPT',
			},
			// Allow loopback
			{
				comment: 'Allow loopback',
				action: RuleAction.Append,
				matches: ['-i lo'],
				target: 'ACCEPT',
			},
			// IPv4 ICMP (ping, diagnostics).
			{
				comment: 'Allow IPv4 ICMP',
				action: RuleAction.Append,
				family: 4,
				proto: 'icmp',
				target: 'ACCEPT',
			},
			// IPv6 relies on ICMPv6 for Neighbor Discovery and Path MTU Discovery.
			{
				comment: 'Allow ICMPv6',
				action: RuleAction.Append,
				family: 6,
				proto: 'ipv6-icmp',
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
   * System firewall rules (always applied)
   */

	async getSystemRules(): Promise<Rule[]> {
		const modeIsActive =
			this.config.mode === 'on' ||
			(this.config.mode === 'auto' && await this.shouldEnableFirewall());
		const isActive = this.config.enabled && this.initialized && modeIsActive;

		return [
			...this.getBaseRules(),
			...(isActive ? this.getDeviceApiRules() : []),
			...(isActive ? this.getMqttRules() : []),
			this.getFinalRule(isActive),
		];
	}
	/**
	 * Device API protection rules
	 * Allow trusted LAN networks while blocking untrusted networks.
	 */
	/**
	 * Use explicitly configured subnets when provided, otherwise detect local LANs.
	 * An explicit empty array disables auto-allow for that address family.
	 */
	private getAllowedLanNetworks(): LocalLanNetworks {
		const detected = getLocalLanNetworks();
		return {
			ipv4: this.config.allowedLanNetworks ?? detected.ipv4,
			ipv6: this.config.allowedLanNetworksV6 ?? detected.ipv6,
		};
	}

	private getDeviceApiRules(): Rule[] {
		const rules: Rule[] = [];
		const networks = this.getAllowedLanNetworks();

		for (const [family, subnets] of [
			[4, networks.ipv4],
			[6, networks.ipv6],
		] as const) {
			for (const subnet of subnets) {
				rules.push({
					comment: `Allow Device API IPv${family} LAN ${subnet}`,
					action: RuleAction.Append,
					family,
					proto: 'tcp',
					matches: [`--dport ${this.config.deviceApiPort}`, `-s ${subnet}`],
					target: 'ACCEPT',
				});
			}
			rules.push({
				comment: `Block Device API IPv${family} from untrusted networks`,
				action: RuleAction.Append,
				family,
				proto: 'tcp',
				matches: [`--dport ${this.config.deviceApiPort}`],
				target: 'REJECT',
			});
		}
		return rules;
	}

	/** MQTT: LAN IPv4/IPv6 and Docker default bridge access (docker0). */
	private getMqttRules(): Rule[] {
		if (!this.config.mqttPort) return [];
		const rules: Rule[] = [];
		const networks = this.getAllowedLanNetworks();
		const dockerNetworks = this.config.allowedDockerNetworks ?? DEFAULT_ALLOWED_DOCKER_NETWORKS;

		for (const [family, subnets] of [
			[4, networks.ipv4],
			[6, networks.ipv6],
		] as const) {
			for (const subnet of subnets) {
				rules.push({
					comment: `MQTT IPv${family} LAN ${subnet}`,
					action: RuleAction.Append,
					family,
					proto: 'tcp',
					matches: [`--dport ${this.config.mqttPort}`, `-s ${subnet}`],
					target: 'ACCEPT',
				});
			}
			if (family === 4) {
				for (const subnet of dockerNetworks) {
					rules.push({
						comment: `MQTT Docker ${subnet}`,
						action: RuleAction.Append,
						family: 4,
						proto: 'tcp',
						matches: [`-i docker0`, `--dport ${this.config.mqttPort}`, `-s ${subnet}`],
						target: 'ACCEPT',
					});
				}
			}
			rules.push({
				comment: `Block MQTT IPv${family} from untrusted networks`,
				action: RuleAction.Append,
				family,
				proto: 'tcp',
				matches: [`--dport ${this.config.mqttPort}`],
				target: 'REJECT',
			});
		}
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
	async updateMode(mode: FirewallMode): Promise<FirewallStatus> {
		const operation = this.modeChangeQueue.then(() => this.applyModeChange(mode));
		this.modeChangeQueue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	private async applyModeChange(mode: FirewallMode): Promise<FirewallStatus> {
		const previousMode = this.config.mode;
		const wasEnabled = this.config.enabled;
		const wasInitialized = this.initialized;

		this.logger.debugSync('Updating firewall mode', {
			component: LogComponents.firewall,
			from: previousMode,
			to: mode,
		});

		this.config.mode = mode;
		this.config.enabled = mode !== 'disabled';
		try {
			if (mode === 'disabled') {
				if (wasInitialized || wasEnabled) {
					this.initialized = true;
					await this.stop({ throwOnError: true });
				}
				this.initialized = false;
			} else {
				await this.applyFirewallRules();
				this.initialized = true;
			}
			this.logger.infoSync('Firewall mode applied', {
				component: LogComponents.firewall,
				from: previousMode,
				to: mode,
			});
			return this.getStatus();
		} catch (error) {
			this.config.mode = previousMode;
			this.config.enabled = wasEnabled;
			this.initialized = wasInitialized;

			let rollbackError: unknown;
			try {
				if (wasInitialized) {
					await this.applyFirewallRules();
				} else {
					this.initialized = true;
					await this.stop({ throwOnError: true });
				}
			} catch (rollbackFailure) {
				rollbackError = rollbackFailure;
			} finally {
				this.initialized = wasInitialized;
			}

			this.logger.errorSync(
				'Failed to apply firewall mode; previous mode restored',
				error instanceof Error ? error : new Error(String(error)),
				{ component: LogComponents.firewall, mode }
			);
			if (rollbackError) {
				this.initialized = false;
				throw new AggregateError(
					[error, rollbackError],
					'Firewall mode application and rollback both failed'
				);
			}
			throw error;
		}
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
	async stop(options: { throwOnError?: boolean } = {}): Promise<void> {
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
			if (options.throwOnError) throw error;
		}
	}

	/**
   * Convert persisted user rules to iptables rules with their configured action
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
				target: normalizeFirewallAction((r as FirewallRule & { action?: FirewallRuleAction }).action),
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

	async addUserRule(rule: { port: string; protocol: string; action?: FirewallRuleAction; interface_name?: string | null; description?: string | null }): Promise<FirewallRule> {
		const action = normalizeFirewallAction(rule.action);
		const created = FirewallRuleModel.create({ ...rule, action });
		this.logger.debugSync('User firewall rule added', { component: LogComponents.firewall, ruleId: created.id, port: rule.port });
		if (this.initialized) await this.applyFirewallRules();
		return created;
	}

	async updateUserRule(id: number, fields: { port?: string; protocol?: string; action?: FirewallRuleAction; interface_name?: string | null; description?: string | null }): Promise<FirewallRule | null> {
		const updated = FirewallRuleModel.update(id, fields.action === undefined ? fields : { ...fields, action: normalizeFirewallAction(fields.action) });
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
	getStatus(): FirewallStatus {
		return {
			enabled: this.config.enabled,
			initialized: this.initialized,
			mode: this.config.mode,
			deviceApiPort: this.config.deviceApiPort,
			mqttPort: this.config.mqttPort,
		};
	}
}
