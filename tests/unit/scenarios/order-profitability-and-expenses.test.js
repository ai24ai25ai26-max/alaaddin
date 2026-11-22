// =============================================================================
// سيناريوهات ربحية الطلبات والمصروفات — مختبر سيناريوهات المحاسبة
// -----------------------------------------------------------------------------
// الوحدة الثانية في جولة التسليم: تتقصّى أثر كل حالة طلب على صافي الربح مقابل
// الخزينة، وعلى حِمل المصروفات التشغيلية، مع السلوكيات الحدّية لقيود المصروفات
// (إنشاء/تعديل/حذف/ترحيل الدوري). كل الأرقام معاد بناؤها من محرك الربح الحقيقي
// (calculateNetProfit) وسجل الدفعات الحقيقي (computeTreasury) — بلا أي mock.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createOrder, updateOrderStatus } from '@/domain/orders/orderRepository'
import { calculateNetProfit } from '@/domain/accounting/accounting'
import {
  createExpense, updateExpense, deleteExpense, postDueRecurringExpenses,
  getCurrentOperatingExpenses, getExpenseNextDueDate, isExpenseDueForPosting,
} from '@/domain/accounting/expenses'
import {
  seedStore, item, customerInfo, STORAGE_KEYS, treasuryReport,
} from './helpers'

const orders = db => db.getCollection(STORAGE_KEYS.ORDERS)
const products = db => db.getCollection(STORAGE_KEYS.PRODUCTS)

describe('سيناريو ربح 0 — فاتورة مكتملة (مرجع)', () => {
  it('الربح = هامش البضاعة، والخزينة = المقبوض الفعلي، والمخزون يُخصم', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })

    await createOrder({ customerInfo: customerInfo({ phone: '01012345021' }), items: [item({ quantity: 2 })], downPayment: 500, status: 'delivered' }, repo)

    const p = calculateNetProfit(orders(db), { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    expect(p).toMatchObject({ itemsSales: 500, cogs: 200, merchantExpenses: 0, netProfit: 300 })
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 500, netTreasury: 500 })
    expect(Number(products(db)[0].stock)).toBe(8)
  })
})

describe('سيناريو ربح 1 — طلب مُرتجَع بعد التسليم', () => {
  it('يُطرح البيع والتكلفة، يُرد كامل المسدد تلقائياً، الربح صفر والمخزون يعود', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })

    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345021' }), items: [item({ quantity: 2 })], downPayment: 500, status: 'delivered' }, repo)
    expect(Number(products(db)[0].stock)).toBe(8)

    await updateOrderStatus(order.id, 'returned', 0, 0, repo)

    // البيع والتكلفة للمُرتجع لا يدخلان الربح، ولا عربون محتفظ به (ردّ كامل)
    const p = calculateNetProfit(orders(db), { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    expect(p).toMatchObject({ itemsSales: 0, cogs: 0, retainedDepositIncome: 0, netProfit: 0 })

    // الخزينة: وارد 500 − رد 500 = 0، والمخزون يعود إلى 10
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 500, totalRefunds: 500, netTreasury: 0 })
    expect(Number(products(db)[0].stock)).toBe(10)
  })
})

describe('سيناريو ربح 1 — إلغاء طلب معلّق', () => {
  it('عربون محتفظ به جزئي → دخل يشغّل صافي الربح', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })

    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345022' }), items: [item({ quantity: 2 })], downPayment: 200, status: 'new' }, repo)
    await updateOrderStatus(order.id, 'cancelled', 100, 0, repo)

    expect(orders(db)[0]).toMatchObject({ status: 'cancelled', refundedAmount: 100, retainedDeposit: 100 })

    const p = calculateNetProfit(orders(db), { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    expect(p).toMatchObject({ itemsSales: 0, cogs: 0, retainedDepositIncome: 100, netProfit: 100 })

    // الخزينة: عربون 200 − رد 100 = 100، ولم يُحقَّق الطلب → لا خصم مخزون
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 200, totalRefunds: 100, netTreasury: 100 })
    expect(Number(products(db)[0].stock)).toBe(10)
  })

  it('إلغاء باسترداد كامل → لا دخل محتفظ به', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })

    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345022' }), items: [item({ quantity: 2 })], downPayment: 200, status: 'new' }, repo)
    await updateOrderStatus(order.id, 'cancelled', 200, 0, repo)

    const p = calculateNetProfit(orders(db), { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    expect(p).toMatchObject({ retainedDepositIncome: 0, netProfit: 0 })
    expect(orders(db)[0]).toMatchObject({ retainedDeposit: 0 })
  })
})

