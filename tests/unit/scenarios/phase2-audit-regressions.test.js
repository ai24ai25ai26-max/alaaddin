// =============================================================================
// Phase 2 — اختبارات انحدار تدقيق (verify-only) — بلا أي تعديل على كود الإنتاج
// -----------------------------------------------------------------------------
// هذا الملف يقفل النتائج المؤكدة من مراجعة التدقيق مقابل طبقة الدومين الحقيقية
// (fakeRepo يفوّض لكل الوحدات النقية — لا mock للحسابات). لكل عيب مؤكد:
//   • اختبار توصيفي (it) يوثّق السلوك الفعلي الحالي كي لا يتغيّر بصمت، ثم
//   • اختبار it.fails يثبت السلوك «المقصود» — يمرّ فقط بعد الإصلاح.
// كل الأرقام مستخرجة من المحرّكات الحقيقية (orderRepository / payments /
// customers / products / accounting / aiAssistant) وليست قيماً مكتوبة يدويًا.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createOrder, updateOrderStatus } from '@/domain/orders/orderRepository'
import { createPaymentRecord, reversePaymentRecord } from '@/domain/accounting/payments'
import { adjustCustomerDebt, recalculateCustomerBalance } from '@/domain/customers/customers'
import { calculateNetProfit } from '@/domain/accounting/accounting'
import { createExpense, postDueRecurringExpenses } from '@/domain/accounting/expenses'
import { addStockShipment, decrementProductStock, incrementProductStock } from '@/domain/inventory/products'
import { getTopProducts, buildAiSummary } from '@/services/aiAssistant'
import { applyPosDiscount, computePosTotal } from '@/services/posService'
import { round2, getCairoDate } from '@/utils/formatters'
import {
  seedStore, item, customerInfo, STORAGE_KEYS, treasuryReport,
} from './helpers'
import { seedCustomer } from '../../helpers/fakeRepo'

const orders = db => db.getCollection(STORAGE_KEYS.ORDERS)
const payments = db => db.getCollection(STORAGE_KEYS.PAYMENTS)
const getOrder = (db, id) => orders(db).find(o => o.id === id)
const getCustomerById = (db, id) => db.getCollection(STORAGE_KEYS.CUSTOMERS).find(c => c.id === id)
const theCustomer = db => db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]

/* ===========================================================================
 * F-01 (خطير) — تسريب مديونية عند إعادة التفعيل بعد استرداد جزئي
 * المسار: توصيل بعربون 800 (إجمالي 1000) → إلغاء باسترداد 300 → إعادة تفعيل
 *         → توصيل. الرصيد المتبقي المخزَّن 200 بينما النقد المحتفظ به 500.
 * ======================================================================== */
describe('F-01 — تسريب 300 عند إعادة التفعيل بعد استرداد جزئي', () => {
  async function runCycle(repo) {
    // يبدأ «قيد الانتظار» (new) لأن الإلغاء مسموح فقط من new في مصفوفة الحالات
    const order = await createOrder({
      customerInfo: customerInfo({ phone: '01012345601' }),
      items: [item({ quantity: 4 })],
      downPayment: 800,
      status: 'new',
    }, repo)
    await updateOrderStatus(order.id, 'cancelled', 300, 0, repo)
    await updateOrderStatus(order.id, 'new', 0, 0, repo)
    await updateOrderStatus(order.id, 'delivered', 0, 0, repo)
    return order.id
  }

  it('توصيف: الموظّف الحالي يخزّن downPayment=800 والمتبقي=200 والنقد المحتفظ به=500', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const id = await runCycle(repo)

    const o = getOrder(db, id)
    const c = theCustomer(db)

    expect(o.totalAmount).toBe(1000)
    expect(o.refundedAmount).toBe(300)
    expect(o.retainedDeposit).toBe(500)
    expect(o.downPayment).toBe(800)          // 👈 لم يُحدَّث على إعادة التفعيل
    expect(o.remainingBalance).toBe(200)     // 👈 المبني على downPayment=800

    // العميل: النقد الصافي المدفوع فعلاً = 800 − 300 = 500
    expect(c.paid).toBe(500)
    expect(c.remainingBalance).toBe(200)
  })

  it.fails('المقصود: النقد المحتفظ به (500) + المتبقي يجب أن يساوي الإجمالي (1000)', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const id = await runCycle(repo)

    const o = getOrder(db, id)
    const c = theCustomer(db)

    const netCashRetained = 800 - 300 // إعادة التفعيل لا تُدخل نقدًا حقيقيًا
    expect(netCashRetained + Number(o.remainingBalance)).toBe(Number(o.totalAmount))
    expect(Number(o.remainingBalance)).toBe(500)
    expect(Number(o.downPayment)).toBe(500)
    expect(Number(c.paid) + Number(c.remainingBalance)).toBe(Number(c.totalPurchases))
  })
})

