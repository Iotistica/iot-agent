type LiveDataInterceptor = (messages: any[], endpointName: string) => Promise<any[]> | any[];

/**
 * Composes multiple live-data interceptor stages into the single function
 * PublishManager.setLiveDataInterceptor() accepts (that hook holds one
 * function reference, last-write-wins — this lets several pipeline stages
 * share it). Runs stages in order, sequentially threading `messages` through
 * each one. A future Point-Name-Normalization / Haystack-Tagging stage adds
 * itself to this argument list rather than needing to touch call sites.
 */
export function composeInterceptors(...stages: LiveDataInterceptor[]): LiveDataInterceptor {
	return async function composedInterceptor(messages: any[], endpointName: string): Promise<any[]> {
		let current = messages;
		for (const stage of stages) {
			const result = await stage(current, endpointName);
			if (Array.isArray(result)) current = result;
		}
		return current;
	};
}
