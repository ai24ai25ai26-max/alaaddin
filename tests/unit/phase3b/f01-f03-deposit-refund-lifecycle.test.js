// =============================================================================
// Phase 3B — F-01 / F-03 — اختبار معزول لدورة حياة العربون والاسترداد
// -----------------------------------------------------------------------------
// verify-only: لا يعدّل كود الإنتاج. يشغّل طبقة الدومين الحقيقية عبر fakeRepo
// (يفوّض لكل الوحدات النقية؛ لا mock للحسابات) ويسجّل القيم الفعلية في كل مرحلة.
// الاختبارات توصيفية (تُثبِت السلوك الفعلي الحالي). كل توقّع مُحسوب من المحرّكات
// الحقيقية، ومسارات «السياسة البديلة» موثّقة في console.log لا في تأكيدات فاشلة.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createOrder, updateOrderStatus } from '@/domain/orders/orderRepository'
import { getOrderOutstanding, getOrderRemainingAmount } from '@/domain/accounting/accounting'
import { seedStore, item, customerInfo, STORAGE_KEYS, treasuryReport } from './../scenarios/helpers'

const orders = db => db.getCollection(STORAGE_KEYS.ORDERS)
const payments = db => db.getCollection(STORAGE_KEYS.PAYMENTS)
const theCustomer = db => db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]

/** لقطة كاملة لكل الأرقام المطلوبة في تقرير المرحلة. */
function snap(db, id) {
  const o = orders(db).find(x => x.id === id)
  const c = theCustomer(db)
  return {
    status: o.status,
    total: o.totalAmount,
    downPayment: o.downPayment,
    refundedAmount: o.refundedAmount,
    retainedDeposit: o.retainedDeposit,
    remainingBalance: o.remainingBalance,
    paidInFull: o.paidInFull,
    outstanding: getOrderOutstanding(o),
    remainingAmount: getOrderRemainingAmount(o),
    customerPaid: c.paid,
    customerPurchases: c.totalPurchases,
    customerRemaining: c.remainingBalance,
    paymentLines: payments(db)
      .filter(p => p.entityType === 'customer')
      .map(p => ({ amount: p.amount, type: p.type, cycleKey: p.cycleKey, isDownPayment: !!p.isDownPayment, allocatedToOrders: !!p.allocatedToOrders })),
  }
}

function printTable(title, rows) {
  // يُطبع في مخرجات vitest ليكون دليلاً قابلاً للنسخ في التقرير.
  // eslint-disable-next-line no-console
  console.log('\n[' + title + ']\n' + JSON.stringify(rows, null, 2))
}

