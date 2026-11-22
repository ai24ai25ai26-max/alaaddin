// =============================================================================
// سيناريوهات المورد: المرتجعات والتسويات — اختبارات تكامل (V3.65)
// -----------------------------------------------------------------------------
// تغطية: مرتجع نقدي داخل المديونية، مردود نقدي بفائض (وارد خزينة)، مرتجع تخفيض
//         دين بفائض (رصيد دائن لنا)، تسديد دفعة للمورد، تسوية مديونية مورد،
//         إعادة احتساب أرصدة الموردين (recalculateTotals)، وتحصيل نقدية من مورد.
// يتحقق كل اختبار من ثابت المورد: الرصيد المخزَّن = صافي الدفتر = مشتريات − مدفوع.
// ⚠️ لا يُعدَّل أي معادلة مالية هنا — التثبيت فقط.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createSupplierReturn, recalculateTotals } from '@/domain/inventory/supplierReturns'
import { adjustSupplierDebt } from '@/domain/suppliers/suppliers'
import { freshSystem, seedProduct, STORAGE_KEYS, expectSupplierConsistent, supplierLedgerNet, treasuryReport, profitReport } from './helpers'

const supplier = db => db.getCollection(STORAGE_KEYS.SUPPLIERS)[0]
const product = db => db.getCollection(STORAGE_KEYS.PRODUCTS)[0]
const txns = db => db.getCollection(STORAGE_KEYS.SUPPLIER_TRANSACTIONS)

function supplierEnv({ totalPurchases = 1000, remaining = 1000, paid = totalPurchases - remaining, stock = 10, purchasePrice = 100, ledger = [{ debit: totalPurchases, credit: 0 }] } = {}) {
  return freshSystem({
    [STORAGE_KEYS.PRODUCTS]: [seedProduct({ id: 'PRD1', stock, purchasePrice, sellingPrice: 250, supplierId: 'SUP1', supplierName: 'مورد أ' })],
    [STORAGE_KEYS.SUPPLIERS]: [{
      id: 'SUP1', name: 'مورد أ', phone: '01000000000', secondaryPhone: '', address: '', notes: '',
      totalPurchases, paid, remainingBalance: remaining, createdAt: '2026-08-01', updatedAt: '2026-08-01',
    }],
    [STORAGE_KEYS.SUPPLIER_TRANSACTIONS]: ledger.map((t, i) => ({
      id: 'T' + (i + 1), supplierId: 'SUP1', supplierName: 'مورد أ', type: 'شحنة توريد', refId: 'PRD1',
      debit: t.debit, credit: t.credit, createdAt: '2026-08-01T10:00:00',
    })),
  })
}

describe('مرتجع مورد نقدي داخل المديونية (لا فائض)', () => {
  it('يخصم قيمة المرتجع من الدين والمخزون بلا أي حركة خزينة', async () => {
    const { db, repo } = supplierEnv() // مديونية 1000

    await createSupplierReturn({ supplierId: 'SUP1', items: [{ productId: 'PRD1', quantity: 3, unitCost: 100 }], refundType: 'cash' }, repo)

    // قبل: 1000 / بعد: 700 (خصم 300)، ولا فائض فلا كاش
    expect(supplier(db)).toMatchObject({ totalPurchases: 700, paid: 0, remainingBalance: 700 })
    expect(product(db).stock).toBe(7)
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 0, treasuryInflow: 0 })
    expect(db.getCollection(STORAGE_KEYS.PAYMENTS)).toHaveLength(0)
    expectSupplierConsistent(supplier(db), txns(db))
  })
})

describe('مرتجع مورد نقدي مع فائض (كاش فعلي)', () => {
  it('يخصم الدين ويستلم الفائض كوارد خزينة لا يدخل صافي الربح', async () => {
    const { db, repo } = supplierEnv({ totalPurchases: 200, remaining: 200, paid: 0 }) // دين 200

    const ret = await createSupplierReturn({ supplierId: 'SUP1', items: [{ productId: 'PRD1', quantity: 5, unitCost: 100 }], refundType: 'cash' }, repo)

    // مرتجع 500 − دين 200 = فائض كاش 300، والرصيد ينغلق على 0
    expect(ret).toMatchObject({ totalValue: 500, debtOffset: 200, cashRefund: 300 })
    expect(supplier(db)).toMatchObject({ totalPurchases: 0, paid: 0, remainingBalance: 0 })
    expect(product(db).stock).toBe(5)

    const t = treasuryReport(db)
    expect(t).toMatchObject({ totalInflow: 0, treasuryInflow: 300, netTreasury: 300 })
    const movement = db.getCollection(STORAGE_KEYS.PAYMENTS).find(p => p.entityType === 'treasury')
    expect(movement).toMatchObject({ amount: 300, type: 'supplierCashRefund' })

    // يظهر في التقرير لكنه لا يمس صافي الربح (إرجاع بضاعة لا يولّد دخلاً)
    const p = profitReport(db)
    expect(p.supplierCashRefunds).toBe(300)
    expect(p.netProfit).toBe(0)
    expectSupplierConsistent(supplier(db), txns(db))
  })
})

