// =============================================================================
// ui/views/Dashboard.jsx — لوحة التحكم والرصد اليومي الذكية (Glassmorphism & GSAP)
// =============================================================================
import { useState, useEffect, useMemo, useRef } from 'react'
import { gsap } from 'gsap'
import {
  TrendingUp,
  Package,
  Coins,
  ArrowDownLeft,
  ArrowUpRight,
  ShoppingBag,
  AlertTriangle,
  Truck,
  Clock,
  PlusCircle,
  ShoppingCart,
  Wallet,
  CreditCard,
  History,
  ArrowLeft,
  RefreshCw,
  ShieldCheck,
  Scale,
  HelpCircle,
  Sparkles,
} from 'lucide-react'
import Badge from '../components/Badge.jsx'
import Modal from '../components/Modal.jsx'
import { useUiStore } from '../state/uiStore.js'
import { useAuthStore } from '@/state/authStore'
import { canSeeDashboard } from '@/services/permissions'
import { calculateNetProfit, getOrderStatusLabel, getOrderRemainingAmount } from '@/domain/accounting/accounting'
import { getTotalCustomerReceivables, getTotalSupplierPayables } from '@/domain/accounting/payments'
import { computeTreasury } from '@/state/reportsStore'
import { getOpenOrdersCount } from '@/domain/orders/orderRepository'
import { getLowStockProducts } from '@/domain/inventory/products'
import { formatCurrency, formatCurrencyEn, formatPhonePair, formatDate, toNumber } from '@/utils/formatters'
import { showToast } from '../components/toastStore.js'

function readOrders() {
  return window.getOrders ? window.getOrders() : []
}

function computeOps() {
  const payments = window.getPayments ? window.getPayments() : []
  const orders = readOrders()
  return { totalCollected: computeTreasury(payments, orders).totalInflow }
}

function computeStats() {
  const orders = readOrders()
  const payments = window.getPayments ? window.getPayments() : []
  const products = window.getProducts ? window.getProducts() : []
  const suppliers = window.getCollection && window.STORAGE_KEYS ? window.getCollection(window.STORAGE_KEYS.SUPPLIERS) : []
  const calc = calculateNetProfit(orders, {
    getExpenses: () => (window.getExpenses ? window.getExpenses() : []),
    ...(window.getCurrentOperatingExpenses
      ? { getCurrentOperatingExpenses: () => window.getCurrentOperatingExpenses() }
      : {}),
    getSupplierReturns: () => (window.getSupplierReturns ? window.getSupplierReturns() : []),
  })

  const inventoryValuation = products.reduce((sum, p) => {
    const stock = Math.max(0, toNumber(p.stock))
    const buyPrice = toNumber(p.purchasePrice)
    return sum + stock * buyPrice
  }, 0)

  const pendingOrders = orders.filter(o => o.status === 'new')
  const pendingCollectedDeposits = pendingOrders.reduce((s, o) => s + toNumber(o.downPayment), 0)

  return {
    orders,
    grossSales: calc.grossSales,
    netProfit: calc.netProfit,
    shippingRevenueIncome: calc.shippingRevenueIncome || 0,
    inventoryValuation,
    customerReceivables: getTotalCustomerReceivables(orders, payments),
    supplierPayables: getTotalSupplierPayables(suppliers),
    openOrdersCount: getOpenOrdersCount(orders),
    lowStockCount: getLowStockProducts(products).length,
    pendingCount: pendingOrders.length,
    pendingCollectedDeposits,
    recentOrders: orders.slice(0, 5),
  }
}