/* ===========================================================================
 * F-03 (مرتفع) — الاسترداد التلقائي للمرتجع لا يسجّل refundedAmount/retainedDeposit
 * ======================================================================== */
describe('F-03 — الاسترداد التلقائي يترك refundedAmount/retainedDeposit غير مسجّلين', () => {
  it('توصيف: مرتجع طلب مُسلَّم بلا استرداد صريح يُصدر قيد رد تلقائي كامل', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({
      customerInfo: customerInfo({ phone: '01012345602' }),
      items: [item({ quantity: 2 })],
      downPayment: 500,
      status: 'delivered',
    }, repo)
    await updateOrderStatus(order.id, 'returned', 0, 0, repo)

    const refunds = payments(db).filter(p => p.type === 'refund' && p.refOrderId === order.id)
    expect(refunds.map(r => r.amount)).toEqual([-500])
    expect(getOrder(db, order.id).refundedAmount).toBeUndefined() // 👈 لا يُسجَّل على الطلب
  })

  it.fails('المقصود: الاسترداد التلقائي الكامل يسجّل refundedAmount=500 وretainedDeposit=0', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({
      customerInfo: customerInfo({ phone: '01012345602' }),
      items: [item({ quantity: 2 })],
      downPayment: 500,
      status: 'delivered',
    }, repo)
    await updateOrderStatus(order.id, 'returned', 0, 0, repo)

    const o = getOrder(db, order.id)
    expect(o.refundedAmount).toBe(500)
    expect(o.retainedDeposit).toBe(0)
  })

  it.fails('F-03 (جزئي): استرداد تلقائي 200 على طلب ثانٍ يجب أن يُسجَّل فلا يُعاد اعتماده مرتين عند إعادة التفعيل', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 20, purchasePrice: 100, sellingPrice: 250 } })
    const phone = '01012345603'
    // طلب أول مدفوع بالكامل (500) يجعل استرداد الطلب الثاني جزئيًا
    await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 500, status: 'delivered' }, repo)
    const b = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 4 })], downPayment: 200, status: 'delivered' }, repo)

    await updateOrderStatus(b.id, 'returned', 0, 0, repo)

    const refunds = payments(db).filter(p => p.type === 'refund' && p.refOrderId === b.id)
    expect(refunds.map(r => r.amount)).toEqual([-200]) // يوثّق الاسترداد التلقائي الجزئي الفعلي
    expect(getOrder(db, b.id).refundedAmount).toBe(200) // 👈 المقصود: مُسجَّل على الطلب
  })
})

/* ===========================================================================
 * F-05 (مرتفع) — تخصيص الدفعات: عدم التناظر بين الأمام (أقدم) والعكس (أحدث)
 * ======================================================================== */