describe('مرتجع مورد بتخفيض الدين مع فائض', () => {
  it('يبقي الفائض رصيداً دائنًا لصالحنا (رصيد سالب) بلا كاش', async () => {
    const { db, repo } = supplierEnv({ totalPurchases: 200, remaining: 200, paid: 0 })

    const ret = await createSupplierReturn({ supplierId: 'SUP1', items: [{ productId: 'PRD1', quantity: 5, unitCost: 100 }], refundType: 'debt' }, repo)

    expect(ret).toMatchObject({ totalValue: 500, debtOffset: 200, cashRefund: 0, excessAsCredit: 300 })
    // الرصيد يصبح سالباً 300 (مستحق لنا من المورد) و«المسدد» 300
    expect(supplier(db)).toMatchObject({ totalPurchases: 0, paid: 300, remainingBalance: -300 })
    expect(product(db).stock).toBe(5)
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 0, treasuryInflow: 0, netTreasury: 0 })
    expect(supplierLedgerNet(txns(db), 'SUP1')).toBe(-300)
    expectSupplierConsistent(supplier(db), txns(db))
  })
})

describe('تسديد دفعة للمورد', () => {
  it('ينقص الدين ويزيد المدفوع ويُقيَّد دائناً في الدفتر ويخرج من الخزينة', async () => {
    const { db, repo } = supplierEnv() // 1000

    repo.createPaymentRecord({ entityType: 'supplier', entityId: 'SUP1', entityName: 'مورد أ', amount: 400, date: '2026-08-02', paymentMethod: 'cash', notes: 'تسديد جزئي' })

    expect(supplier(db)).toMatchObject({ totalPurchases: 1000, paid: 400, remainingBalance: 600 })
    expect(txns(db).some(t => t.type === 'تسديد دفعة' && t.credit === 400)).toBe(true)
    const t = treasuryReport(db)
    expect(t).toMatchObject({ totalInflow: 0, totalSupplierPayments: 400, netTreasury: -400 })
    expectSupplierConsistent(supplier(db), txns(db))
  })
})

describe('تسوية مديونية مورد + إعادة احتساب', () => {
  it('تُقيَّد في الدفتر فتصمد أمام recalculateTotals', () => {
    const { db, repo } = supplierEnv() // 1000

    adjustSupplierDebt('SUP1', { remainingBalance: 600 }, repo)

    expect(txns(db).some(t => t.type === 'تسوية مديونية مورد' && t.credit === 400)).toBe(true)
    expect(supplier(db)).toMatchObject({ paid: 400, remainingBalance: 600 })

    const restated = recalculateTotals(repo)
    expect(restated).toBe(0)
    expect(supplier(db)).toMatchObject({ paid: 400, remainingBalance: 600 })
    expectSupplierConsistent(supplier(db), txns(db))
  })

  it('يسمح برصيد سالب (مستحق لنا) ويصمد أمام إعادة الاحتساب', () => {
    const { db, repo } = supplierEnv()

    adjustSupplierDebt('SUP1', { remainingBalance: -200 }, repo)

    expect(supplier(db)).toMatchObject({ remainingBalance: -200 })
    recalculateTotals(repo)
    expect(supplier(db)).toMatchObject({ remainingBalance: -200 })
    expectSupplierConsistent(supplier(db), txns(db))
  })
})

describe('إعادة احتساب أرصدة الموردين (recalculateTotals)', () => {
  it('يعيد بناء قيد الدفتر الناقص ويطابق الرصيد المخزَّن بالدفتر', () => {
    const { db, repo } = supplierEnv() // دين 1000، بلا مرتجعات
    // سجل مرتجع «ناقص» كُتب بدون قيد الدفتر (محاكاة كتابة جزئية/بيانات قديمة)
    db.addFirestoreDoc(STORAGE_KEYS.SUPPLIER_RETURNS, {
      id: 'SRET-1', supplierId: 'SUP1', supplierName: 'مورد أ',
      items: [{ productId: 'PRD1', quantity: 3, unitCost: 100 }],
      totalValue: 300, refundType: 'debt', debtOffset: 0, cashRefund: 0, excessAsCredit: 300,
      createdAt: '2026-08-02T10:00:00',
    })

    const restated = recalculateTotals(repo)

    expect(restated).toBe(1)
    expect(supplierLedgerNet(txns(db), 'SUP1')).toBe(700)
    expect(supplier(db)).toMatchObject({ remainingBalance: 700, paid: 300 })
    expectSupplierConsistent(supplier(db), txns(db))
  })
})

describe('تحصيل نقدية من مورد مدين لنا (V3.62)', () => {
  it('يرفع الرصيد السالب نحو الصفر ويُحتسب وارد خزينة', () => {
    const { db, repo } = supplierEnv({
      totalPurchases: 1000, remaining: -200, paid: 1200,
      ledger: [{ debit: 1000, credit: 0 }, { debit: 0, credit: 1200 }],
    })

    repo.createPaymentRecord({ entityType: 'supplier', entityId: 'SUP1', entityName: 'مورد أ', amount: 200, date: '2026-08-02', paymentMethod: 'cash', notes: 'تحصيل من المورد', isCollection: true })

    // قيد قبض سالب يُخزَّن: يرفع الرصيد من −200 إلى 0
    const pay = db.getCollection(STORAGE_KEYS.PAYMENTS)[0]
    expect(pay).toMatchObject({ amount: -200, type: 'supplierCollection' })
    expect(supplier(db)).toMatchObject({ paid: 1000, remainingBalance: 0 })
    expect(txns(db).some(t => t.type === 'تحصيل نقدية من المورد' && t.debit === 200)).toBe(true)
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 200, netTreasury: 200 })
    expect(supplierLedgerNet(txns(db), 'SUP1')).toBe(0)
    expectSupplierConsistent(supplier(db), txns(db))
  })
})
