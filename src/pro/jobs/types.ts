import { z } from 'zod';

export enum JobStatus {
  QUEUED = 'QUEUED',
  IN_PROGRESS = 'IN_PROGRESS',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  TIMED_OUT = 'TIMED_OUT',
  REJECTED = 'REJECTED',
  CANCELED = 'CANCELED'
}

export enum JobExecutionType {
  ONE_TIME = 'oneTime',
  RECURRING = 'recurring',
  CONTINUOUS = 'continuous'
}

export enum ActionType {
  RUN_HANDLER = 'runHandler',
  RUN_COMMAND = 'runCommand'
}

export const JobConditionSchema = z.object({
  key: z.string(),
  value: z.array(z.string()),
  type: z.string().optional().default('stringEqual')
});

export type JobCondition = z.infer<typeof JobConditionSchema>;

export const ActionHandlerInputSchema = z.object({
  handler: z.string(),
  args: z.array(z.string()).optional(),
  path: z.string().optional()
});

export type ActionHandlerInput = z.infer<typeof ActionHandlerInputSchema>;

export const ActionCommandInputSchema = z.object({
  command: z.string()
});

export type ActionCommandInput = z.infer<typeof ActionCommandInputSchema>;

export const JobActionSchema = z.object({
  name: z.string(),
  type: z.nativeEnum(ActionType),
  input: z.union([ActionHandlerInputSchema, ActionCommandInputSchema]),
  runAsUser: z.string().optional(),
  allowStdErr: z.number().optional(),
  ignoreStepFailure: z.boolean().optional().default(false)
});

export type JobAction = z.infer<typeof JobActionSchema>;

export const JobScheduleSchema = z.object({
  type: z.enum(['interval', 'cron']),
  intervalMinutes: z.number().optional(),
  cronExpression: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional()
});

export type JobSchedule = z.infer<typeof JobScheduleSchema>;

export const JobDocumentSchema = z.object({
  version: z.string().default('1.0'),
  includeStdOut: z.boolean().optional().default(false),
  conditions: z.array(JobConditionSchema).optional(),
  steps: z.array(JobActionSchema),
  finalStep: JobActionSchema.optional(),

  executionType: z.nativeEnum(JobExecutionType).optional().default(JobExecutionType.ONE_TIME),
  schedule: JobScheduleSchema.optional(),
  maxExecutions: z.number().optional(),
  maxDurationMinutes: z.number().optional(),
  reportProgress: z.boolean().optional().default(false),
  progressIntervalSeconds: z.number().optional().default(60),

  // Legacy schema support (version 0.0)
  operation: z.string().optional(),
  args: z.array(z.string()).optional(),
  allowStdErr: z.number().optional(),
  path: z.string().optional()
});

export type JobDocument = z.infer<typeof JobDocumentSchema>;

export interface JobExecutionData {
  jobId: string;
  deviceUuid: string;
  jobDocument: JobDocument;
  status: JobStatus;
  queuedAt?: Date | undefined;
  startedAt?: Date | undefined;
  lastUpdatedAt?: Date | undefined;
  versionNumber: number;
  executionNumber: number;
  statusDetails?: Record<string, string> | undefined;
}

export interface JobExecutionStatusInfo {
  status: JobStatus;
  reason?: string;
  stdOutput?: string;
  stdError?: string;
}

export interface ActionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
  reason?: string;
}

export interface JobResult {
  success: boolean;
  exitCode: number;
  reason: string;
  stdout: string;
  stderr: string;
  executedSteps: number;
  failedStep?: string | undefined;
}
