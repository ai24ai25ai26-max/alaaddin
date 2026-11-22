// =============================================================================
// سيناريوهات تحصيل العميل — اختبارات تكامل (V3.65)
// -----------------------------------------------------------------------------
// تغطية: تحصيل جزئي، تحصيل كامل، تحصيل زائد (مرفوض)، تحصيل بلا طلب نشط،
//         تعديل دفعة مستقلة، حذف دفعة مستقلة، تسوية المديونية.
// كل اختبار يوضّح الرصيد قبل الحركة وبعدها والقيمة المتوقعة، ويعتمد على طبقة
// الدومين الحقيقية (fakeRepo يفوّض للوحدات النقية — لا mock للحساب).
// ⚠️ لا يُعدَّل أي معادلة مالية هنا — التثبيت فقط.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createOrder } from '@/domain/orders/orderRepository'
import { adjustCustomerDebt, recalculateCustomerBalance } from '@/domain/customers/customers'
import { seedStore, item, customerInfo, STORAGE_KEYS, treasuryReport } from './helpers'
import { getTotalCustomerReceivables } from '@/domain/accounting/payments'

const PHONE = '01011122233'

function order500Env() {
  return seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
}

async function deliveredOrder(repo, { downPayment = 200, quantity = 2, sellingPrice = 250 } = {}) {
  return createOrder({
    customerInfo: customerInfo({ phone: PHONE }),
    items: [item({ quantity, sellingPrice, purchasePrice: 100 })],
    downPayment,
    status: 'delivered',
  }, repo)
}

const order = db => db.getCollection(STORAGE_KEYS.ORDERS)[0]
const customer = db => db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]
const pays = db => db.getCollection(STORAGE_KEYS.PAYMENTS)
const standalone = db => pays(db).find(p => !p.isDownPayment)

describe('تحصيل العميل — تحصيل جزئي', () => {
  it('يخصم من الطلب ورصيد العميل والذمم ويرفع المقبوضات', async () => {
    const { db, repo } = order500Env()
    const o = await deliveredOrder(repo)

    // —— قبل التحصيل —
    expect(order(db)).toMatchObject({ totalAmount: 500, downPayment: 200, remainingBalance: 300 })
    expect(customer(db)).toMatchObject({ totalPurchases: 500, paid: 200, remainingBalance: 300 })
    expect(getTotalCustomerReceivables(db.getCollection(STORAGE_KEYS.ORDERS), pays(db))).toBe(300)
    expect(treasuryReport(db).totalInflow).toBe(200)

    repo.createPaymentRecord({
      entityType: 'customer', entityId: o.customerId, entityName: 'أحمد محمد',
      amount: 150, date: '2026-08-02', paymentMethod: 'cash', notes: 'تحصيل جزئي',
    })

    // بعد: الطلب 350/150، العميل مدفوع 350 متبقي 150، الذمم 150، المقبوضات 350
    expect(order(db)).toMatchObject({ downPayment: 350, remainingBalance: 150, paidInFull: false })
    expect(customer(db)).toMatchObject({ paid: 350, remainingBalance: 150 })
    expect(getTotalCustomerReceivables(db.getCollection(STORAGE_KEYS.ORDERS), pays(db))).toBe(150)
    expect(treasuryReport(db).totalInflow).toBe(350)
    expect(standalone(db).allocatedToOrders).toBe(true)
  })
})

describe('سيناريوهات تحصيل العميل — اختبارات تكامل (V3.65)', () => {
  it('تحصيل كامل: يصفر متبقي الطلب والعميل ويرفع المقبوضات للإجمالي', async () => {
    const { db, repo } = order500Env()
    const o = await deliveredOrder(repo) // متبقي 300

    repo.createPaymentRecord({ entityType: 'customer', entityId: o.customerId, entityName: 'أحمد محمد', amount: 300, date: '2026-08-02', paymentMethod: 'cash', notes: 'سدّد الباقي' })

    expect(order(db)).toMatchObject({ downPayment: 500, remainingBalance: 0, paidInFull: true })
    expect(customer(db)).toMatchObject({ paid: 500, remainingBalance: 0 })
    expect(getTotalCustomerReceivables(db.getCollection(STORAGE_KEYS.ORDERS), pays(db))).toBe(0)
    expect(treasuryReport(db).totalInflow).toBe(500)
  })

  it('تحصيل زائد عن المديونية: يُرفض بخطأ ولا يغيّر أي رصيد', async () => {
    const { db, repo } = order500Env()
    await deliveredOrder(repo)

    expect(() => repo.createPaymentRecord({
      entityType: 'customer', entityId: customer(db).id, entityName: 'أحمد محمد',
      amount: 400, date: '2026-08-02', paymentMethod: 'cash', notes: 'زائد',
    })).toThrow(/أكبر من إجمالي المديونية/)

    // لم تتغيّر الطلبات/العميل/الدفعات (تبقى دفعة العربون الوحيدة)
    expect(order(db)).toMatchObject({ downPayment: 200, remainingBalance: 300 })
    expect(customer(db)).toMatchObject({ paid: 200, remainingBalance: 300 })
    expect(pays(db)).toHaveLength(1)
  })
})

