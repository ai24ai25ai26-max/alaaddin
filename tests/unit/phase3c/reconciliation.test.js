// =============================================================================
// Phase 3C — Evidence Reconciliation tests (verify-only)
// -----------------------------------------------------------------------------
// يوثّق هذا الملف سلوكاً فعلياً في طبقة الدومين (عبر fakeRepo) لدعم تصنيف
// المراجعة. لا يعدّل أي كود إنتاجي. الاختبارات توصيفية: تؤكّد القيم المرصودة
// فعلاً وتشرح دلالتها في تعليق — بلا كسر أو تخطٍّ لأي اختبار قائم.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createOrder, updateOrderStatus } from '@/domain/orders/orderRepository'
import { createPaymentRecord } from '@/domain/accounting/payments'
import { adjustCustomerDebt, recalculateCustomerBalance } from '@/domain/customers/customers'
import { seedStore, item, customerInfo, STORAGE_KEYS } from './../scenarios/helpers'
import { freshSystem, seedCustomer } from '../../helpers/fakeRepo'

const cust = db => db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]
const orders = db => db.getCollection(STORAGE_KEYS.ORDERS)

// ─────────────────────────────────────────────────────────────────────────────
// F-05B — وسم allocatedToOrders بلا تخصيص ⇒ الدفعة تختفي من إعادة الاحتساب
// المثال المطلوب نصّاً: دفعة 200 + مديونية يدوية 300 + لا طلب مؤهّل.
// ─────────────────────────────────────────────────────────────────────────────
describe('F-05B — دفعة بلا طلب مؤهّل (مثال 200/300)', () => {
  it('(F-05B مُصلَح Phase 4) الدفعة لا تُوسم ولا تفنى عند recalculateCustomerBalance', () => {
    const { db, repo } = freshSystem()
    db.addFirestoreDoc(STORAGE_KEYS.CUSTOMERS, seedCustomer({ id: 'CUST1', phone: '01099999999' }))

    // مديونية يدوية 300 بلا أي طلب (قيد customerDebtAdjustment = −300 ⇒ يرفع المديونية)
    adjustCustomerDebt('CUST1', { remainingBalance: 300 }, repo)
    expect(Number(cust(db).remainingBalance)).toBe(300)
    expect(Number(cust(db).paid)).toBe(-300)   // قيد التسوية يخفض «المسدد»

    // دفعة 200 مقبوضة فعلاً، لا طلبات لتخصيصها
    createPaymentRecord({ entityType: 'customer', entityId: 'CUST1', entityName: 'عميل اختبار', amount: 200, date: '2026-08-01', paymentMethod: 'cash' }, repo)
    const pay = db.getCollection(STORAGE_KEYS.PAYMENTS).find(p => p.entityId === 'CUST1')
    // لا تخصيص فعلي ⇒ لا وسم
    expect(pay.allocatedToOrders).toBe(false)
    expect(pay.allocatedAmount).toBe(0)
    // رصيد لحظي بعد الدفعة: 300 − 200 = 100
    expect(Number(cust(db).remainingBalance)).toBe(100)

    // إعادة الاحتساب: يُحتسب الباقي غير المُخصَّص كدفعة مباشرة ⇒ يبقى المتبقي 100
    recalculateCustomerBalance('CUST1', repo)
    expect(Number(cust(db).remainingBalance)).toBe(100)
    expect(Number(cust(db).paid)).toBe(-100)
  })

  it('مقابل ناجح: دفعة 200 تُخصَّص لطلب متبقٍّ 500 فيُحتسب أثرها عبر order.downPayment', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345909' }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    expect(Number(orders(db)[0].remainingBalance)).toBe(500)

    const c = cust(db)
    createPaymentRecord({ entityType: 'customer', entityId: c.id, entityName: c.name, amount: 200, date: '2026-08-01', paymentMethod: 'cash' }, repo)
    const pay = db.getCollection(STORAGE_KEYS.PAYMENTS).find(p => p.entityId === c.id && !p.refOrderId)
    expect(pay.allocatedToOrders).toBe(true)
    // التخصيص ظهر على الطلب
    expect(orders(db)[0]).toMatchObject({ downPayment: 200, remainingBalance: 300 })

    // إعادة الاحتساب: تُقرأ من order.downPayment (200) فيبقى الأثر محفوظاً
    recalculateCustomerBalance(c.id, repo)
    expect(Number(cust(db).paid)).toBe(200)
    expect(Number(cust(db).remainingBalance)).toBe(300)
    expect(order.id).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// F-01 — تباعد بين «المسدد» الحدثي و«المسدد» المُعاد بناؤه بعد استرداد
// ─────────────────────────────────────────────────────────────────────────────
describe('F-01 — recalculateCustomerBalance بعد استرداد جزئي', () => {
  it('الدفتر الحدثي يُظهر paid=500 بينما إعادة البناء تشتق paid=800 (فرق = refundedAmount)', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345910' }), items: [item({ quantity: 4 })], downPayment: 800, status: 'new' }, repo)
    await updateOrderStatus(order.id, 'cancelled', 300, 0, repo)   // استرداد 300، محتفظ 500
    await updateOrderStatus(order.id, 'new', 0, 0, repo)           // إعادة اعتماد 500
    await updateOrderStatus(order.id, 'delivered', 0, 0, repo)

    // الحدثي (event-driven): 800 − 500(احتفاظ) − 300(رد) + 500(إعادة اعتماد) = 500
    expect(Number(cust(db).paid)).toBe(500)
    expect(orders(db)[0]).toMatchObject({ totalAmount: 1000, downPayment: 800, remainingBalance: 200 })

    // إعادة البناء: totalPaid = order.downPayment(800) + مباشر(0) + تسويات(0) = 800
    recalculateCustomerBalance(cust(db).id, repo)
    expect(Number(cust(db).paid)).toBe(800)      // 👈 تباعد 300 = refundedAmount
    expect(Number(cust(db).remainingBalance)).toBe(200)
  })
})
