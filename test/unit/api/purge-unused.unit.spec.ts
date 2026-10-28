jest.mock('../../../src/api/actions', () => ({
	getDockerInstance: jest.fn(),
}));

import * as actions from '../../../src/api/actions';
import { router } from '../../../src/api/v1';

describe('POST /v1/apps/purge-unused', () => {
	it('prunes all unused volumes, including named volumes', async () => {
		const docker = {
			pruneImages: jest.fn().mockResolvedValue({ ImagesDeleted: [], SpaceReclaimed: 0 }),
			pruneVolumes: jest.fn().mockResolvedValue({ VolumesDeleted: [], SpaceReclaimed: 0 }),
		};
		(actions.getDockerInstance as jest.Mock).mockReturnValue(docker);
		const route = (router as any).stack.find(
			(layer: any) => layer.route?.path === '/v1/apps/purge-unused' && layer.route.methods.post,
		).route;
		const handler = route.stack[route.stack.length - 1].handle;
		const response = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
		};

		await handler({}, response, jest.fn());

		expect(docker.pruneVolumes).toHaveBeenCalledWith({ all: true });
		expect(response.status).toHaveBeenCalledWith(200);
	});
});
