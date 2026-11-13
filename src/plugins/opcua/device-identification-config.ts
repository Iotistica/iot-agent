import { z } from 'zod';

export const OPCUADeviceIdentificationSchema = z.object({
	rootNodeId: z.string().trim().min(1),
	scopeNodeId: z.string().trim().min(1),
	deviceTypeNodeId: z.string().trim().min(1),
	identifierProperty: z.string().trim().min(1),
	identifierPath: z.string().trim().min(1),
}).strict();
export type OPCUADeviceIdentification = z.infer<typeof OPCUADeviceIdentificationSchema>;
