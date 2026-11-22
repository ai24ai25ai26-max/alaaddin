// =============================================================================
// تماسك أرقام الداشبورد مقابل التقارير — اختبارات تكامل (V3.65)
// -----------------------------------------------------------------------------
// يثبّت العلاقة بين ثلاثة أرقام:
//   • «إجمالي المقبوضات» في الداشبورد      = computeTreasury().totalInflow   (Dashboard.jsx:48)
//   • «إجمالي المقبوضات (وارد الخزينة)» في بطاقة التقارير = totalInflow      (ReportsView.jsx:111)
//   • «إجمالي الوارد» في تبويب الخزينة      = totalInflow + treasuryInflow    (ReportsView.jsx:208)
// ويوضّح أن الفرق بين الأخير وأولهما = حركات الخزينة المباشرة (مردودات مورد
// نقدية + تسويات يدوية) — وأنها لا تدخل صافي الربح.
// ⚠️ لا يُعدَّل أي معادلة مالية هنا — التثبيت فقط.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import Dashboard from '@/ui/views/Dashboard'
import { useSettingsStore } from '@/state/settingsStore'
import { formatCurrencyEn, round2 } from '@/utils/formatters'
import { createOrder } from '@/domain/orders/orderRepository'
import { createSupplierReturn } from '@/domain/inventory/supplierReturns'
import { seedStore, item, customerInfo, STORAGE_KEYS, treasuryReport, profitReport } from './helpers'

// القيم المشتقة من مكوّنات الواجهة (نفس التعبيرات الحرفية في التقارير).
const reportsSalesTabReceipts = t => t.totalInflow          // ReportsView.jsx:111
const reportsTreasuryTabInflow = t => round2(t.totalInflow + t.treasuryInflow) // ReportsView.jsx:208

function mountDashboard(db) {
  window.getOrders = () => db.getCollection(STORAGE_KEYS.ORDERS)
  window.getPayments = () => db.getCollection(STORAGE_KEYS.PAYMENTS)
  window.getProducts = () => db.getCollection(STORAGE_KEYS.PRODUCTS)
  window.getExpenses = () => db.getCollection(STORAGE_KEYS.EXPENSES)
  window.getSupplierReturns = () => db.getCollection(STORAGE_KEYS.SUPPLIER_RETURNS)
  window.STORAGE_KEYS = { SUPPLIERS: STORAGE_KEYS.SUPPLIERS }
  window.getCollection = key => db.getCollection(key)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(<Dashboard />) })
  return { host, unmount: () => { act(() => root.unmount()); host.remove() } }
}

const receiptsCard = host =>
  Array.from(host.querySelectorAll('button')).find(b => b.textContent.includes('إجمالي المقبوضات'))

beforeEach(() => { useSettingsStore.setState({ compactNumbers: false }) })
afterEach(() => { useSettingsStore.setState({ compactNumbers: false }) })

describe('إجمالي المقبوضات: الداشبورد = بطاقة التقارير = totalInflow', () => {
  it('يعرض الداشبورد وارد الخزينة الفعلي ويطابق بطاقة التقارير', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    // بيع 2×250 = 500 مدفوع كاملاً → عربون وارد 500
    await createOrder({ customerInfo: customerInfo({ phone: '01011122233' }), items: [item({ quantity: 2, sellingPrice: 250, purchasePrice: 100 })], downPayment: 500, status: 'delivered' }, repo)

    const t = treasuryReport(db)
    expect(t.totalInflow).toBe(500)
    expect(reportsSalesTabReceipts(t)).toBe(500)

    const { host, unmount } = mountDashboard(db)
    const card = receiptsCard(host)
    expect(card).toBeTruthy()
    expect(card.textContent).toContain(formatCurrencyEn(500))
    unmount()
  })
})

describe('فروق متوقعة: تبويب الخزينة يضيف حركات الخزينة المباشرة', () => {
  it('مردود مورد نقدي: الداشبورد يستبعده وتبويب الخزينة يضمّه (الفرق = الفائض)', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    await createOrder({ customerInfo: customerInfo({ phone: '01011122233' }), items: [item({ quantity: 2, sellingPrice: 250, purchasePrice: 100 })], downPayment: 500, status: 'delivered' }, repo)
    // مورد بلا مديونية → كامل قيمة المرتجع (3×100=300) فائض كاش وارد خزينة
    await createSupplierReturn({ supplierId: 'SUP1', items: [{ productId: 'PRD1', quantity: 3, unitCost: 100 }], refundType: 'cash' }, repo)

    const t = treasuryReport(db)
    expect(t.totalInflow).toBe(500)                       // الداشبورد وبطاقة التقارير
    expect(t.treasuryInflow).toBe(300)                    // حركة خزينة مباشرة
    expect(reportsTreasuryTabInflow(t)).toBe(800)         // تبويب الخزينة
    expect(reportsTreasuryTabInflow(t) - reportsSalesTabReceipts(t)).toBe(300)

    const { host, unmount } = mountDashboard(db)
    const card = receiptsCard(host)
    expect(card.textContent).toContain(formatCurrencyEn(500))     // يستبعد المردود
    expect(card.textContent).not.toContain(formatCurrencyEn(800)) // لا يساوي تبويب الخزينة
    unmount()

    // صافي الربح لا يتأثر بالمردود النقدي (إرجاع بضاعة لا يولّد دخلاً)
    expect(profitReport(db).netProfit).toBe(300)
  })

  it('تسوية خزينة يدوية: تُحتسب في تبويب الخزينة فقط (الفرق = مبلغ التسوية)', () => {
    const { db, repo } = seedStore()
    repo.createPaymentRecord({ entityType: 'treasury', entityId: 'TREASURY', entityName: 'الخزينة', amount: 850, date: '2026-08-02', paymentMethod: 'cash', notes: 'إيداع رأس مال يدوي' })

    const t = treasuryReport(db)
    expect(t.totalInflow).toBe(0)                 // الداشبورد وبطاقة التقارير
    expect(t.treasuryInflow).toBe(850)
    expect(reportsTreasuryTabInflow(t)).toBe(850)
    expect(t.netTreasury).toBe(850)

    const { host, unmount } = mountDashboard(db)
    expect(receiptsCard(host).textContent).toContain(formatCurrencyEn(0))
    unmount()
  })
})
