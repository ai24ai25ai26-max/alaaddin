// =============================================================================
// سيناريوهات المخزون والمشتريات والمرتجعات — اختبارات تكامل حدّية
// -----------------------------------------------------------------------------
// تغطية مسار البضاعة من الإنشاء/التوريد حتى التعديل والمرتجع والإعادة:
//   • createProduct + ترصيد مديونية المورد عند توريد مخزون.
//   • addStockShipment — التكلفة المرجّحة، مصاريف الشحن/النسريات داخل COGS
//     دون مديونية، سلسلة شحنات، وشحنة بلا مورد، والحالة الحدّية لسعر سالب.
//   • editStockShipment (V3.70) — تعديل الكمية/السعر، إعادة مزج التكلفة، ربط
//     المخزون/المديونية/قيد الدفتر، الحماية من المخزون السالب، القيود القديمة.
//   • createSupplierReturn — مسارات وحدود الاسترداد والثوابت.
//   • recalculateTotals — إعادة الاحتساب ومورّد بلا دفتر.
//   • ضوابط المخزون وحذف المنتج.
// الثابت الحديدي في كل خطوة: رصيد المورد المخزَّن = صافي دفتره = مشترياته − مدفوعه.
// ⚠️ لا يُعدَّل أي كود إنتاجي هنا — التوثيق والتثبيت فقط.
// =============================================================================
import { describe, it, expect } from 'vitest'
import {
  createProduct, addStockShipment, editStockShipment, deleteProduct,
  decrementProductStock, incrementProductStock,
} from '@/domain/inventory/products'
import { createSupplierReturn, recalculateTotals } from '@/domain/inventory/supplierReturns'
import { freshSystem, seedProduct, seedSupplier, STORAGE_KEYS, expectSupplierConsistent, supplierLedgerNet, treasuryReport, profitReport } from './helpers'
import { createOrder, updateOrderStatus } from '@/domain/orders/orderRepository'
import { item, customerInfo } from './helpers'

const products = db => db.getCollection(STORAGE_KEYS.PRODUCTS)
const suppliers = db => db.getCollection(STORAGE_KEYS.SUPPLIERS)
const txns = db => db.getCollection(STORAGE_KEYS.SUPPLIER_TRANSACTIONS)
const returns = db => db.getCollection(STORAGE_KEYS.SUPPLIER_RETURNS)
const sup = db => suppliers(db)[0]
const prod = db => products(db)[0]

function ledger({ id = 'SUPLOG-1', supplierId = 'SUP1', type = 'شحنة توريد', refId = 'PRD1', debit = 0, credit = 0, qty, unitCost, note = '', createdAt = '2026-08-01T10:00:00' } = {}) {
  const t = { id, supplierId, type, refId, debit, credit, note, createdAt }
  if (qty !== undefined) t.qty = qty
  if (unitCost !== undefined) t.unitCost = unitCost
  return t
}

function env({ stock = 0, purchasePrice = 0, supplier = null, ledgerTxns = [] } = {}) {
  return freshSystem({
    [STORAGE_KEYS.PRODUCTS]: [seedProduct({ id: 'PRD1', name: 'منتج أ', stock, purchasePrice, sellingPrice: 250, supplierId: 'SUP1', supplierName: 'مورد أ' })],
    [STORAGE_KEYS.SUPPLIERS]: [supplier || seedSupplier({ id: 'SUP1', name: 'مورد أ' })],
    [STORAGE_KEYS.SUPPLIER_TRANSACTIONS]: ledgerTxns,
  })
}

const supplierWithDebt = ({ totalPurchases = 1000, paid = 0 } = {}) => ({
  id: 'SUP1', name: 'مورد أ', phone: '01000000000', secondaryPhone: '', address: '', notes: '',
  totalPurchases, paid, remainingBalance: totalPurchases - paid, createdAt: '2026-08-01', updatedAt: '2026-08-01',
})

/* ===================== شحنة التوريد ===================== */

