/**
 * Image update detection (registry digest vs. deployed image).
 *
 * Detection only: nothing here pulls layers or changes containers. The user's
 * desired image reference (e.g. "nginx:latest") is never rewritten; the deployed
 * image is tracked separately.
 */
import type Docker from 'dockerode';

export interface ImageUpdateStatus {
	imageRef: string;
	deployedImageId?: string;
	deployedDigest?: string;
	remoteDigest?: string;
	/** true = update available, false = up to date, null = cannot be determined */
	updateAvailable: boolean | null;
	/** Why updateAvailable is null (or extra context for true) */
	reason?: string;
	checkedAt: string;
}

/** Registry-qualified repository without tag/digest, normalised (docker.io/library/ stripped). */
export function imageRepository(ref: string): string {
	let name = ref.split('@')[0];
	const lastSlash = name.lastIndexOf('/');
	const lastColon = name.lastIndexOf(':');
	if (lastColon > lastSlash) name = name.slice(0, lastColon);
	return name.replace(/^(index\.)?docker\.io\//, '').replace(/^library\//, '');
}

export function isDigestPinned(ref: string): boolean {
	return ref.includes('@sha256:');
}

/** Find the digest recorded locally for the same repository as imageRef. */
export function localDigestFor(imageRef: string, repoDigests: string[] | undefined): string | undefined {
	const repo = imageRepository(imageRef);
	for (const entry of repoDigests ?? []) {
		const at = entry.indexOf('@');
		if (at > 0 && imageRepository(entry.slice(0, at)) === repo) return entry.slice(at + 1);
	}
	return undefined;
}

/** Ask the Docker daemon for the registry manifest descriptor (no layers downloaded). */
export async function getRemoteDigest(
	docker: Docker,
	imageRef: string,
	authConfig?: object,
): Promise<string> {
	const modem: any = (docker as any).modem;
	const result: any = await new Promise((resolve, reject) => {
		modem.dial(
			{
				path: `/distribution/${encodeURIComponent(imageRef)}/json`,
				method: 'GET',
				authconfig: authConfig,
				statusCodes: { 200: true, 401: 'unauthorized', 403: 'forbidden', 404: 'not found', 500: 'server error' },
			},
			(err: Error | null, data: any) => (err ? reject(err) : resolve(data)),
		);
	});
	const digest = result?.Descriptor?.digest;
	if (typeof digest !== 'string' || !digest.startsWith('sha256:')) {
		throw new Error('Registry returned no manifest digest');
	}
	return digest;
}

/**
 * Compare the deployed image with the registry. Failures and non-comparable
 * cases yield updateAvailable=null rather than a false "no update".
 */
export async function checkImageUpdate(
	docker: Docker,
	imageRef: string,
	deployedImageId?: string,
	authConfig?: object,
): Promise<ImageUpdateStatus> {
	const status: ImageUpdateStatus = {
		imageRef,
		deployedImageId,
		updateAvailable: null,
		checkedAt: new Date().toISOString(),
	};

	if (isDigestPinned(imageRef)) {
		status.reason = 'pinned-by-digest';
		return status;
	}

	let tagInfo: Docker.ImageInspectInfo;
	try {
		tagInfo = await docker.getImage(imageRef).inspect();
	} catch {
		status.reason = 'image-not-present-locally';
		return status;
	}
	status.deployedDigest = localDigestFor(imageRef, tagInfo.RepoDigests);

	try {
		status.remoteDigest = await getRemoteDigest(docker, imageRef, authConfig);
	} catch (err) {
		status.reason = `registry-check-failed: ${err instanceof Error ? err.message : String(err)}`;
		return status;
	}

	// Locally pulled newer image than the one the container runs (needs recreate only).
	if (deployedImageId && tagInfo.Id !== deployedImageId) {
		status.updateAvailable = true;
		status.reason = 'newer-image-pulled-locally';
		return status;
	}

	if (!status.deployedDigest) {
		status.reason = 'no-local-repo-digest'; // locally built or loaded image
		return status;
	}

	status.updateAvailable = status.deployedDigest !== status.remoteDigest;
	return status;
}
