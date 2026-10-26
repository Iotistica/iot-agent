import type { ContainerService } from './container-manager.js';
import { socketHostDir } from './socket-mount.js';
import { PublishDestinationsModel } from '../db/models/publish-destinations.model.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';

const SOCKET_FILENAME = 'app.sock';

function socketDestinationName(service: ContainerService): string {
	return `socket:${service.appName}/${service.serviceName}`;
}

function socketPath(service: ContainerService): string {
	return `${socketHostDir(service.appId, service.serviceId)}/${SOCKET_FILENAME}`;
}

export function ensureSocketDestination(
	service: ContainerService,
	logger?: AgentLogger,
) {
	const name = socketDestinationName(service);
	const config = {
		appId: service.appId,
		serviceId: service.serviceId,
		socketPath: socketPath(service),
	};

	const existing = PublishDestinationsModel.getByName(name);

	if (existing && existing.id !== undefined) {
		PublishDestinationsModel.update(existing.id, {
			enabled: true,
			config_json: config,
		});
		logger?.infoSync('Socket destination re-enabled', {
			component: LogComponents.containerManager,
			operation: 'ensureSocketDestination',
			destinationId: existing.id,
			name,
		});
		return PublishDestinationsModel.getById(existing.id);
	}

	const created = PublishDestinationsModel.create({
		name,
		type: 'socket',
		config_json: config,
		enabled: true,
		use_for_commands: false,
	});

	logger?.infoSync('Socket destination created', {
		component: LogComponents.containerManager,
		operation: 'ensureSocketDestination',
		destinationId: created?.id,
		name,
	});

	return created;
}

export function disableSocketDestination(
	service: ContainerService,
	logger?: AgentLogger,
) {
	const name = socketDestinationName(service);
	const existing = PublishDestinationsModel.getByName(name);

	if (!existing || existing.id === undefined) {
		logger?.debugSync('No socket destination to disable', {
			component: LogComponents.containerManager,
			operation: 'disableSocketDestination',
			name,
		});
		return;
	}

	PublishDestinationsModel.update(existing.id, { enabled: false });
	logger?.infoSync('Socket destination disabled', {
		component: LogComponents.containerManager,
		operation: 'disableSocketDestination',
		destinationId: existing.id,
		name,
	});
}