describe('شحنة التوريد — مخزون وتكلفة مرجّحة ومديونية', () => {
  it('سلسلة شحنتين تبني تكلفة متوسط مرجّح وترصّن دفتر المورد', () => {
    const { db, repo } = env()
    addStockShipment('PRD1', 10, 'SUP1', 100, '', {}, repo)
    addStockShipment('PRD1', 10, 'SUP1', 200, '', { shippingCost: 100 }, repo)

    // (0×0 + 10×100 + 0)/10 = 100 ثم (10×100 + 10×200 + 100)/20 = 155
    expect(prod(db)).toMatchObject({ stock: 20, purchasePrice: 155, shipmentExtrasTotal: 100 })
    expect(sup(db)).toMatchObject({ totalPurchases: 3000, remainingBalance: 3000, paid: 0 })
    expect(supplierLedgerNet(txns(db), 'SUP1')).toBe(3000)
    expectSupplierConsistent(sup(db), txns(db))
    // لا أثر على الخزينة ولا على صافي الربح (تكلفة مخزون لا مصروف)
    expect(treasuryReport(db)).toMatchObject({ totalInflow: 0, netTreasury: 0 })
    expect(profitReport(db).netProfit).toBe(0)
  })

  it('شحنة بلا مورد ترفع المخزون بإعادة تقييم قديمة دون أي مديونية أو حركة', () => {
    const { db, repo } = env({ stock: 10, purchasePrice: 100 })
    addStockShipment('PRD1', 5, '', 0, '', {}, repo)

    // purPrice = 0 يُستبدل بالتكلفة الحالية 100 → (10×100 + 5×100)/15 = 100
    expect(prod(db)).toMatchObject({ stock: 15, purchasePrice: 100 })
    expect(sup(db)).toMatchObject({ totalPurchases: 0, remainingBalance: 0 })
    expect(txns(db)).toHaveLength(0)
    expectSupplierConsistent(sup(db), txns(db))
  })

  it('مصاريف الشحن/النسريات تدخل COGS بالكامل ولا تدخل مديونية المورد', () => {
    const { db, repo } = env({ stock: 10, purchasePrice: 100 })
    addStockShipment('PRD1', 10, 'SUP1', 100, '', { shippingCost: 50, suppliesCost: 30 }, repo)

    // (10×100 + 10×100 + 80)/20 = 104
    expect(prod(db)).toMatchObject({ stock: 20, purchasePrice: 104, shipmentExtrasTotal: 80 })
    expect(sup(db).remainingBalance).toBe(1000)
    const txn = txns(db)[0]
    expect(txn).toMatchObject({ type: 'شحنة توريد', debit: 1000, qty: 10, unitCost: 100 })
    expectSupplierConsistent(sup(db), txns(db))
  })

  it.fails('سعر شراء سالب يجب أن يُرفض (السلوك الحالي: يُتجاهَل بصمت)', () => {
    const { repo } = env({ stock: 10, purchasePrice: 100 })
    expect(() => addStockShipment('PRD1', 5, 'SUP1', -50, '', {}, repo)).toThrow()
  })

  it('يرفض كمية تساوي صفراً أو مصاريف سالبة', () => {
    const { repo } = env({ stock: 10, purchasePrice: 100 })
    expect(() => addStockShipment('PRD1', 0, 'SUP1', 100, '', {}, repo)).toThrow(/كمية شحنة صحيحة/)
    expect(() => addStockShipment('PRD1', 5, 'SUP1', 100, '', { shippingCost: -1 }, repo)).toThrow(/غير صالحة/)
  })
})

/* ===================== تعديل شحنة التوريد (V3.70) ===================== */

