import { DEVICE_API_V1, CLIError, logger, apiRequest, getFlagValue } from '../core';

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function printOutput(output: Record<string, any>): void {
  console.log(`  protocol:        ${output.protocol}`);
  console.log(`  socket_path:     ${output.socket_path}`);
  console.log(`  buffer_capacity: ${output.buffer_capacity ?? 'default'} (${humanBytes(output.buffer_capacity ?? 1048576)})`);
  console.log(`  data_format:     ${output.data_format}`);
  console.log(`  delimiter:       ${JSON.stringify(output.delimiter)}`);
  if (output.drift_options) {
    console.log(`  drift:           enabled=${output.drift_options.enabled ?? false}`);
  }
}

export async function pipelineList(): Promise<void> {
  const data = await apiRequest(`${DEVICE_API_V1}/protocol-outputs`);
  const outputs: any[] = data.outputs ?? [];
  if (outputs.length === 0) {
    logger.info('No protocol pipelines configured');
    return;
  }
  logger.info(`${outputs.length} protocol pipeline(s)`);
  console.log('');
  for (const output of outputs) {
    console.log(`[${output.protocol}]`);
    printOutput(output);
    console.log('');
  }
}

export async function pipelineShow(protocol?: string): Promise<void> {
  if (!protocol) {
    throw new CLIError('Protocol name required', 1, {
      usage: 'iotctl pipeline show <protocol>',
    });
  }
  const data = await apiRequest(`${DEVICE_API_V1}/protocol-outputs`);
  const output = (data.outputs ?? []).find((o: any) => o.protocol === protocol);
  if (!output) {
    throw new CLIError(`Protocol output not found: ${protocol}`, 1);
  }
  console.log(`[${output.protocol}]`);
  printOutput(output);
}

const SETTABLE_FIELDS = new Set(['socket_path', 'buffer_capacity', 'data_format', 'delimiter']);

export async function pipelineSet(protocol?: string, ...args: string[]): Promise<void> {
  if (!protocol || args.length === 0 || args.length % 2 !== 0) {
    throw new CLIError('Protocol and key-value pairs required', 1, {
      usage: 'iotctl pipeline set <protocol> <key> <value> [<key> <value> ...]',
      fields: [...SETTABLE_FIELDS].join(', '),
    });
  }

  const patch: Record<string, any> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const raw = args[i + 1];
    if (!SETTABLE_FIELDS.has(key)) {
      throw new CLIError(`Unknown field: ${key}`, 1, {
        hint: `Settable fields: ${[...SETTABLE_FIELDS].join(', ')}`,
      });
    }
    let parsed: any = raw;
    try { parsed = JSON.parse(raw); } catch { /* keep as string */ }
    patch[key] = parsed;
  }

  const data = await apiRequest(`${DEVICE_API_V1}/protocol-outputs/${protocol}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  logger.info(`Updated ${protocol} pipeline`);
  printOutput(data.output);
}

export async function pipelineAdd(protocol?: string): Promise<void> {
  if (!protocol) {
    throw new CLIError('Protocol name required', 1, {
      usage: 'iotctl pipeline add <protocol> --socket <path> [--buffer <bytes>]',
    });
  }
  const socketPath = getFlagValue('--socket');
  if (!socketPath) {
    throw new CLIError('--socket <path> is required', 1, {
      usage: 'iotctl pipeline add <protocol> --socket <path> [--buffer <bytes>]',
    });
  }
  const bufferRaw = getFlagValue('--buffer');
  const body: Record<string, any> = {
    protocol,
    socket_path: socketPath,
  };
  if (bufferRaw) {
    body.buffer_capacity = Number(bufferRaw);
  }

  const data = await apiRequest(`${DEVICE_API_V1}/protocol-outputs`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  logger.info(`Added ${protocol} pipeline`);
  printOutput(data.output);
}

export async function pipelineRemove(protocol?: string): Promise<void> {
  if (!protocol) {
    throw new CLIError('Protocol name required', 1, {
      usage: 'iotctl pipeline remove <protocol>',
    });
  }
  await apiRequest(`${DEVICE_API_V1}/protocol-outputs/${protocol}`, {
    method: 'DELETE',
  });
  logger.info(`Removed ${protocol} pipeline`);
}
