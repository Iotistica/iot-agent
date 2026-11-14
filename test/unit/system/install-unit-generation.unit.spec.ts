import { execSync } from 'child_process';
import * as path from 'path';

const INSTALL_SH = path.resolve(__dirname, '../../../bin/install.sh').replace(/\\/g, '/');

/**
 * Extracts the validation functions and generate_systemd_unit from install.sh
 * into a self-contained bash snippet that tests can invoke without running the
 * full installer (no root, no systemctl, no file-system side effects).
 */
function buildTestPreamble(): string {
	return [
		'set -e',
		'installer_message() { echo "$*" >&2; }',
		'installer_step() { installer_message "  $*"; }',
		// Extract function definitions from install.sh (validate_* and generate_systemd_unit)
		`eval "$(sed -n '/^validate_systemd_memory()/,/^}/p; /^validate_systemd_timeout()/,/^}/p; /^validate_cpu_quota()/,/^}/p; /^validate_memory_high_le_max()/,/^}/p; /^generate_systemd_unit()/,/^}/p' '${INSTALL_SH}')"`,
	].join('\n');
}

function runBash(script: string): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execSync(`bash -c '${script.replace(/'/g, "'\\''")}'`, {
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		return { stdout, stderr: '', exitCode: 0 };
	} catch (error: any) {
		return {
			stdout: error.stdout || '',
			stderr: error.stderr || '',
			exitCode: error.status ?? 1,
		};
	}
}

function generateUnit(env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
	const envExports = Object.entries(env)
		.map(([k, v]) => `export ${k}="${v}"`)
		.join('\n');

	const script = `
${buildTestPreamble()}
${envExports}

# Apply defaults (mirrors install.sh logic)
AGENT_MEMORY_LIMIT="\${AGENT_MEMORY_LIMIT:-300M}"
AGENT_MEMORY_HIGH="\${AGENT_MEMORY_HIGH:-250M}"
AGENT_CPU_QUOTA="\${AGENT_CPU_QUOTA:-100%}"
AGENT_STARTUP_TIMEOUT="\${AGENT_STARTUP_TIMEOUT:-300}"

validate_systemd_memory "AGENT_MEMORY_LIMIT" "$AGENT_MEMORY_LIMIT" || exit 1
validate_systemd_memory "AGENT_MEMORY_HIGH" "$AGENT_MEMORY_HIGH" || exit 1
validate_cpu_quota "AGENT_CPU_QUOTA" "$AGENT_CPU_QUOTA" || exit 1
validate_systemd_timeout "AGENT_STARTUP_TIMEOUT" "$AGENT_STARTUP_TIMEOUT" || exit 1
validate_memory_high_le_max "$AGENT_MEMORY_HIGH" "$AGENT_MEMORY_LIMIT" || exit 1

SERVICE_TYPE="notify"
WATCHDOG_DIRECTIVES="WatchdogSec=60
NotifyAccess=all"
STARTUP_TIMEOUT="$AGENT_STARTUP_TIMEOUT"
SERVICE_NAME="iotistica-agent"

if [ "\${CI}" = "true" ]; then
    SERVICE_TYPE="simple"
    WATCHDOG_DIRECTIVES="# Watchdog disabled in CI service mode"
    STARTUP_TIMEOUT="60"
fi

UNIT_AFTER="network-online.target docker.service"
UNIT_REQUIRES="docker.service"
SERVICE_READWRITE_PATHS="/var/lib/iotistic /var/log/iotistic /opt/iotistic/agent /opt/iotistic/.config /var/run/docker.sock"
NODE_PATH="/usr/bin/node"
APP_JS_PATH="/opt/iotistic/agent/dist/app.js"

generate_systemd_unit
`;
	return runBash(script);
}

