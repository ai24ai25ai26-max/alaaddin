// =============================================================================
// سيناريوهات طبقة التقارير والبحث والفلاتر — مختبر سيناريوهات المحاسبة
// -----------------------------------------------------------------------------
// الوحدة الثالثة في جولة التسليم: ثبات دالّة فلترة الطلبات الذكية، ومحرّك البحث
// الموحّد، واتساق أرقام التقارير عبر محرّكين (الدومين والتحليلات) — مع توثيق
// موضع اختلاف «تعريف» صافي الربح بين المحرّكين ومشكلة فلتر التاريخ في التقارير.
// كل الحسابات من الدوال الحقيقية — بلا أي mock.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { filterOrdersSmart, computeTreasury } from '@/state/reportsStore'
import { calculateNetProfit } from '@/domain/accounting/accounting'
import { searchPayments } from '@/domain/accounting/payments'
import { searchOrders } from '@/domain/orders/orderRepository'
import { computeAnalyticsKPIs, collectFilterOptions } from '@/domain/analytics/analytics'

/* ===================== بيانات مرجعية نقية ===================== */

const NOW = new Date('2026-08-20T12:00:00')

function order(o = {}) {
  return {
    id: 'ORD', status: 'delivered', createdAt: '2026-08-15 10:00',
    totalAmount: 500, downPayment: 500, itemsSubtotal: 500,
    shippingCost: 0, shippingPayer: 'customer', extraExpenses: 0, extraExpensesPayer: 'customer',
    items: [{ sellingPrice: 250, purchasePrice: 100, quantity: 2 }],
    ...o,
  }
}

/* ===================== filterOrdersSmart ===================== */

describe('فلتر الطلبات الذكي — النافذة الافتراضية 30 يوماً', () => {
  const list = [
    { id: 'A', createdAt: '2026-08-19 10:00' },
    { id: 'B', createdAt: '2026-06-01 09:00' },
    { id: 'C', createdAt: '2026-07-25 08:00' },
    { id: 'D', createdAt: '2026-08-19T10:00' },
    { id: 'F', createdAt: '2026-07-21 00:00' },
    { id: 'G', createdAt: '2026-07-20 23:00' },
  ]

  it('يعرض ما وقع خلال آخر 30 يوماً فقط (الحد الأدنى شامل)', () => {
    const ids = filterOrdersSmart(list, null, null, NOW).map(o => o.id)
    expect(ids).toEqual(['A', 'C', 'D', 'F'])
    expect(ids).not.toContain('B')
    expect(ids).not.toContain('G')
  })

  it('عند تمرير فلتر تاريخ صريح يتجاهل النافذة ويطبّق المدى ضمناً', () => {
    expect(filterOrdersSmart(list, '2026-06-01', '2026-06-30', NOW).map(o => o.id)).toEqual(['B'])
    expect(filterOrdersSmart(list, '2026-08-01', null, NOW).map(o => o.id)).toEqual(['A', 'D'])
  })

  it('التاريخ غير الصالح يُمرَّر دائماً (لا يُستبعد بصمت)', () => {
    const withInvalid = [...list, { id: 'E', createdAt: 'ليس-تاريخاً' }]
    expect(filterOrdersSmart(withInvalid, '2026-06-01', '2026-06-30', NOW).map(o => o.id)).toContain('E')
  })
})

/* ===================== محرّك البحث ===================== */

describe('محرّك البحث — searchPayments', () => {
  const payments = [
    { id: 'PAY-2', entityName: 'أحمد محمد', notes: 'عربون أ', amount: 100, createdAt: '2026-08-02' },
    { id: 'PAY-1', entityName: 'شركة النور', notes: 'تسديد', amount: 200, createdAt: '2026-08-01' },
    { id: 'PAY-3', entityName: 'AHMED', notes: '', amount: 50, createdAt: '2026-08-03' },
  ]

  it('بلا استعلام يعيد الكل مرتّباً تنازلياً بالتاريخ', () => {
    expect(searchPayments(payments, '').map(p => p.id)).toEqual(['PAY-3', 'PAY-2', 'PAY-1'])
  })

  it('يطابق الاسم/المعرّف/الملاحظات بلا حساسية لحالة الأحرف ومقتطعاً', () => {
    expect(searchPayments(payments, 'أحمد').map(p => p.id)).toEqual(['PAY-2'])
    expect(searchPayments(payments, 'ahmed').map(p => p.id)).toEqual(['PAY-3'])
    expect(searchPayments(payments, 'PAY-1').map(p => p.id)).toEqual(['PAY-1'])
    expect(searchPayments(payments, 'تسديد').map(p => p.id)).toEqual(['PAY-1'])
    expect(searchPayments(payments, '  النور  ').map(p => p.id)).toEqual(['PAY-1'])
  })

  it('لا يبحث في المبلغ (البحث نصي على الاسم/المعرّف/الملاحظات فقط)', () => {
    expect(searchPayments(payments, '200')).toHaveLength(0)
  })
})

describe('محرّك البحث — searchOrders بالمعرّف والهاتف الثانوي', () => {
  const orders = [
    { id: 'ORD-9', customerName: 'سالم', customerPhone: '01000000001', customerSecondaryPhone: '01100000009' },
    { id: 'ORD-7', customerName: 'مريم', customerPhone: '01000000002', customerSecondaryPhone: '' },
  ]

  it('يطابق رقم الفاتورة أو الهاتف الثانوي', () => {
    expect(searchOrders(orders, 'ORD-9').map(o => o.id)).toEqual(['ORD-9'])
    expect(searchOrders(orders, '01100000009').map(o => o.id)).toEqual(['ORD-9'])
    expect(searchOrders(orders, '')).toHaveLength(2)
  })
})

