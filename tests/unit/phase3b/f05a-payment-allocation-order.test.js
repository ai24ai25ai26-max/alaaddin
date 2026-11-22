// =============================================================================
// Phase 3B — F-05A — توزيع الدفعات (FIFO) مقابل عكسها (LIFO) على مستوى الطلبات
// -----------------------------------------------------------------------------
// الغرض: قياس الأثر الفعلي لاستخدام oldest-first في التخصيص وnewest-first في
// العكس — هل يغيّر الإجماليات/يُفقد مالاً، أم يعيد توزيع المبلغ بين الطلبات فقط؟
// verify-only: يشغّل مسارات createPaymentRecord / reversePaymentRecord الحقيقية.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createOrder } from '@/domain/orders/orderRepository'
import { createPaymentRecord, reversePaymentRecord } from '@/domain/accounting/payments'
import { adjustCustomerDebt, recalculateCustomerBalance } from '@/domain/customers/customers'
import { seedStore, item, customerInfo, STORAGE_KEYS } from './../scenarios/helpers'
import { seedCustomer } from '../../helpers/fakeRepo'

const orders = db => db.getCollection(STORAGE_KEYS.ORDERS)
const theCustomer = db => db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]
const getOrder = (db, id) => orders(db).find(o => o.id === id)

function allocTable(db) {
  return orders(db).map(o => ({ id: o.id, createdAt: o.createdAt, downPayment: o.downPayment, remainingBalance: o.remainingBalance }))
}
function sums(db) {
  const rows = allocTable(db)
  const c = theCustomer(db)
  return {
    downTotal: rows.reduce((a, r) => a + Number(r.downPayment || 0), 0),
    remainingTotal: rows.reduce((a, r) => a + Number(r.remainingBalance || 0), 0),
    customerPaid: c.paid,
    customerRemaining: c.remainingBalance,
    customerPurchases: c.totalPurchases,
  }
}

