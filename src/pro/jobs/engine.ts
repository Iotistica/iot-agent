import { spawn, type SpawnOptions } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	type JobDocument,
	type JobAction,
	type ActionResult,
	type JobResult,
	ActionType,
	type ActionHandlerInput,
	type ActionCommandInput,
} from './types.js';
import type { AgentLogger } from '../shared/types.js';

const LOG_COMPONENT = 'JobEngine';

export class JobEngine {
	private static readonly MAX_LOG_LINES = 1000;
	private static readonly MAX_OUTPUT_LENGTH = 1024 * 10;
	private static readonly DEFAULT_PATH_KEYWORD = 'default';

	private logger?: AgentLogger;

	constructor(logger?: AgentLogger) {
		this.logger = logger;
	}

	async executeSteps(jobDocument: JobDocument, jobHandlerDir: string): Promise<JobResult> {
		if (!jobDocument) {
			const errorMsg = 'Job document is undefined or null';
			this.logger?.errorSync(errorMsg, new Error(errorMsg), { component: LOG_COMPONENT });
			return { success: false, exitCode: 1, reason: errorMsg, stdout: '', stderr: errorMsg, executedSteps: 0, failedStep: 'validation' };
		}

		if (!jobDocument.steps || !Array.isArray(jobDocument.steps)) {
			const errorMsg = 'Job document missing required "steps" array';
			this.logger?.errorSync(errorMsg, new Error(errorMsg), { component: LOG_COMPONENT, jobDocument });
			return { success: false, exitCode: 1, reason: errorMsg, stdout: '', stderr: errorMsg, executedSteps: 0, failedStep: 'validation' };
		}

		this.logger?.infoSync(`Starting job execution with ${jobDocument.steps.length} steps`, {
			component: LOG_COMPONENT,
			stepCount: jobDocument.steps.length,
		});

		let overallSuccess = true;
		let overallExitCode = 0;
		let combinedStdout = '';
		let combinedStderr = '';
		let executedSteps = 0;
		let failedStep: string | undefined;

		for (const step of jobDocument.steps) {
			this.logger?.infoSync(`Executing step: ${step.name}`, { component: LOG_COMPONENT, stepName: step.name });

			const result = await this.executeAction(step, jobHandlerDir);
			executedSteps++;

			combinedStdout += `=== Step: ${step.name} ===\n${result.stdout}\n`;
			combinedStderr += result.stderr ? `=== Step: ${step.name} STDERR ===\n${result.stderr}\n` : '';

			if (!result.success) {
				this.logger?.errorSync(`Step '${step.name}' failed with exit code ${result.exitCode}`, new Error(result.reason ?? 'step failed'), {
					component: LOG_COMPONENT,
					stepName: step.name,
					exitCode: result.exitCode,
				});

				if (!step.ignoreStepFailure) {
					overallSuccess = false;
					overallExitCode = result.exitCode;
					failedStep = step.name;
					break;
				} else {
					this.logger?.warnSync(`Ignoring failure of step '${step.name}' due to ignoreStepFailure=true`, {
						component: LOG_COMPONENT,
						stepName: step.name,
					});
				}
			}
		}

		if (overallSuccess && jobDocument.finalStep) {
			this.logger?.infoSync(`Executing final step: ${jobDocument.finalStep.name}`, {
				component: LOG_COMPONENT,
				stepName: jobDocument.finalStep.name,
			});

			const finalResult = await this.executeAction(jobDocument.finalStep, jobHandlerDir);
			executedSteps++;

			combinedStdout += `=== Final Step: ${jobDocument.finalStep.name} ===\n${finalResult.stdout}\n`;
			combinedStderr += finalResult.stderr ? `=== Final Step: ${jobDocument.finalStep.name} STDERR ===\n${finalResult.stderr}\n` : '';

			if (!finalResult.success && !jobDocument.finalStep.ignoreStepFailure) {
				overallSuccess = false;
				overallExitCode = finalResult.exitCode;
				failedStep = jobDocument.finalStep.name;
			}
		}

		const reason = overallSuccess
			? `Job completed successfully. Executed ${executedSteps} steps.`
			: `Job failed at step '${failedStep}' with exit code ${overallExitCode}`;

		return {
			success: overallSuccess,
			exitCode: overallExitCode,
			reason,
			stdout: this.truncateOutput(combinedStdout),
			stderr: this.truncateOutput(combinedStderr),
			executedSteps,
			failedStep,
		};
	}