describe('تعديل شحنة التوريد editStockShipment (V3.70)', () => {
  it('زيادة الكمية ترفع المخزون والدين وتحدّث نفس قيد الدفتر', () => {
    const { db, repo } = env({ stock: 10, purchasePrice: 100, supplier: supplierWithDebt(), ledgerTxns: [ledger({ debit: 1000, qty: 10, unitCost: 100 })] })

    const res = editStockShipment('SUPLOG-1', { qty: 12, unitCost: 100 }, repo)

    expect(res).toMatchObject({ oldQty: 10, newQty: 12, oldUnitCost: 100, newUnitCost: 100, debtDelta: 200, newAvg: 100, newStock: 12 })
    expect(prod(db)).toMatchObject({ stock: 12, purchasePrice: 100 })
    expect(sup(db)).toMatchObject({ totalPurchases: 1200, remainingBalance: 1200 })
    expect(txns(db)).toHaveLength(1)
    expect(txns(db)[0]).toMatchObject({ id: 'SUPLOG-1', qty: 12, debit: 1200 })
    expect(txns(db)[0].note).toContain('تعديل')
    expectSupplierConsistent(sup(db), txns(db))
  })

  it('تخفيض الكمية مع رفع السعر يعيد مزج التكلفة ويضبط صافي الدين', () => {
    const { db, repo } = env({ stock: 10, purchasePrice: 100, supplier: supplierWithDebt(), ledgerTxns: [ledger({ debit: 1000, qty: 10, unitCost: 100 })] })

    // oldGoods = 10×100 = 1000، newDebit = 8×150 = 1200 → (10×100 − 1000 + 1200)/8 = 150
    const res = editStockShipment('SUPLOG-1', { qty: 8, unitCost: 150 }, repo)

    expect(res).toMatchObject({ newStock: 8, newUnitCost: 150, debtDelta: 200, newAvg: 150 })
    expect(prod(db)).toMatchObject({ stock: 8, purchasePrice: 150 })
    expect(sup(db)).toMatchObject({ totalPurchases: 1200, remainingBalance: 1200 })
    expect(txns(db)[0]).toMatchObject({ debit: 1200, qty: 8, unitCost: 150 })
    expectSupplierConsistent(sup(db), txns(db))
  })

  it('يسمح بتعديل قيد «تسجيل منتج ومخزون»', () => {
    const { db, repo } = env({ stock: 5, purchasePrice: 100, supplier: supplierWithDebt({ totalPurchases: 500 }), ledgerTxns: [ledger({ type: 'تسجيل منتج ومخزون', debit: 500, qty: 5, unitCost: 100 })] })
    const res = editStockShipment('SUPLOG-1', { qty: 6, unitCost: 100 }, repo)
    expect(res).toMatchObject({ newStock: 6, debtDelta: 100, newAvg: 100 })
    expect(sup(db)).toMatchObject({ totalPurchases: 600, remainingBalance: 600 })
    expectSupplierConsistent(sup(db), txns(db))
  })

  it('يدعم القيود القديمة بلا حقلي الكمية/السعر عبر تحليل البيان', () => {
    const { db, repo } = env({
      stock: 3, purchasePrice: 100, supplier: supplierWithDebt({ totalPurchases: 300 }),
      ledgerTxns: [ledger({ debit: 300, note: 'إضافة منتج "قماش" للمخزون (3 قطعة × 100)' })],
    })
    const res = editStockShipment('SUPLOG-1', { qty: 5, unitCost: 100 }, repo)
    expect(res).toMatchObject({ oldQty: 3, oldUnitCost: 100, newStock: 5, debtDelta: 200, newAvg: 100 })
    expect(sup(db)).toMatchObject({ totalPurchases: 500, remainingBalance: 500 })
    expectSupplierConsistent(sup(db), txns(db))
  })

  it('يرفض كمية/سعراً غير صالحين ونوع قيد غير قابل للتعديل وقيداً مفقوداً دون تغيير الحالة', () => {
    const { db, repo } = env({
      stock: 10, purchasePrice: 100, supplier: supplierWithDebt(),
      ledgerTxns: [ledger({ debit: 1000, qty: 10, unitCost: 100 }), ledger({ id: 'T-PAY', type: 'تسديد دفعة', debit: 0, credit: 0 })],
    })
    expect(() => editStockShipment('SUPLOG-1', { qty: 0, unitCost: 100 }, repo)).toThrow(/أكبر من الصفر/)
    expect(() => editStockShipment('SUPLOG-1', { qty: 5, unitCost: -1 }, repo)).toThrow(/سعر شراء صحيح/)
    expect(() => editStockShipment('T-PAY', { qty: 5, unitCost: 100 }, repo)).toThrow(/ليس شحنة توريد/)
    expect(() => editStockShipment('NOPE', { qty: 5, unitCost: 100 }, repo)).toThrow(/لم يتم العثور/)
    expect(prod(db)).toMatchObject({ stock: 10, purchasePrice: 100 })
    expect(sup(db)).toMatchObject({ totalPurchases: 1000, remainingBalance: 1000 })
  })

  it('يمنع تقليل الكمية إن صار المخزون الناتج سالباً (بضاعة بيعت)', () => {
    // المخزون الحالي 2 فقط بينما القيد 10 → أي تخفيض دون 8 يجعل المخزون سالباً
    const { db, repo } = env({ stock: 2, purchasePrice: 100, supplier: supplierWithDebt(), ledgerTxns: [ledger({ debit: 1000, qty: 10, unitCost: 100 })] })
    expect(() => editStockShipment('SUPLOG-1', { qty: 2, unitCost: 100 }, repo)).toThrow(/المخزون الناتج سالب/)
    expect(prod(db)).toMatchObject({ stock: 2, purchasePrice: 100 })
    expect(txns(db)[0]).toMatchObject({ qty: 10, debit: 1000 })
    expect(sup(db)).toMatchObject({ totalPurchases: 1000, remainingBalance: 1000 })
  })
})

