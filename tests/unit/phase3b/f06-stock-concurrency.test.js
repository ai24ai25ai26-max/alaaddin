// =============================================================================
// Phase 3B — F-06 — تزامن تحديث المخزون: كتابة مطلقة مقابل increment
// -----------------------------------------------------------------------------
// verify-only. قسمان:
//   (أ) بنيوي: يلتقط نوع الكتابة الفعلي لكل مسار (marker __inc أم قيمة مطلقة).
//   (ب) حتمي: يفبرك ترتيب قراءة/كتابة لعمليتين متزامنتين عبر fakeRepo.
// ⚠️ الحدّ: fakeRepo ذاكرة وهمية أحادية المؤشر؛ النتيجة تُثبت منطق الفقدان عند
//    هذا الترتيب ولا تُثبت وقوعه في طبقة Firestore الحقيقية (تحتاج emulator/شبكة).
// =============================================================================
import { describe, it, expect } from 'vitest'
import { addStockShipment, editStockShipment, decrementProductStock, incrementProductStock } from '@/domain/inventory/products'
import { seedStore, STORAGE_KEYS } from './../scenarios/helpers'

describe('F-06 — كتابة المخزون المطلقة في مسار الشحنة (fakeRepo)', () => {
  it('مرجع: عمليات increment تتراكم دون فقدان (10 − 3 + 5 = 12)', () => {
    const { repo } = seedStore({ productOver: { id: 'PRD1', stock: 10 } })
    decrementProductStock('PRD1', 3, repo)
    incrementProductStock('PRD1', 5, repo)
    expect(Number(repo.getProductById('PRD1').stock)).toBe(12)
  })

  it('بنية: خصم البيع → {__inc:…} (increment) بينما الشحنة → قيمة مطلقة (رقم)', () => {
    const { repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })
    const writes = []
    const spyRepo = {
      ...repo,
      storageKeys: repo.storageKeys,
      getProducts: () => repo.getProducts(),
      getSuppliers: () => repo.getSuppliers(),
      updateFirestoreDoc: (key, id, fields) => {
        if (key === STORAGE_KEYS.PRODUCTS && 'stock' in fields) writes.push(fields.stock)
        repo.updateFirestoreDoc(key, id, fields)
      },
    }
    decrementProductStock('PRD1', 2, spyRepo)     // increment
    addStockShipment('PRD1', 3, '', 0, '', {}, spyRepo) // absolute

    expect(writes[0]).toMatchObject({ __inc: -2 })      // البيع آمن (marker)
    expect(typeof writes[1]).toBe('number')              // الشحنة تكتب قيمة مطلقة
    expect(writes[1]).toBe(11)                           // 10 − 2 + 3
  })

  it('حتمي: بيع متزامن (increment) ثم شحنة قرأت رصيداً قديماً فطمست البيع', () => {
    const { repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 } })

    // 1) بيع يُخصم فعلاً عبر increment: 10 → 7
    decrementProductStock('PRD1', 3, repo)
    expect(Number(repo.getProductById('PRD1').stock)).toBe(7)

    // 2) شحنة كانت قد قرأت الرصيد القديم (10) قبل البيع، ثم تكتب 10+5=15 بقيمة مطلقة
    const stale = { ...repo.getProductById('PRD1'), stock: 10 }
    const racyRepo = { ...repo, getProducts: () => [stale] }
    addStockShipment('PRD1', 5, '', 100, '', {}, racyRepo)

    const finalStock = Number(repo.getProductById('PRD1').stock)
    console.log('\n[F-06 race] final=' + finalStock + ' expected=12 surplus=' + (finalStock - 12))
    expect(finalStock).toBe(15)   // 👈 الفعلي: 15 (طُمس خصم البيع −3)
    expect(finalStock - 12).toBe(3) // مقدار التحديث المفقود (البيع فقد تأثيره)
  })

  it('بنية: editStockShipment يكتب أيضاً قيمة مطلقة للمخزون', () => {
    const { repo } = seedStore({ productOver: { id: 'PRD1', stock: 10, purchasePrice: 100, sellingPrice: 250 }, supplierOver: { id: 'SUP1' } })
    addStockShipment('PRD1', 5, 'SUP1', 100, '', {}, repo) // 10 → 15 + سطر مورد
    const txn = repo.getSupplierTransactions().find(t => t.type === 'شحنة توريد')
    expect(txn).toBeTruthy()

    const writes = []
    const spyRepo = {
      ...repo,
      storageKeys: repo.storageKeys,
      getProducts: () => repo.getProducts(),
      getSuppliers: () => repo.getSuppliers(),
      getSupplierTransactions: () => repo.getSupplierTransactions(),
      updateFirestoreDoc: (key, id, fields) => {
        if (key === STORAGE_KEYS.PRODUCTS && 'stock' in fields) writes.push(fields.stock)
        repo.updateFirestoreDoc(key, id, fields)
      },
    }
    editStockShipment(txn.id, { qty: 7, unitCost: 100 }, spyRepo) // delta +2 → 17

    expect(typeof writes[0]).toBe('number')  // 👈 قيمة مطلقة لا marker
    expect(writes[0]).toBe(17)
  })
})
