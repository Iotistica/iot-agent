import { checkImageUpdate, getRemoteDigest, imageRepository, localDigestFor } from '../../../src/containers/image-update';

function fakeDocker(opts: { repoDigests?: string[]; id?: string; remote?: string | Error; missing?: boolean }) {
	return {
		getImage: () => ({
			inspect: opts.missing
				? jest.fn().mockRejectedValue(new Error('no such image'))
				: jest.fn().mockResolvedValue({ Id: opts.id ?? 'sha256:aaa', RepoDigests: opts.repoDigests }),
		}),
		modem: {
			dial: (_o: any, cb: any) =>
				opts.remote instanceof Error
					? cb(opts.remote)
					: cb(null, { Descriptor: { digest: opts.remote } }),
		},
	} as any;
}

describe('image update detection', () => {
	it('normalises repositories', () => {
		expect(imageRepository('docker.io/library/nginx:latest')).toBe('nginx');
		expect(imageRepository('localhost:5000/app:1')).toBe('localhost:5000/app');
		expect(localDigestFor('nginx:latest', ['nginx@sha256:x'])).toBe('sha256:x');
		expect(localDigestFor('nginx:latest', ['other@sha256:x'])).toBeUndefined();
	});

	it('reports update when digests differ', async () => {
		const s = await checkImageUpdate(fakeDocker({ repoDigests: ['nginx@sha256:old'], remote: 'sha256:new' }), 'nginx:latest', 'sha256:aaa');
		expect(s.updateAvailable).toBe(true);
	});

	it('reports up to date when digests match', async () => {
		const s = await checkImageUpdate(fakeDocker({ repoDigests: ['nginx@sha256:same'], remote: 'sha256:same' }), 'nginx:latest', 'sha256:aaa');
		expect(s.updateAvailable).toBe(false);
	});

	it('reports a locally pulled newer image', async () => {
		const s = await checkImageUpdate(fakeDocker({ repoDigests: ['nginx@sha256:same'], remote: 'sha256:same', id: 'sha256:new' }), 'nginx:latest', 'sha256:old');
		expect(s.updateAvailable).toBe(true);
		expect(s.reason).toBe('newer-image-pulled-locally');
	});

	it('is unknown without repo digests, on registry failure, or when pinned', async () => {
		expect((await checkImageUpdate(fakeDocker({ remote: 'sha256:n' }), 'app:latest')).updateAvailable).toBeNull();
		const failed = await checkImageUpdate(fakeDocker({ repoDigests: ['a@sha256:x'], remote: new Error('offline') }), 'a:latest');
		expect(failed.updateAvailable).toBeNull();
		expect(failed.reason).toContain('registry-check-failed');
		expect((await checkImageUpdate(fakeDocker({}), 'a@sha256:abc')).reason).toBe('pinned-by-digest');
		expect((await checkImageUpdate(fakeDocker({ missing: true }), 'a:latest')).updateAvailable).toBeNull();
	});

	it('URL-encodes image refs with slashes for the distribution API', async () => {
		let dialPath = '';
		const docker = {
			modem: {
				dial: (o: any, cb: any) => { dialPath = o.path; cb(null, { Descriptor: { digest: 'sha256:abc' } }); },
			},
		} as any;
		await getRemoteDigest(docker, 'ghcr.io/org/app:latest');
		expect(dialPath).toBe(`/distribution/${encodeURIComponent('ghcr.io/org/app:latest')}/json`);
	});

	it('normalises multi-segment private registry repos', () => {
		expect(imageRepository('ghcr.io/org/app:v2')).toBe('ghcr.io/org/app');
		expect(imageRepository('localhost:5000/deep/nested/img:1')).toBe('localhost:5000/deep/nested/img');
	});
});
