// =============================================================================
// Phase 4.2 — A3: عكس/حذف دفعة مُخصَّصة جزئياً (allocatedAmount < amount)
// -----------------------------------------------------------------------------
// يثبت أن مسار العكس يستخدم «المبلغ المُخصَّص فعلاً» (allocatedAmount) وليس قيمة
// الدفعة كاملة: يُرجَع من الطلبات 500 فقط، وتبقى الـ200 غير المُخصَّصة محسوبةً
// كدفعة مباشرة على مستوى العميل. لو استُخدم amount كاملاً لتجاوز العكس قيمة
// تخصيص الطلب وظهر رصيد سالب في الطلب.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createPaymentRecord, reversePaymentRecord, deletePaymentRecord } from '@/domain/accounting/payments'
import { adjustCustomerDebt, recalculateCustomerBalance } from '@/domain/customers/customers'
import { freshSystem, seedCustomer, STORAGE_KEYS } from '../../helpers/fakeRepo'

const { CUSTOMERS, ORDERS, PAYMENTS } = STORAGE_KEYS

// عميل عليه طلب بقيمة 500، ثم تُرفع مديونيته إلى 700 بتسوية يدوية (200 دين غير
// مرتبط بطلب) — بهذا تُخصَّص دفعة 700 جزئياً: 500 للطلب + 200 للمديونية اليدوية.
function partialAllocationSystem() {
  const sys = freshSystem({
    [CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01011111111' })],
    [ORDERS]: [{ id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 500, downPayment: 0, remainingBalance: 500, paidInFull: false, createdAt: '2026-08-01T10:00:00' }],
  })
  adjustCustomerDebt('CUST1', { remainingBalance: 700 }, sys.repo)
  const created = createPaymentRecord({ entityType: 'customer', entityId: 'CUST1', entityName: 'عميل اختبار', amount: 700, date: '2026-08-05', paymentMethod: 'cash' }, sys.repo)
  const pay = sys.db.getCollection(PAYMENTS).find(p => p.id === created.id)
  return { ...sys, pay }
}

const cust = db => db.getCollection(CUSTOMERS)[0]
const ord = db => db.getCollection(ORDERS)[0]

describe('A3 — عكس الدفعة المُخصَّصة جزئياً', () => {
  it('الإعداد: الدفعة 700 تُخصَّص 500 للطلب والباقي 200 غير مُخصَّص', () => {
    const { db, pay } = partialAllocationSystem()
    expect(pay.allocatedAmount).toBe(500)
    expect(pay.allocatedToOrders).toBe(true)
    expect(ord(db)).toMatchObject({ downPayment: 500, remainingBalance: 0 })
    expect(cust(db)).toMatchObject({ paid: 500, remainingBalance: 0 })
  })

  it('deletePaymentRecord: يُرجع 500 فقط من الطلب ويعيد الرصيد ويتحمّل إعادة الاحتساب', async () => {
    const { db, repo, pay } = partialAllocationSystem()
    expect(ord(db)).toMatchObject({ downPayment: 500, remainingBalance: 0 })
    recalculateCustomerBalance('CUST1', repo)
    expect(cust(db)).toMatchObject({ paid: 500, remainingBalance: 0, creditBalance: 0 })

    await deletePaymentRecord(pay.id, repo)

    // أُزيل من الطلب 500 بالضبط (لا 700) ⇒ لا رصيد سالب في الطلب
    expect(ord(db)).toMatchObject({ downPayment: 0, remainingBalance: 500, paidInFull: false })
    expect(db.getCollection(PAYMENTS).find(p => p.id === pay.id)).toBeUndefined()

    recalculateCustomerBalance('CUST1', repo)
    // عاد إلى ما بعد التسوية اليدوية: 200 دين غير مرتبط بالطلب ⇒ مسدد -200/متبقي 700
    expect(cust(db)).toMatchObject({ paid: -200, remainingBalance: 700 })

    // إعادة احتساب متكررة لا تُحدث انزياحاً (لا ازدواج للـ200)
    recalculateCustomerBalance('CUST1', repo)
    expect(cust(db)).toMatchObject({ paid: -200, remainingBalance: 700 })
  })

  it('reversePaymentRecord: يستخدم allocatedAmount (500) لا قيمة الدفعة (700)', () => {
    const { db, repo, pay } = partialAllocationSystem()
    reversePaymentRecord(pay.id, repo)
    // لو استُخدم 700 لأصبح downPayment = -200 (خطأ)
    expect(ord(db)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
    expect(cust(db)).toMatchObject({ paid: -200, remainingBalance: 700 })
  })
})