describe('سيناريو ربح 2 — شحن ونثريات على حساب التاجر', () => {
  it('شحن يدفعه التاجر: مصروف لا يدخل إجمالي الفاتورة', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })

    const order = await createOrder({
      customerInfo: customerInfo({ phone: '01012345023' }),
      items: [item({ quantity: 2 })],
      shippingCost: 40, shippingPayer: 'merchant',
      downPayment: 500, status: 'delivered',
    }, repo)

    expect(order.totalAmount).toBe(500)
    const p = calculateNetProfit(orders(db), { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    expect(p).toMatchObject({ itemsSales: 500, customerShippingTotal: 0, merchantShippingTotal: 40, merchantExpenses: 40, grossProfit: 260, netProfit: 260 })
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 500 })
  })

  it('نثريات يدفعها التاجر: مصروف إضافي مستقل عن الشحن', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })

    await createOrder({
      customerInfo: customerInfo({ phone: '01012345024' }),
      items: [item({ quantity: 2 })],
      extraExpenses: 30, extraExpensesPayer: 'merchant',
      downPayment: 500, status: 'delivered',
    }, repo)

    const p = calculateNetProfit(orders(db), { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    expect(p).toMatchObject({ merchantShippingTotal: 0, merchantExtraExpensesTotal: 30, merchantExpenses: 30, netProfit: 270 })
  })

  it('طلب مرتجع دفع التاجر شحنه: الشحن يبقى خسارة محققة (لا بيع يقابله)', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })

    const order = await createOrder({
      customerInfo: customerInfo({ phone: '01012345025' }),
      items: [item({ quantity: 2 })],
      shippingCost: 40, shippingPayer: 'merchant',
      downPayment: 500, status: 'delivered',
    }, repo)
    await updateOrderStatus(order.id, 'returned', 0, 0, repo)

    const p = calculateNetProfit(orders(db), { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    expect(p).toMatchObject({ itemsSales: 0, cogs: 0, merchantShippingTotal: 40, netProfit: -40 })
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 500, totalRefunds: 500, netTreasury: 0 })
  })
})

describe('سيناريو ربح 2 — تجميع حالات مختلطة', () => {
  it('مُسلَّم + مُلغى (دخل محتفظ) + مُسلَّم: الربح والخزينة والمخزون متسقون', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })

    await createOrder({ customerInfo: customerInfo({ phone: '01012345031' }), items: [item({ quantity: 2 })], downPayment: 500, status: 'delivered' }, repo)
    const b = await createOrder({ customerInfo: customerInfo({ phone: '01012345032' }), items: [item({ quantity: 2 })], downPayment: 200, status: 'new' }, repo)
    await updateOrderStatus(b.id, 'cancelled', 100, 0, repo)
    await createOrder({ customerInfo: customerInfo({ phone: '01012345033' }), items: [item({ quantity: 1 })], downPayment: 250, status: 'delivered' }, repo)

    const p = calculateNetProfit(orders(db), { getCurrentOperatingExpenses: () => ({ total: 0 }) })
    expect(p).toMatchObject({ itemsSales: 750, cogs: 300, retainedDepositIncome: 100, netProfit: 550 })

    // الخزينة: 500 + 200 + 250 وارد − 100 رد = 850
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 950, totalRefunds: 100, netTreasury: 850 })
    // المخزون: 10 − 2 − 1 = 7 (الطلب الملغي لم يُحقَّق)
    expect(Number(products(db)[0].stock)).toBe(7)
  })
})

