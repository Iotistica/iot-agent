interface AppWithServices {
	appId: number;
	appName: string;
	services: Array<{
		imageName?: string;
		config?: { image?: string };
	}>;
}

interface DockerImageUsage {
	RepoTags?: string[];
	RepoDigests?: string[];
	Size?: number;
	SharedSize?: number;
}

function normalizeImageReference(reference: string): string {
	let normalized = reference.trim().replace(/^docker\.io\//, '');
	if (!normalized.includes('/')) normalized = `library/${normalized}`;

	const lastSlash = normalized.lastIndexOf('/');
	if (!normalized.slice(lastSlash + 1).includes(':') && !normalized.includes('@')) {
		normalized += ':latest';
	}

	return normalized;
}

export function getDockerImageUsageByApp(
	apps: AppWithServices[],
	images: DockerImageUsage[],
): Array<{ appId: number; appName: string; bytes: number }> {
	const usageByApp = new Map(apps.map(app => [app.appId, 0]));

	for (const image of images) {
		const size = Number.isFinite(image.Size) && Number.isFinite(image.SharedSize)
			? Math.max(0, image.Size! - image.SharedSize!)
			: Number.isFinite(image.Size) ? Math.max(0, image.Size!) : 0;
		if (!size) continue;

		const imageReferences = new Set(
			[...(image.RepoTags ?? []), ...(image.RepoDigests ?? [])]
				.filter(reference => reference && reference !== '<none>:<none>')
				.map(normalizeImageReference),
		);
		if (imageReferences.size === 0) continue;

		const consumers = apps.filter(app => app.services.some(service =>
			[service.imageName, service.config?.image]
				.filter((reference): reference is string => !!reference)
				.some(reference => imageReferences.has(normalizeImageReference(reference))),
		));
		if (consumers.length === 0) continue;

		const sizePerApp = size / consumers.length;
		for (const app of consumers) {
			usageByApp.set(app.appId, (usageByApp.get(app.appId) ?? 0) + sizePerApp);
		}
	}

	return apps.map(app => ({
		appId: app.appId,
		appName: app.appName,
		bytes: usageByApp.get(app.appId) ?? 0,
	}));
}