	private async executeAction(action: JobAction, _jobHandlerDir: string): Promise<ActionResult> {
		try {
			switch (action.type) {
				case ActionType.RUN_HANDLER:
					return await this.executeHandler(action.input as ActionHandlerInput, action.runAsUser, action.allowStdErr);
				case ActionType.RUN_COMMAND:
					return await this.executeCommand(action.input as ActionCommandInput, action.runAsUser, action.allowStdErr);
				default:
					throw new Error(`Unknown action type: ${action.type}`);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger?.errorSync(`Action '${action.name}' failed: ${errorMessage}`, error as Error, {
				component: LOG_COMPONENT,
				actionName: action.name,
				actionType: action.type,
			});
			return { exitCode: 1, stdout: '', stderr: errorMessage, success: false, reason: `Action execution failed: ${errorMessage}` };
		}
	}

	private async executeHandler(handlerInput: ActionHandlerInput, runAsUser?: string, allowStdErr?: number): Promise<ActionResult> {
		const handlerPath = await this.buildHandlerCommand(handlerInput.path, handlerInput.handler);
		const args = handlerInput.args || [];
		const allArgs = runAsUser ? [runAsUser, ...args] : args;

		this.logger?.debugSync(`Executing handler: ${handlerPath}`, { component: LOG_COMPONENT, handlerPath, args: allArgs });

		return await this.executeProcess(handlerPath, allArgs, runAsUser, allowStdErr);
	}

	private async executeCommand(commandInput: ActionCommandInput, runAsUser?: string, allowStdErr?: number): Promise<ActionResult> {
		const commandParts = this.parseCommandString(commandInput.command);
		const command = commandParts[0];
		const args = commandParts.slice(1);

		if (!command) throw new Error('Empty command provided');

		this.logger?.debugSync(`Executing command: ${command}`, { component: LOG_COMPONENT, command, args });

		return await this.executeProcess(command, args, runAsUser, allowStdErr);
	}

	private async executeProcess(command: string, args: string[], runAsUser?: string, allowStdErr?: number): Promise<ActionResult> {
		let finalCommand = command;
		let finalArgs = args;

		if (runAsUser && process.platform !== 'win32') {
			if (await this.commandExists('sudo')) {
				finalCommand = 'sudo';
				finalArgs = ['-u', runAsUser, '-n', command, ...args];
			} else {
				this.logger?.warnSync('sudo not available, running as current user', {
					component: LOG_COMPONENT,
					requestedUser: runAsUser,
				});
			}
		}

		return new Promise((resolve) => {
			const options: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], shell: false };
			const child = spawn(finalCommand, finalArgs, options);
			let stdout = '';
			let stderr = '';

			child.stdout?.on('data', (data: Buffer) => {
				stdout += data.toString();
				stdout = this.limitOutputLines(stdout);
			});

			child.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString();
				stderr = this.limitOutputLines(stderr);
			});

			child.on('close', (code) => {
				const exitCode = code || 0;
				const stderrLines = stderr.split('\n').filter(line => line.trim()).length;
				const maxStderrLines = allowStdErr || 0;
				const success = exitCode === 0 && stderrLines <= maxStderrLines;
				const reason = success
					? 'Command executed successfully'
					: `Command failed with exit code ${exitCode}. STDERR lines: ${stderrLines}`;
				resolve({ exitCode, stdout: this.truncateOutput(stdout), stderr: this.truncateOutput(stderr), success, reason });
			});

			child.on('error', (error) => {
				resolve({ exitCode: 1, stdout: '', stderr: error.message, success: false, reason: `Process spawn failed: ${error.message}` });
			});
		});
	}

	private async buildHandlerCommand(handlerPath: string | undefined, handler: string): Promise<string> {
		let fullPath: string;

		if (!handlerPath || handlerPath === JobEngine.DEFAULT_PATH_KEYWORD) {
			const defaultDir = path.join(os.homedir(), '.aws-iot-device-client', 'jobs');
			fullPath = path.join(defaultDir, handler);
		} else {
			fullPath = path.isAbsolute(handlerPath)
				? path.join(handlerPath, handler)
				: path.join(process.cwd(), handlerPath, handler);
		}

		try {
			const stats = await fs.stat(fullPath);
			if (!stats.isFile()) throw new Error(`Handler is not a file: ${fullPath}`);

			if (process.platform !== 'win32') {
				const mode = stats.mode & parseInt('777', 8);
				if (mode !== parseInt('700', 8)) {
					throw new Error(`Handler has incorrect permissions. Expected 700, got ${mode.toString(8)}: ${fullPath}`);
				}
			}
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
				throw new Error(`Handler not found: ${fullPath}`);
			}
			throw error;
		}

		return fullPath;
	}

	private parseCommandString(commandString: string): string[] {
		const parts: string[] = [];
		let current = '';
		let escaped = false;

		for (let i = 0; i < commandString.length; i++) {
			const char = commandString[i];
			const nextChar = commandString[i + 1];

			if (char === '\\' && nextChar === ',') {
				current += ',';
				i++;
				escaped = true;
			} else if (char === ',' && !escaped) {
				parts.push(current);
				current = '';
			} else {
				current += char;
			}
			escaped = false;
		}

		if (current) parts.push(current);

		return parts.map(part => part.trim()).filter(part => part.length > 0);
	}

	private limitOutputLines(output: string): string {
		const lines = output.split('\n');
		if (lines.length <= JobEngine.MAX_LOG_LINES) return output;
		return lines.slice(0, JobEngine.MAX_LOG_LINES).join('\n') + `\n... [Output truncated after ${JobEngine.MAX_LOG_LINES} lines]`;
	}

	private truncateOutput(output: string): string {
		if (output.length <= JobEngine.MAX_OUTPUT_LENGTH) return output;
		return output.substring(0, JobEngine.MAX_OUTPUT_LENGTH) + `\n... [Output truncated after ${JobEngine.MAX_OUTPUT_LENGTH} characters]`;
	}

	private async commandExists(command: string): Promise<boolean> {
		return new Promise((resolve) => {
			const child = spawn('which', [command], { stdio: 'ignore' });
			child.on('close', (code) => resolve(code === 0));
			child.on('error', () => resolve(false));
		});
	}
}