/* ===================== تقاطع الدومين ↔ التحليلات ===================== */

describe('O-REP-1 — اختلاف 「تعريف」 إجمالي الربح بين محرّك المحاسبة ومحرّك التحليلات', () => {
  it('شحن يدفعه العميل: التحليلات تستبعده، والمحاسبة تُضمّنه في grossProfit', () => {
    const o = order({ shippingCost: 40, shippingPayer: 'customer', downPayment: 540, totalAmount: 540 })

    const acct = calculateNetProfit([o], { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    const kpi = computeAnalyticsKPIs([o], {})

    // محرّك المحاسبة: إجمالي الفاتورة شامل شحن العميل → grossProfit 340
    expect(acct).toMatchObject({ itemsSales: 500, grossSales: 540, grossProfit: 340, netProfit: 300 })
    // محرّك التحليلات: ربح بضاعة فقط (بلا شحن العميل) → grossProfit 300، والهامش على إجمالي البيع
    expect(kpi).toMatchObject({ totalSales: 540, grossProfit: 300 })
    expect(acct.grossProfit - kpi.grossProfit).toBe(40)
  })

  it('طلب مرتجع دفع التاجر شحنه: التحليلات تُهمله (المحقّقة فقط) والمحاسبة تحسبه خسارة', () => {
    const returned = order({ id: 'ORD-R', status: 'returned', shippingCost: 40, shippingPayer: 'merchant' })

    const acct = calculateNetProfit([returned], { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    const kpi = computeAnalyticsKPIs([returned], {})

    expect(acct).toMatchObject({ merchantExpenses: 40, netProfit: -40 })
    expect(kpi.grossProfit).toBe(0)
    // فرق التعريف = 40 على نفس الطلب المرتجع
    expect(acct.grossProfit - kpi.grossProfit).toBe(-40)
  })
})

describe('اتساق الذمم: تحليلات uncollected ↔ محاسبة receivables', () => {
  it('لكل الطلبات النشطة يتساوى المتأخر غير المحصّل مع المتبقي على العميل', () => {
    const ordersList = [
      order({ id: 'ORD-1', status: 'new', downPayment: 200, totalAmount: 500, paidInFull: false }),
      order({ id: 'ORD-2', status: 'delivered', downPayment: 0, totalAmount: 500, paidInFull: false }),
      order({ id: 'ORD-3', status: 'completed', downPayment: 500, totalAmount: 500, paidInFull: true }),
      order({ id: 'ORD-4', status: 'returned', downPayment: 0, totalAmount: 500 }),
    ]
    const kpi = computeAnalyticsKPIs(ordersList, {})
    expect(kpi.receivables).toBe(300 + 500)
    expect(kpi.uncollected).toBe(300 + 500)
  })
})

describe('collectFilterOptions — خيارات الفلاتر من الطلبات', () => {
  it('يستخرج العملاء والتصنيفات والكاشيرية بلا تكرار', () => {
    const opts = collectFilterOptions([
      order({ id: 'A', customerId: 'C1', customerName: 'أحمد', customerCategory: 'جملة', createdBy: 'كاشير' }),
      order({ id: 'B', customerId: 'C1', customerName: 'أحمد', customerCategory: 'قطاعي', createdBy: 'مدير' }),
      order({ id: 'C', customerId: 'C2', customerName: 'منى', customerCategory: 'جملة', createdBy: 'كاشير' }),
    ])
    expect(opts.customers).toEqual([{ id: 'C1', name: 'أحمد' }, { id: 'C2', name: 'منى' }])
    expect(opts.categories).toEqual(['جملة', 'قطاعي'])
    expect(opts.cashiers).toEqual(['كاشير', 'مدير'].sort())
  })
})

/* ===================== توثيق تقاطع فلتر التاريخ (ReportsView) ===================== */

describe('D-REP-1 — فلتر التاريخ يغيّر بطاقات الأرباح فقط لا الخزينة/الذمم', () => {
  it('نفس الطلبات: calc على المعروض، لكن computeTreasury/الذمم على الكل بلا فلترة', () => {
    const ordersList = [
      order({ id: 'ORD-A', createdAt: '2026-08-15 10:00' }),
      order({ id: 'ORD-B', createdAt: '2026-01-10 10:00' }),
    ]
    const paymentsList = [
      { id: 'P1', entityType: 'customer', amount: 500, isDownPayment: true, refOrderId: 'ORD-A' },
      { id: 'P2', entityType: 'customer', amount: 500, isDownPayment: true, refOrderId: 'ORD-B' },
    ]

    // ReportsView.jsx:329 — الإحصائيات على filtered
    const filtered = filterOrdersSmart(ordersList, '2026-08-01', '2026-08-31', NOW)
    const calcFiltered = calculateNetProfit(filtered, { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    expect(filtered.map(o => o.id)).toEqual(['ORD-A'])
    expect(calcFiltered.itemsSales).toBe(500)

    // ReportsView.jsx:337 — الخزينة على orders الكامل (غير مفلتر)
    const treasury = computeTreasury(paymentsList, ordersList)
    expect(treasury.totalInflow).toBe(1000)

    // الربح المفلتر (500) لا يقابل وارد خزينة مفلتر — الوارد يظهر كامل (1000)
    expect(treasury.totalInflow).not.toBe(calcFiltered.itemsSales)
  })
})
