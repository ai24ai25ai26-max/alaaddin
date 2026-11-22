// =============================================================================
// Phase 4 — F-05B: الدفعات غير المُخصَّصة (أو بقيّتها الجزئية) لا تفنى عند
// إعادة احتساب رصيد العميل.
// -----------------------------------------------------------------------------
// العيب السابق: createPaymentRecord كان يوسم الدفعة المستقلة allocatedToOrders=true
// دائماً حتى بلا أي تخصيص، وrecalculateCustomerBalance يستبعد الوسوم، فتفنى قيمة
// الدفعة (أو بقيّتها غير المُخصَّصة). الإصلاح: سجل allocatedAmount (المبلغ المُخصَّص
// فعلاً) + احتساب الباقي فقط كدفعة مباشرة، مع دعم السجلات التاريخية (تُسقط إلى
// العلامة المنطقية). كل الحساب عبر طبقة الدومين الحقيقية (fakeRepo).
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createOrder } from '@/domain/orders/orderRepository'
import { createPaymentRecord } from '@/domain/accounting/payments'
import { adjustCustomerDebt, recalculateCustomerBalance } from '@/domain/customers/customers'
import { seedStore, item, customerInfo, STORAGE_KEYS } from './../scenarios/helpers'
import { freshSystem, seedCustomer } from '../../helpers/fakeRepo'

const cust = db => db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]
const ordersOf = db => db.getCollection(STORAGE_KEYS.ORDERS)
const paysOf = db => db.getCollection(STORAGE_KEYS.PAYMENTS)
const orderById = (db, id) => ordersOf(db).find(o => o.id === id)
const standalone = db => paysOf(db).find(p => !p.isDownPayment && p.type !== 'customerDebtAdjustment')

