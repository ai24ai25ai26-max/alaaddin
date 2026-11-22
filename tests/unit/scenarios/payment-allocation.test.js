// =============================================================================
// سيناريوهات توزيع الدفعات وحراسات تجاوز السقف — مختبر سيناريوهات المحاسبة
// -----------------------------------------------------------------------------
// دفع واحد يُوزَّع على عدة طلبات متبقية بالترتيب الأقدم أولاً، ورفض كل دفعة
// تتجاوز المبلغ المستحق فعلاً (عميل/مورد/تحصيل) قبل أي كتابة في الدفتر.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createOrder } from '@/domain/orders/orderRepository'
import { createPaymentRecord } from '@/domain/accounting/payments'
import { recalculateCustomerBalance } from '@/domain/customers/customers'
import { freshSystem, seedCustomer } from '../../helpers/fakeRepo'
import {
  seedStore, item, customerInfo, STORAGE_KEYS,
  expectSupplierConsistent, expectOrderMoneyConsistent, expectCustomerLedgerTies,
  expectStockTies, treasuryReport,
} from './helpers'

describe('سيناريو توزيع 1 — دفعة واحدة تُوزَّع على ثلاثة طلبات بالأقدم أولاً', () => {
  it('التخصيص التسلسلي يقفل الأقدم أولاً ويترك الباقي على الأحدث', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const phone = '01012345003'

    await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    await createOrder({ customerInfo: customerInfo({ phone }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, repo)
    expectStockTies(db.getCollection(STORAGE_KEYS.PRODUCTS)[0], 4)

    const customerBefore = db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]
    expect(customerBefore).toMatchObject({ paid: 0, totalPurchases: 1500, remainingBalance: 1500 })

    // دفع 900 → يغطي الأول بالكامل، والثاني 400، ولا يلمس الثالث
    createPaymentRecord({ entityType: 'customer', entityId: customerBefore.id, entityName: customerBefore.name, amount: 900, date: '2026-08-10', paymentMethod: 'cash', notes: 'دفعة على عدة فواتير' }, repo)

    const orders = db.getCollection(STORAGE_KEYS.ORDERS)
    // التخصيص بالأقدم أولاً (ترتيب الإنشاء) → يقفل الأقدم ويترك الأحدث
    expect(orders[0]).toMatchObject({ downPayment: 500, remainingBalance: 0, paidInFull: true })
    expect(orders[1]).toMatchObject({ downPayment: 400, remainingBalance: 100, paidInFull: false })
    expect(orders[2]).toMatchObject({ downPayment: 0, remainingBalance: 500, paidInFull: false })
    orders.forEach(expectOrderMoneyConsistent)

    const customer = db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]
    expect(customer).toMatchObject({ paid: 900, totalPurchases: 1500, remainingBalance: 600 })
    expectCustomerLedgerTies(customer, orders, db.getCollection(STORAGE_KEYS.PAYMENTS))
    expectSupplierConsistent(db.getCollection(STORAGE_KEYS.SUPPLIERS)[0], db.getCollection(STORAGE_KEYS.SUPPLIER_TRANSACTIONS))
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 900, netTreasury: 900 })
  })
})