describe('سيناريو مصروفات 1 — تصنيف التشغيل الجاري', () => {
  it('الدوري المستحق فقط يدخل الإجمالي، والمستقبلي يُستبعد، واليوم غير الصالح يُعامل كمرة واحدة', () => {
    const expenses = [
      { id: 'E1', amount: 100, recurring: false },
      { id: 'E2', amount: 200, recurring: true, dueDay: 5 },
      { id: 'E3', amount: 50, recurring: true, dueDay: 20 },
      { id: 'E4', amount: 30, recurring: true, dueDay: 99 },
    ]

    const r = getCurrentOperatingExpenses(expenses, '2026-08-10')
    expect(r).toMatchObject({ oneTime: 130, recurringThisMonth: 200, recurringFuture: 50, total: 330 })
  })

  it('calculateNetProfit يخصم إجمالي التشغيل الجاري المُمرَّر عبر الـ deps', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    await createOrder({ customerInfo: customerInfo({ phone: '01012345041' }), items: [item({ quantity: 2 })], downPayment: 500, status: 'delivered' }, repo)

    const p = calculateNetProfit(orders(db), { getCurrentOperatingExpenses: () => ({ total: 330 }) })
    expect(p).toMatchObject({ itemsSales: 500, totalOpExpenses: 330, netProfit: -30 })
  })
})

describe('سيناريو مصروفات 2 — قيود الإنشاء والتعديل والحذف', () => {
  function expenseRepo(db, repo) {
    repo.getExpenses = () => db.getCollection(STORAGE_KEYS.EXPENSES)
    return repo
  }

  it('createExpense يرفض القيم غير الصحيحة ويضبط dueDay حسب نوع التكرار', () => {
    const { db, repo } = seedStore()
    const er = expenseRepo(db, repo)

    expect(() => createExpense({ title: 'صفر', amount: 0 }, er)).toThrow(/قيمة مصروف صحيحة/)
    expect(() => createExpense({ title: 'سالب', amount: -5 }, er)).toThrow(/قيمة مصروف صحيحة/)
    expect(() => createExpense({ title: 'نص', amount: 'abc' }, er)).toThrow(/قيمة مصروف صحيحة/)

    const oneTime = createExpense({ title: 'مرة واحدة', amount: 100, date: '2026-08-01' }, er)
    expect(oneTime).toMatchObject({ amount: 100, recurring: false, dueDay: null })

    const recurring = createExpense({ title: 'دوري', amount: 300, date: '2026-08-01', recurring: true, dueDay: 15 }, er)
    expect(recurring).toMatchObject({ recurring: true, dueDay: 15 })
  })

  it('updateExpense يعيد تقنين القيم ويحذف dueDay عند إيقاف التكرار، وdeleteExpense يحذف', () => {
    const { db, repo } = seedStore()
    const er = expenseRepo(db, repo)

    const exp = createExpense({ title: 'شحن', amount: 100, date: '2026-08-01' }, er)
    const updated = updateExpense(exp.id, { amount: '250', recurring: true, dueDay: 10 }, er)
    expect(updated).toMatchObject({ amount: 250, recurring: true, dueDay: 10 })

    const stopped = updateExpense(exp.id, { recurring: false }, er)
    expect(stopped).toMatchObject({ recurring: false, dueDay: null })

    deleteExpense(exp.id, er)
    expect(db.getCollection(STORAGE_KEYS.EXPENSES)).toHaveLength(0)
  })

  it.fails('D-EXP-1: updateExpense يجب أن يرفض مبلغاً صفرياً مثل createExpense', () => {
    const { db, repo } = seedStore()
    const er = expenseRepo(db, repo)
    const exp = createExpense({ title: 'كهرباء', amount: 100, date: '2026-08-01' }, er)

    // الفعلي: يُخزَّن صفراً بصمت (لا يوجد guard) — المتوقع: يرفض
    expect(() => updateExpense(exp.id, { amount: 0 }, er)).toThrow()
  })

  it.fails('D-EXP-1: updateExpense يجب أن يرفض مبلغاً سالباً مثل createExpense', () => {
    const { db, repo } = seedStore()
    const er = expenseRepo(db, repo)
    const exp = createExpense({ title: 'كهرباء', amount: 100, date: '2026-08-01' }, er)

    // الفعلي: يُخزَّن -50 بصمت — المتوقع: يرفض
    expect(() => updateExpense(exp.id, { amount: -50 }, er)).toThrow()
  })
})

