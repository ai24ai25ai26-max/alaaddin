// =============================================================================
// Phase 4.5 — F-10: أمان الفشل في مسار تعديل/حذف الدفعات (سلوك آمن بعد الإصلاح)
// -----------------------------------------------------------------------------
// يثبت الخصائص الآمنة الجديدة:
//   1) العكس idempotent: إعادة المحاولة/الطلب المزدوج لا تعكس الأثر مرتين.
//   2) علامة `reversed` الدائمة متوافقة رجعياً (سجلات قديمة بلا الحقل تبقى طبيعية).
//   3) محركات الاشتقاق (recalculateCustomerBalance/computeTreasury/الإجماليات)
//      تتجاهل القيود المعكوسة فيصبح القيد المتبقي بلا أثر مالي.
//   4) الذرّية: حذف/تعديل عبر WriteBatch واحد (reverse ➔ delete ➔ recreate).
//   5) الاسترداد: فشل الإبدال أثناء التعديل لا يُفقد القيد الأصلي.
//   6) فشل جزئي في مسار fallback (بلا ذرّية) يترك حالة مالية متسقة قابلة للاسترداد.
//
// المسبار يبقى على حدود التخزين (repo.*) دون أي تعديل إنتاجي إضافي.
// =============================================================================
import { describe, it, expect } from 'vitest'
import {
  createPaymentRecord, deletePaymentRecord, updatePaymentRecord, reversePaymentRecord,
  getTotalPaymentsCollected,
} from '@/domain/accounting/payments'
import { adjustCustomerDebt, recalculateCustomerBalance } from '@/domain/customers/customers'
import { computeTreasury } from '@/state/reportsStore'
import { freshSystem, seedCustomer, disableAtomicWrites, STORAGE_KEYS } from '../../helpers/fakeRepo'

const { CUSTOMERS, ORDERS, PAYMENTS } = STORAGE_KEYS

