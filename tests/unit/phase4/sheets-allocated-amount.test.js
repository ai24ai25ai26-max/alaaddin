// =============================================================================
// Phase 4.2 — A1: allocatedAmount ينجو من دورة تصدير/استيراد Google Sheets
// -----------------------------------------------------------------------------
// يثبت أن الحقل العددي «المبلغ المُخصَّص فعلاً للطلبات» يُكتب في ورقة الدفعات
// ويُقرأ عند الاستعادة الكاملة، مع توافق السجلات القديمة (بلا الحقل) وعدم حدوث
// فقد أو حساب مزدوج في رصيد العميل. الدورة تُشغَّل عبر محرّك sheets الحقيقي
// (exportAll/importAll) على ناقل في الذاكرة (بلا شبكة) + طبقة الدومين الحقيقية.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { exportAll, importAll, createMemoryTransport, resetSyncState } from '@/services/sheets'
import { createOrder } from '@/domain/orders/orderRepository'
import { createPaymentRecord } from '@/domain/accounting/payments'
import { recalculateCustomerBalance } from '@/domain/customers/customers'
import { round2 } from '@/utils/formatters'
import { seedStore, item, customerInfo, STORAGE_KEYS } from './../scenarios/helpers'
import { freshSystem, seedCustomer } from '../../helpers/fakeRepo'

const { PAYMENTS, ORDERS, CUSTOMERS, SUPPLIERS, PRODUCTS, SUPPLIER_RETURNS } = STORAGE_KEYS

// يربط واجهات window التي يستخدمها محرّك sheets بقاعدة fakeRepo المعطاة.
function wire(db, repo) {
  window.getOrders = () => db.getCollection(ORDERS)
  window.getPayments = () => db.getCollection(PAYMENTS)
  window.getCustomers = () => db.getCollection(CUSTOMERS)
  window.getSuppliers = () => db.getCollection(SUPPLIERS)
  window.getProducts = () => db.getCollection(PRODUCTS)
  window.getSupplierReturns = () => db.getCollection(SUPPLIER_RETURNS)
  window.getUsers = () => []
  window.getExpenses = () => []
  window.getCustomerAddresses = () => []
  window.getCustomerById = (id) => db.getCollection(CUSTOMERS).find(c => c.id === id) || null
  window.getSupplierById = (id) => db.getCollection(SUPPLIERS).find(s => s.id === id) || null
  window.STORAGE_KEYS = STORAGE_KEYS
  window.round2 = round2
  window.addFirestoreDoc = (key, doc) => db.addFirestoreDoc(key, doc)
  window.updateFirestoreDoc = (key, id, fields) => db.updateFirestoreDoc(key, id, fields)
  window.recalculateCustomerBalance = (id) => recalculateCustomerBalance(id, repo)
  window.recalculateAllCustomerBalances = () => db.getCollection(CUSTOMERS).forEach(c => recalculateCustomerBalance(c.id, repo))
}

function snapshot(db) {
  const c = db.getCollection(CUSTOMERS)[0]
  return {
    paid: Number(c.paid) || 0,
    remaining: Number(c.remainingBalance) || 0,
    credit: Number(c.creditBalance) || 0,
    orderDown: Number(db.getCollection(ORDERS)[0] ? db.getCollection(ORDERS)[0].downPayment : 0) || 0,
  }
}

function paymentDoc(over = {}) {
  return {
    id: 'PAY-1', entityType: 'customer', entityId: 'CUST1', entityName: 'عميل اختبار',
    amount: 700, date: '2026-08-01', paymentMethod: 'cash', notes: '',
    isDownPayment: false, createdBy: 'test', createdAt: '2026-08-01T10:00:00',
    type: 'payment', refOrderId: '', cycleKey: '', ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
  window.isSandboxMode = false
})
afterEach(() => {
  resetSyncState()
  localStorage.clear()
})

