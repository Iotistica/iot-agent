import { client } from './client'

export type UserRole = 'viewer' | 'operator' | 'admin'

export interface AuthUser {
  username: string
  role: UserRole
  is_superuser: boolean
  must_change_password: boolean
}

export const authApi = {
  login(username: string, password: string): Promise<AuthUser> {
    return client.post<AuthUser>('/v1/auth/login', { username, password }).then((r) => r.data)
  },

  logout(): Promise<void> {
    return client.post('/v1/auth/logout').then(() => undefined)
  },

  me(): Promise<AuthUser> {
    return client.get<AuthUser>('/v1/auth/me').then((r) => r.data)
  },
}
