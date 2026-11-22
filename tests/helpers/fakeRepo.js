// Shared in-memory repository for domain-layer unit tests.
// Mirrors the legacy db.js semantics exactly:
//   - addFirestoreDoc prepends (unshift) the doc into the collection cache
//   - updateFirestoreDoc REPLACES the matching doc with { ...old, ...fields }
//   - getCollection returns the live array (updates visible immediately)
// Orchestration methods (createCustomer / updateSupplier / createPaymentRecord /
// decrementProductStock / ...) DELEGATE to the real pure domain modules through
// this repo, so the tests exercise the whole domain layer — not a mock of it.
import { generateAutoId, getCairoFormattedDate, resolveIncrementFields } from '@/utils/formatters'
import { normalizePhone } from '@/utils/phones'
import {
  createPaymentRecord as createPaymentRecordDomain,
  reversePaymentRecord as reversePaymentRecordDomain,
  deletePaymentRecord as deletePaymentRecordDomain,
  updatePaymentRecord as updatePaymentRecordDomain,
} from '@/domain/accounting/payments'
import {
  createCustomer as createCustomerDomain,
  updateCustomer as updateCustomerDomain,
  recalculateCustomerBalance as recalculateCustomerBalanceDomain,
  adjustCustomerDebt as adjustCustomerDebtDomain,
} from '@/domain/customers/customers'
import {
  createSupplier as createSupplierDomain,
  updateSupplier as updateSupplierDomain,
  adjustSupplierDebt as adjustSupplierDebtDomain,
} from '@/domain/suppliers/suppliers'
import {
  createProduct as createProductDomain,
  updateProduct as updateProductDomain,
  decrementProductStock as decrementProductStockDomain,
  incrementProductStock as incrementProductStockDomain,
} from '@/domain/inventory/products'
import { logSupplierTransaction as logSupplierTransactionDomain } from '@/domain/inventory/supplierReturns'

export const STORAGE_KEYS = {
  ORDERS: 'orders',
  CUSTOMERS: 'customers',
  PRODUCTS: 'products',
  SUPPLIERS: 'suppliers',
  PAYMENTS: 'payments',
  EXPENSES: 'expenses',
  SUPPLIER_RETURNS: 'supplier_returns',
  SUPPLIER_TRANSACTIONS: 'supplier_transactions',
}

export function createFakeDb(seed = {}) {
  const cache = new Map()
  Object.keys(STORAGE_KEYS).forEach(k => {
    cache.set(STORAGE_KEYS[k], seed[STORAGE_KEYS[k]] ? seed[STORAGE_KEYS[k]].map(o => ({ ...o })) : [])
  })

  const db = {
    cache,
    getCollection(key) {
      return cache.get(key) || []
    },
    addFirestoreDoc(key, doc) {
      if (!cache.has(key)) cache.set(key, [])
      cache.get(key).unshift({ ...doc })
      return doc
    },
    updateFirestoreDoc(key, id, fields) {
      const list = cache.get(key)
      if (!list) return
      const idx = list.findIndex(item => item.id === id)
      if (idx !== -1) list[idx] = { ...list[idx], ...resolveIncrementFields(list[idx], fields) }
    },
    deleteFirestoreDoc(key, id) {
      if (cache.has(key)) cache.set(key, cache.get(key).filter(item => item.id !== id))
    },
  }
  return db
}

// ── F-10 — atomic WriteBatch emulation (mirrors src/legacy/compat.js withBatchRepo
// + src/services/db.js runAtomicBatch): every write lands in the batch AND is
// applied to the local mirror immediately, so later reads in the same flow see the
// in-flight state. commit() re-applies idempotently and never rejects (production
// queues on cloud error instead of throwing).
function _applyOp(db, op) {
  const { type, collectionKey, docId, data } = op
  if (!db.cache.has(collectionKey)) db.cache.set(collectionKey, [])
  const list = db.cache.get(collectionKey)
  if (type === 'add') {
    const idx = list.findIndex(i => i && i.id === docId)
    if (idx !== -1) list[idx] = { ...data }
    else list.unshift({ ...data })
  } else if (type === 'update') {
    const idx = list.findIndex(i => i && i.id === docId)
    if (idx !== -1) list[idx] = { ...list[idx], ...resolveIncrementFields(list[idx], data) }
  } else if (type === 'delete') {
    db.cache.set(collectionKey, list.filter(i => i && i.id !== docId))
  }
}

// Used by commit(): idempotent re-apply — exactly like db.js/runAtomicBatch. Ops
// already applied to the mirror by withBatchRepo (flagged `_localApplied`) are
// skipped so increment markers are not double-counted AND a later update is not
// clobbered by an earlier add of the same doc.
function _fakeApply(db, op) {
  if (op && op._localApplied) return
  _applyOp(db, op)
}

