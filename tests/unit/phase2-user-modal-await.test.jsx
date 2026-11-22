// =============================================================================
// Phase 4 — F-08: تعديل المستخدم يجب أن ينتظر updateUserAccount ويعالج الفشل
// -----------------------------------------------------------------------------
// كان فرع التعديل في UserModal.jsx يستدعي window.updateUserAccount بلا await ثم
// يعرض النجاح ويغلق النافذة فوراً. بعد الإصلاح: ننتظر الوعد، ولا نغلق/نعرض نجاحاً
// إلا بعد النجاح المؤكّد، ونُبقي النافذة مفتوحة عند الفشل مع رسالة خطأ وإمكانية
// إعادة المحاولة. هذه الاختبارات توصيفية للسلوك المصحَّح (كانت it/it.fails قبل
// الإصلاح). لا تعدّل كود إنتاج.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import UserModal from '@/ui/modals/UserModal'
import { useUiStore } from '@/ui/state/uiStore'
import { useToastStore } from '@/ui/components/toastStore'

const USERS = [
  { id: 'USR-2002', name: 'سارة محمد حسن', email: 'sara@store.com', role: 'employee', createdAt: '2026-07-10T10:00:00Z' },
]
const ADMIN = { id: 'USR-1001', email: 'admin@store.com', role: 'admin' }

const RESET_UI = {
  userModal: { open: false, userId: null, onDone: null },
}

function mount(node) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(node)
  })
  return {
    host,
    unmount() {
      act(() => {
        root.unmount()
      })
      host.remove()
    },
  }
}

function click(el) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** يفرّغ سلسلة الميكروتاسكس داخل act حتى تستقر حالة المكوّن. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setInput(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttons() {
  return Array.from(document.body.querySelectorAll('button'))
}
function submitEdit() {
  return buttons().find(b => b.textContent.includes('حفظ التعديلات وكلمة المرور'))
}
function submitCreate() {
  return buttons().find(b => b.textContent.includes('إنشاء الحساب وتفعيل الصلاحية'))
}
function openEdit() {
  useUiStore.setState({ userModal: { open: true, userId: 'USR-2002', onDone: null } })
}
function lastToast() {
  const toasts = useToastStore.getState().toasts
  return toasts[toasts.length - 1]
}

/** وعد مؤجَّل يمكن التحكم في حسمه يدوياً. */
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useUiStore.setState(RESET_UI)
  useToastStore.setState({ toasts: [] })
  window.getUsers = vi.fn(() => USERS)
  window.isAdmin = vi.fn(() => true)
  window.getCurrentUser = vi.fn(() => ADMIN)
})

afterEach(() => {
  useUiStore.setState(RESET_UI)
  useToastStore.setState({ toasts: [] })
})

describe('F-08 — UserModal (مُصلَح في Phase 4)', () => {
  it('النجاح المؤكّد: لا تُغلق النافذة ولا يظهر نجاح حتى يُحسَم الوعد، ثم تُغلق', async () => {
    const d = deferred()
    window.updateUserAccount = vi.fn(() => d.promise)
    openEdit()
    const { unmount } = mount(<UserModal />)

    const btn = submitEdit()
    click(btn)
    await flush()

    // الوعد ما زال معلّقاً: نافذة مفتوحة، لا رسالة نجاح، والزر في حالة تحميل
    expect(window.updateUserAccount).toHaveBeenCalledWith(
      'USR-2002',
      expect.objectContaining({ name: 'سارة محمد حسن' })
    )
    expect(useUiStore.getState().userModal.open).toBe(true)
    expect(useToastStore.getState().toasts).toHaveLength(0)
    expect(btn.disabled).toBe(true)

    // نحسم الوعد بالنجاح → تُغلق النافذة ويظهر النجاح
    await act(async () => {
      d.resolve({ authSync: 'unchanged' })
      await Promise.resolve()
    })
    expect(useUiStore.getState().userModal.open).toBe(false)
    expect(lastToast().message).toContain('تم تعديل بيانات ورمز حساب')
    unmount()
  })

  it('الفشل: تبقى النافذة مفتوحة وتظهر رسالة خطأ ولا نجاح زائف', async () => {
    const d = deferred()
    window.updateUserAccount = vi.fn(() => d.promise)
    openEdit()
    const { unmount } = mount(<UserModal />)

    click(submitEdit())
    await act(async () => {
      d.reject(new Error('هذا البريد الإلكتروني مسجل بالفعل لمستخدم آخر'))
      await Promise.resolve()
    })

    expect(useUiStore.getState().userModal.open).toBe(true)
    expect(lastToast().message).toContain('مسجل بالفعل')
    expect(lastToast().type).toBe('error')
    // الحالة عادت غير محمّلة → يمكن إعادة المحاولة
    expect(submitEdit().disabled).toBe(false)
    unmount()
  })

  it('لا يفلت رفض غير معالَج (unhandled rejection) خارج المعالج', async () => {
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    window.updateUserAccount = vi.fn(() => Promise.reject(new Error('boom')))
    openEdit()
    const { unmount } = mount(<UserModal />)

    click(submitEdit())
    await flush()
    // نمنح حلقة إضافية كي يُطلَق أي unhandledrejection لو وُجد
    await flush()

    expect(unhandled).not.toHaveBeenCalled()
    expect(useUiStore.getState().userModal.open).toBe(true)
    window.removeEventListener('unhandledrejection', unhandled)
    unmount()
  })

  it('إعادة المحاولة بعد فشل: المحاولة الثانية الناجحة تُغلق النافذة', async () => {
    let call = 0
    const d1 = deferred()
    const d2 = deferred()
    window.updateUserAccount = vi.fn(() => (++call === 1 ? d1.promise : d2.promise))
    openEdit()
    const { unmount } = mount(<UserModal />)

    click(submitEdit())
    await act(async () => {
      d1.reject(new Error('تعذّر الحفظ'))
      await Promise.resolve()
    })
    expect(useUiStore.getState().userModal.open).toBe(true)

    click(submitEdit())
    await act(async () => {
      d2.resolve({ authSync: 'unchanged' })
      await Promise.resolve()
    })
    expect(useUiStore.getState().userModal.open).toBe(false)
    expect(window.updateUserAccount).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('إنشاء مستخدم: مسار الإنشاء ما زال ينتظر createNewUserAccount ثم يُغلق', async () => {
    const d = deferred()
    window.createNewUserAccount = vi.fn(() => d.promise)
    useUiStore.setState({ userModal: { open: true, userId: null, onDone: null } })
    const { unmount } = mount(<UserModal />)

    const inputs = document.body.querySelectorAll('input')
    setInput(inputs[0], 'موظف جديد')
    setInput(inputs[1], 'new@store.com')
    setInput(inputs[2], 'secret123')

    click(submitCreate())
    await flush()
    // ما زال معلّقاً → مفتوحة
    expect(window.createNewUserAccount).toHaveBeenCalled()
    expect(useUiStore.getState().userModal.open).toBe(true)

    await act(async () => {
      d.resolve({ id: 'USR-3000' })
      await Promise.resolve()
    })
    expect(useUiStore.getState().userModal.open).toBe(false)
    unmount()
  })
})
