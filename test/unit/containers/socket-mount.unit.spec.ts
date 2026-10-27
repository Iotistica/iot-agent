import fs from 'node:fs';
import {
	SOCKET_HOST_BASE,
	SOCKET_CONTAINER_PATH,
	socketHostDir,
	socketBindString,
	ensureSocketDir,
	removeSocketDir,
	isSocketMount,
} from '../../../src/containers/socket-mount';

jest.mock('node:fs', () => {
	const actual = jest.requireActual('node:fs');
	return {
		...actual,
		existsSync: jest.fn(),
		promises: {
			mkdir: jest.fn(),
			rm: jest.fn(),
		},
	};
});

const existsSyncMock = fs.existsSync as jest.Mock;
const mkdirMock = fs.promises.mkdir as jest.Mock;
const rmMock = fs.promises.rm as jest.Mock;

describe('socket-mount helpers', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('socketHostDir', () => {
		it('returns correct path for valid IDs', () => {
			expect(socketHostDir(1, 42)).toBe(`${SOCKET_HOST_BASE}/1_42`);
		});

		it('handles zero IDs', () => {
			expect(socketHostDir(0, 0)).toBe(`${SOCKET_HOST_BASE}/0_0`);
		});

		it('throws for negative appId', () => {
			expect(() => socketHostDir(-1, 1)).toThrow('appId must be a non-negative integer');
		});

		it('throws for negative serviceId', () => {
			expect(() => socketHostDir(1, -1)).toThrow('serviceId must be a non-negative integer');
		});

		it('throws for NaN', () => {
			expect(() => socketHostDir(NaN, 1)).toThrow('appId');
		});

		it('throws for non-integer', () => {
			expect(() => socketHostDir(1.5, 1)).toThrow('appId');
		});

		it('throws for Infinity', () => {
			expect(() => socketHostDir(Infinity, 1)).toThrow('appId');
		});
	});

	describe('socketBindString', () => {
		it('returns host:container format', () => {
			expect(socketBindString(3, 7)).toBe(
				`${SOCKET_HOST_BASE}/3_7:${SOCKET_CONTAINER_PATH}`,
			);
		});
	});

	describe('isSocketMount', () => {
		it('matches agent-managed socket mount', () => {
			expect(isSocketMount(`${SOCKET_HOST_BASE}/1_2`, SOCKET_CONTAINER_PATH)).toBe(true);
		});

		it('rejects wrong destination', () => {
			expect(isSocketMount(`${SOCKET_HOST_BASE}/1_2`, '/some/other/path')).toBe(false);
		});

		it('rejects wrong source (user-created mount to same destination)', () => {
			expect(isSocketMount('/home/user/mydir', SOCKET_CONTAINER_PATH)).toBe(false);
		});

		it('rejects empty strings', () => {
			expect(isSocketMount('', '')).toBe(false);
		});

		it('rejects source that is exactly SOCKET_HOST_BASE without trailing slash', () => {
			expect(isSocketMount(SOCKET_HOST_BASE, SOCKET_CONTAINER_PATH)).toBe(false);
		});
	});

	describe('ensureSocketDir', () => {
		it('reports created: true for new directory', async () => {
			existsSyncMock.mockReturnValue(false);
			mkdirMock.mockResolvedValue(undefined);

			const result = await ensureSocketDir(1, 2);
			expect(result).toEqual({ path: `${SOCKET_HOST_BASE}/1_2`, created: true });
			expect(mkdirMock).toHaveBeenCalledWith(`${SOCKET_HOST_BASE}/1_2`, {
				recursive: true,
				mode: 0o777,
			});
		});

		it('reports created: false for existing directory', async () => {
			existsSyncMock.mockReturnValue(true);
			mkdirMock.mockResolvedValue(undefined);

			const result = await ensureSocketDir(5, 10);
			expect(result).toEqual({ path: `${SOCKET_HOST_BASE}/5_10`, created: false });
		});

		it('propagates mkdir errors', async () => {
			existsSyncMock.mockReturnValue(false);
			mkdirMock.mockRejectedValue(new Error('EACCES'));

			await expect(ensureSocketDir(1, 1)).rejects.toThrow('EACCES');
		});
	});

	describe('removeSocketDir', () => {
		it('removes directory with force', async () => {
			rmMock.mockResolvedValue(undefined);
			await removeSocketDir(1, 2);
			expect(rmMock).toHaveBeenCalledWith(`${SOCKET_HOST_BASE}/1_2`, {
				recursive: true,
				force: true,
			});
		});

		it('logs warning on failure without throwing', async () => {
			rmMock.mockRejectedValue(new Error('EBUSY'));
			const logger = { warnSync: jest.fn() } as any;

			await expect(removeSocketDir(1, 2, logger)).resolves.toBeUndefined();
			expect(logger.warnSync).toHaveBeenCalledWith(
				'Failed to clean up socket directory',
				expect.objectContaining({ dir: `${SOCKET_HOST_BASE}/1_2` }),
			);
		});

		it('does not throw when no logger provided', async () => {
			rmMock.mockRejectedValue(new Error('EBUSY'));
			await expect(removeSocketDir(1, 2)).resolves.toBeUndefined();
		});
	});
});