export function createFakeWriteBatch(db) {
  const ops = []
  return {
    ops,
    add(collectionKey, doc) { ops.push({ type: 'add', collectionKey, docId: doc && doc.id, data: doc }); return this },
    update(collectionKey, id, fields) { ops.push({ type: 'update', collectionKey, docId: id, data: fields }); return this },
    delete(collectionKey, id) { ops.push({ type: 'delete', collectionKey, docId: id }); return this },
    async commit() {
      if (typeof db.__onCommit === 'function') db.__onCommit(ops)
      ops.forEach(op => _fakeApply(db, op))
      return true
    },
  }
}

function withBatchRepo(db, repo, batch) {
  const w = Object.create(repo)
  const markLocal = () => {
    const op = batch.ops[batch.ops.length - 1]
    if (op) op._localApplied = true
  }
  // Delegate the immediate mirror-apply to the BASE repo so any instrumentation
  // (spies that replace repo.updateFirestoreDoc/...) still observes the write,
  // exactly as it would on the non-batch path.
  w.addFirestoreDoc = (key, doc) => { batch.add(key, doc); markLocal(); return repo.addFirestoreDoc(key, doc) }
  w.updateFirestoreDoc = (key, id, fields) => { batch.update(key, id, fields); markLocal(); return repo.updateFirestoreDoc(key, id, fields) }
  w.deleteFirestoreDoc = (key, id) => { batch.delete(key, id); markLocal(); return repo.deleteFirestoreDoc(key, id) }
  w.createCustomer = (data) => createCustomerDomain(data, w)
  w.updateCustomer = (id, fields) => updateCustomerDomain(id, fields, w)
  w.updateSupplier = (id, fields) => updateSupplierDomain(id, fields, w)
  w.createPaymentRecord = (input) => createPaymentRecordDomain(input, w)
  w.logSupplierTransaction = (txn) => logSupplierTransactionDomain(txn, w)
  w.decrementProductStock = (id, qty) => decrementProductStockDomain(id, qty, w)
  w.incrementProductStock = (id, qty) => incrementProductStockDomain(id, qty, w)
  w.recalculateCustomerBalance = (customerId) => recalculateCustomerBalanceDomain(customerId, w)
  return w
}

export function makeRepo(db, { atomic = false } = {}) {
  const repo = {
    storageKeys: STORAGE_KEYS,
    getCollection: (key) => db.getCollection(key),
    addFirestoreDoc: (key, doc) => db.addFirestoreDoc(key, doc),
    updateFirestoreDoc: (key, id, fields) => db.updateFirestoreDoc(key, id, fields),
    deleteFirestoreDoc: (key, id) => db.deleteFirestoreDoc(key, id),

    getOrders: () => db.getCollection(STORAGE_KEYS.ORDERS),
    getOrderById: (id) => db.getCollection(STORAGE_KEYS.ORDERS).find(o => o.id === id) || null,
    getCustomers: () => db.getCollection(STORAGE_KEYS.CUSTOMERS),
    getCustomerById: (id) => db.getCollection(STORAGE_KEYS.CUSTOMERS).find(c => c.id === id) || null,
    getSuppliers: () => db.getCollection(STORAGE_KEYS.SUPPLIERS),
    getSupplierById: (id) => db.getCollection(STORAGE_KEYS.SUPPLIERS).find(s => s.id === id) || null,
    getProducts: () => db.getCollection(STORAGE_KEYS.PRODUCTS),
    getProductById: (id) => db.getCollection(STORAGE_KEYS.PRODUCTS).find(p => p.id === id || p.code === id) || null,
    getPayments: () => db.getCollection(STORAGE_KEYS.PAYMENTS),
    getPaymentsByEntity: (entityType, entityId) =>
      db.getCollection(STORAGE_KEYS.PAYMENTS).filter(p => p.entityType === entityType && p.entityId === entityId),
    getSupplierReturns: () => db.getCollection(STORAGE_KEYS.SUPPLIER_RETURNS),
    getSupplierTransactions: () => db.getCollection(STORAGE_KEYS.SUPPLIER_TRANSACTIONS),
    getSupplierTransactionsBySupplier: (supplierId) =>
      db.getCollection(STORAGE_KEYS.SUPPLIER_TRANSACTIONS).filter(t => t.supplierId === supplierId),

    findCustomerByPhone: (phone) => {
      const norm = normalizePhone(phone)
      if (!norm) return null
      return db.getCollection(STORAGE_KEYS.CUSTOMERS).find(c => {
        const p = c.phone ? normalizePhone(c.phone) : ''
        const s = c.secondaryPhone ? normalizePhone(c.secondaryPhone) : ''
        return (p && p === norm) || (s && s === norm)
      }) || null
    },
    getCustomerAddresses: (customerId) => {
      const c = db.getCollection(STORAGE_KEYS.CUSTOMERS).find(x => x.id === customerId)
      if (!c) return []
      return Array.isArray(c.addresses) ? c.addresses.filter(a => a && a.address && String(a.address).trim()) : []
    },

    createCustomer: (data) => createCustomerDomain(data, repo),
    updateCustomer: (id, fields) => updateCustomerDomain(id, fields, repo),
    adjustCustomerDebt: (id, fields) => adjustCustomerDebtDomain(id, fields, repo),
    createSupplier: (data) => createSupplierDomain(data, repo),
    updateSupplier: (id, fields) => updateSupplierDomain(id, fields, repo),
    adjustSupplierDebt: (id, fields) => adjustSupplierDebtDomain(id, fields, repo),
    createProduct: (input) => createProductDomain(input, repo),
    updateProduct: (id, data) => updateProductDomain(id, data, repo),
    decrementProductStock: (id, qty) => decrementProductStockDomain(id, qty, repo),
    incrementProductStock: (id, qty) => incrementProductStockDomain(id, qty, repo),
    createPaymentRecord: (input) => createPaymentRecordDomain(input, repo),
    reversePaymentRecord: (id) => reversePaymentRecordDomain(id, repo),
    deletePaymentRecord: (id) => deletePaymentRecordDomain(id, repo),
    updatePaymentRecord: (id, changes) => updatePaymentRecordDomain(id, changes, repo),
    logSupplierTransaction: (txn) => logSupplierTransactionDomain(txn, repo),
    recalculateCustomerBalance: (customerId) => recalculateCustomerBalanceDomain(customerId, repo),
  }
  // The WriteBatch surface is OPT-IN (mirrors the non-atomic fallback branch of
  // db.js when createWriteBatch is absent). Only the F-10 failure-safety tests
  // enable it, so the dozens of structural/spy tests keep observing the plain
  // repo.* write path exactly as they did before V3.57.
  if (atomic) enableAtomicWrites(repo, db)
  return repo
}

