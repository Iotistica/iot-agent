import { client } from './client'

export type LicenseTier = 'trial' | 'paid'

export type LicenseState =
  | 'unlicensed'
  | 'trial'
  | 'trial_expired'
  | 'paid'
  | 'paid_expired'

export interface LicenseStatus {
  state: LicenseState
  tier?: LicenseTier
  licenseId?: string
  expiresAt?: number | null
  daysRemaining?: number
  invalidReason?: string
}

export const licenseApi = {
  getStatus(): Promise<LicenseStatus> {
    return client.get<LicenseStatus>('/v1/license').then(r => r.data)
  },

  activateTrial(): Promise<LicenseStatus> {
    return client.post<LicenseStatus>('/v1/license/trial').then(r => r.data)
  },

  activatePaid(licenseKey: string): Promise<LicenseStatus> {
    return client.post<LicenseStatus>('/v1/license/activate', { licenseKey }).then(r => r.data)
  },
}
