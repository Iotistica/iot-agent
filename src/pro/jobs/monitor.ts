import { type HttpClient, FetchHttpClient } from '../shared/http-client.js';
import type { AgentLogger, JobsMqttClient } from '../shared/types.js';
import { JobEngine } from './engine.js';
import { type JobDocument, type JobExecutionData } from './types.js';

const LOG_COMPONENT = 'Jobs';

export interface JobsConfig {
  enabled: boolean;
  cloudApiUrl: string;
  deviceApiKey?: string;
  pollingIntervalMs?: number;
  maxRetries?: number;
  handlerDirectory?: string;
  maxConcurrentJobs?: number;
  defaultHandlerTimeout?: number;
}

export interface JobsOptions {
  mqttClient?: JobsMqttClient;
  notifyTopic?: string;
  buildUpdateTopic?: (jobId: string) => string;
}

interface CloudJob {
  job_id: string;
  job_name: string;
  job_document: JobDocument;
  timeout_seconds: number;
  created_at: string;
}

interface JobStatusUpdate {
  status: 'QUEUED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELED';
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  status_details?: {
    message?: string;
    progress?: number;
    error?: string;
    timestamp?: string;
    [key: string]: any;
  };
}

interface FeatureLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, errorOrContext?: any, context?: Record<string, any>): void;
  debug(message: string, ...args: any[]): void;
}

function createLogger(agentLogger: AgentLogger): FeatureLogger {
  return {
    info: (msg) => agentLogger.infoSync(msg, { component: LOG_COMPONENT }),
    warn: (msg) => agentLogger.warnSync(msg, { component: LOG_COMPONENT }),
    error: (msg, errOrCtx?, ctx?) => {
      if (errOrCtx instanceof Error) {
        agentLogger.errorSync(msg, errOrCtx, { component: LOG_COMPONENT, ...ctx });
      } else if (errOrCtx && typeof errOrCtx === 'object') {
        agentLogger.errorSync(msg, undefined, { component: LOG_COMPONENT, ...errOrCtx, ...ctx });
      } else {
        agentLogger.errorSync(msg, undefined, { component: LOG_COMPONENT });
      }
    },
    debug: (msg, ...args) => {
      if (process.env.JOBS_DEBUG === 'true') {
        agentLogger.debugSync(msg, { component: LOG_COMPONENT, args });
      }
    },
  };
}

export class JobsFeature {
  private logger: FeatureLogger;
  private jobEngine: JobEngine;
  private httpClient: HttpClient;
  private baseUrl: string = '';
  private deviceApiKey: string = '';
  private httpPollingInterval?: NodeJS.Timeout;
  private connectionMonitor?: NodeJS.Timeout;
  private lastMqttState: boolean = false;
  private httpPaused: boolean = false;
  private handlingJob: boolean = false;
  private needStop: boolean = false;
  private latestJobNotification: JobExecutionData | null = null;
  private mqttSubscribed: boolean = false;
  private isRunning: boolean = false;

  private mqttClient?: JobsMqttClient;
  private notifyTopic?: string;
  private buildUpdateTopic?: (jobId: string) => string;

