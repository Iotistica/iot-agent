/**
 * Pro module loader.
 *
 * The Community edition calls these helpers whenever it needs a Pro feature.
 * If @iotistica/pro is not installed (Community build), every helper returns null
 * and the calling code skips the feature gracefully — no errors, no stubs.
 *
 * The Pro package is a private npm package distributed only to Pro customers.
 * Installing it alongside the Community base activates all Pro features.
 */

const PRO_PKG = '@iotistica/agent-pro'

async function tryLoad<T>(subpath: string): Promise<T | null> {
	try {
		return (await import(`${PRO_PKG}/${subpath}`)) as T
	} catch {
		return null
	}
}

export async function loadShellHandler(): Promise<{ ShellHandler: any } | null> {
	return tryLoad('shell')
}

export async function loadJobsFeature(): Promise<{ JobsFeature: any } | null> {
	return tryLoad('jobs')
}

export async function loadAnomalyDetection(): Promise<{ AnomalyDetectionService: any; loadConfigFromTargetState: any } | null> {
	return tryLoad('anomaly')
}

export async function loadMaintenanceEnergy(): Promise<{ MaintenanceEnergyService: any } | null> {
	return tryLoad('maintenance')
}

export async function loadSchemaDrift(): Promise<{ SchemaDriftDetector: any } | null> {
	return tryLoad('schema-drift')
}

export async function loadSimulationModule(): Promise<{ SimulationOrchestrator: any; loadSimulationConfig: any } | null> {
	return tryLoad('anomaly')
}

export async function loadAzureDestination(): Promise<{ AzurePublishPlugin: any } | null> {
	return tryLoad('destinations/azure')
}

export async function loadAwsDestination(): Promise<{ AwsPublishPlugin: any } | null> {
	return tryLoad('destinations/aws')
}

export async function loadGcpDestination(): Promise<{ GcpPublishPlugin: any } | null> {
	return tryLoad('destinations/gcp')
}

export async function loadInfluxDbDestination(): Promise<{ InfluxDbPublishPlugin: any } | null> {
	return tryLoad('destinations/influxdb')
}

// @iotistica/agent-pro is "type": "module" with subpath-only exports (no "."
// root export, no "require" condition) — require.resolve() on the bare
// package name always throws ERR_PACKAGE_PATH_NOT_EXPORTED even when the
// package is installed and perfectly loadable, because every loadX() helper
// above uses dynamic import() instead. Detect presence the same way: a real
// dynamic import of a stable subpath, cached after the first check.
let proInstalledCache: boolean | null = null

/** Primes the Pro-install cache. Call once during early startup (before the
 *  Device API starts accepting requests) so isProInstalled() never serves a
 *  false negative while detection is still in flight. */
export async function primeProInstalled(): Promise<boolean> {
	if (proInstalledCache === null) {
		proInstalledCache = (await tryLoad('shell')) !== null
	}
	return proInstalledCache
}

/** Returns true when the Pro package is resolvable in the current node_modules.
 *  Set PRO_FORCE=true to bypass the check (dev/testing only). Reflects the
 *  cache populated by primeProInstalled(); returns false if that hasn't run
 *  yet, and kicks off detection in the background so later calls are correct. */
export function isProInstalled(): boolean {
	if (process.env.PRO_FORCE === 'true') return true
	if (proInstalledCache === null) {
		void primeProInstalled()
		return false
	}
	return proInstalledCache
}
