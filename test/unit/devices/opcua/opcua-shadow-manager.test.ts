import assert from 'node:assert/strict';
import test from 'node:test';
import { AdapterManager } from '../../../../src/plugins/index.js';
import { OPCUAAdapter } from '../../../../src/plugins/opcua/adapter.js';
import { EndpointModel, type Endpoint } from '../../../../src/db/models/endpoint.model.js';
import { PrivateEvidenceRegistry } from '../../../../src/points/private-evidence-registry.js';
import { PrivateShadowObserver } from '../../../../src/points/private-shadow-observer.js';

test('manager startup binds only a unique persistent OPC UA source, not explicit config', async () => {
	const registry = new PrivateEvidenceRegistry();
	const observer = new PrivateShadowObserver(registry);
	const originalGetAll = EndpointModel.getAll;
	const originalStart = OPCUAAdapter.prototype.start;
	const row: Endpoint = {
		id: 1, uuid: 'source', name: 'plc', protocol: 'opcua', enabled: true,
		poll_interval: 5000, connection: { endpointUrl: 'opc.tcp://localhost:4840' },
		data_points: [{ nodeId: 'ns=2;s=a', name: 'a', nodeType: 'metric' }],
	};
	const logger = { infoSync() {}, warnSync() {}, errorSync() {}, debugSync() {} };
	const managers: AdapterManager[] = [];
	try {
		EndpointModel.getAll = async () => [row];
		OPCUAAdapter.prototype.start = async () => {};
		const manager = new AdapterManager({ opcua: { enabled: true } }, logger as any, 'agent', { registry, observer });
		managers.push(manager);
		(manager as any).createSocketServer = async () => ({ sendData() {}, sendControl() {} });
		await manager.start();
		const adapter = (manager as any).adapters.get('opcua');
		const configuration = adapter.devices.get('plc');
		const binding = adapter.shadowBindings.get(configuration);
		assert.ok(binding);
		const result = registry.observe(binding, adapter, configuration, {}, { protocol: 'opcua', nodeId: 'ns=2;s=a' });
		assert.equal(result.status, 'ok');
		if (result.status !== 'ok') throw new Error(result.reason);
		assert.equal(registry.inspect(result.value).status, 'candidate-observed');
		EndpointModel.getAll = async () => [{ ...row, data_points: [{ nodeId: 'ns=2;s=b', name: 'b' }] }];
		await manager.reloadAdapterGroup('opcua');
		assert.deepEqual(registry.inspect(result.value), { status: 'unresolved', reason: 'stale-observation' });
		const reloaded = (manager as any).adapters.get('opcua');
		assert.ok(reloaded.shadowBindings.get(reloaded.devices.get('plc')));

		EndpointModel.getAll = async () => [];
		const explicit = { ...configuration, uuid: 'source' };
		const other = new AdapterManager(
			{ opcua: { enabled: true, config: { devices: [explicit] } } },
			logger as any, 'agent', { registry, observer },
		);
		managers.push(other);
		(other as any).createSocketServer = async () => ({ sendData() {}, sendControl() {} });
		await other.start();
		const explicitAdapter = (other as any).adapters.get('opcua');
		assert.equal(explicitAdapter.shadowBindings.get(explicit), undefined);
	} finally {
		for (const manager of managers) await manager.stop();
		EndpointModel.getAll = originalGetAll;
		OPCUAAdapter.prototype.start = originalStart;
		await observer.dispose();
		registry.dispose();
	}
});