describe('سيناريو توزيع 2 — حراسات تجاوز السقف ترفض قبل أي كتابة', () => {
  it('لا دفعة عميل/مورد/تحصيل تتجاوز المستحق الفعلي', async () => {
    const { db, repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 }, supplierOver: { id: 'SUP1', totalPurchases: 10000, paid: 0, remainingBalance: 10000 } })

    const order = await awaitPayCustomer300(db, repo)

    const customer = db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]
    const supplier = db.getCollection(STORAGE_KEYS.SUPPLIERS)[0]

    // عميل: المتبقي 300 → رفض 400
    expect(() => createPaymentRecord({ entityType: 'customer', entityId: customer.id, entityName: customer.name, amount: 400, date: '2026-08-10' }, repo))
      .toThrow(/أكبر من إجمالي المديونية المتبقية على العميل/)

    // مورد: المديونية 10000 → رفض 15000
    expect(() => createPaymentRecord({ entityType: 'supplier', entityId: 'SUP1', entityName: 'مورد أ', amount: 15000, date: '2026-08-10' }, repo))
      .toThrow(/أكبر من إجمالي المديونية المستحقة للمورد/)

    // تحويل إلى تحصيل من مورد ليس مديناً لنا (رصيده موجب)
    expect(() => createPaymentRecord({ entityType: 'supplier', entityId: 'SUP1', entityName: 'مورد أ', amount: 1000, date: '2026-08-10', isCollection: true }, repo))
      .toThrow(/لا يوجد مبلغ مستحق لنا من هذا المورد/)

    // لا شيء كُتب بعد كل الرفض
    expect(db.getCollection(STORAGE_KEYS.PAYMENTS)).toHaveLength(1) // عربون الطلب فقط
    expect(db.getCollection(STORAGE_KEYS.CUSTOMERS)[0].remainingBalance).toBe(300)
    expect(db.getCollection(STORAGE_KEYS.SUPPLIERS)[0].remainingBalance).toBe(10000)
    expect(db.getCollection(STORAGE_KEYS.SUPPLIER_TRANSACTIONS)).toHaveLength(0)
    expect(order.status).toBe('delivered')

    // تحصيل ضمن السقف من مورد رصيده سالب: السقف هو المستحق لنا منه (1000)
    db.getCollection(STORAGE_KEYS.SUPPLIERS)[0].remainingBalance = -1000
    db.getCollection(STORAGE_KEYS.SUPPLIERS)[0].paid = 11000
    expect(() => createPaymentRecord({ entityType: 'supplier', entityId: 'SUP1', entityName: 'مورد أ', amount: 1500, date: '2026-08-10', isCollection: true }, repo))
      .toThrow(/أكبر من إجمالي المبلغ المستحق لنا من المورد/)
    expect(db.getCollection(STORAGE_KEYS.SUPPLIERS)[0].remainingBalance).toBe(-1000)
  })
})

describe('سيناريو توزيع 3 — تخصيص جزئي (Phase 4.2 / A2)', () => {
  it('دفعة تتجاوز متبقي الطلبات: يُخصَّص المتاح فقط ويبقى الباقي دفعة مباشرة', () => {
    // حالة مستعادة/مستوردة: طلب مسدَّد + طلب مفتوح، ودفعة 800 خُصِّص منها 700
    // للطلب المفتوح وبقيت 100 دفعةً مباشرة. الثابت يجب أن يطابق إعادة الاحتساب.
    const seedPayment = {
      id: 'PAY-PART', entityType: 'customer', entityId: 'CUST1', entityName: 'عميل اختبار',
      amount: 800, date: '2026-08-10', paymentMethod: 'cash', notes: '',
      isDownPayment: false, createdBy: 'test', createdAt: '2026-08-10T10:00:00',
      type: 'payment', refOrderId: '', cycleKey: '',
      allocatedToOrders: true, allocatedAmount: 700,
    }
    const { db, repo } = freshSystem({
      [STORAGE_KEYS.CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01012345005' })],
      [STORAGE_KEYS.ORDERS]: [
        { id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 300, downPayment: 300, remainingBalance: 0, paidInFull: true, createdAt: '2026-08-01T10:00:00' },
        { id: 'ORD2', customerId: 'CUST1', status: 'delivered', totalAmount: 800, downPayment: 100, remainingBalance: 700, paidInFull: false, createdAt: '2026-08-02T10:00:00' },
      ],
      [STORAGE_KEYS.PAYMENTS]: [seedPayment],
    })

    recalculateCustomerBalance('CUST1', repo)

    const customer = db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]
    // 400 عربونات + 100 غير مُخصَّصة = 500 مسدد ⇒ المتبقي 1100 − 500 = 600
    expect(customer).toMatchObject({ paid: 500, totalPurchases: 1100, remainingBalance: 600 })
    expectCustomerLedgerTies(customer, db.getCollection(STORAGE_KEYS.ORDERS), db.getCollection(STORAGE_KEYS.PAYMENTS))
  })
})

/** عميل عليه طلب واحد متبقي منه 300. */
async function awaitPayCustomer300(db, repo) {
  const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345004' }), items: [item({ quantity: 2 })], downPayment: 200, status: 'delivered' }, repo)
  expect(db.getCollection(STORAGE_KEYS.CUSTOMERS)[0]).toMatchObject({ paid: 200, remainingBalance: 300 })
  return order
}
