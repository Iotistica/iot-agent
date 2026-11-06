import {
  createPublicKey,
  verify,
  type KeyObject
} from 'node:crypto';

import type {
  SignedLicense
} from './types';

export class LicenseManager {
  private readonly publicKey: KeyObject;

  constructor(
    publicKeyPem: string,
    private readonly agentUuid: string
  ) {
    this.publicKey = createPublicKey(publicKeyPem);
  }

  validate(
    license: SignedLicense
  ): { valid: boolean; reason?: string } {
    const { payload, signature } = license;

    // Must match backend's canonical signing format.
    const data = Buffer.from(
      JSON.stringify(payload),
      'utf8'
    );

    const validSignature = verify(
      null,
      data,
      this.publicKey,
      Buffer.from(signature, 'base64')
    );

    if (!validSignature) {
      return { valid: false, reason: 'Invalid signature' };
    }

    if (payload.version !== 1) {
      return { valid: false, reason: 'Unsupported version' };
    }

    if (payload.agentUuid !== this.agentUuid) {
      return { valid: false, reason: 'Agent mismatch' };
    }

    const expiresAt = Date.parse(payload.expiresAt);

    if (!Number.isFinite(expiresAt)) {
      return { valid: false, reason: 'Invalid expiration' };
    }

    if (Date.now() >= expiresAt) {
      return { valid: false, reason: 'License expired' };
    }

    return { valid: true };
  }
}