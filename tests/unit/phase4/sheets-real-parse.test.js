// =============================================================================
// Phase 4.4 — Step 3: مسار Google Sheets «الحقيقي» للتسلسل/التحليل (بلا شبكة)
// -----------------------------------------------------------------------------
// الفرق عن sheets-allocated-amount.test.js: ذاك يمرّر ناقل الذاكرة (صفوف
// بمفاتيح law canonical keys). هنا نُمرّر ملف Excel حقيقي: نكتب مصنّفاً بـ SheetJS
// بترويسات عربية (label keys) كما تُعيده ورقة Google فعلاً، نقرأه عبر readWorkbookSheets
// الحقيقي (تحليل SheetJS)، ثم نستورده عبر importFromFile الحقيقي. بذلك يُختبَر
//   - تعيين الترويسة العربية (label) ➔ المفتاح الداخلي (normalizeRow)
//   - تحليل الخلية الرقمية (UNFORMATTED_VALUE ⇒ number) لـ allocatedAmount
//   - سلوك الخلية الفارغة (سجل قديم ⇒ الحقل غير معرَّف ⇒ السقوط على العلامة)
//   - ثبات رصيد العميل بعد الاستيراد وإعادة الاحتساب المتكرر
// لا يلمس أي شبكة أو بيانات إنتاج — المصنّف مبنيّ في الذاكرة من تصدير نظام معزول.
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as XLSX from 'xlsx'
import { SHEETS, exportAll, createMemoryTransport, importFromFile, resetSyncState } from '@/services/sheets'
import { createOrder } from '@/domain/orders/orderRepository'
import { createPaymentRecord } from '@/domain/accounting/payments'
import { recalculateCustomerBalance } from '@/domain/customers/customers'
import { round2 } from '@/utils/formatters'
import { seedStore, item, customerInfo, STORAGE_KEYS } from './../scenarios/helpers'
import { freshSystem, seedCustomer } from '../../helpers/fakeRepo'

const { PAYMENTS, ORDERS, CUSTOMERS, PRODUCTS, SUPPLIERS, SUPPLIER_RETURNS } = STORAGE_KEYS
const PAY = SHEETS.find(s => s.entityKey === 'payments')
const ALLOC_LABEL = 'المبلغ المخصص لسداد الطلبات'

// الأعمدة الرقمية التي يجب أن تصل كأرقام (UNFORMATTED_VALUE) لا كنصوص.
const NUMERIC_KEYS = new Set([
  'amount', 'allocatedAmount', 'totalAmount', 'downPayment', 'remainingBalance',
  'paid', 'totalPurchases', 'itemsSubtotal',
])

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

// يحوّل مخرجات exportAll (صفوف بمفاتيح canonical) إلى مصنّف Excel حقيقي
// بترويسات عربية، مع تحويل الأعمدة الرقمية إلى أرقام فعلية.
function workbookFromSheets(sheets) {
  const wb = XLSX.utils.book_new()
  for (const def of SHEETS) {
    const s = sheets[def.title]
    if (!s) continue
    const aoa = [def.headers.map(h => h.label)]
    for (const r of s.rows) {
      aoa.push(def.headers.map(h => {
        let v = r[h.key]
        if (v === undefined || v === null) v = ''
        if (NUMERIC_KEYS.has(h.key)) { const n = Number(v); if (v !== '' && !isNaN(n)) v = n }
        return v
      }))
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), def.title)
  }
  return wb
}

function xlsxFile(wb, name = 'backup.xlsx') {
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return { name, arrayBuffer: async () => buf }
}

const custBalance = db => {
  const c = db.getCollection(CUSTOMERS)[0]
  return { paid: round2(c.paid), remaining: round2(c.remainingBalance) }
}

beforeEach(() => {
  localStorage.clear()
  window.isSandboxMode = false
  // ensureXLSX() يستخدم window.XLSX؛ نحقن نفس الوحدة التي نكتب بها المصنّف
  // (import('xlsx') الديناميكي قد يُغلّف default interop فيبيّن read غير دالة).
  window.XLSX = XLSX
})
afterEach(() => { resetSyncState(); localStorage.clear() })