describe('سيناريو مصروفات 3 — مواعيد الاستحقاق وترحيل الدوري للخزينة', () => {
  it('getExpenseNextDueDate يحسب الاستحقاق القادم مع ترحيل نهاية السنة', () => {
    expect(getExpenseNextDueDate({ recurring: true, dueDay: 5 }, '2026-08-10')).toBe('2026-09-05')
    expect(getExpenseNextDueDate({ recurring: true, dueDay: 15 }, '2026-08-10')).toBe('2026-08-15')
    expect(getExpenseNextDueDate({ recurring: false, dueDay: 5 }, '2026-08-10')).toBe('')
    expect(getExpenseNextDueDate({ recurring: true, dueDay: 5 }, '2026-12-20')).toBe('2027-01-05')
  })

  it('isExpenseDueForPosting: لا يستحق إذا أُنشئ بعد يوم الاستحقاق أو رُحّل مسبقاً', () => {
    expect(isExpenseDueForPosting({ recurring: true, dueDay: 5, date: '2026-08-08' }, '2026-08-20')).toBe(false)
    expect(isExpenseDueForPosting({ recurring: true, dueDay: 5, date: '2026-08-08' }, '2026-09-20')).toBe(true)
    expect(isExpenseDueForPosting({ recurring: true, dueDay: 25, date: '2026-08-01' }, '2026-08-20')).toBe(false)
    expect(isExpenseDueForPosting({ recurring: true, dueDay: 5, lastPostedPeriod: '2026-08', date: '2026-08-01' }, '2026-08-20')).toBe(false)
    expect(isExpenseDueForPosting({ recurring: false, dueDay: 5, date: '2026-08-01' }, '2026-08-20')).toBe(false)
  })

  it('postDueRecurringExpenses يُرحّل الدوري الموجب مرة واحدة ويستبعد الصفري وغير الدوري', async () => {
    const { db, repo } = seedStore()
    repo.getExpenses = () => db.getCollection(STORAGE_KEYS.EXPENSES)

    createExpense({ title: 'إيجار', amount: 300, date: '2026-01-01', recurring: true, dueDay: 5 }, repo)
    createExpense({ title: 'مرة واحدة', amount: 50, date: '2026-01-01' }, repo)
    // دوري صفري يُزرع مباشرة (createExpense يمنع الصفر) لاختبار حراسة التخطي
    db.addFirestoreDoc(STORAGE_KEYS.EXPENSES, { id: 'EXPZERO', title: 'صفر', amount: 0, category: 'عمومية', date: '2026-01-01', recurring: true, dueDay: 5, createdBy: 'المدير العام' })

    expect(await postDueRecurringExpenses(repo, '2026-08-20')).toBe(1)
    expect(await postDueRecurringExpenses(repo, '2026-08-20')).toBe(0)

    const expensePayments = db.getCollection(STORAGE_KEYS.PAYMENTS).filter(x => x.type === 'expense')
    expect(expensePayments).toHaveLength(1)
    expect(expensePayments[0]).toMatchObject({ entityType: 'treasury', amount: -300, cycleKey: 'expense-2026-08' })

    const zero = db.getCollection(STORAGE_KEYS.EXPENSES).find(e => e.id === 'EXPZERO')
    expect(zero.lastPostedPeriod).toBeUndefined()

    expect(treasuryReport(db)).toMatchObject({ treasuryOutflow: 300, netTreasury: -300 })
  })
})