describe('F-05A — عدم تناظر ترتيب التخصيص/العكس (fakeRepo)', () => {
  it('1) دفعة سابقة خُصصت لطلب قديم + طلب أحدث بعربون مستقل: العكس يخصم من الأحدث خطأً (توزيع فقط)', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 50, purchasePrice: 100, sellingPrice: 250 } })

    // O1 مجانب (بلا عربون) — الأقدم
    const o1 = await createOrder({ customerInfo: customerInfo({ phone: '01012345801' }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, o1.id, { createdAt: '2026-01-01T10:00:00' })

    // دفعة مستقلة 500 تُخصَّص كاملةً لـ O1
    const cust = theCustomer(db)
    const p1 = createPaymentRecord({ entityType: 'customer', entityId: cust.id, entityName: cust.name, amount: 500, date: '2026-01-02', paymentMethod: 'cash' }, repo)
    const afterPay = allocTable(db)
    expect(getOrder(db, o1.id)).toMatchObject({ downPayment: 500, remainingBalance: 0 })

    // O2 لاحق بعربون مستقل 200 (مصدر مختلف عن الدفعة P1)
    const o2 = await createOrder({ customerInfo: customerInfo({ phone: '01012345801' }), items: [item({ quantity: 2 })], downPayment: 200, status: 'delivered' }, repo)
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, o2.id, { createdAt: '2026-02-01T10:00:00' })
    const beforeReverse = { allocation: allocTable(db), sums: sums(db) }

    // عكس P1 — التخصيص كان كلّه لـ O1، لكن العكس يُلغي من الأحدث (O2) أولاً
    reversePaymentRecord(p1.id, repo)
    const afterReverse = { allocation: allocTable(db), sums: sums(db) }

    console.log('\n[F-05A #1]\n' + JSON.stringify({ afterPay, beforeReverse, afterReverse }, null, 2))

    // ── الفعلي: العكس نزع 200 من O2 ثم 300 من O1 ──
    expect(getOrder(db, o2.id)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
    expect(getOrder(db, o1.id)).toMatchObject({ downPayment: 200, remainingBalance: 300 })

    // ── الإجمالي لم يُفقد: التوزيع تغيّر فقط ──
    // التخصيص الصحيح المتوقّع لو كان العكس FIFO (عكس أثر P1 على O1 وحده): O1=0/500، O2=200/300
    // الفعلي: O1=200/300، O2=0/500 — نفس مجموع down (200) ونفس مجموع المتبقي (800).
    expect(beforeReverse.sums.customerPurchases).toBe(1000)
    expect(afterReverse.sums.downTotal).toBe(200)
    expect(afterReverse.sums.remainingTotal).toBe(800)
    expect(afterReverse.sums.downTotal + afterReverse.sums.remainingTotal).toBe(afterReverse.sums.customerPurchases)
    // الفرق عن التوزيع «الصحيح» طلب-بطلب = 200 (تحويل توزيع لا خسارة)
    const expectedFifoDown = { [o1.id]: 0, [o2.id]: 200 }
    const actualDown = Object.fromEntries(allocTable(db).map(r => [r.id, r.downPayment]))
    expect(actualDown).not.toEqual(expectedFifoDown)
    expect(actualDown[o1.id] + actualDown[o2.id]).toBe(expectedFifoDown[o1.id] + expectedFifoDown[o2.id])
  })

  it('2) دفعة واحدة تمتد على طلبين بلا أرصدة سابقة: العكس يعيد التوزيع تماماً (متناظر)', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 50, purchasePrice: 100, sellingPrice: 250 } })
    const phone = '01012345802'
    const o1 = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, o1.id, { createdAt: '2026-01-01T10:00:00' })
    const o2 = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, o2.id, { createdAt: '2026-02-01T10:00:00' })

    const cust = theCustomer(db)
    const p = createPaymentRecord({ entityType: 'customer', entityId: cust.id, entityName: cust.name, amount: 700, date: '2026-03-01', paymentMethod: 'cash' }, repo)
    const before = { allocation: allocTable(db), sums: sums(db) }
    expect(getOrder(db, o1.id)).toMatchObject({ downPayment: 500, remainingBalance: 0 })
    expect(getOrder(db, o2.id)).toMatchObject({ downPayment: 200, remainingBalance: 300 })

    reversePaymentRecord(p.id, repo)
    const after = { allocation: allocTable(db), sums: sums(db) }
    console.log('\n[F-05A #2]\n' + JSON.stringify({ before, after }, null, 2))

    // كل الطلبات عادت لأرصدتها الأصلية — السلوك متناظر عند عدم وجود عربونات سابقة
    expect(getOrder(db, o1.id)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
    expect(getOrder(db, o2.id)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
    expect(after.sums.downTotal).toBe(0)
    expect(after.sums.remainingTotal).toBe(1000)
    expect(after.sums.customerPaid).toBe(0)
  })

  it('3) (F-05B — مُصلَح Phase 4) دفعة بلا طلبات مؤهلة لا تُوسم ولا تفنى عند إعادة الاحتساب', () => {
    const { db, repo } = seedStore()
    db.addFirestoreDoc(STORAGE_KEYS.CUSTOMERS, seedCustomer({ id: 'CUST9', phone: '01099999999' }))

    adjustCustomerDebt('CUST9', { remainingBalance: 300 }, repo)
    expect(Number(db.getCollection(STORAGE_KEYS.CUSTOMERS).find(c => c.id === 'CUST9').remainingBalance)).toBe(300)

    createPaymentRecord({ entityType: 'customer', entityId: 'CUST9', entityName: 'عميل اختبار', amount: 200, date: '2026-08-01', paymentMethod: 'cash' }, repo)
    const pay = db.getCollection(STORAGE_KEYS.PAYMENTS).find(p => p.entityId === 'CUST9')
    expect(pay.allocatedToOrders).toBe(false)  // ✅ لا تخصيص فعلي ⇒ لا وسم
    expect(pay.allocatedAmount).toBe(0)

    recalculateCustomerBalance('CUST9', repo)
    const rem = Number(db.getCollection(STORAGE_KEYS.CUSTOMERS).find(c => c.id === 'CUST9').remainingBalance)
    expect(rem).toBe(100)                       // ✅ الدفعة محفوظة: 300 − 200 = 100
  })
})