describe('F-05 — تخصيص/عكس الدفعات غير متناظر', () => {
  function seedTwoUnpaid(phone = '01012345610') {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 50, purchasePrice: 100, sellingPrice: 250 } })
    return { db, repo, phone }
  }

  it('مرجع: التخصيص الأمامي يملأ الطلبات غير المسدَّدة الأقدم أولاً', async () => {
    const { db, repo, phone } = seedTwoUnpaid()
    const older = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    const newer = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, older.id, { createdAt: '2026-01-01T10:00:00' })
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, newer.id, { createdAt: '2026-02-01T10:00:00' })

    const cust = theCustomer(db)
    createPaymentRecord({ entityType: 'customer', entityId: cust.id, entityName: cust.name, amount: 300, date: '2026-03-01', paymentMethod: 'cash' }, repo)

    expect(getOrder(db, older.id)).toMatchObject({ downPayment: 300, remainingBalance: 200 })
    expect(getOrder(db, newer.id)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
  })

  it('مرجع: دفعة أكبر من الأقدم تُكمل عليه ثم تتجاوز للأحدث', async () => {
    const { db, repo, phone } = seedTwoUnpaid('01012345612')
    const older = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    const newer = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, older.id, { createdAt: '2026-01-01T10:00:00' })
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, newer.id, { createdAt: '2026-02-01T10:00:00' })

    const cust = theCustomer(db)
    createPaymentRecord({ entityType: 'customer', entityId: cust.id, entityName: cust.name, amount: 700, date: '2026-03-01', paymentMethod: 'cash' }, repo)

    expect(getOrder(db, older.id)).toMatchObject({ downPayment: 500, remainingBalance: 0 })
    expect(getOrder(db, newer.id)).toMatchObject({ downPayment: 200, remainingBalance: 300 })
  })

  it('F-05/3 (مُصلَح Phase 4): دفعة بلا طلبات مؤهلة لا تفنى عند إعادة الاحتساب', () => {
    const { db, repo } = seedStore()
    db.addFirestoreDoc(STORAGE_KEYS.CUSTOMERS, seedCustomer({ id: 'CUST9', phone: '01099999999' }))

    // دَين غير مرتبط بطلب (تسوية يدوية) → العميل مدين 300 بلا أي طلب
    adjustCustomerDebt('CUST9', { remainingBalance: 300 }, repo)
    expect(Number(getCustomerById(db, 'CUST9').remainingBalance)).toBe(300)

    // دفعة نقدية 200 لتسوية جزء من الدين
    createPaymentRecord({ entityType: 'customer', entityId: 'CUST9', entityName: 'عميل اختبار', amount: 200, date: '2026-08-01', paymentMethod: 'cash' }, repo)

    recalculateCustomerBalance('CUST9', repo)
    // المقصود: تُحتسب الدفعة → المتبقي 100. الفعلي: 300 (فُقدت الدفعة)
    expect(Number(getCustomerById(db, 'CUST9').remainingBalance)).toBe(100)
  })

  it.fails('F-05/4: عكس دفعة يجب أن يتراجع عن الطلبات التي خُصصت لها لا عن الأحدث', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 50, purchasePrice: 100, sellingPrice: 250 } })
    const phone = '01012345611'
    const a = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, a.id, { createdAt: '2026-01-01T10:00:00' })

    const cust = theCustomer(db)
    const pay = createPaymentRecord({ entityType: 'customer', entityId: cust.id, entityName: cust.name, amount: 500, date: '2026-01-02', paymentMethod: 'cash' }, repo)
    expect(Number(getOrder(db, a.id).downPayment)).toBe(500) // خُصصت كاملةً للطلب A

    const b = await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 200, status: 'delivered' }, repo)
    repo.updateFirestoreDoc(STORAGE_KEYS.ORDERS, b.id, { createdAt: '2026-02-01T10:00:00' })

    reversePaymentRecord(pay.id, repo)

    // المقصود: A يعود لحالته قبل الدفعة، وB يبقى كما هو
    expect(getOrder(db, a.id)).toMatchObject({ downPayment: 0, remainingBalance: 500 })
    expect(getOrder(db, b.id)).toMatchObject({ downPayment: 200, remainingBalance: 300 })
  })

  it('توصيف: لا يمكن تسجيل دفعة/رصيد مقدَّم لعميل بلا أي طلبات (يُرفض)', () => {
    const { db, repo } = seedStore()
    db.addFirestoreDoc(STORAGE_KEYS.CUSTOMERS, seedCustomer({ id: 'CUST8', phone: '01088888888' }))
    expect(() => createPaymentRecord({ entityType: 'customer', entityId: 'CUST8', entityName: 'عميل اختبار', amount: 100, date: '2026-08-01', paymentMethod: 'cash' }, repo)).toThrow()
  })
})

/* ===========================================================================
 * F-06 (مرتفع) — كتابة المخزون المطلقة في الشحنة تطمس التحديثات المتزامنة
 * ======================================================================== */
