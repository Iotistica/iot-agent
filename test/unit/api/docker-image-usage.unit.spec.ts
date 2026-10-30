import { getDockerImageUsageByApp } from '../../../src/api/docker-image-usage';

describe('getDockerImageUsageByApp', () => {
	it('groups unique image sizes by app and splits shared images across consumers', () => {
		const result = getDockerImageUsageByApp(
			[
				{
					appId: 1,
					appName: 'first',
					services: [
						{ imageName: 'nginx', config: { image: 'nginx:latest' } },
						{ imageName: 'worker:1' },
					],
				},
				{ appId: 2, appName: 'second', services: [{ imageName: 'nginx:latest' }] },
				{ appId: 3, appName: 'empty', services: [] },
			],
			[
				{ RepoTags: ['docker.io/library/nginx:latest'], Size: 1000, SharedSize: 200 },
				{ RepoTags: ['worker:1'], Size: 500, SharedSize: 0 },
				{ RepoTags: ['<none>:<none>'], Size: 300, SharedSize: 0 },
			],
		);

		expect(result).toEqual([
			{ appId: 1, appName: 'first', bytes: 900 },
			{ appId: 2, appName: 'second', bytes: 400 },
			{ appId: 3, appName: 'empty', bytes: 0 },
		]);
	});
});
