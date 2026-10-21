import { ref, computed, watchEffect } from 'vue'

type ThemeMode = 'light' | 'dark'

const mode = ref<ThemeMode>((localStorage.getItem('theme') as ThemeMode) || 'light')

export function useTheme() {
  function toggle() {
    mode.value = mode.value === 'light' ? 'dark' : 'light'
    localStorage.setItem('theme', mode.value)
  }

  function set(m: ThemeMode) {
    mode.value = m
    localStorage.setItem('theme', m)
  }

  const isDark = computed(() => mode.value === 'dark')

  watchEffect(() => {
    document.documentElement.setAttribute('data-theme', mode.value)
  })

  return { mode, isDark, toggle, set }
}