describe('F-06 — شحنة المخزون تكتب قيمة مطلقة (سباق ضياع تحديث)', () => {
  it('مرجع: عمليات المخزون القائمة على increment تُراكم دون ضياع', () => {
    const { repo } = seedStore({ productOver: { id: 'PRD1', stock: 10 } })
    decrementProductStock('PRD1', 3, repo)
    incrementProductStock('PRD1', 5, repo)
    expect(Number(repo.getProductById('PRD1').stock)).toBe(12)
  })

  it.fails('F-06: بيع متزامن بين قراءة الشحنة وكتابتها يجب ألا يضيع (10+5−3=12)', () => {
    const { repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    // بيع يُخصم عبر increment → 7
    decrementProductStock('PRD1', 3, repo)
    // شحنة قرأت الرصيد القديم (10) قبل البيع، ثم تكتب 15 بقيمة مطلقة
    const stale = { ...repo.getProductById('PRD1'), stock: 10 }
    const racyRepo = { ...repo, getProducts: () => [stale] }
    addStockShipment('PRD1', 5, '', 100, '', {}, racyRepo)

    expect(Number(repo.getProductById('PRD1').stock)).toBe(12) // الفعلي: 15
  })

  it('بنية: خصم البيع يصدر علامة increment بينما الشحنة تكتب قيمة مطلقة', () => {
    const { repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const writes = []
    const spyRepo = {
      ...repo,
      storageKeys: repo.storageKeys,
      getProducts: () => repo.getProducts(),
      getSuppliers: () => repo.getSuppliers(),
      updateFirestoreDoc: (key, id, fields) => {
        if (key === STORAGE_KEYS.PRODUCTS) writes.push(fields.stock)
        repo.updateFirestoreDoc(key, id, fields)
      },
    }
    decrementProductStock('PRD1', 2, spyRepo)
    addStockShipment('PRD1', 3, '', 0, '', {}, spyRepo)

    expect(writes[0]).toMatchObject({ __inc: -2 }) // خصم البيع آمن (increment)
    expect(writes[1]).toBe(11)                     // الشحنة تكتب قيمة مطلقة (غير آمنة)
  })
})

/* ===========================================================================
 * F-09 (متوسط) — مؤشرات المساعد تتجاهل حالة الطلب (تُدرِج الملغى/المرتجع)
 * ======================================================================== */
describe('F-09 — مؤشرات الذكاء الاصطناعي تشمل الطلبات الملغاة/المرتجعة', () => {
  const today = getCairoDate()
  const ts = h => `${today}T0${h}:00:00`
  const sample = [
    { id: 'O1', status: 'delivered', createdAt: ts(9), totalAmount: 1000, items: [{ productName: 'منتج أ', productId: 'PRD1', quantity: 4, subtotal: 1000 }] },
    { id: 'O2', status: 'cancelled', createdAt: ts(8), totalAmount: 500, items: [{ productName: 'منتج ب', productId: 'PRD2', quantity: 9, subtotal: 500 }] },
    { id: 'O3', status: 'returned', createdAt: ts(7), totalAmount: 300, items: [{ productName: 'منتج ب', productId: 'PRD2', quantity: 9, subtotal: 300 }] },
  ]

  it('توصيف: getTopProducts وbuildAiSummary يعدّان كل الحالات حالياً', () => {
    const top = getTopProducts(sample, 5)
    expect(top.find(x => x.name === 'منتج ب')).toMatchObject({ quantity: 18 }) // 9 ملغى + 9 مرتجع
    expect(buildAiSummary({ orders: sample }).todaySales).toBe(1800)
  })

  it.fails('المقصود: تُستبعد الملغاة/المرتجعة فتقتصر المبيعات والكميات على المحقَّقة', () => {
    expect(getTopProducts(sample, 5).find(x => x.name === 'منتج ب')).toBeUndefined()
    expect(buildAiSummary({ orders: sample }).todaySales).toBe(1000)
  })
})

/* ===========================================================================
 * F-04 (مرتفع - قرار سياسة) — الخزينة تتجاهل المصروفات لمرة واحدة
 * ======================================================================== */
describe('F-04 — أثر المصروفات على الخزينة (قرار سياسة مطلوب)', () => {
  it('توصيف: مصروف لمرة واحدة يخصم من صافي الربح ولا يمس الخزينة', () => {
    const { db, repo } = seedStore()
    repo.getExpenses = () => db.getCollection(STORAGE_KEYS.EXPENSES)
    createExpense({ title: 'كهرباء', amount: 300, date: '2026-08-01' }, repo)

    const t = treasuryReport(db)
    expect(t.netTreasury).toBe(0) // الفعلي: لا أثر نقدي لمصروف فوري

    const p = calculateNetProfit(orders(db), { getCurrentOperatingExpenses: () => ({ total: 300 }) })
    expect(p.totalOpExpenses).toBe(300)
  })

  it('توصيف: المصروف الدوري المُرحَّل يخصم من الخزينة مرة واحدة فقط (idempotent)', async () => {
    const { db, repo } = seedStore()
    repo.getExpenses = () => db.getCollection(STORAGE_KEYS.EXPENSES)
    createExpense({ title: 'إيجار', amount: 1000, date: '2026-01-01', recurring: true, dueDay: 5 }, repo)

    expect(await postDueRecurringExpenses(repo, '2026-08-10')).toBe(1)
    expect(await postDueRecurringExpenses(repo, '2026-08-10')).toBe(0)
    expect(treasuryReport(db).netTreasury).toBe(-1000)
  })
})

/* ===========================================================================
 * F-11 (منخفض) — كمية أقصى انحراف تقريب بعد توزيع خصم الكاشير
 * ======================================================================== */
describe('F-11 — قياس انحراف التقريب في توزيع خصم الكاشير', () => {
  it('الانحراف عن الإجمالي المستهدف ≤ نصف قرش × كمية آخر بند (مقبول/غير مؤثر)', () => {
    const items = [
      { productId: 'A', quantity: 3, sellingPrice: 33.33 },
      { productId: 'B', quantity: 7, sellingPrice: 11.11 },
    ]
    const subtotal = round2(3 * 33.33 + 7 * 11.11)
    const discount = 12.34
    const target = round2(subtotal - discount)
    const result = applyPosDiscount(items, discount)
    const total = computePosTotal(result)
    const lastQty = items[items.length - 1].quantity

    expect(Math.abs(total - target)).toBeLessThanOrEqual(0.005 * lastQty + 1e-9)
  })
})
