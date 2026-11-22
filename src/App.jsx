// Phase 3 — هيكل التطبيق: بوابة الجلسة (LoginView) ثم AppShell.
// يُهيّئ المخازن (المظهر/الجلسة) عند الإقلاع؛ البيانات تمر عبر الجسر (compat).
import { useEffect } from 'react'
import AppShell from '@/ui/layout/AppShell'
import LoginView from '@/ui/views/LoginView'
import ToastContainer from '@/ui/components/ToastContainer'
import { useSettingsStore } from '@/state/settingsStore'
import { useAuthStore } from '@/state/authStore'
import { initDB } from '@/services/db.js'

import { isUsingFallbackConfig } from '@/services/db.js'

function ProductionConfigWarningBanner() {
  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] bg-amber-600 text-white px-4 py-2 text-xs font-semibold flex items-center justify-between shadow-lg dir-rtl">
      <span>⚠️ تنبيه الإنتاج (Production Guard): التطبيق يعمل بمشروع Firebase الافتراضي الاحتياطي. يُوصى بضبط إعدادات مشروعك السحابي من معالج الإعداد (Config Wizard).</span>
    </div>
  )
}

function App() {
  const user = useAuthStore(s => s.user)
  const isProdFallback = Boolean(import.meta.env && import.meta.env.PROD && isUsingFallbackConfig())

  useEffect(() => {
    initDB()
    if (typeof window !== 'undefined' && typeof window.postDueRecurringExpenses === 'function') {
      window.postDueRecurringExpenses()
    }
    useSettingsStore.getState().hydrate()
    useAuthStore.getState().restore()
  }, [])

  useEffect(() => {
    if (user) {
      useSettingsStore.getState().hydrate()
      // V3.63 — تفضيلات العرض الشخصية للمستخدم (ثيم/لون/اختصار) تعود فور دخوله
      // على هذا المتصفح — تُقرأ محلياً بلا سحابة.
      useSettingsStore.getState().hydrateCloudTheme()
    }
  }, [user])

  return (
    <div className="relative min-h-screen bg-[#08090C] text-slate-100 selection:bg-brand-500/30 selection:text-brand-200">
      {/* خلفيات إضاءة أوبتكال غلاسية في الخلفية */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-32 -right-32 w-[32rem] h-[32rem] bg-brand-500/10 rounded-full blur-[140px]" />
        <div className="absolute top-1/3 -left-32 w-[28rem] h-[28rem] bg-cyan-500/10 rounded-full blur-[160px]" />
        <div className="absolute -bottom-32 right-1/4 w-[36rem] h-[36rem] bg-indigo-500/10 rounded-full blur-[160px]" />
      </div>

      <div className="relative z-10">
        {isProdFallback && <ProductionConfigWarningBanner />}
        {user ? <AppShell /> : <LoginView />}
        <ToastContainer />
      </div>
    </div>
  )
}

export default App

