jest.mock('../../../src/db/models/publish-destinations.model', () => {
	return {
		PublishDestinationsModel: {
			getByName: jest.fn(),
			create: jest.fn(),
			update: jest.fn(),
			getById: jest.fn(),
		},
	};
});

jest.mock('../../../src/containers/socket-mount', () => ({
	socketHostDir: (appId: number, serviceId: number) => `/run/agent/sockets/${appId}_${serviceId}`,
}));

import { ensureSocketDestination, disableSocketDestination } from '../../../src/containers/socket-destination-lifecycle';
import { PublishDestinationsModel } from '../../../src/db/models/publish-destinations.model';
import type { ContainerService } from '../../../src/containers/container-manager';

const mockGetByName = PublishDestinationsModel.getByName as jest.Mock;
const mockCreate = PublishDestinationsModel.create as jest.Mock;
const mockUpdate = PublishDestinationsModel.update as jest.Mock;
const mockGetById = PublishDestinationsModel.getById as jest.Mock;

function makeService(overrides: Partial<ContainerService> = {}): ContainerService {
	return {
		serviceId: 1,
		serviceName: 'my-svc',
		imageName: 'img:latest',
		appId: 10,
		appName: 'my-app',
		config: { image: 'img:latest', enableSocketDestination: true },
		...overrides,
	} as ContainerService;
}

const mockLogger = {
	infoSync: jest.fn(),
	debugSync: jest.fn(),
	warnSync: jest.fn(),
	errorSync: jest.fn(),
} as any;

describe('socket-destination-lifecycle', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('ensureSocketDestination', () => {
		it('creates a new destination when none exists', () => {
			mockGetByName.mockReturnValue(null);
			mockCreate.mockReturnValue({ id: 42, name: 'socket:my-app/my-svc', type: 'socket', enabled: true });

			const result = ensureSocketDestination(makeService(), mockLogger);

			expect(mockGetByName).toHaveBeenCalledWith('socket:my-app/my-svc');
			expect(mockCreate).toHaveBeenCalledWith({
				name: 'socket:my-app/my-svc',
				type: 'socket',
				config_json: {
					appId: 10,
					serviceId: 1,
					socketPath: '/run/agent/sockets/10_1/app.sock',
				},
				enabled: true,
				use_for_commands: false,
			});
			expect(result).toEqual({ id: 42, name: 'socket:my-app/my-svc', type: 'socket', enabled: true });
		});

		it('re-enables an existing disabled destination', () => {
			mockGetByName.mockReturnValue({
				id: 5,
				name: 'socket:my-app/my-svc',
				type: 'socket',
				enabled: false,
			});
			mockGetById.mockReturnValue({
				id: 5,
				name: 'socket:my-app/my-svc',
				type: 'socket',
				enabled: true,
			});

			const result = ensureSocketDestination(makeService(), mockLogger);

			expect(mockUpdate).toHaveBeenCalledWith(5, {
				enabled: true,
				config_json: {
					appId: 10,
					serviceId: 1,
					socketPath: '/run/agent/sockets/10_1/app.sock',
				},
			});
			expect(mockCreate).not.toHaveBeenCalled();
			expect(result).toEqual(expect.objectContaining({ id: 5, enabled: true }));
		});

		it('updates config_json when appId/serviceId changed', () => {
			mockGetByName.mockReturnValue({
				id: 5,
				name: 'socket:my-app/my-svc',
				type: 'socket',
				enabled: true,
				config_json: { appId: 99, serviceId: 99, socketPath: '/old/path' },
			});
			mockGetById.mockReturnValue({
				id: 5,
				name: 'socket:my-app/my-svc',
				type: 'socket',
				enabled: true,
				config_json: { appId: 10, serviceId: 1, socketPath: '/run/agent/sockets/10_1/app.sock' },
			});

			ensureSocketDestination(makeService(), mockLogger);

			expect(mockUpdate).toHaveBeenCalledWith(5, {
				enabled: true,
				config_json: {
					appId: 10,
					serviceId: 1,
					socketPath: '/run/agent/sockets/10_1/app.sock',
				},
			});
		});
	});

	describe('disableSocketDestination', () => {
		it('disables an existing destination', () => {
			mockGetByName.mockReturnValue({
				id: 5,
				name: 'socket:my-app/my-svc',
				type: 'socket',
				enabled: true,
			});

			disableSocketDestination(makeService(), mockLogger);

			expect(mockUpdate).toHaveBeenCalledWith(5, { enabled: false });
		});

		it('is a no-op when destination does not exist', () => {
			mockGetByName.mockReturnValue(null);

			disableSocketDestination(makeService(), mockLogger);

			expect(mockUpdate).not.toHaveBeenCalled();
		});
	});
});