describe('A1 — المبلغ المُخصَّص ينجو من دورة Google Sheets', () => {
  // ── تخصيص كامل عبر الدومين الحقيقي + رصيد العميل قبل/بعد ──
  it('تخصيص كامل: allocatedAmount يُستعاد ورصيد العميل لا يتغير بعد الدورة', async () => {
    const { db: sdb, repo: srepo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345701' }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, srepo)
    createPaymentRecord({ entityType: 'customer', entityId: order.customerId, entityName: 'عميل اختبار', amount: 500, date: '2026-08-01', paymentMethod: 'cash' }, srepo)
    const srcPay = sdb.getCollection(PAYMENTS).find(p => !p.isDownPayment)
    expect(srcPay.allocatedAmount).toBe(500)
    expect(srcPay.allocatedToOrders).toBe(true)

    wire(sdb, srepo)
    recalculateCustomerBalance(order.customerId, srepo)
    const before = snapshot(sdb)
    expect(before).toMatchObject({ paid: 500, remaining: 0, orderDown: 500 })

    const sheets = {}
    const t = createMemoryTransport(sheets)
    await exportAll(t)
    expect(sheets['Treasury_Payments'].rows[0].allocatedAmount).toBe('500')
    expect(sheets['Treasury_Payments'].rows[0].allocatedToOrders).toBe('نعم')

    // استعادة كاملة على سيستم فارغ
    const { db: tdb, repo: trepo } = freshSystem()
    wire(tdb, trepo)
    await importAll(t)

    const rstPay = tdb.getCollection(PAYMENTS).find(p => !p.isDownPayment)
    expect(rstPay.allocatedAmount).toBe(500)
    expect(rstPay.allocatedToOrders).toBe(true)

    recalculateCustomerBalance(rstPay.entityId, trepo)
    const after = snapshot(tdb)
    expect(after).toEqual(before)

    // إعادة احتساب متكررة لا تُحدث انزياحاً
    recalculateCustomerBalance(rstPay.entityId, trepo)
    recalculateCustomerBalance(rstPay.entityId, trepo)
    expect(snapshot(tdb)).toEqual(before)
  })

  // ── تخصيص جزئي: المُخصَّص = 500 من 700، والباقي 200 يبقى دفعة مباشرة مرة واحدة ──
  it('تخصيص جزئي: allocatedAmount=500 من 700 يُستعاد والباقي 200 يُحتسب مرة واحدة (بلا ازدواج)', async () => {
    const seed = {
      [CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01011111111', totalPurchases: 500, paid: 700, remainingBalance: 0 })],
      [ORDERS]: [{ id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 500, downPayment: 500, remainingBalance: 0, paidInFull: true, createdAt: '2026-08-01T10:00:00' }],
      [PAYMENTS]: [paymentDoc({ id: 'PAY-P', amount: 700, allocatedToOrders: true, allocatedAmount: 500 })],
    }
    const { db: sdb, repo: srepo } = freshSystem(seed)
    wire(sdb, srepo)
    recalculateCustomerBalance('CUST1', srepo)
    const before = snapshot(sdb)
    expect(before).toMatchObject({ paid: 700, remaining: 0, credit: 200, orderDown: 500 })

    const sheets = {}
    const t = createMemoryTransport(sheets)
    await exportAll(t)
    expect(sheets['Treasury_Payments'].rows[0].allocatedAmount).toBe('500')

    const { db: tdb, repo: trepo } = freshSystem()
    wire(tdb, trepo)
    await importAll(t)

    const rstPay = tdb.getCollection(PAYMENTS).find(p => p.id === 'PAY-P')
    expect(rstPay.allocatedAmount).toBe(500)
    recalculateCustomerBalance('CUST1', trepo)
    expect(snapshot(tdb)).toEqual(before)
    // لا ازدواج: 500 (الطلب) + 200 (غير مُخصَّص) = 700 بالضبط
    expect(snapshot(tdb).paid).toBe(700)

    recalculateCustomerBalance('CUST1', trepo)
    expect(snapshot(tdb)).toEqual(before)
  })

  // ── دفعة غير مُخصَّصة كلياً: allocatedAmount=0 ──
  it('غير مُخصَّصة: allocatedAmount=0 يُستعاد وتُحتسب الدفعة كاملة مباشرة', async () => {
    const seed = {
      [CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01011111111', totalPurchases: 500, paid: 200, remainingBalance: 300 })],
      [ORDERS]: [{ id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 500, downPayment: 0, remainingBalance: 500, paidInFull: false, createdAt: '2026-08-01T10:00:00' }],
      [PAYMENTS]: [paymentDoc({ id: 'PAY-U', amount: 200, allocatedToOrders: false, allocatedAmount: 0 })],
    }
    const { db: sdb, repo: srepo } = freshSystem(seed)
    wire(sdb, srepo)
    recalculateCustomerBalance('CUST1', srepo)
    const before = snapshot(sdb)
    expect(before).toMatchObject({ paid: 200, remaining: 300, credit: 0, orderDown: 0 })

    const sheets = {}
    const t = createMemoryTransport(sheets)
    await exportAll(t)
    expect(sheets['Treasury_Payments'].rows[0].allocatedAmount).toBe('0')
    expect(sheets['Treasury_Payments'].rows[0].allocatedToOrders).toBe('لا')

    const { db: tdb, repo: trepo } = freshSystem()
    wire(tdb, trepo)
    await importAll(t)

    const rstPay = tdb.getCollection(PAYMENTS).find(p => p.id === 'PAY-U')
    expect(rstPay.allocatedAmount).toBe(0)
    expect(rstPay.allocatedToOrders).toBe(false)
    recalculateCustomerBalance('CUST1', trepo)
    expect(snapshot(tdb)).toEqual(before)

    recalculateCustomerBalance('CUST1', trepo)
    expect(snapshot(tdb)).toEqual(before)
  })

  // ── توافق السجلات القديمة: صف بلا عمود allocatedAmount ──
  it('سجل قديم بلا allocatedAmount: يُستعاد بلا الحقل ويُحتسب عبر العلامة المنطقية (بلا انزياح)', async () => {
    const { db, repo } = freshSystem({
      [CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01011111111' })],
      [ORDERS]: [{ id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 500, downPayment: 400, remainingBalance: 100, paidInFull: false, createdAt: '2026-08-01T10:00:00' }],
    })
    wire(db, repo)
    // ورقة قديمة: دفعة مُخصَّصة كاملة بلا عمود allocatedAmount
    const t = createMemoryTransport({
      Treasury_Payments: {
        headers: ['id', 'entityType', 'entityId', 'entityName', 'amount', 'isDownPayment', 'allocatedToOrders'],
        rows: [{ id: 'PAY-LEG', entityType: 'customer', entityId: 'CUST1', entityName: 'عميل', amount: 400, isDownPayment: false, allocatedToOrders: true }],
      },
    })
    const imp = await importAll(t)
    expect(imp.errors).toEqual([])

    const rst = db.getCollection(PAYMENTS).find(p => p.id === 'PAY-LEG')
    expect(rst).toBeTruthy()
    expect(rst.allocatedAmount).toBeUndefined()
    expect(rst.allocatedToOrders).toBe(true)

    recalculateCustomerBalance('CUST1', repo)
    // السقوط على العلامة المنطقية: direct = 0 ⇒ يُحتسب عبر order.downPayment فقط
    expect(snapshot(db)).toMatchObject({ paid: 400, remaining: 100, orderDown: 400 })

    recalculateCustomerBalance('CUST1', repo)
    expect(snapshot(db)).toMatchObject({ paid: 400, remaining: 100, orderDown: 400 })
  })
})