/* ===================== عيب موثَّق: إعادة مزج التكلفة عند بيع جزء من الشحنة ===================== */
// editStockShipment يطرح كامل قيمة البضاعة الأصلية (oldQty × oldUnitCost) من قيمة
// المخزون الحالي، بينما المخزون الحالي قد يكون أقل بكثير (بيع جزء). فتصبح إعادة
// المزج خاطئة: تهبط بالتكلفة إلى الصفر أو تضخّمها. الصيغة الصحيحة يجب أن تطرح فقط
// نصيب الوحدات المتبقية. الاختبارات التالية تُثبّت العيب (it.fails) دون إصلاحه.

describe('editStockShipment — إعادة مزج التكلفة مع بيع جزء من الشحنة (عيب موثَّق)', () => {
  const partialSold = () => env({
    stock: 2, purchasePrice: 100, supplier: supplierWithDebt(),
    ledgerTxns: [ledger({ debit: 1000, qty: 10, unitCost: 100 })], // بيع 8 من أصل 10، تبقّى 2
  })

  it.fails('خفض سعر الشحنة يجب أن يعطي تكلفة الوحدتين المتبقيتين = 50 (الفعلي: 0)', () => {
    const { repo } = partialSold()
    const res = editStockShipment('SUPLOG-1', { qty: 10, unitCost: 50 }, repo)
    expect(res.newAvg).toBe(50)
  })

  it.fails('رفع سعر الشحنة يجب أن يعطي تكلفة الوحدتين المتبقيتين = 200 (الفعلي: 600)', () => {
    const { repo } = partialSold()
    const res = editStockShipment('SUPLOG-1', { qty: 10, unitCost: 200 }, repo)
    expect(res.newAvg).toBe(200)
  })
})

/* ===================== مرتجع المشتريات ===================== */