// ─────────────────────────────────────────────────────────────────────────────
// Case A — لا طلب مؤهّل: دفعة 200 على دَين يدوي 300 ⇒ المتبقي 100 قبل وبعد recalc
// ─────────────────────────────────────────────────────────────────────────────
describe('F-05B / Case A — دفعة بلا طلب مؤهّل', () => {
  it('مصدر الحقيقة: دفعة 200 على تسوية مديونية 300 تبقى 100 بعد إعادة الاحتساب', () => {
    const { db, repo } = freshSystem()
    db.addFirestoreDoc(STORAGE_KEYS.CUSTOMERS, seedCustomer({ id: 'CUST1', phone: '01099999999' }))
    adjustCustomerDebt('CUST1', { remainingBalance: 300 }, repo)   // قيد تسوية = −300
    expect(Number(cust(db).remainingBalance)).toBe(300)

    createPaymentRecord({ entityType: 'customer', entityId: 'CUST1', entityName: 'عميل اختبار', amount: 200, date: '2026-08-01', paymentMethod: 'cash' }, repo)

    const pay = standalone(db)
    // لا تخصيص فعلي ⇒ لا وسم
    expect(pay.allocatedToOrders).toBe(false)
    expect(pay.allocatedAmount).toBe(0)
    // الرصيد اللحظي: 300 − 200 = 100
    expect(Number(cust(db).remainingBalance)).toBe(100)

    recalculateCustomerBalance('CUST1', repo)
    // يُحتسب الباقي (200) كدفعة مباشرة ⇒ المتبقي 100 (لم تَفنَ الدفعة)
    expect(Number(cust(db).remainingBalance)).toBe(100)
    expect(Number(cust(db).paid)).toBe(-100)   // −300 تسوية + 200 دفعة
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Case B — دفعة مُخصَّصة كاملة: لا تُحتسب مرتين
// ─────────────────────────────────────────────────────────────────────────────
describe('F-05B / Case B — دفعة مُخصَّصة كاملة', () => {
  it('دفعة 200 تُسدّد طلباً متبقٍّ 500 ⇒ متبقٍّ 300 بعد recalc بلا خصم مزدوج', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345901' }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    expect(Number(order.remainingBalance)).toBe(500)

    createPaymentRecord({ entityType: 'customer', entityId: order.customerId, entityName: 'عميل اختبار', amount: 200, date: '2026-08-02', paymentMethod: 'cash' }, repo)

    const pay = standalone(db)
    expect(pay.allocatedToOrders).toBe(true)
    expect(pay.allocatedAmount).toBe(200)   // خُصّصت كاملةً

    expect(orderById(db, order.id)).toMatchObject({ downPayment: 200, remainingBalance: 300 })
    expect(Number(cust(db).remainingBalance)).toBe(300)

    recalculateCustomerBalance(order.customerId, repo)
    // ممثّلة عبر order.downPayment فقط ⇒ لا خصم مزدوج
    expect(Number(cust(db).paid)).toBe(200)
    expect(Number(cust(db).remainingBalance)).toBe(300)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Case C — تخصيص جزئي: المُخصَّص والباقي كلٌّ ممثَّل مرة واحدة بالضبط
// ─────────────────────────────────────────────────────────────────────────────
describe('F-05B / Case C — تخصيص جزئي', () => {
  it('دفعة 700: 500 للطلب + 200 غير مُخصَّصة ⇒ recalc يثبّت المتبقي 100', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345902' }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    // رفع المديونية لـ800 (500 طلب + 300 تسوية يدوية) ليُسمح بدفعة 700
    adjustCustomerDebt(order.customerId, { remainingBalance: 800 }, repo)
    expect(Number(cust(db).remainingBalance)).toBe(800)

    createPaymentRecord({ entityType: 'customer', entityId: order.customerId, entityName: 'عميل اختبار', amount: 700, date: '2026-08-03', paymentMethod: 'cash' }, repo)

    const pay = standalone(db)
    expect(pay.allocatedToOrders).toBe(true)   // خُصّص جزء
    expect(pay.allocatedAmount).toBe(500)      // المُخصَّص فعلاً

    // الطلب امتلأ بالكامل من الدفعة (500)
    expect(orderById(db, order.id)).toMatchObject({ downPayment: 500, remainingBalance: 0, paidInFull: true })
    // الرصيد اللحظي: 800 − 700 = 100
    expect(Number(cust(db).remainingBalance)).toBe(100)

    recalculateCustomerBalance(order.customerId, repo)
    // 500 عبر order.downPayment + 200 مباشرة + (−300 تسوية) = 400 مدفوع ⇒ متبقٍّ 100
    expect(Number(cust(db).paid)).toBe(400)
    expect(Number(cust(db).remainingBalance)).toBe(100)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Case D — إعادة احتساب متكررة: النتيجة مستقرة
// ─────────────────────────────────────────────────────────────────────────────
describe('F-05B / Case D — إعادة احتساب متكررة', () => {
  it('ثلاث إعادات احتساب متتالية لا تغيّر الأرصدة', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345903' }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    adjustCustomerDebt(order.customerId, { remainingBalance: 800 }, repo)
    createPaymentRecord({ entityType: 'customer', entityId: order.customerId, entityName: 'عميل اختبار', amount: 700, date: '2026-08-04', paymentMethod: 'cash' }, repo)

    recalculateCustomerBalance(order.customerId, repo)
    const snap1 = { paid: Number(cust(db).paid), remaining: Number(cust(db).remainingBalance), orderDown: Number(orderById(db, order.id).downPayment) }
    recalculateCustomerBalance(order.customerId, repo)
    recalculateCustomerBalance(order.customerId, repo)
    const snap2 = { paid: Number(cust(db).paid), remaining: Number(cust(db).remainingBalance), orderDown: Number(orderById(db, order.id).downPayment) }

    expect(snap2).toEqual(snap1)
    expect(snap2).toEqual({ paid: 400, remaining: 100, orderDown: 500 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Case E — توافق السجلات التاريخية (بلا allocatedAmount)
// ─────────────────────────────────────────────────────────────────────────────
describe('F-05B / Case E — توافق السجلات التاريخية', () => {
  it('سجل قديم مُخصَّص كاملاً (allocatedToOrders=true بلا allocatedAmount) ⇒ direct=0', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345904' }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    const c = cust(db)
    // محاكاة مخزون تاريخي: دفعة مُخصَّصة كاملة (بلا حقل allocatedAmount الجديد)
    db.addFirestoreDoc(STORAGE_KEYS.PAYMENTS, {
      id: 'PAY-LEG1', entityType: 'customer', entityId: c.id, entityName: c.name,
      amount: 200, date: '2026-01-01', paymentMethod: 'cash', notes: '',
      isDownPayment: false, createdBy: 'test', createdAt: '2026-01-01T10:00:00',
      type: 'payment', refOrderId: '', cycleKey: '', allocatedToOrders: true
    })
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, order.id, { downPayment: 200, remainingBalance: 300 })
    repo.updateFirestoreDoc(STORAGE_KEYS.CUSTOMERS, c.id, { paid: 200, remainingBalance: 300 })

    recalculateCustomerBalance(c.id, repo)
    // تُحتسب عبر order.downPayment فقط (لا تُحتسب مباشرة)
    expect(Number(cust(db).paid)).toBe(200)
    expect(Number(cust(db).remainingBalance)).toBe(300)
  })

  it('سجل قديم مباشر (بلا أي وسم) ⇒ يُحتسب كدفعة مباشرة كاملة', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    await createOrder({ customerInfo: customerInfo({ phone: '01012345905' }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    const c = cust(db)
    db.addFirestoreDoc(STORAGE_KEYS.PAYMENTS, {
      id: 'PAY-LEG2', entityType: 'customer', entityId: c.id, entityName: c.name,
      amount: 150, date: '2026-01-02', paymentMethod: 'cash', notes: '',
      isDownPayment: false, createdBy: 'test', createdAt: '2026-01-02T10:00:00',
      type: 'payment', refOrderId: '', cycleKey: ''
    })

    recalculateCustomerBalance(c.id, repo)
    expect(Number(cust(db).paid)).toBe(150)
    expect(Number(cust(db).remainingBalance)).toBe(350)   // 500 − 150
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Case F — دفعات وطلبات متعددة: التخصيص والمتبقي متسقة داخلياً
// ─────────────────────────────────────────────────────────────────────────────
describe('F-05B / Case F — دفعات وطلبات متعددة', () => {
  it('طلبان (500+500) ودفعتان (300+400) ⇒ التخصيص والرصيد متسقان بعد recalc', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 50, purchasePrice: 100, sellingPrice: 250 } })
    const phone = '01012345906'
    const older = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, older.id, { createdAt: '2026-01-01T10:00:00' })
    const newer = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, newer.id, { createdAt: '2026-02-01T10:00:00' })

    const c = cust(db)
    expect(Number(cust(db).remainingBalance)).toBe(1000)

    createPaymentRecord({ entityType: 'customer', entityId: c.id, entityName: c.name, amount: 300, date: '2026-03-01', paymentMethod: 'cash' }, repo)
    expect(orderById(db, older.id)).toMatchObject({ downPayment: 300, remainingBalance: 200 })

    createPaymentRecord({ entityType: 'customer', entityId: c.id, entityName: c.name, amount: 400, date: '2026-03-02', paymentMethod: 'cash' }, repo)
    // الأقدم يُكمل إلى 500 ثم الأحدث يأخذ 200
    expect(orderById(db, older.id)).toMatchObject({ downPayment: 500, remainingBalance: 0 })
    expect(orderById(db, newer.id)).toMatchObject({ downPayment: 200, remainingBalance: 300 })

    expect(Number(cust(db).remainingBalance)).toBe(300)   // 1000 − 700

    recalculateCustomerBalance(c.id, repo)
    // totalDownPayments = 500 + 200 = 700، لا دفعات مباشرة ⇒ مدفوع 700، متبقٍّ 300
    expect(Number(cust(db).paid)).toBe(700)
    expect(Number(cust(db).remainingBalance)).toBe(300)
  })
})
