export interface DetectionRuleScope {
	fieldPattern?: string;
	devicePattern?: string;
	endpointPattern?: string;
}

export interface DetectionRuleBase extends DetectionRuleScope {
	id?: string;
	enabled: boolean;
	priority: number;
	name?: string;
	description?: string;
	createdAt?: string;
	updatedAt?: string;
}

const globCache = new Map<string, RegExp>();

export function matchGlob(pattern: string, value: string): boolean {
	let re = globCache.get(pattern);
	if (!re) {
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		const globbed = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
		re = new RegExp(`^${globbed}$`, 'i');
		if (globCache.size > 500) globCache.clear();
		globCache.set(pattern, re);
	}
	return re.test(value);
}

export function resolveRules<T extends DetectionRuleBase>(
	rules: T[],
	fieldName: string,
	deviceId: string,
	endpointName: string,
): T[] {
	const matched: T[] = [];
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (rule.fieldPattern && !matchGlob(rule.fieldPattern, fieldName)) continue;
		if (rule.devicePattern && !matchGlob(rule.devicePattern, deviceId)) continue;
		if (rule.endpointPattern && !matchGlob(rule.endpointPattern, endpointName)) continue;
		matched.push(rule);
	}
	matched.sort((a, b) => b.priority - a.priority);
	return matched;
}
