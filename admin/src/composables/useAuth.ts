import { ref } from 'vue'
import { authApi, type AuthUser, type UserRole } from '@/api/auth'

const currentUser = ref<AuthUser | null>(null)

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 }

export function useAuth() {
  async function checkAuth(): Promise<boolean> {
    try {
      currentUser.value = await authApi.me()
      return true
    } catch {
      currentUser.value = null
      return false
    }
  }

  async function logout(): Promise<void> {
    try { await authApi.logout() } catch { /* ignore */ }
    currentUser.value = null
  }

  // Not logged in ranks below 'viewer' — hasRole('viewer') correctly returns
  // false when currentUser is null, same as every other minimum.
  function hasRole(min: UserRole): boolean {
    const role = currentUser.value?.role
    if (!role) return false
    return ROLE_RANK[role] >= ROLE_RANK[min]
  }

  return { currentUser, checkAuth, logout, hasRole }
}
