import { DEVICE_API_V1, CLIError, logger, apiRequest, clearApiCache } from '../core';

function printStatus(status: any): void {
  logger.info('License status', {
    state: status.state,
    tier: status.tier ?? 'none',
    licenseId: status.licenseId ?? 'none',
    expiresAt: status.expiresAt ? new Date(status.expiresAt).toISOString() : status.expiresAt === null ? 'never' : 'n/a',
    daysRemaining: status.daysRemaining ?? 'n/a',
    invalidReason: status.invalidReason,
  });
}

async function post(path: string, body: unknown, failure: string): Promise<void> {
  try {
    clearApiCache();
    printStatus(await apiRequest(`${DEVICE_API_V1}/license${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch (error: any) {
    if (error instanceof CLIError) throw error;
    throw new CLIError(failure, 1, { reason: error?.message });
  }
}

/** iotctl license [status] */
export async function licenseStatus(): Promise<void> {
  try {
    clearApiCache();
    printStatus(await apiRequest(`${DEVICE_API_V1}/license`));
  } catch (error: any) {
    if (error instanceof CLIError) throw error;
    throw new CLIError('Failed to get license status', 1, { reason: error?.message });
  }
}

/** iotctl license trial */
export async function licenseTrial(): Promise<void> {
  await post('/trial', {}, 'Trial activation failed');
}

/** iotctl license activate <key> (also converts an existing trial to paid) */
export async function licenseActivate(key?: string): Promise<void> {
  if (!key) {
    throw new CLIError('License key is required', 1, { usage: 'iotctl license activate <key>' });
  }
  await post('/activate', { licenseKey: key }, 'License activation failed');
}

/** iotctl license apply-token <token> (offline activation) */
export async function licenseApplyToken(token?: string): Promise<void> {
  if (!token) {
    throw new CLIError('Signed license token is required', 1, { usage: 'iotctl license apply-token <token>' });
  }
  await post('/token', { token }, 'Applying license token failed');
}
