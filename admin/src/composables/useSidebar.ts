import { ref } from 'vue'

const collapsed = ref(localStorage.getItem('sidebar-collapsed') === 'true')

export function useSidebar() {
  function toggle() {
    collapsed.value = !collapsed.value
    localStorage.setItem('sidebar-collapsed', String(collapsed.value))
  }

  return { collapsed, toggle }
}
