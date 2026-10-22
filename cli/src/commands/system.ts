import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CLIError, DEVICE_API_V1, apiProbe, logger } from '../core';


/**
 * iotctl logs [-f] [--lines <count>]
 */
export function showLogs(follow: boolean = false, lines: number = 50): void {
  throw new CLIError('Agent logs not available from inside container', 1, {
    note: 'Run from host machine instead',
    hint_docker: follow ? 'docker logs -f agent-1' : `docker logs --tail ${lines} agent-1`,
    hint_compose: follow ? 'docker-compose logs -f agent-1' : `docker-compose logs --tail=${lines} agent-1`,
  });
}

/**
 * iotctl version
 */
export async function showVersion(): Promise<void> {
  const result = await apiProbe(`${DEVICE_API_V1}/settings`);
  if (result.ok && result.data) {
    const agentVersion = (result.data as any)?.settings?.agent?.version;
    if (agentVersion) {
      logger.info('Iotistica Agent', { version: agentVersion });
      return;
    }
  }

  const agentPaths = [
    '/opt/iotistic/agent/package.json',
    '/app/package.json',
  ];

  for (const packagePath of agentPaths) {
    try {
      if (existsSync(packagePath)) {
        const agentVersion = JSON.parse(readFileSync(packagePath, 'utf-8')).version;
        if (agentVersion) {
          logger.info('Iotistica Agent', { version: agentVersion });
          return;
        }
      }
    } catch { continue; }
  }

  logger.info('Iotistica Agent', { version: 'unknown (agent not reachable)' });
}