// 💎 بطاقة مؤشر غلاسية فاخرة بألوان أوبتكال مميزة
function KpiCard({ label, value, icon: Icon, valueClass, hint, onClick, fullValue, colorTheme = 'brand' }) {
  const themeStyles = {
    brand: 'hover:border-sky-500/40 hover:shadow-sky-500/15 text-sky-400 bg-sky-500/10 border-sky-500/25',
    emerald: 'hover:border-emerald-500/40 hover:shadow-emerald-500/15 text-emerald-400 bg-emerald-500/10 border-emerald-500/25',
    amber: 'hover:border-amber-500/40 hover:shadow-amber-500/15 text-amber-400 bg-amber-500/10 border-amber-500/25',
    purple: 'hover:border-purple-500/40 hover:shadow-purple-500/15 text-purple-400 bg-purple-500/10 border-purple-500/25',
    rose: 'hover:border-rose-500/40 hover:shadow-rose-500/15 text-rose-400 bg-rose-500/10 border-rose-500/25',
    indigo: 'hover:border-indigo-500/40 hover:shadow-indigo-500/15 text-indigo-400 bg-indigo-500/10 border-indigo-500/25',
    orange: 'hover:border-orange-500/40 hover:shadow-orange-500/15 text-orange-400 bg-orange-500/10 border-orange-500/25',
  }
  const currentTheme = themeStyles[colorTheme] || themeStyles.brand

  return (
    <button
      onClick={onClick}
      title={fullValue || undefined}
      className={[
        'dashboard-kpi v7-kpi text-right',
        onClick ? 'cursor-pointer' : 'cursor-default',
      ].join(' ')}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-bold text-slate-300/80">{label}</span>
        <div className={`p-2.5 rounded-xl border transition-all ${currentTheme}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <div className={`text-2xl font-black num-font mb-1.5 tracking-tight ${valueClass || 'text-white'}`}>{value}</div>
      {hint ? <span className="text-[11px] text-slate-400 font-medium leading-relaxed block">{hint}</span> : null}
    </button>
  )
}

function SectionTitle({ title, subtitle, icon: Icon }) {
  return (
    <div className="flex items-center justify-between mb-4 v7-section-title">
      <div className="flex items-center gap-2.5">
        <span className="w-1.5 h-4.5 rounded-full bg-gradient-to-b from-brand-400 to-brand-600 shadow-sm shadow-brand-500/50" />
        <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
          {Icon ? <Icon className="w-4 h-4 text-brand-400" /> : null}
          <span>{title}</span>
        </h2>
        {subtitle ? <span className="text-[11px] text-slate-400 font-normal hidden sm:inline-block">({subtitle})</span> : null}
      </div>
    </div>
  )
}

function SalesTrendChart({ orders }) {
  const [drawn, setDrawn] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 40)
    return () => clearTimeout(t)
  }, [])

  const days = useMemo(() => {
    const map = new Map()
    const now = new Date()
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      map.set(key, { date: key, total: 0 })
    }
    ;(orders || []).forEach(o => {
      if (!o || o.status === 'cancelled' || o.status === 'returned') return
      const rawDate = o.createdAt || o.date || ''
      const key = String(rawDate).slice(0, 10)
      if (map.has(key)) {
        map.get(key).total += toNumber(o.totalAmount)
      }
    })
    return Array.from(map.values())
  }, [orders])

  const max = Math.max(1, ...days.map(d => d.total))
  const width = 800
  const height = 180
  const paddingX = 24
  const paddingY = 24
  const plotW = width - paddingX * 2
  const plotH = height - paddingY * 2

  const points = days.map((d, i) => {
    const x = paddingX + (i / (days.length - 1)) * plotW
    const y = height - paddingY - (d.total / max) * plotH
    return { x, y, ...d }
  })

  const pathD = points.length > 0 ? points.reduce((acc, p, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`, '') : ''
  const areaD = points.length > 0 ? `${pathD} L ${points[points.length - 1].x.toFixed(1)} ${height - paddingY} L ${points[0].x.toFixed(1)} ${height - paddingY} Z` : ''

  return (
    <div className="w-full relative overflow-hidden">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-44 overflow-visible">
        <defs>
          <linearGradient id="salesGradGlass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0284c7" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#0284c7" stopOpacity="0.0" />
          </linearGradient>
          <linearGradient id="lineGradGlass" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#818cf8" />
          </linearGradient>
        </defs>
        <line x1={paddingX} y1={height - paddingY} x2={width - paddingX} y2={height - paddingY} stroke="rgba(255,255,255,0.08)" strokeDasharray="4 4" />
        <line x1={paddingX} y1={paddingY} x2={width - paddingX} y2={paddingY} stroke="rgba(255,255,255,0.05)" strokeDasharray="4 4" />

        {areaD ? <path d={areaD} fill="url(#salesGradGlass)" className="transition-all duration-700" style={{ opacity: drawn ? 1 : 0 }} /> : null}
        {pathD ? <path d={pathD} fill="none" stroke="url(#lineGradGlass)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="transition-all duration-700" style={{ opacity: drawn ? 1 : 0 }} /> : null}

        {drawn && points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={p.total > 0 ? 4 : 2} fill="#38bdf8" stroke="#080b10" strokeWidth="2" className="transition-all hover:scale-150 cursor-pointer" />
        ))}
      </svg>
      <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono px-2 mt-1">
        <span>{days[0]?.date}</span>
        <span className="text-brand-400 font-bold">أعلى يوم: {formatCurrency(max)}</span>
        <span>{days[days.length - 1]?.date}</span>
      </div>
    </div>
  )
}