function validateOnly(env: Record<string, string>): { stderr: string; exitCode: number } {
	const envExports = Object.entries(env)
		.map(([k, v]) => `export ${k}="${v}"`)
		.join('\n');

	const script = `
${buildTestPreamble()}
${envExports}

AGENT_MEMORY_LIMIT="\${AGENT_MEMORY_LIMIT:-300M}"
AGENT_MEMORY_HIGH="\${AGENT_MEMORY_HIGH:-250M}"
AGENT_CPU_QUOTA="\${AGENT_CPU_QUOTA:-100%}"
AGENT_STARTUP_TIMEOUT="\${AGENT_STARTUP_TIMEOUT:-300}"

validate_systemd_memory "AGENT_MEMORY_LIMIT" "$AGENT_MEMORY_LIMIT" || exit 1
validate_systemd_memory "AGENT_MEMORY_HIGH" "$AGENT_MEMORY_HIGH" || exit 1
validate_cpu_quota "AGENT_CPU_QUOTA" "$AGENT_CPU_QUOTA" || exit 1
validate_systemd_timeout "AGENT_STARTUP_TIMEOUT" "$AGENT_STARTUP_TIMEOUT" || exit 1
validate_memory_high_le_max "$AGENT_MEMORY_HIGH" "$AGENT_MEMORY_LIMIT" || exit 1
echo "OK"
`;
	const result = runBash(script);
	return { stderr: result.stderr, exitCode: result.exitCode };
}