describe('مرتجع المشتريات — مسار كامل وحدود', () => {
  it('مرتجع متعدد المنتجات يخصم المخزون والدين ويحافظ على ثابت المورد', async () => {
    const { db, repo } = freshSystem({
      [STORAGE_KEYS.PRODUCTS]: [
        seedProduct({ id: 'PRD1', name: 'أ', stock: 10, purchasePrice: 100, supplierId: 'SUP1', supplierName: 'مورد أ' }),
        seedProduct({ id: 'PRD2', name: 'ب', stock: 10, purchasePrice: 100, supplierId: 'SUP1', supplierName: 'مورد أ' }),
      ],
      [STORAGE_KEYS.SUPPLIERS]: [supplierWithDebt({ totalPurchases: 2000 })],
      [STORAGE_KEYS.SUPPLIER_TRANSACTIONS]: [{ id: 'L1', supplierId: 'SUP1', type: 'تسجيل منتج ومخزون', refId: 'PRD1', debit: 2000, credit: 0, createdAt: '2026-08-01' }],
    })

    const rec = await createSupplierReturn({ supplierId: 'SUP1', items: [{ productId: 'PRD1', quantity: 2, unitCost: 100 }, { productId: 'PRD2', quantity: 3, unitCost: 100 }] }, repo)

    expect(rec).toMatchObject({ totalValue: 500, refundType: 'debt', debtOffset: 500, cashRefund: 0 })
    expect(products(db).find(p => p.id === 'PRD1').stock).toBe(8)
    expect(products(db).find(p => p.id === 'PRD2').stock).toBe(7)
    expect(sup(db)).toMatchObject({ totalPurchases: 1500, remainingBalance: 1500 })
    expect(returns(db)).toHaveLength(1)
    expectSupplierConsistent(sup(db), txns(db))
  })

  it('يرفض قيمة مرتجع صفر وكمية تتجاوز المخزون وبنوداً بلا كمية', async () => {
    const { db, repo } = env({ stock: 10, purchasePrice: 100 })
    await expect(createSupplierReturn({ supplierId: 'SUP1', items: [{ productId: 'PRD1', quantity: 2, unitCost: 0 }] }, repo)).rejects.toThrow(/أكبر من الصفر/)
    await expect(createSupplierReturn({ supplierId: 'SUP1', items: [{ productId: 'PRD1', quantity: 11, unitCost: 100 }] }, repo)).rejects.toThrow(/المخزون الحالي/)
    await expect(createSupplierReturn({ supplierId: 'SUP1', items: [{ productId: 'PRD1', quantity: 0, unitCost: 100 }] }, repo)).rejects.toThrow(/منتج واحد على الأقل/)
    expect(returns(db)).toHaveLength(0)
    expect(prod(db).stock).toBe(10)
    expectSupplierConsistent(sup(db), txns(db))
  })

  it('مرتجع بكامل المخزون يصفر المخزون والدين دون كسر الثوابت', async () => {
    const { db, repo } = env({ stock: 10, purchasePrice: 100, supplier: supplierWithDebt(), ledgerTxns: [ledger({ debit: 1000, qty: 10, unitCost: 100 })] })
    await createSupplierReturn({ supplierId: 'SUP1', items: [{ productId: 'PRD1', quantity: 10, unitCost: 100 }] }, repo)
    expect(prod(db).stock).toBe(0)
    expect(sup(db)).toMatchObject({ totalPurchases: 0, remainingBalance: 0, paid: 0 })
    expect(supplierLedgerNet(txns(db), 'SUP1')).toBe(0)
    expectSupplierConsistent(sup(db), txns(db))
  })

  it('recalculateTotals بعد مرتجع حقيقي لا يعيد أي ترميم ويحافظ على الأرصدة', async () => {
    const { db, repo } = env({ stock: 10, purchasePrice: 100, supplier: supplierWithDebt(), ledgerTxns: [ledger({ debit: 1000, qty: 10, unitCost: 100 })] })
    await createSupplierReturn({ supplierId: 'SUP1', items: [{ productId: 'PRD1', quantity: 2, unitCost: 100 }] }, repo)
    expect(recalculateTotals(repo)).toBe(0)
    expect(sup(db)).toMatchObject({ totalPurchases: 800, remainingBalance: 800 })
    expectSupplierConsistent(sup(db), txns(db))
  })
})

/* ===================== إعادة احتساب أرصدة الموردين ===================== */

describe('recalculateTotals — مورد بلا حركات دفتر', () => {
  it('يتخطى مورداً بلا أي قيد فلا يصفّر رصيده المخزَّن (توثيق سلوك حالي)', () => {
    const { db, repo } = env({ stock: 5, purchasePrice: 100, supplier: supplierWithDebt({ totalPurchases: 500 }) })
    expect(txns(db)).toHaveLength(0)
    expect(recalculateTotals(repo)).toBe(0)
    // لا يوجد دفتر لإعادة البناء منه → الرصيد المخزَّن يبقى كما هو
    expect(sup(db)).toMatchObject({ totalPurchases: 500, remainingBalance: 500 })
  })
})