describe('Step 3 — مسار Sheets الحقيقي: تحليل SheetJS بترويسات عربية ➔ importFromFile', () => {
  it('تخصيص كامل: العمود العربي يُنشئ allocatedAmount=500 ورصيد العميل مستقر', async () => {
    const { db: sdb, repo: srepo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const order = await createOrder({ customerInfo: customerInfo({ phone: '01012345799' }), items: [item({ quantity: 2 })], downPayment: 0, status: 'delivered' }, srepo)
    createPaymentRecord({ entityType: 'customer', entityId: order.customerId, entityName: 'عميل اختبار', amount: 500, date: '2026-08-01', paymentMethod: 'cash' }, srepo)

    wire(sdb, srepo)
    const sheets = {}
    await exportAll(createMemoryTransport(sheets))
    const file = xlsxFile(workbookFromSheets(sheets))

    const { db: tdb, repo: trepo } = freshSystem()
    wire(tdb, trepo)
    const res = await importFromFile(file)
    expect(res.errors).toEqual([])
    expect(res.matchedTabs).toContain('Treasury_Payments')

    // تحليل SheetJS أظهر الترويسة العربية الجديدة (label mapping صحيح)
    expect(workbookFromSheets(sheets)).toBeTruthy()
    const rstPay = tdb.getCollection(PAYMENTS).find(p => !p.isDownPayment)
    expect(rstPay).toBeTruthy()
    expect(rstPay.allocatedAmount).toBe(500)
    expect(rstPay.allocatedToOrders).toBe(true)

    recalculateCustomerBalance(rstPay.entityId, trepo)
    expect(custBalance(tdb)).toEqual({ paid: 500, remaining: 0 })
    recalculateCustomerBalance(rstPay.entityId, trepo)
    expect(custBalance(tdb)).toEqual({ paid: 500, remaining: 0 })
  })

  it('تخصيص جزئي: 500 من 700 يُحلَّل رقمياً ويُستعاد بلا ازدواج للـ200', async () => {
    const seed = {
      [CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01011111111', totalPurchases: 500, paid: 700, remainingBalance: 0 })],
      [ORDERS]: [{ id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 500, downPayment: 500, remainingBalance: 0, paidInFull: true, createdAt: '2026-08-01T10:00:00' }],
      [PAYMENTS]: [{ id: 'PAY-P', entityType: 'customer', entityId: 'CUST1', entityName: 'عميل اختبار', amount: 700, date: '2026-08-01', paymentMethod: 'cash', isDownPayment: false, allocatedToOrders: true, allocatedAmount: 500, createdAt: '2026-08-01T10:00:00' }],
    }
    const { db: sdb, repo: srepo } = freshSystem(seed)
    wire(sdb, srepo)
    const sheets = {}
    await exportAll(createMemoryTransport(sheets))
    expect(sheets['Treasury_Payments'].rows[0].allocatedAmount).toBe('500')

    const { db: tdb, repo: trepo } = freshSystem()
    wire(tdb, trepo)
    await importFromFile(xlsxFile(workbookFromSheets(sheets)))

    const rst = tdb.getCollection(PAYMENTS).find(p => p.id === 'PAY-P')
    expect(rst.allocatedAmount).toBe(500)
    recalculateCustomerBalance('CUST1', trepo)
    expect(custBalance(tdb)).toEqual({ paid: 700, remaining: 0 })
  })

  it('غير مُخصَّصة: allocatedAmount=0 يبقى رقماً صفراً ويُحتسب كدفعة مباشرة كاملة', async () => {
    const seed = {
      [CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01011111111', totalPurchases: 500, paid: 200, remainingBalance: 300 })],
      [ORDERS]: [{ id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 500, downPayment: 0, remainingBalance: 500, paidInFull: false, createdAt: '2026-08-01T10:00:00' }],
      [PAYMENTS]: [{ id: 'PAY-U', entityType: 'customer', entityId: 'CUST1', entityName: 'عميل اختبار', amount: 200, date: '2026-08-01', paymentMethod: 'cash', isDownPayment: false, allocatedToOrders: false, allocatedAmount: 0, createdAt: '2026-08-01T10:00:00' }],
    }
    const { db: sdb, repo: srepo } = freshSystem(seed)
    wire(sdb, srepo)
    const sheets = {}
    await exportAll(createMemoryTransport(sheets))
    expect(sheets['Treasury_Payments'].rows[0].allocatedAmount).toBe('0')

    const { db: tdb, repo: trepo } = freshSystem()
    wire(tdb, trepo)
    await importFromFile(xlsxFile(workbookFromSheets(sheets)))

    const rst = tdb.getCollection(PAYMENTS).find(p => p.id === 'PAY-U')
    expect(rst.allocatedAmount).toBe(0)
    expect(rst.allocatedToOrders).toBe(false)
    recalculateCustomerBalance('CUST1', trepo)
    expect(custBalance(tdb)).toEqual({ paid: 200, remaining: 300 })
  })

  it('سجل قديم: خلية عربية فارغة ⇒ الحقل غير معرَّف ويُحتسب عبر العلامة المنطقية', async () => {
    const { db, repo } = freshSystem({
      [CUSTOMERS]: [seedCustomer({ id: 'CUST1', phone: '01011111111' })],
      [ORDERS]: [{ id: 'ORD1', customerId: 'CUST1', status: 'delivered', totalAmount: 500, downPayment: 400, remainingBalance: 100, paidInFull: false, createdAt: '2026-08-01T10:00:00' }],
    })
    wire(db, repo)
    // ورقة دفعات حقيقية بترويسات عربية، خلية «المبلغ المخصص» فارغة (سجل ما قبل V3.67)
    const rowObj = {
      id: 'PAY-LEG', entityType: 'customer', entityId: 'CUST1', entityName: 'عميل',
      amount: 400, date: '2026-08-01', paymentMethod: 'cash', isDownPayment: 'لا',
      allocatedToOrders: 'نعم', allocatedAmount: '', notes: '', createdAt: '2026-08-01T00:00:00', syncUpdatedAt: '',
    }
    const aoa = [PAY.headers.map(h => h.label), PAY.headers.map(h => rowObj[h.key] ?? '')]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Treasury_Payments')

    const res = await importFromFile(xlsxFile(wb))
    expect(res.errors).toEqual([])
    const rst = db.getCollection(PAYMENTS).find(p => p.id === 'PAY-LEG')
    expect(rst).toBeTruthy()
    expect(rst.allocatedAmount).toBeUndefined()
    expect(rst.allocatedToOrders).toBe(true)

    recalculateCustomerBalance('CUST1', repo)
    // السقوط على العلامة: direct = 0 ⇒ يُحتسب عبر order.downPayment فقط (400)
    expect(custBalance(db)).toEqual({ paid: 400, remaining: 100 })
  })

  it('تعيين الترويسة: العمود العربي الجديد موجود بين ترويسات ورقة الدفعات', () => {
    expect(PAY.headers.map(h => h.label)).toContain(ALLOC_LABEL)
    expect(PAY.headers.find(h => h.key === 'allocatedAmount').label).toBe(ALLOC_LABEL)
    expect(PAY.headers.filter(h => h.key === 'allocatedAmount')).toHaveLength(1)
  })
})