// F-10 — attach the atomic WriteBatch surface to a repo built WITHOUT it.
export function enableAtomicWrites(repo, db) {
  const database = db || repo.__db
  repo.createWriteBatch = () => createFakeWriteBatch(database)
  repo.withBatch = function (batch) { return withBatchRepo(database, this, batch) }
  return repo
}

export function freshSystem(seed = {}, { atomic = false } = {}) {
  const db = createFakeDb(seed)
  return { db, repo: makeRepo(db, { atomic }) }
}

// F-10 — force the non-atomic fallback: removes the WriteBatch surface so the
// domain takes the reverse+delete/recreate sequence guarded only by the durable
// `reversed` marker (used to test partial-failure handling without atomicity).
export function disableAtomicWrites(repo) {
  repo.createWriteBatch = undefined
  repo.withBatch = undefined
  return repo
}

// Small helpers for building seed docs deterministically.
export function seedProduct({ id = 'PRD1', code = '', name = 'منتج اختباري', category = 'عام', purchasePrice = 100, sellingPrice = 250, stock = 10, minStock = 5, supplierId = '', supplierName = '' } = {}) {
  return { id, code: code || id, name, category, purchasePrice, sellingPrice, stock, minStock, supplierId, supplierName }
}

export function seedSupplier({ id = 'SUP1', name = 'مورد اختبار', phone = '01000000000', secondaryPhone = '', address = '', totalPurchases = 0, paid = 0 } = {}) {
  return { id, name, phone, secondaryPhone, address, notes: '', totalPurchases, paid, remainingBalance: Math.max(0, totalPurchases - paid) }
}

export function seedCustomer({ id = 'CUST1', name = 'عميل اختبار', phone = '01011111111', secondaryPhone = '', category = 'عميل قطاعي / فردي', address = '', addresses, ordersCount = 0, totalPurchases = 0, paid = 0, remainingBalance = 0 } = {}) {
  const addrs = addresses !== undefined ? addresses : (address ? [{ id: 'ADDR-DEFAULT', label: 'العنوان الأساسي', address, isDefault: true }] : [])
  return { id, name, phone, secondaryPhone, category, address, addresses: addrs, notes: '', ordersCount, totalPurchases, paid, remainingBalance, lastOrderDate: null, createdAt: getCairoFormattedDate(), updatedAt: getCairoFormattedDate() }
}

export function autoId(prefix) {
  return generateAutoId(prefix)
}