// عميل مديونيته 700: طلب بقيمة 500 (متبقٍّ 500) + تسوية يدوية +200 دين غير مرتبط.
// دفعة 700 تُخصَّص 500 للطلب و200 تبقى غير مُخصَّصة.
function partialSystem() {
  const sys = freshSystem({
    [CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01011111111' })],
    [ORDERS]: [{ id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 500, downPayment: 0, remainingBalance: 500, paidInFull: false, createdAt: '2026-08-01T10:00:00' }],
  }, { atomic: true })
  adjustCustomerDebt('CUST1', { remainingBalance: 700 }, sys.repo)
  const created = createPaymentRecord({ entityType: 'customer', entityId: 'CUST1', entityName: 'عميل اختبار', amount: 700, date: '2026-08-05', paymentMethod: 'cash' }, sys.repo)
  const pay = sys.db.getCollection(PAYMENTS).find(p => p.id === created.id)
  return { ...sys, pay }
}

// عميل بطلب 500 ودفعة 500 مُخصَّصة بالكامل (المديونية تصفَّر) — لاختبار التعديل.
function fullPaymentSystem() {
  const sys = freshSystem({
    [CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01011111111', totalPurchases: 500, paid: 0, remainingBalance: 500 })],
    [ORDERS]: [{ id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 500, downPayment: 0, remainingBalance: 500, paidInFull: false, createdAt: '2026-08-01T10:00:00' }],
  }, { atomic: true })
  const created = createPaymentRecord({ entityType: 'customer', entityId: 'CUST1', entityName: 'عميل اختبار', amount: 500, date: '2026-08-05', paymentMethod: 'cash' }, sys.repo)
  const pay = sys.db.getCollection(PAYMENTS).find(p => p.id === created.id)
  return { ...sys, pay }
}

const cust = db => db.getCollection(CUSTOMERS)[0]
const order = db => db.getCollection(ORDERS)[0]
const byId = (db, id) => db.getCollection(PAYMENTS).find(p => p.id === id)
const countById = (db, id) => db.getCollection(PAYMENTS).filter(p => p.id === id).length

describe('F-10 — العكس idempotent (إعادة المحاولة/الطلب المزدوج)', () => {
  it('عكس القيد مرتين يُطبّق الأثر مرة واحدة ويوسم القيد بـ reversed', () => {
    const { db, repo, pay } = partialSystem()
    expect(cust(db).paid).toBe(500)

    reversePaymentRecord(pay.id, repo)
    expect(cust(db).paid).toBe(-200) // 500 − 700
    expect(order(db)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
    expect(byId(db, pay.id).reversed).toBe(true)

    // إعادة المحاولة: لا عكس ثانٍ (لولا العلامة لصار paid = −900)
    reversePaymentRecord(pay.id, repo)
    expect(cust(db).paid).toBe(-200)
    expect(order(db)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
  })

  it('إعادات عكس متكررة (≥5) لا تُحدث أي انزياح إضافي', () => {
    const { db, repo, pay } = partialSystem()
    for (let i = 0; i < 5; i++) reversePaymentRecord(pay.id, repo)
    expect(cust(db).paid).toBe(-200)
    expect(order(db)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
  })
})

describe('F-10 — الاشتقاق يتجاهل القيود المعكوسة (تعادل مالي)', () => {
  it('قيد معكوس لكنه ما زال موجوداً لا يؤثر على recalculateCustomerBalance', () => {
    const { db, repo, pay } = partialSystem()
    reversePaymentRecord(pay.id, repo) // القيد ما زال موجوداً ووسمه reversed
    expect(byId(db, pay.id)).toBeTruthy()

    recalculateCustomerBalance('CUST1', repo)
    // كأن الدفعة حُذفت تماماً: 200 دين غير مرتبط بالطلب ⇒ −200/700
    expect({ paid: cust(db).paid, remaining: cust(db).remainingBalance }).toEqual({ paid: -200, remaining: 700 })
  })

  it('إعادة الاحتساب المتكررة بعد العكس لا تُحدث انزياحاً', () => {
    const { db, repo, pay } = partialSystem()
    reversePaymentRecord(pay.id, repo)
    for (let i = 0; i < 3; i++) {
      recalculateCustomerBalance('CUST1', repo)
      expect({ paid: cust(db).paid, remaining: cust(db).remainingBalance }).toEqual({ paid: -200, remaining: 700 })
    }
  })

  it('computeTreasury وgetTotalPaymentsCollected يستبعدان reversed', () => {
    const base = [{ id: 'P1', entityType: 'customer', amount: 200, type: '', isDownPayment: false, refOrderId: '' }]
    const withReversed = [...base, { id: 'P2', entityType: 'customer', amount: 200, type: '', isDownPayment: false, refOrderId: '', reversed: true }]
    expect(computeTreasury(withReversed, []).totalInflow).toBe(200)
    expect(getTotalPaymentsCollected(withReversed)).toBe(200)
    // السجل غير المعكوس وحده يعطي نفس النتيجة
    expect(computeTreasury(base, []).totalInflow).toBe(200)
  })
})

describe('F-10 — الحذف الذرّي (WriteBatch)', () => {
  it('حذف ناجح: يعكس الأثر مرة واحدة ويزيل المستند', async () => {
    const { db, repo, pay } = fullPaymentSystem()
    await deletePaymentRecord(pay.id, repo)
    expect(countById(db, pay.id)).toBe(0)
    expect(cust(db)).toMatchObject({ paid: 0, remainingBalance: 500 })
    expect(order(db)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
  })

  it('إعادة محاولة الحذف بعد نجاحه تُرفض بلا أثر مزدوج', async () => {
    const { db, repo, pay } = fullPaymentSystem()
    await deletePaymentRecord(pay.id, repo)
    await expect(deletePaymentRecord(pay.id, repo)).rejects.toThrow(/غير موجود/)
    expect(cust(db)).toMatchObject({ paid: 0, remainingBalance: 500 })
  })
})

describe('F-10 — طلبات حذف متزامنة (concurrent retries)', () => {
  it('حذفان متزامنان: واحد ينجح والآخر يُرفض، والعكس يُطبّق مرة واحدة', async () => {
    const { db, repo, pay } = partialSystem()
    const results = await Promise.allSettled([
      deletePaymentRecord(pay.id, repo),
      deletePaymentRecord(pay.id, repo),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled').length
    const rejected = results.filter(r => r.status === 'rejected').length
    expect(fulfilled).toBe(1)
    expect(rejected).toBe(1)
    expect(results.find(r => r.status === 'rejected').reason.message).toMatch(/غير موجود/)

    // أثر واحد فقط، والمستند مُزال
    expect(countById(db, pay.id)).toBe(0)
    recalculateCustomerBalance('CUST1', repo)
    expect({ paid: cust(db).paid, remaining: cust(db).remainingBalance }).toEqual({ paid: -200, remaining: 700 })
    expect(order(db)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
  })
})

describe('F-10 — التعديل الذرّي والاسترداد عند فشل الإبدال', () => {
  it('تعديل ناجح: قيد واحد بالمبلغ الجديد وأرصدة مضبوطة', async () => {
    const { db, repo, pay } = fullPaymentSystem()
    const created = await updatePaymentRecord(pay.id, { amount: 300 }, repo)
    expect(created.id).toBe(pay.id)
    expect(countById(db, pay.id)).toBe(1)
    expect(Number(byId(db, pay.id).amount)).toBe(300)
    expect(cust(db)).toMatchObject({ paid: 300, remainingBalance: 200 })
    expect(order(db)).toMatchObject({ downPayment: 300, remainingBalance: 200 })
  })

  it('فشل الإبدال بعد العكس/الحذف يسترد السجل الأصلي (لا تُفقد الدفعة)', async () => {
    const { db, repo, pay } = fullPaymentSystem()
    // مبلغ أكبر من المديونية المتبقية بعد العكس (500) ⇒ يفشل createPaymentRecord
    await expect(updatePaymentRecord(pay.id, { amount: 600 }, repo)).rejects.toThrow(/أكبر من إجمالي المديونية/)

    // الأصلي مُسترد كما كان بالضبط
    expect(countById(db, pay.id)).toBe(1)
    const restored = byId(db, pay.id)
    expect(Number(restored.amount)).toBe(500)
    expect(restored.reversed).not.toBe(true)
    expect(cust(db)).toMatchObject({ paid: 500, remainingBalance: 0 })
    expect(order(db)).toMatchObject({ downPayment: 500, remainingBalance: 0 })
    // لا قيد مكرر
    expect(db.getCollection(PAYMENTS)).toHaveLength(1)
  })

  it('فشل الإبدال بمبلغ غير صالح لا يغيّر أي رصيد', async () => {
    const { db, repo, pay } = fullPaymentSystem()
    await expect(updatePaymentRecord(pay.id, { amount: 0 }, repo)).rejects.toThrow(/مبلغ صحيح/)
    expect(countById(db, pay.id)).toBe(1)
    expect(Number(byId(db, pay.id).amount)).toBe(500)
    expect(cust(db)).toMatchObject({ paid: 500, remainingBalance: 0 })
  })
})

describe('F-10 — الفشل الجزئي في مسار fallback (بلا ذرّية)', () => {
  it('فشل الحذف بعد العكس يترك القيد موسوماً وبلا أثر مالي (متعادل)، وإعادة المحاولة تُتمّ الحذف', async () => {
    const { db, repo, pay } = partialSystem()
    disableAtomicWrites(repo)

    const original = repo.deleteFirestoreDoc
    repo.deleteFirestoreDoc = (key) => {
      if (key === PAYMENTS) throw new Error('فشل شبكة أثناء الحذف')
      return original(key)
    }

    await expect(deletePaymentRecord(pay.id, repo)).rejects.toThrow('فشل شبكة')

    // القيد ما زال موجوداً لكنه موسوم reversed ⇒ بلا أثر مالي
    const lingering = byId(db, pay.id)
    expect(lingering).toBeTruthy()
    expect(lingering.reversed).toBe(true)

    recalculateCustomerBalance('CUST1', repo)
    expect({ paid: cust(db).paid, remaining: cust(db).remainingBalance }).toEqual({ paid: -200, remaining: 700 })
    expect(order(db)).toMatchObject({ downPayment: 0, remainingBalance: 500 })

    // إعادة المحاولة (بعد زوال العطل): العكس idempotent فلا ازدواج، ويُزال القيد
    repo.deleteFirestoreDoc = original
    await deletePaymentRecord(pay.id, repo)
    expect(countById(db, pay.id)).toBe(0)
    recalculateCustomerBalance('CUST1', repo)
    expect({ paid: cust(db).paid, remaining: cust(db).remainingBalance }).toEqual({ paid: -200, remaining: 700 })
  })
})

describe('F-10 — توافق السجلات القديمة (بلا حقل reversed)', () => {
  it('قيد قديم بلا reversed يُحتسب طبيعياً ويُعكس طبيعياً', () => {
    const sys = freshSystem({
      [CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01011111111' })],
      [ORDERS]: [{ id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 500, downPayment: 0, remainingBalance: 500, paidInFull: false, createdAt: '2026-08-01T10:00:00' }],
      [PAYMENTS]: [{ id: 'PAY-LEG', entityType: 'customer', entityId: 'CUST1', entityName: 'عميل اختبار', amount: 200, date: '2026-08-01', paymentMethod: 'cash', allocatedToOrders: false }],
    })
    // يُحتسب كدفعة مباشرة (لا reversed، لا allocatedAmount ⇒ الباقي كامل)
    recalculateCustomerBalance('CUST1', sys.repo)
    expect(cust(sys.db)).toMatchObject({ paid: 200, remainingBalance: 300 })

    // العكس يعمل طبيعياً ويوسم القيد
    reversePaymentRecord('PAY-LEG', sys.repo)
    expect(byId(sys.db, 'PAY-LEG').reversed).toBe(true)
    recalculateCustomerBalance('CUST1', sys.repo)
    expect(cust(sys.db)).toMatchObject({ paid: 0, remainingBalance: 500 })
  })
})