  constructor(
    private readonly config: JobsConfig,
    agentLogger: AgentLogger,
    private readonly deviceUuid: string,
    httpClient?: HttpClient,
    options?: JobsOptions,
  ) {
    this.logger = createLogger(agentLogger);
    this.jobEngine = new JobEngine(agentLogger);

    this.mqttClient = options?.mqttClient;
    this.notifyTopic = options?.notifyTopic;
    this.buildUpdateTopic = options?.buildUpdateTopic;

    const apiVersion = process.env.API_VERSION || 'v1';
    const trimmed = config.cloudApiUrl.replace(/\/+$/, '');
    const normalizedBaseUrl = trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
    this.baseUrl = `${normalizedBaseUrl}/${apiVersion}`;
    this.deviceApiKey = config.deviceApiKey || '';

    if (httpClient) {
      this.httpClient = httpClient;
    } else {
      const isLocalhost = normalizedBaseUrl.includes('localhost') || normalizedBaseUrl.includes('127.0.0.1');
      const isHttps = normalizedBaseUrl.startsWith('https://');
      this.httpClient = new FetchHttpClient({
        defaultHeaders: {
          'Content-Type': 'application/json',
          'User-Agent': `Iotistic-agent/${deviceUuid}`,
        },
        defaultTimeout: 30000,
        rejectUnauthorized: !isLocalhost && !isHttps,
      });
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Feature already running');
      return;
    }

    if (!this.config.cloudApiUrl) {
      throw new Error('cloudApiUrl is required for Jobs feature');
    }

    this.logger.debug(`Initializing Jobs Feature - pollingIntervalMs: ${this.config.pollingIntervalMs || 30000}, handlerDirectory: ${this.config.handlerDirectory || '/app/data/job-handlers'}`);

    await this.startHttpPolling();
    await this.initializeMqttSubscriptions();
    this.startConnectionMonitor();

    this.isRunning = true;
    this.logger.debug(`Jobs Feature started - Mode: ${this.mqttSubscribed ? 'MQTT-primary with HTTP fallback' : 'HTTP-only'}`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.logger.debug('Stopping Jobs Feature');
    this.needStop = true;

    if (this.connectionMonitor) {
      clearInterval(this.connectionMonitor);
      this.connectionMonitor = undefined;
    }

    if (this.httpPollingInterval) {
      clearInterval(this.httpPollingInterval);
      this.httpPollingInterval = undefined;
      this.logger.debug('HTTP polling stopped');
    }

    if (this.mqttSubscribed) {
      await this.unsubscribeFromMqtt();
    }

    while (this.handlingJob) {
      await this.sleep(100);
    }

    this.isRunning = false;
    this.logger.debug('Jobs Feature stopped');
  }

  running(): boolean {
    return this.isRunning;
  }

  private async startHttpPolling(): Promise<void> {
    const pollingIntervalMs = this.config.pollingIntervalMs || 30000;
    this.logger.debug(`Starting HTTP polling (interval: ${pollingIntervalMs}ms)`);

    await this.pollForJobs();

    this.httpPollingInterval = setInterval(async () => {
      if (!this.httpPaused && !this.handlingJob && !this.needStop) {
        await this.pollForJobs();
      }
    }, pollingIntervalMs);

    this.logger.debug('HTTP polling started');
  }

  private async pollForJobs(): Promise<void> {
    try {
      const url = `${this.baseUrl}/devices/${this.deviceUuid}/jobs/next`;
      const response = await this.httpClient.get<CloudJob | null>(url, {
        headers: { 'X-Device-API-Key': this.deviceApiKey },
      });

      if (response.ok && response.status === 200) {
        const cloudJob = await response.json();

        if (cloudJob) {
          if (!cloudJob.job_id) {
            this.logger.error('HTTP job response missing job_id', { cloudJob });
            return;
          }

          this.logger.info(`Received job from HTTP polling: ${cloudJob.job_id}`);

          if (!cloudJob.job_document) {
            this.logger.error(`HTTP job response missing job_document for job ${cloudJob.job_id}`, {
              jobId: cloudJob.job_id, cloudJob,
            });
            return;
          }

          let jobDocument = cloudJob.job_document;
          if (typeof jobDocument === 'string') {
            try {
              jobDocument = JSON.parse(jobDocument);
            } catch (error) {
              this.logger.error('Failed to parse job_document JSON', {
                jobId: cloudJob.job_id,
                error: error instanceof Error ? error.message : String(error),
              });
              return;
            }
          }

          const jobData: JobExecutionData = {
            jobId: cloudJob.job_id,
            deviceUuid: this.deviceUuid,
            jobDocument,
            status: 'QUEUED' as any,
            versionNumber: 1,
            executionNumber: 1,
          };

          await this.executeJob(jobData);
        }
      }
    } catch (error: any) {
      const is404 = (error.status === 404) || (error.response?.status === 404);
      if (!is404) {
        let errorMessage = error.message;
        if (!errorMessage && error.cause) {
          errorMessage = error.cause.message || (typeof error.cause === 'object' ? JSON.stringify(error.cause) : String(error.cause));
        }
        if (!errorMessage) errorMessage = String(error);

        const errorDetails: Record<string, any> = {
          errorType: error.name || 'Unknown',
          url: `${this.baseUrl}/devices/${this.deviceUuid}/jobs/next`,
        };
        if (error.code) errorDetails.code = error.code;
        if (error.status) errorDetails.status = error.status;
        if (error.cause) {
          errorDetails.cause = typeof error.cause === 'object'
            ? (error.cause.message || error.cause.code || JSON.stringify(error.cause))
            : String(error.cause);
        }

        this.logger.error(`HTTP polling error: ${errorMessage}`, errorDetails);
      }
    }
  }

  private async initializeMqttSubscriptions(): Promise<void> {
    if (!this.mqttClient || !this.notifyTopic) {
      this.logger.warn('MQTT client or notify topic not provided, using HTTP-only mode');
      return;
    }

    try {
      if (!this.mqttClient.isConnected()) {
        this.logger.warn('MQTT not connected, using HTTP-only mode');
        return;
      }

      this.logger.debug('Initializing MQTT job notifications (primary)');

      await this.mqttClient.subscribe(this.notifyTopic, { qos: 1 }, async (_topic: string, payload: Buffer) => {
        try {
          const message = JSON.parse(payload.toString());
          await this.handleMqttJobNotification(message);
        } catch (error) {
          this.logger.error(`Failed to parse MQTT job notification: ${error}`);
        }
      });

      this.mqttSubscribed = true;
      this.logger.debug('MQTT job notifications initialized');
    } catch (error) {
      this.logger.warn(`Failed to initialize MQTT subscriptions (will use HTTP fallback): ${error}`);
      this.mqttSubscribed = false;
    }
  }

  private async handleMqttJobNotification(message: any): Promise<void> {
    this.logger.debug('Received MQTT job notification');

    if (!message.execution) {
      this.logger.debug('No pending jobs available');
      return;
    }

    if (!message.execution.jobId) {
      this.logger.error('MQTT job notification missing jobId', { message });
      return;
    }

    if (!message.execution.jobDocument) {
      this.logger.error(`MQTT job notification missing jobDocument for job ${message.execution.jobId}`, {
        jobId: message.execution.jobId,
        executionData: message.execution,
      });
      return;
    }

    let jobDocument = message.execution.jobDocument;
    if (typeof jobDocument === 'string') {
      try {
        jobDocument = JSON.parse(jobDocument);
      } catch (error) {
        this.logger.error('Failed to parse jobDocument JSON', {
          jobId: message.execution.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    const jobData: JobExecutionData = {
      jobId: message.execution.jobId,
      deviceUuid: message.execution.deviceUuid || message.execution.thingName || this.deviceUuid,
      jobDocument,
      status: message.execution.status || 'QUEUED',
      queuedAt: message.execution.queuedAt ? new Date(message.execution.queuedAt) : undefined,
      startedAt: message.execution.startedAt ? new Date(message.execution.startedAt) : undefined,
      lastUpdatedAt: message.execution.lastUpdatedAt ? new Date(message.execution.lastUpdatedAt) : undefined,
      versionNumber: message.execution.versionNumber || 1,
      executionNumber: message.execution.executionNumber || 1,
      statusDetails: message.execution.statusDetails,
    };

    if (this.isDuplicateNotification(jobData)) {
      this.logger.debug(`Ignoring duplicate job notification for job ${jobData.jobId}`);
      return;
    }

    await this.executeJob(jobData);
  }

  private async unsubscribeFromMqtt(): Promise<void> {
    if (!this.mqttClient || !this.notifyTopic) return;
    try {
      await this.mqttClient.unsubscribe(this.notifyTopic);
      this.mqttSubscribed = false;
      this.logger.info('Unsubscribed from MQTT job notifications');
    } catch (error) {
      this.logger.warn(`Failed to unsubscribe from MQTT: ${error}`);
    }
  }

  private async executeJob(jobData: JobExecutionData): Promise<void> {
    if (this.needStop) {
      this.logger.info(`Ignoring job ${jobData.jobId} due to shutdown request`);
      return;
    }

    if (this.handlingJob) {
      this.logger.warn(`Already handling a job, ignoring job ${jobData.jobId}`);
      return;
    }

    this.handlingJob = true;
    this.latestJobNotification = jobData;

    try {
      this.logger.info(`Starting execution of job ${jobData.jobId}`);

      if (!jobData.jobDocument) {
        this.logger.error('Job document is missing from job data', {
          jobId: jobData.jobId,
          jobDataKeys: Object.keys(jobData),
        });
        throw new Error('Job document is missing from job data');
      }

      if (!jobData.jobDocument.steps || !Array.isArray(jobData.jobDocument.steps)) {
        this.logger.error('Job document missing required "steps" array', {
          jobId: jobData.jobId,
          jobDocument: JSON.stringify(jobData.jobDocument),
        });
        throw new Error('Job document missing required "steps" array');
      }

      await this.updateJobStatus(jobData.jobId, {
        status: 'IN_PROGRESS',
        status_details: { message: 'Job execution started', timestamp: new Date().toISOString() },
      });

      const result = await this.jobEngine.executeSteps(
        jobData.jobDocument,
        this.config.handlerDirectory || '/app/data/job-handlers',
      );

      const finalStatus = result.success ? 'SUCCEEDED' : 'FAILED';
      await this.updateJobStatus(jobData.jobId, {
        status: finalStatus,
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        status_details: {
          message: result.reason || (result.success ? 'Job completed successfully' : 'Job failed'),
          timestamp: new Date().toISOString(),
        },
      });

      this.logger.info(`Job ${jobData.jobId} completed with status: ${finalStatus}`);
    } catch (error) {
      const errorMessage = `Job execution failed: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(errorMessage);

      try {
        await this.updateJobStatus(jobData.jobId, {
          status: 'FAILED',
          stderr: errorMessage,
          status_details: { error: errorMessage, timestamp: new Date().toISOString() },
        });
      } catch (updateError) {
        this.logger.error(`Failed to update job status after error: ${updateError}`);
      }
    } finally {
      this.handlingJob = false;
    }
  }

  private async updateJobStatus(jobId: string, update: JobStatusUpdate): Promise<void> {
    const mqttHealthy = this.mqttClient?.isConnected() ?? false;

    if (mqttHealthy && this.buildUpdateTopic) {
      try {
        const updateTopic = this.buildUpdateTopic(jobId);
        this.logger.debug(`Updating job status via MQTT: ${updateTopic}`, { status: update.status });
        await this.mqttClient!.publishNoQueue(updateTopic, JSON.stringify(update), { qos: 1 });
        this.logger.debug(`Updated job ${jobId} status to ${update.status} via MQTT`);
        return;
      } catch (error: any) {
        this.logger.warn(`MQTT status update failed, falling back to HTTP: ${error.message}`);
      }
    } else {
      this.logger.debug('MQTT not connected or topic not configured, using HTTP for status update');
    }

    const url = `${this.baseUrl}/devices/${this.deviceUuid}/jobs/${jobId}/status`;
    try {
      this.logger.debug(`Updating job status via HTTP: PATCH ${url}`, { status: update.status });
      await this.httpClient.patch(url, update, {
        headers: { 'X-Device-API-Key': this.deviceApiKey },
      });
      this.logger.debug(`Updated job ${jobId} status to ${update.status} via HTTP`);
    } catch (error: any) {
      this.logger.error(`Failed to update job status via HTTP: ${error.message}`, {
        url,
        status: error.response?.status,
      });
      throw error;
    }
  }

  private isDuplicateNotification(jobData: JobExecutionData): boolean {
    if (!this.latestJobNotification) return false;
    return this.latestJobNotification.jobId === jobData.jobId &&
      this.latestJobNotification.versionNumber === jobData.versionNumber &&
      this.latestJobNotification.executionNumber === jobData.executionNumber;
  }

  private startConnectionMonitor(): void {
    if (!this.mqttClient) return;

    this.lastMqttState = this.mqttClient.isConnected();

    if (this.lastMqttState && this.mqttSubscribed) {
      this.httpPaused = true;
      this.logger.info('MQTT connected - HTTP polling paused (MQTT-primary mode)');
    }

    this.connectionMonitor = setInterval(() => {
      const currentMqttState = this.mqttClient!.isConnected();

      if (currentMqttState !== this.lastMqttState) {
        if (currentMqttState && this.mqttSubscribed) {
          this.httpPaused = true;
          this.logger.debug('MQTT reconnected - switching to MQTT-primary mode');
        } else {
          this.httpPaused = false;
          this.logger.warn('MQTT disconnected - falling back to HTTP polling');
        }
        this.lastMqttState = currentMqttState;
      }
    }, 5000);

    this.logger.debug(`Connection monitor started - Initial mode: ${this.lastMqttState && this.mqttSubscribed ? 'MQTT-primary' : 'HTTP-fallback'}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getJobEngine(): JobEngine {
    return this.jobEngine;
  }

  isMqttActive(): boolean {
    return this.mqttSubscribed && (this.mqttClient?.isConnected() ?? false);
  }

  isHttpActive(): boolean {
    return !this.httpPaused;
  }

  getCurrentMode(): 'mqtt' | 'http' {
    return this.isMqttActive() ? 'mqtt' : 'http';
  }
}