describe('systemd unit generation', () => {
	describe('default values', () => {
		it('generates correct defaults with no overrides', () => {
			const { stdout, exitCode } = generateUnit();
			expect(exitCode).toBe(0);
			expect(stdout).toContain('TimeoutStartSec=300');
			expect(stdout).toContain('CPUQuota=100%');
			expect(stdout).toContain('MemoryHigh=250M');
			expect(stdout).toContain('MemoryMax=300M');
			expect(stdout).toContain('Type=notify');
			expect(stdout).toContain('WatchdogSec=60');
			expect(stdout).toContain('NotifyAccess=all');
		});
	});

	describe('custom overrides', () => {
		it('applies custom timeout', () => {
			const { stdout, exitCode } = generateUnit({ AGENT_STARTUP_TIMEOUT: '600' });
			expect(exitCode).toBe(0);
			expect(stdout).toContain('TimeoutStartSec=600');
		});

		it('applies custom CPU quota', () => {
			const { stdout, exitCode } = generateUnit({ AGENT_CPU_QUOTA: '200%' });
			expect(exitCode).toBe(0);
			expect(stdout).toContain('CPUQuota=200%');
		});

		it('applies custom memory limits', () => {
			const { stdout, exitCode } = generateUnit({
				AGENT_MEMORY_HIGH: '500M',
				AGENT_MEMORY_LIMIT: '600M',
			});
			expect(exitCode).toBe(0);
			expect(stdout).toContain('MemoryHigh=500M');
			expect(stdout).toContain('MemoryMax=600M');
		});

		it('applies all overrides together', () => {
			const { stdout, exitCode } = generateUnit({
				AGENT_STARTUP_TIMEOUT: '450',
				AGENT_CPU_QUOTA: '150%',
				AGENT_MEMORY_HIGH: '400M',
				AGENT_MEMORY_LIMIT: '500M',
			});
			expect(exitCode).toBe(0);
			expect(stdout).toContain('TimeoutStartSec=450');
			expect(stdout).toContain('CPUQuota=150%');
			expect(stdout).toContain('MemoryHigh=400M');
			expect(stdout).toContain('MemoryMax=500M');
		});
	});

	describe('CI mode', () => {
		it('uses Type=simple and 60s timeout in CI', () => {
			const { stdout, exitCode } = generateUnit({ CI: 'true' });
			expect(exitCode).toBe(0);
			expect(stdout).toContain('Type=simple');
			expect(stdout).toContain('TimeoutStartSec=60');
			expect(stdout).not.toContain('WatchdogSec=60');
		});

		it('ignores AGENT_STARTUP_TIMEOUT in CI mode', () => {
			const { stdout, exitCode } = generateUnit({
				CI: 'true',
				AGENT_STARTUP_TIMEOUT: '600',
			});
			expect(exitCode).toBe(0);
			expect(stdout).toContain('TimeoutStartSec=60');
			expect(stdout).not.toContain('TimeoutStartSec=600');
		});
	});

	describe('validation failures', () => {
		it('rejects non-numeric timeout', () => {
			const result = validateOnly({ AGENT_STARTUP_TIMEOUT: 'abc' });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain('AGENT_STARTUP_TIMEOUT');
		});

		it('rejects timeout below minimum', () => {
			const result = validateOnly({ AGENT_STARTUP_TIMEOUT: '10' });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain('out of range');
		});

		it('rejects timeout above maximum', () => {
			const result = validateOnly({ AGENT_STARTUP_TIMEOUT: '1000' });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain('out of range');
		});

		it('rejects CPU quota without percent sign', () => {
			const result = validateOnly({ AGENT_CPU_QUOTA: '50' });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain('AGENT_CPU_QUOTA');
		});

		it('rejects CPU quota of 0%', () => {
			const result = validateOnly({ AGENT_CPU_QUOTA: '0%' });
			expect(result.exitCode).not.toBe(0);
		});

		it('rejects invalid memory suffix', () => {
			const result = validateOnly({ AGENT_MEMORY_LIMIT: '300Z' });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain('AGENT_MEMORY_LIMIT');
		});

		it('rejects Kubernetes-style binary suffix', () => {
			const result = validateOnly({ AGENT_MEMORY_LIMIT: '300Mi' });
			expect(result.exitCode).not.toBe(0);
		});

		it('rejects zero memory', () => {
			const result = validateOnly({ AGENT_MEMORY_LIMIT: '0M' });
			expect(result.exitCode).not.toBe(0);
		});

		it('rejects empty memory value', () => {
			const result = validateOnly({ AGENT_MEMORY_LIMIT: '' });
			expect(result.exitCode).not.toBe(0);
		});

		it('rejects MemoryHigh exceeding MemoryMax', () => {
			const result = validateOnly({
				AGENT_MEMORY_HIGH: '500M',
				AGENT_MEMORY_LIMIT: '300M',
			});
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain('exceeds');
		});

		it('rejects MemoryHigh exceeding MemoryMax by suffix rank', () => {
			const result = validateOnly({
				AGENT_MEMORY_HIGH: '1G',
				AGENT_MEMORY_LIMIT: '500M',
			});
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain('exceeds');
		});

		it('accepts MemoryHigh equal to MemoryMax', () => {
			const result = validateOnly({
				AGENT_MEMORY_HIGH: '300M',
				AGENT_MEMORY_LIMIT: '300M',
			});
			expect(result.exitCode).toBe(0);
		});

		it('accepts valid bare-bytes memory value', () => {
			const result = validateOnly({
				AGENT_MEMORY_HIGH: '262144000',
				AGENT_MEMORY_LIMIT: '314572800',
			});
			expect(result.exitCode).toBe(0);
		});
	});

	describe('unit structure', () => {
		it('contains required systemd sections', () => {
			const { stdout, exitCode } = generateUnit();
			expect(exitCode).toBe(0);
			expect(stdout).toContain('[Unit]');
			expect(stdout).toContain('[Service]');
			expect(stdout).toContain('[Install]');
		});

		it('sets correct service identity', () => {
			const { stdout, exitCode } = generateUnit();
			expect(exitCode).toBe(0);
			expect(stdout).toContain('SyslogIdentifier=iotistica-agent');
			expect(stdout).toContain('User=iotistic');
			expect(stdout).toContain('Group=iotistic');
		});

		it('includes security hardening directives', () => {
			const { stdout, exitCode } = generateUnit();
			expect(exitCode).toBe(0);
			expect(stdout).toContain('NoNewPrivileges=true');
			expect(stdout).toContain('ProtectSystem=strict');
			expect(stdout).toContain('ProtectHome=true');
		});
	});
});
