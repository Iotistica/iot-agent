import type { DeviceDataPoint } from '../types.js';

export interface PrimitiveEntry {
	nodeId: string;
	value: number | boolean | string | null;
	isGood: boolean;
	statusCodeName: string;
	metric: string;
	unit: string;
	deviceName: string;
	device_uuid?: string;
	browseName?: string;
	writable?: boolean;
}

export interface TransformLookups {
	normalizationNames: Record<string, string>;
	displayNames: Record<string, string | undefined>;
	resolvedDisplayNames: Record<string, string | undefined>;
	stableDeviceIds: Record<string, string>;
}

export interface TransformRequest {
	type: 'transform';
	batchId: number;
	entries: PrimitiveEntry[];
}

export interface TransformResponse {
	type: 'result';
	batchId: number;
	points: DeviceDataPoint[];
}

export interface SyncMessage {
	type: 'sync';
	lookups: TransformLookups;
}

export type WorkerInMessage = TransformRequest | SyncMessage | { type: 'stop' };
export type WorkerOutMessage = TransformResponse;

export function classifyQualityFromName(statusName: string): 'UNCERTAIN' | 'BAD' {
	if (statusName.includes('Uncertain') || statusName.includes('BadWaitingForInitialData') || statusName.includes('BadDataUnavailable')) {
		return 'UNCERTAIN';
	}
	return 'BAD';
}

export function mapQualityCode(statusName: string): string {
	if (statusName.includes('BadSessionClosed') || statusName.includes('BadSessionIdInvalid')) return 'SESSION_CLOSED';
	if (statusName.includes('BadSecureChannelClosed') || statusName.includes('BadSecureChannelIdInvalid')) return 'SECURE_CHANNEL_CLOSED';
	if (statusName.includes('BadConnectionClosed') || statusName.includes('BadConnectionRejected')) return 'CONNECTION_REFUSED';
	if (statusName.includes('BadCommunicationError')) return 'COMMUNICATION_ERROR';
	if (statusName.includes('BadServerHalted') || statusName.includes('BadServerNotConnected')) return 'DEVICE_OFFLINE';
	if (statusName.includes('BadTimeout') || statusName.includes('BadRequestTimeout')) return 'TIMEOUT';
	if (statusName.includes('BadNodeIdUnknown') || statusName.includes('BadNodeIdInvalid')) return 'INVALID_NODE_ID';
	if (statusName.includes('BadAttributeIdInvalid')) return 'INVALID_ATTRIBUTE';
	if (statusName.includes('BadDataUnavailable') || statusName.includes('BadWaitingForInitialData')) return 'DATA_UNAVAILABLE';
	if (statusName.includes('BadIdentityTokenInvalid') || statusName.includes('BadIdentityTokenRejected')) return 'AUTHENTICATION_FAILED';
	if (statusName.includes('BadUserAccessDenied') || statusName.includes('BadNotReadable')) return 'ACCESS_DENIED';
	if (statusName.includes('BadCertificate')) return 'CERTIFICATE_ERROR';
	if (statusName.includes('BadOutOfRange')) return 'VALUE_OUT_OF_RANGE';
	if (statusName.includes('BadTypeMismatch')) return 'TYPE_MISMATCH';
	if (statusName.includes('BadUnexpectedError') || statusName.includes('BadInternalError')) return 'INTERNAL_ERROR';
	if (statusName.includes('BadNotSupported')) return 'NOT_SUPPORTED';
	return statusName;
}

export function buildPoint(entry: PrimitiveEntry, lookups: TransformLookups): DeviceDataPoint {
	const quality: 'GOOD' | 'UNCERTAIN' | 'BAD' = entry.isGood ? 'GOOD' : classifyQualityFromName(entry.statusCodeName);
	const qualityCode = quality !== 'GOOD' ? mapQualityCode(entry.statusCodeName) : undefined;
	const normalizationDeviceName = lookups.normalizationNames[entry.nodeId] ?? entry.deviceName;
	const deviceDisplayName = lookups.displayNames[entry.nodeId];
	const resolvedDisplayName = lookups.resolvedDisplayNames[entry.nodeId];
	const deviceId = lookups.stableDeviceIds[entry.nodeId];

	return {
		timestamp: new Date().toISOString(),
		deviceName: entry.deviceName,
		...(deviceId && { deviceId }),
		metric: entry.metric,
		value: entry.value,
		unit: entry.unit,
		quality,
		...(qualityCode && { qualityCode }),
		protocol: 'opcua',
		nodeType: 'metric',
		normalizationDeviceName,
		...(deviceDisplayName && { deviceDisplayName }),
		...(entry.device_uuid && { device_uuid: entry.device_uuid }),
		...(resolvedDisplayName !== undefined && { resolvedDisplayName }),
		...(entry.browseName && { rawObjectName: entry.browseName }),
		...(entry.writable && { writable: true }),
	};
}
