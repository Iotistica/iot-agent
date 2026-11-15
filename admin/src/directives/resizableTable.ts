import type { Directive } from 'vue'

const MIN_COL_WIDTH = 50

function ensureHandles(container: HTMLElement) {
  const ths = container.querySelectorAll<HTMLElement>('.ant-table-thead th')
  for (const th of ths) {
    if (th.querySelector('.col-resize-handle')) continue
    // Skip fixed-right columns (actions) — they shouldn't be resized
    if (th.classList.contains('ant-table-cell-fix-right')) continue
    th.style.position = 'relative'
    const handle = document.createElement('span')
    handle.className = 'col-resize-handle'
    th.appendChild(handle)
  }
}

function onMouseDown(e: MouseEvent) {
  const handle = e.target as HTMLElement
  if (!handle.classList.contains('col-resize-handle')) return

  const th = handle.closest('th') as HTMLElement
  if (!th) return

  const startX = e.clientX
  const startWidth = th.offsetWidth

  e.preventDefault()
  e.stopPropagation()

  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'

  function onMove(ev: MouseEvent) {
    const newWidth = Math.max(MIN_COL_WIDTH, startWidth + ev.clientX - startX)
    th.style.width = `${newWidth}px`
    th.style.minWidth = `${newWidth}px`

    const table = th.closest('table')
    if (!table) return
    const idx = Array.from(th.parentElement!.children).indexOf(th)
    const colgroup = table.querySelector('colgroup')
    if (colgroup) {
      const col = colgroup.children[idx] as HTMLElement | undefined
      if (col) {
        col.style.width = `${newWidth}px`
        col.style.minWidth = `${newWidth}px`
      }
    }
  }

  function onUp() {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

export const vResizableTable: Directive<HTMLElement> = {
  mounted(el) {
    ensureHandles(el)
    el.addEventListener('mousedown', onMouseDown, true)

    const observer = new MutationObserver(() => ensureHandles(el))
    observer.observe(el, { childList: true, subtree: true })
    ;(el as any).__resizeObserver = observer
  },
  updated(el) {
    ensureHandles(el)
  },
  unmounted(el) {
    el.removeEventListener('mousedown', onMouseDown, true)
    const observer = (el as any).__resizeObserver as MutationObserver | undefined
    observer?.disconnect()
    delete (el as any).__resizeObserver
  },
}