describe('تعديل/حذف دفعة مستقلة', () => {
  it('تعديل المبلغ 150→250 يعيد التخصيص ويضبط الأرصدة', async () => {
    const { db, repo } = order500Env()
    await deliveredOrder(repo)
    repo.createPaymentRecord({ entityType: 'customer', entityId: customer(db).id, entityName: 'أحمد محمد', amount: 150, date: '2026-08-02', paymentMethod: 'cash', notes: 'تحصيل' })

    // قبل التعديل: الطلب 350/150 والذمم 150 والمقبوضات 350
    expect(order(db)).toMatchObject({ downPayment: 350, remainingBalance: 150 })
    expect(treasuryReport(db).totalInflow).toBe(350)

    await repo.updatePaymentRecord(standalone(db).id, { amount: 250 })

    // بعد: الطلب 450/50 والعميل 450/50 والمقبوضات 450
    expect(order(db)).toMatchObject({ downPayment: 450, remainingBalance: 50 })
    expect(customer(db)).toMatchObject({ paid: 450, remainingBalance: 50 })
    expect(treasuryReport(db).totalInflow).toBe(450)
  })

  it('حذف الدفعة المستقلة يعكس أثرها بالكامل', async () => {
    const { db, repo } = order500Env()
    await deliveredOrder(repo)
    repo.createPaymentRecord({ entityType: 'customer', entityId: customer(db).id, entityName: 'أحمد محمد', amount: 150, date: '2026-08-02', paymentMethod: 'cash', notes: 'تحصيل' })

    await repo.deletePaymentRecord(standalone(db).id)

    expect(order(db)).toMatchObject({ downPayment: 200, remainingBalance: 300 })
    expect(customer(db)).toMatchObject({ paid: 200, remainingBalance: 300 })
    expect(treasuryReport(db).totalInflow).toBe(200)
    expect(pays(db).filter(p => !p.isDownPayment)).toHaveLength(0)
  })
})

describe('تسوية المديونية', () => {
  it('تخفض الذمم بقيد دفتر ولا تمسّ الخزينة وتصمد أمام إعادة الاحتساب', async () => {
    const { db, repo } = order500Env()
    const o = await deliveredOrder(repo)

    // قبل: الذمم 300 والخزينة 200
    expect(getTotalCustomerReceivables(db.getCollection(STORAGE_KEYS.ORDERS), pays(db))).toBe(300)

    adjustCustomerDebt(o.customerId, { remainingBalance: 100 }, repo)

    const adj = pays(db).find(p => p.type === 'customerDebtAdjustment')
    expect(adj).toMatchObject({ entityType: 'customer', amount: 200 })
    expect(customer(db)).toMatchObject({ remainingBalance: 100 })
    // الذمم تخصم مقدار التسوية، والخزينة لا تتأثر
    expect(getTotalCustomerReceivables(db.getCollection(STORAGE_KEYS.ORDERS), pays(db))).toBe(100)
    expect(treasuryReport(db).totalInflow).toBe(200)

    recalculateCustomerBalance(o.customerId, repo)
    expect(customer(db).remainingBalance).toBe(100)
  })
})

describe('⚠️ عيب موثّق (غير مُصلَح) — تحصيل بلا طلب نشط', () => {
  // السبب: getTotalCustomerReceivables مبنية على «متبقي الطلبات النشطة − صافي
  // التسويات» فقط، ولا تعرف عن الدفعات المستقلة التي لم يبقَ لها طلب تُخصَّص له.
  // الحالة: عميل عليه مديونية أُنشئت بتسوية يدوية (لا طلبات)، ثم حصّلنا جزءاً.
  // الصافي الدفتري (remainingBalance) ينقص، لكن مؤشر «ديون على العملاء» يبقى
  // مبنياً على التسوية فقط فيبالغ في الدين (500 بدل 300).
  // الإصلاح المقترح (منفصل، غير منفَّذ): اشتقاق الذمم من صافي أرصدة العملاء
  // الموجبة، أو تتبّع رصيد/ائتمان العميل غير المخصَّص لطلب.
  it.fails('يجب أن يطابق مؤشر الذمم صافي رصيد العميل بعد التحصيل', () => {
    const { db, repo } = order500Env()
    const cust = repo.createCustomer({ name: 'عميل بلا طلبات', phone: '01099988877' })
    adjustCustomerDebt(cust.id, { remainingBalance: 500 }, repo)
    repo.createPaymentRecord({ entityType: 'customer', entityId: cust.id, entityName: 'عميل بلا طلبات', amount: 200, date: '2026-08-03', paymentMethod: 'cash', notes: 'تحصيل جزء' })

    // الرصيد الدفتري الفعلي صار 300
    expect(customer(db).remainingBalance).toBe(300)
    // المتوقع الصحيح أن يطابق المؤشر الرصيد الفعلي (يفشل حاليًا: 500)
    expect(getTotalCustomerReceivables(db.getCollection(STORAGE_KEYS.ORDERS), pays(db))).toBe(300)
  })
})