describe('F-01/F-03 — دورة حياة العربون والاسترداد (fakeRepo — طبقة دومين حقيقية)', () => {
  it('A) استرداد يدوي جزئي: new → cancelled(300) → new → delivered (إجمالي 1000، عربون 800)', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({
      customerInfo: customerInfo({ phone: '01012345701' }),
      items: [item({ quantity: 4 })], // 4 × 250 = 1000
      downPayment: 800,
      status: 'new',
    }, repo)

    const s0 = snap(db, order.id)
    await updateOrderStatus(order.id, 'cancelled', 300, 0, repo)
    const s1 = snap(db, order.id)
    await updateOrderStatus(order.id, 'new', 0, 0, repo)
    const s2 = snap(db, order.id)
    await updateOrderStatus(order.id, 'delivered', 0, 0, repo)
    const s3 = snap(db, order.id)

    printTable('F-01 A stages', { s0, s1, s2, s3, treasury: treasuryReport(db) })

    // ── القيم الفعلية (توصيف) ──
    expect(s0).toMatchObject({ total: 1000, downPayment: 800, remainingBalance: 200, outstanding: 200, customerPaid: 800 })
    expect(s0.refundedAmount).toBeUndefined()
    expect(s1).toMatchObject({ status: 'cancelled', total: 1000, downPayment: 800, refundedAmount: 300, retainedDeposit: 500, remainingBalance: 0, customerPaid: 0 })
    expect(s1.paymentLines.find(p => p.type === 'refund')).toMatchObject({ amount: -300 })
    expect(s2).toMatchObject({ status: 'new', downPayment: 800, remainingBalance: 0, customerPaid: 500 })
    expect(s2.paymentLines.find(p => p.cycleKey === 'recredit-500')).toMatchObject({ amount: 500, isDownPayment: true })
    expect(s3).toMatchObject({ status: 'delivered', downPayment: 800, remainingBalance: 200, customerPaid: 500, customerPurchases: 1000, customerRemaining: 200 })

    // ── المعادلة الحاكمة: النقد المحتفظ به فعلاً (800−300=500) + المتبقي المخزَّن (200) ──
    const netCashRetained = 800 - 300
    const statedTotal = Number(s3.customerPaid) + Number(s3.remainingBalance)
    expect(netCashRetained + Number(s3.remainingBalance)).toBe(700)   // 500 + 200
    expect(Number(s3.total) - (netCashRetained + Number(s3.remainingBalance))).toBe(300) // فجوة 300
    expect(statedTotal).toBe(Number(s3.customerPurchases) - 300)      // 700 = 1000 − 300
  })

  it('B) استرداد يدوي كامل: new → cancelled(800) → new → delivered', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({
      customerInfo: customerInfo({ phone: '01012345702' }),
      items: [item({ quantity: 4 })],
      downPayment: 800,
      status: 'new',
    }, repo)

    await updateOrderStatus(order.id, 'cancelled', 800, 0, repo)
    const s1 = snap(db, order.id)
    await updateOrderStatus(order.id, 'new', 0, 0, repo)
    const s2 = snap(db, order.id)
    await updateOrderStatus(order.id, 'delivered', 0, 0, repo)
    const s3 = snap(db, order.id)

    printTable('F-01 B stages', { s1, s2, s3 })

    expect(s1).toMatchObject({ refundedAmount: 800, retainedDeposit: 0, customerPaid: 0 })
    expect(s2).toMatchObject({ status: 'new', downPayment: 800, customerPaid: 0 })
    // إعادة الاعتماد = 800 − 800 = 0 ⇒ لا قيد recredit
    expect(s2.paymentLines.some(p => String(p.cycleKey).startsWith('recredit'))).toBe(false)
    expect(s3).toMatchObject({ status: 'delivered', downPayment: 800, remainingBalance: 200, customerPaid: 0 })
    // النقد الصافي المُبقى فعلاً = 800 − 800 = 0، لكن المتبقي المخزَّن = 200 ⇒ فجوة 800
    const netCashRetained = 800 - 800
    expect(Number(s3.total) - (netCashRetained + Number(s3.remainingBalance))).toBe(800)
  })

  it('C) مسار الإرجاع التلقائي (F-03): delivered → returned → new → delivered لا يسجّل refundedAmount', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({
      customerInfo: customerInfo({ phone: '01012345703' }),
      items: [item({ quantity: 2 })], // 2 × 250 = 500
      downPayment: 500,
      status: 'delivered',
    }, repo)
    const s0 = snap(db, order.id)

    await updateOrderStatus(order.id, 'returned', 0, 0, repo)  // refundAmount=0 ⇒ مسار autoRefund
    const s1 = snap(db, order.id)
    await updateOrderStatus(order.id, 'new', 0, 0, repo)
    const s2 = snap(db, order.id)
    await updateOrderStatus(order.id, 'delivered', 0, 0, repo)
    const s3 = snap(db, order.id)

    printTable('F-03 C stages', { s0, s1, s2, s3, treasury: treasuryReport(db) })

    expect(s0).toMatchObject({ status: 'delivered', total: 500, downPayment: 500, remainingBalance: 0, customerPaid: 500 })
    expect(s1).toMatchObject({ status: 'returned', customerPaid: 0 })
    expect(s1.refundedAmount).toBeUndefined()   // 👈 F-03: لا يُسجَّل
    expect(s1.retainedDeposit).toBeUndefined()
    expect(s1.paymentLines.find(p => p.type === 'refund')).toMatchObject({ amount: -500 })
    expect(s2.paymentLines.find(p => p.cycleKey === 'recredit-500')).toMatchObject({ amount: 500 })
    expect(s3).toMatchObject({ status: 'delivered', downPayment: 500, remainingBalance: 0, customerPaid: 500, customerRemaining: 0 })
  })

  it('D) F-03: إرجاع ثانٍ متطابق المبلغ يُدمج بمفتاح idempotency فلا يتكرر الاسترداد', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({
      customerInfo: customerInfo({ phone: '01012345704' }),
      items: [item({ quantity: 2 })],
      downPayment: 500,
      status: 'delivered',
    }, repo)

    await updateOrderStatus(order.id, 'returned', 0, 0, repo)  // refund #1 (autoRefund-500)
    await updateOrderStatus(order.id, 'new', 0, 0, repo)       // recredit 500
    await updateOrderStatus(order.id, 'delivered', 0, 0, repo)
    await updateOrderStatus(order.id, 'returned', 0, 0, repo)  // refund #2 — نفس cycleKey ⇒ مدموج
    const s = snap(db, order.id)

    printTable('F-03 D stages', s)

    // المرصود: مفتاح idempotency (refOrderId + cycleKey='autoRefund-500') يمنع إنشاء رد ثانٍ
    const refunds = s.paymentLines.filter(p => p.type === 'refund').map(p => p.amount)
    expect(refunds).toEqual([-500])                 // استرداد واحد فقط، لا اثنان
    expect(s.customerPaid).toBe(500)                // عربون 500 ثم recredit 500، بلا رد مضاعف
    // ملاحظة: الدمج مشروط بتساوي المبلغ (نفس cycleKey). اختلاف مبلغ الرد يعطي cycleKey
    // مختلفاً فيُنشأ قيد ثانٍ — لم يُختبر هنا (يحتاج سيناريو بعربون متغيّر).
    const signedSum = s.paymentLines.reduce((a, p) => a + Number(p.amount), 0)
    expect(signedSum).toBe(500)
  })

  it('E) لا استرداد لطلب (new) بلا عربون: الإلغاء لا يُنشئ أي قيد رد', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10 } })
    const order = await createOrder({
      customerInfo: customerInfo({ phone: '01012345705' }),
      items: [item({ quantity: 2 })],
      downPayment: 0,
      status: 'new',
    }, repo)
    await updateOrderStatus(order.id, 'cancelled', 0, 0, repo)
    const s = snap(db, order.id)
    expect(s.paymentLines.filter(p => p.type === 'refund')).toHaveLength(0)
    expect(s.refundedAmount).toBeUndefined()
  })
})