/* ===================== ضوابط المخزون ===================== */

describe('ضوابط المخزون الحدّية', () => {
  it('خصم أكثر من المتاح يُحصَر عند صفر ويُبلّغ عن العجز', () => {
    const { db, repo } = env({ stock: 3, purchasePrice: 100 })
    expect(decrementProductStock('PRD1', 10, repo)).toEqual({ consumedQty: 3, deficitQty: 7 })
    expect(prod(db).stock).toBe(0)
  })

  it('خصم كمية كسرية لا يجعل المخزون سالباً', () => {
    const { db, repo } = env({ stock: 3, purchasePrice: 100 })
    expect(decrementProductStock('PRD1', 2.5, repo)).toEqual({ consumedQty: 2.5, deficitQty: 0 })
    expect(prod(db).stock).toBe(0.5)
  })

  it('زيادة مخزون منتج غير موجود لا ترمي ولا تُنشئ شيئاً', () => {
    const { db, repo } = env({ stock: 1, purchasePrice: 100 })
    expect(() => incrementProductStock('NOPE', 5, repo)).not.toThrow()
    expect(products(db)).toHaveLength(1)
    expect(prod(db).stock).toBe(1)
  })
})

/* ===================== حذف المنتج — حماية السلامة المالية ===================== */

describe('حذف المنتج — حماية التكامل عبر مسار طلب حقيقي', () => {
  it('يمنع حذف منتج مرتبط بطلب نشط ويسمح به بعد إرجاع الطلب', async () => {
    const { db, repo } = env({ stock: 0, purchasePrice: 100 })
    await createOrder({ customerInfo: customerInfo({ phone: '01099988877' }), items: [item({ quantity: 3, sellingPrice: 250, purchasePrice: 100 })], downPayment: 0, status: 'delivered' }, repo)

    await expect(deleteProduct('PRD1', repo)).rejects.toThrow(/طلبات قائمة/)

    await updateOrderStatus(db.getCollection(STORAGE_KEYS.ORDERS)[0].id, 'returned', 0, 0, repo)
    await deleteProduct('PRD1', repo)
    expect(products(db)).toHaveLength(0)
  })

  it('الحذف بالكود (SKU) لا يحذف المنتج فعلياً (توثيق سلوك حالي — يُفضَّل الحذف بالمعرّف)', async () => {
    const { db, repo } = freshSystem({
      [STORAGE_KEYS.PRODUCTS]: [seedProduct({ id: 'PRD1', code: 'SKU-1', stock: 0, purchasePrice: 100 })],
    })
    // getProductById يجد بالكود، لكن deleteFirestoreDoc يطابق الحقل id فقط → لا حذف
    await deleteProduct('SKU-1', repo)
    expect(products(db)).toHaveLength(1)
    expect(products(db)[0].id).toBe('PRD1')
  })
})

/* ===================== تسجيل منتج ومخزون عند الإنشاء ===================== */

describe('createProduct — ترصين مديونية المورد عند التسجيل', () => {
  it('منتج بمخزون ومورد يسجّل قيد دين ويحافظ على الثابت', () => {
    const { db, repo } = env()
    createProduct({ name: 'قماش', code: 'FAB-1', purchasePrice: 100, sellingPrice: 150, stock: 5, supplierId: 'SUP1', supplierName: 'مورد أ' }, repo)
    expect(sup(db)).toMatchObject({ totalPurchases: 500, remainingBalance: 500, paid: 0 })
    expect(supplierLedgerNet(txns(db), 'SUP1')).toBe(500)
    expectSupplierConsistent(sup(db), txns(db))
  })

  it('مورد غير موجود في القائمة لا يُنشئ أي مديونية (مخزون بلا دين)', () => {
    const { db, repo } = env()
    createProduct({ name: 'قماش', code: 'FAB-2', purchasePrice: 100, sellingPrice: 150, stock: 5, supplierId: 'GHOST', supplierName: 'وهمي' }, repo)
    expect(sup(db)).toMatchObject({ totalPurchases: 0, remainingBalance: 0 })
    expect(txns(db)).toHaveLength(0)
  })
})