// 🛡️ شريط تدقيق ومطابقة الأرقام (Data Integrity & Reconciliation)
function DataReconciliationAudit({ onRefresh }) {
  const [reconciling, setReconciling] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)

  const audit = useMemo(() => {
    const orders = window.getOrders ? window.getOrders() : []
    const customers = window.getCustomers ? window.getCustomers() : (window.getCollection ? window.getCollection(window.STORAGE_KEYS?.CUSTOMERS || 'customers') : [])
    const activeOrders = orders.filter(o => o.status !== 'cancelled' && o.status !== 'returned')

    const totalOrdersAmount = activeOrders.reduce((sum, o) => sum + toNumber(o.totalAmount), 0)
    const totalCustomerPurchases = customers.reduce((sum, c) => sum + toNumber(c.totalPurchases), 0)
    const salesDiff = Math.abs(totalOrdersAmount - totalCustomerPurchases)

    const ordersDebt = activeOrders.reduce((sum, o) => sum + toNumber(o.remainingBalance), 0)
    const customerDebt = customers.reduce((sum, c) => sum + toNumber(c.remainingBalance), 0)
    const debtDiff = Math.abs(ordersDebt - customerDebt)

    const isFullyUnified = salesDiff < 10 && debtDiff < 10

    return {
      totalOrdersAmount,
      totalCustomerPurchases,
      salesDiff,
      ordersDebt,
      customerDebt,
      debtDiff,
      isFullyUnified,
      ordersCount: activeOrders.length,
      customersCount: customers.length,
    }
  }, [reconciling])

  const handleReconcile = async () => {
    setReconciling(true)
    try {
      if (typeof window.recalculateAllCustomerBalances === 'function') {
        window.recalculateAllCustomerBalances()
      }
      if (typeof window.normalizeAccountingData === 'function') {
        window.normalizeAccountingData()
      }
      showToast('⚡ تم توحيد ومطابقة كافة أرصدة الفواتير وسجلات العملاء بنجاح!', 'success')
      if (onRefresh) onRefresh()
    } catch (e) {
      showToast('حدث خطأ أثناء المطابقة: ' + (e?.message || e), 'error')
    } finally {
      setTimeout(() => setReconciling(false), 500)
    }
  }

  return (
    <>
      <div className="glass-panel p-5 border border-white/10 shadow-xl relative overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-start sm:items-center gap-3.5">
            <div className={`p-3 rounded-2xl border ${audit.isFullyUnified ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' : 'bg-amber-500/15 border-amber-500/30 text-amber-400'}`}>
              {audit.isFullyUnified ? <ShieldCheck className="w-6 h-6" /> : <Scale className="w-6 h-6" />}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-extrabold text-white">تدقيق ومطابقة أرصدة السيستم</h3>
                <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${audit.isFullyUnified ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-300'}`}>
                  {audit.isFullyUnified ? 'الأرصدة متطابقة وموحدة ✓' : 'يوجد تفاوت تراكمي بحاجة لمطابقة'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                فواتير البيع: <span className="font-bold text-white num-font">{formatCurrency(audit.totalOrdersAmount)}</span> مقابل مشتريات العملاء: <span className="font-bold text-white num-font">{formatCurrency(audit.totalCustomerPurchases)}</span> | ديون الفواتير: <span className="font-bold text-amber-300 num-font">{formatCurrency(audit.ordersDebt)}</span> مقابل ديون العملاء: <span className="font-bold text-amber-300 num-font">{formatCurrency(audit.customerDebt)}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              onClick={() => setGuideOpen(true)}
              className="px-3.5 py-2 rounded-xl text-xs font-bold text-slate-300 bg-white/5 hover:bg-white/10 border border-white/10 transition-all flex items-center gap-1.5"
            >
              <HelpCircle className="w-4 h-4 text-brand-400" />
              <span>دليل معاني الأرقام</span>
            </button>
            <button
              onClick={handleReconcile}
              disabled={reconciling}
              className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-brand-600 to-brand-500 hover:from-brand-500 hover:to-brand-400 shadow-md shadow-brand-500/20 transition-all flex items-center gap-2 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${reconciling ? 'animate-spin' : ''}`} />
              <span>{reconciling ? 'جارٍ المطابقة...' : 'مطابقة وتوحيد الأرصدة ⚡'}</span>
            </button>
          </div>
        </div>
      </div>

      <MetricsGuideModal open={guideOpen} onClose={() => setGuideOpen(false)} />
    </>
  )
}

// 📖 نافذة دليل الأرقام والإحصائيات وتوحيد البيانات
function MetricsGuideModal({ open, onClose }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="دليل فهم وتوحيد أرقام وإحصائيات النظام"
      icon={Scale}
      maxWidth="max-w-3xl"
    >
      <div className="space-y-6 text-sm text-slate-300 leading-relaxed py-2" dir="rtl">
        <div className="p-4 rounded-xl bg-brand-500/10 border border-brand-500/20 text-xs text-brand-200">
          💡 هذا الدليل يوضح لك لماذا قد ترى رقماً في شاشة يختلف عن شاشة أخرى وكيف يفسر المحاسب كل رقم رياضياً داخل النظام:
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 rounded-xl bg-white/[0.03] border border-white/10 space-y-2">
            <h4 className="font-extrabold text-white text-sm flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-sky-400" />
              إجمالي المبيعات مقابل مشتريات العملاء
            </h4>
            <p className="text-xs text-slate-400">
              <strong>إجمالي المبيعات (الطلبات):</strong> يجمع كل فواتير البيع المؤكدة في النظام (بما فيها فواتير الزوار أو الحسابات غير المسجلة).<br />
              <strong>مشتريات العملاء:</strong> هي مجموع ما اشتراه العملاء المسجلون رسمياً في شاشة العملاء. عند استخدام زر "مطابقة وتوحيد الأرصدة"، يقوم النظام بمطابقة كل فاتورة مع عميلها وتحديث رصيد العميل فوراً.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-white/[0.03] border border-white/10 space-y-2">
            <h4 className="font-extrabold text-white text-sm flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              المتبقي على الفواتير مقابل ديون العملاء
            </h4>
            <p className="text-xs text-slate-400">
              <strong>ديون الفواتير:</strong> تحسب المتبقي على كل فاتورة على حدة.<br />
              <strong>ديون العملاء:</strong> تأخذ في الحسبان أي سدادات مجمعة (Lump Sum) دفعها العميل لحسابه العام دون تخصيصها لفاتورة بعينها، أو أي رصيد دائن.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-white/[0.03] border border-white/10 space-y-2">
            <h4 className="font-extrabold text-white text-sm flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              صافي الربح مقابل رصيد الخزينة
            </h4>
            <p className="text-xs text-slate-400">
              <strong>صافي الربح:</strong> مقياس محاسبي يطرح تكلفة شراء البضاعة المباعة ومصروفات التشغيل من إجمالي المبيعات (حتى لو كانت الفواتير آجلة لم تُحصّل بعد).<br />
              <strong>رصيد الخزينة (الكاش):</strong> هو السيولة النقدية الفعلية الموجودة في الدرج والبنك (المقبوضات الفعلية ناقص مدفوعات الموردين والمصروفات).
            </p>
          </div>

          <div className="p-4 rounded-xl bg-white/[0.03] border border-white/10 space-y-2">
            <h4 className="font-extrabold text-white text-sm flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-purple-400" />
              مستحقات الموردين وتكلفة المخزون
            </h4>
            <p className="text-xs text-slate-400">
              <strong>ديون الموردين:</strong> متطابقة محاسبياً بنسبة 100% مع (إجمالي مشتريات البضاعة ناقص كل ما سددته للموردين).<br />
              <strong>تكلفة المخزن:</strong> كمية البضاعة الموجودة في المستودع الآن مضروبة في سعر الشراء من المورد.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function Dashboard({ onNavigate }) {
  const [stats, setStats] = useState(() => computeStats())
  const [ops, setOps] = useState(() => computeOps())
  const containerRef = useRef(null)

  const reload = () => {
    setStats(computeStats())
    setOps(computeOps())
  }

  useEffect(() => {
    const handleSync = () => reload()
    window.addEventListener('bms-data-synced', handleSync)
    return () => window.removeEventListener('bms-data-synced', handleSync)
  }, [])

  // 🎬 تحريك GSAP أنيق واستعراضي للمؤشرات والبطاقات
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && gsap) {
        const ctx = gsap.context(() => {
          gsap.from('.v7-dashboard-hero', {
            opacity: 0,
            y: -16,
            duration: 0.5,
            ease: 'power3.out',
          })
          gsap.from('.v7-kpi', {
            opacity: 0,
            y: 20,
            duration: 0.45,
            stagger: 0.05,
            ease: 'power2.out',
            delay: 0.1,
          })
          gsap.from('.v7-chart-card', {
            opacity: 0,
            y: 15,
            duration: 0.5,
            ease: 'power2.out',
            delay: 0.25,
          })
        }, containerRef)
        return () => ctx.revert()
      }
    } catch {}
  }, [])

  const role = useAuthStore(s => s.role)
  if (role && !canSeeDashboard(role)) {
    return (
      <div className="grid place-items-center min-h-[60vh] animate-fadeIn">
        <div className="text-center glass-panel p-8 max-w-md">
          <h2 className="text-lg font-bold text-white mb-2">لوحة التحكم غير متاحة لهذا الحساب</h2>
          <p className="text-sm text-slate-400">الأرقام المالية متاحة لمدير المتجر والمحاسب فقط.</p>
        </div>
      </div>
    )
  }

  const s = stats
  const fmt = n => formatCurrency(n)
  const openNewOrder = () => useUiStore.getState().openOrderModal()
  const openPayment = () => useUiStore.getState().openPaymentModal()

  return (
    <div ref={containerRef} className="dashboard-view space-y-8 animate-fadeIn v7-dashboard pb-12">
      {/* Welcome Hero Card */}
      <div className="dashboard-hero v7-dashboard-hero flex flex-col md:flex-row md:items-center justify-between gap-4 p-6 rounded-2xl relative overflow-hidden">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="p-1.5 rounded-lg bg-brand-500/20 text-brand-400 border border-brand-500/30">
              <Sparkles className="w-4 h-4" />
            </span>
            <h1 className="text-2xl font-black text-white tracking-tight">لوحة التحكم والرصد اليومي</h1>
          </div>
          <p className="text-xs text-slate-400">متابعة دقيقة للمبيعات الحية، حركة الخزينة، أرباح المنتجات، والتكاليف الآجلة</p>
        </div>
        <div className="flex items-center gap-2.5 text-xs font-semibold text-slate-300 bg-white/5 backdrop-blur-md px-4 py-2.5 rounded-xl border border-white/10 self-start md:self-auto shadow-sm">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span>المزامنة السحابية: متصلة ومباشرة</span>
        </div>
      </div>

      {/* 🛡️ شريط تدقيق ومطابقة الأرصدة الفورية */}
      <DataReconciliationAudit onRefresh={reload} />

      {/* الصف 1: مؤشرات الأداء الحيوية */}
      <div className="v7-dash-row">
        <SectionTitle title="أساسيات الأداء والمبيعات" subtitle="كافة الفواتير والطلبات والتحصيلات لحظياً" icon={TrendingUp} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 v7-kpi-grid">
          <KpiCard
            label="إجمالي المبيعات (التراكمي)"
            icon={TrendingUp}
            value={fmt(s.grossSales)}
            fullValue={formatCurrencyEn(s.grossSales)}
            hint="كافة فواتير البيع المؤكدة (شامل الشحن)"
            colorTheme="blue"
          />
          <KpiCard
            label="الطلبات قيد التنفيذ"
            icon={ShoppingBag}
            value={`${s.openOrdersCount} طلبات`}
            hint="تحت التجهيز والشحن"
            onClick={() => onNavigate && onNavigate('orders')}
            colorTheme="indigo"
          />
          <KpiCard
            label="ديون على العملاء (مستحقة)"
            icon={ArrowDownLeft}
            value={fmt(s.customerReceivables)}
            fullValue={formatCurrencyEn(s.customerReceivables)}
            hint="مبالغ آجلة قيد التحصيل"
            onClick={() => onNavigate && onNavigate('customers')}
            colorTheme="amber"
          />
          <KpiCard
            label="إجمالي قيمة المخزون"
            icon={Package}
            value={fmt(s.inventoryValuation)}
            fullValue={formatCurrencyEn(s.inventoryValuation)}
            hint="بسعر التكلفة من الموردين"
            onClick={() => onNavigate && onNavigate('products')}
            colorTheme="purple"
          />
        </div>
      </div>

      {/* الصف 2: الأرباح والمستحقات وحركة السيولة */}
      <div className="v7-dash-row">
        <SectionTitle title="الأرباح والسيولة النقدية" subtitle="متابعة الربحية الصافية وحركة الخزينة والديون" icon={Coins} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 v7-kpi-grid">
          <KpiCard
            label="صافي أرباح المنتجات"
            icon={Coins}
            value={fmt(s.netProfit)}
            fullValue={formatCurrencyEn(s.netProfit)}
            valueClass={s.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}
            hint="ربح البضاعة بعد خصم التكلفة والمصروفات"
            onClick={() => onNavigate && onNavigate('reports')}
            colorTheme="emerald"
          />
          <KpiCard
            label="ديون للموردين (واجبة السداد)"
            icon={ArrowUpRight}
            value={fmt(s.supplierPayables)}
            fullValue={formatCurrencyEn(s.supplierPayables)}
            hint="مستحقات المصانع والموردين"
            onClick={() => onNavigate && onNavigate('suppliers')}
            colorTheme="rose"
          />
          <KpiCard
            label="إجمالي المقبوضات النقدية"
            icon={Wallet}
            value={fmt(ops.totalCollected)}
            fullValue={formatCurrencyEn(ops.totalCollected)}
            hint="وارد الخزينة الفعلي من التحصيلات"
            onClick={() => onNavigate && onNavigate('payments')}
            colorTheme="indigo"
          />
          <KpiCard
            label="نواقص المخزون والتوريد"
            icon={AlertTriangle}
            value={`${s.lowStockCount} أصناف`}
            valueClass={s.lowStockCount > 0 ? 'text-rose-400' : 'text-slate-200'}
            hint="أصناف قاربت على النفاد"
            onClick={() => onNavigate && onNavigate('products')}
            colorTheme="orange"
          />
        </div>
      </div>

      {/* رسم تحليل المبيعات */}
      <div className="v7-dash-row">
        <SectionTitle title="تحليل اتجاه المبيعات اليومية" subtitle="مبيعات آخر 14 يوماً" icon={Clock} />
        <div className="glass-panel p-6 shadow-xl v7-chart-card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-slate-100">رسم بياني للمبيعات اليومية</h3>
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5 font-medium">
              <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" />
              فواتير مؤكدة
            </span>
          </div>
          <SalesTrendChart orders={s.orders} />
        </div>
      </div>

      {/* الشحن وفواتير قيد الانتظار */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-panel p-5 border border-sky-500/20 bg-sky-950/20 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-sky-500/15 text-sky-400 border border-sky-500/30">
              <Truck className="w-5 h-5" />
            </div>
            <div>
              <span className="text-sm font-bold text-sky-200 block">إيراد خدمات شحن ونقل</span>
              <span className="text-[11px] text-slate-400">عربون الشحن والتسليم المحصل — مفصول محاسبياً عن مبيعات المنتجات</span>
            </div>
          </div>
          <span className="text-xl font-black text-sky-300 num-font" title={formatCurrencyEn(s.shippingRevenueIncome)}>{fmt(s.shippingRevenueIncome)}</span>
        </div>

        <div className="glass-panel p-5 border border-amber-500/20 bg-amber-950/20 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-amber-500/15 text-amber-400 border border-amber-500/30">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <span className="text-sm font-bold text-amber-200 block">فواتير قيد الانتظار (جديدة)</span>
              <span className="text-[11px] text-slate-400">فواتير لم تُشحن بعد — عربونها يدخل الخزينة والمبيعات تُحسب بعد التأكيد</span>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="text-left">
              <span className="text-[10px] text-slate-400 block font-bold">العدد</span>
              <span className="text-lg font-black text-amber-300 num-font">{s.pendingCount}</span>
            </div>
            <div className="text-left">
              <span className="text-[10px] text-slate-400 block font-bold">العربون</span>
              <span className="text-lg font-black text-emerald-400 num-font" title={formatCurrencyEn(s.pendingCollectedDeposits)}>{fmt(s.pendingCollectedDeposits)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* إجراءات سريعة */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="glass-panel p-6 border border-brand-500/25 flex flex-col justify-between">
          <div className="flex items-center gap-3.5 mb-4">
            <div className="p-3 bg-brand-500/15 text-brand-400 rounded-2xl border border-brand-500/30">
              <PlusCircle className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-white">إنشاء طلب جديد / فاتورة بيع</h3>
              <p className="text-xs text-slate-400">إضافة طلب للعميل وتخصيم المخزون وتسجيل الآجل فورياً</p>
            </div>
          </div>
          <button onClick={openNewOrder} className="w-full py-3 px-4 bg-gradient-to-r from-brand-600 to-brand-500 hover:from-brand-500 hover:to-brand-400 text-white font-bold rounded-xl shadow-lg shadow-brand-500/20 transition-all flex items-center justify-center gap-2">
            <ShoppingCart className="w-5 h-5" />
            <span>فتح نافذة فاتورة البيع</span>
          </button>
        </div>

        <div className="glass-panel p-6 border border-emerald-500/25 flex flex-col justify-between">
          <div className="flex items-center gap-3.5 mb-4">
            <div className="p-3 bg-emerald-500/15 text-emerald-400 rounded-2xl border border-emerald-500/30">
              <Wallet className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-white">تسجيل إيصال دفعة مالية</h3>
              <p className="text-xs text-slate-400">تسجيل مقبوضات نقدية من عميل أو دفعات صادرة لمورد</p>
            </div>
          </div>
          <button onClick={openPayment} className="w-full py-3 px-4 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-bold rounded-xl shadow-lg shadow-emerald-500/20 transition-all flex items-center justify-center gap-2">
            <CreditCard className="w-5 h-5" />
            <span>تسجيل إيصال جديد</span>
          </button>
        </div>
      </div>

      {/* أحدث الطلبات */}
      <div className="glass-panel p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-extrabold text-white flex items-center gap-2">
            <History className="w-5 h-5 text-brand-400" />
            <span>أحدث الطلبات والفواتير المسجلة</span>
          </h3>
          <button onClick={() => onNavigate && onNavigate('orders')} className="text-xs text-brand-400 hover:text-brand-300 font-bold flex items-center gap-1 transition-all">
            <span>عرض كافة الفواتير</span>
            <ArrowLeft className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr>
                <th>رقم الطلب</th>
                <th>اسم العميل</th>
                <th>رقم الهاتف</th>
                <th>إجمالي الفاتورة</th>
                <th>المقدم</th>
                <th>المتبقي</th>
                <th>الحالة</th>
                <th>التاريخ</th>
              </tr>
            </thead>
            <tbody>
              {s.recentOrders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-6 text-slate-500">لا توجد طلبات مسجلة حتى الآن</td>
                </tr>
              ) : (
                s.recentOrders.map(o => {
                  const remaining = getOrderRemainingAmount(o)
                  return (
                    <tr key={o.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="font-bold text-brand-400 num-font">{o.id}</td>
                      <td className="font-bold text-white">{o.customerName}</td>
                      <td className="num-font text-slate-300">{formatPhonePair(o.customerPhone, o.customerSecondaryPhone)}</td>
                      <td className="num-font font-bold text-white">{formatCurrency(o.totalAmount)}</td>
                      <td className="num-font text-emerald-400">{formatCurrency(o.downPayment)}</td>
                      <td className={`num-font font-bold ${remaining > 0 ? 'text-rose-400' : 'text-slate-400'}`}>{formatCurrency(remaining)}</td>
                      <td><Badge variant={o.status === 'delivered' || o.status === 'completed' ? 'success' : o.status === 'returned' ? 'error' : o.status === 'cancelled' ? 'neutral' : 'warning'}>{getOrderStatusLabel(o.status)}</Badge></td>
                      <td className="text-xs text-slate-400 num-font">{formatDate(o.createdAt)}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
