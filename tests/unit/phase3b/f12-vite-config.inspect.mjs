// =============================================================================
// Phase 3B — F-12 — فحص إعداد Vite الفعلي (verify-only, لا يعدّل أي ملف)
// -----------------------------------------------------------------------------
// يستورد كائنَي الإعداد الحقيقيين ويطبع مجموعة plugins النهائية التي يلتقطها
// محمّل الوحدات (JS: المفتاح المكرر ← الأخير يفوز)، إضافةً إلى عدد أسطر
// `plugins:` في المصدر لإثبات التكرار نصّياً.
// التشغيل: node tests/unit/phase3b/f12-vite-config.inspect.mjs
// =============================================================================
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ROOT = 'C:/Users/m/opencode/react'

async function loadConfig(rel) {
  const mod = await import(pathToFileURL(`${ROOT}/${rel}`).href)
  return mod.default
}

function summarize(cfg, rel) {
  const src = readFileSync(`${ROOT}/${rel}`, 'utf8')
  const pluginsKeyCount = (src.match(/^\s*plugins\s*:/gm) || []).length
  const plugins = (cfg && cfg.plugins) || []
  return {
    file: rel,
    pluginsKeyOccurrencesInSource: pluginsKeyCount,
    effectivePluginCount: Array.isArray(plugins) ? plugins.length : 'not-array',
    effectivePlugins: (Array.isArray(plugins) ? plugins : []).map(p => {
      if (p && typeof p === 'object' && p.name) return p.name
      return typeof p === 'function' ? '[function-plugin]' : String(p)
    }),
  }
}

const offline = await loadConfig('vite.offline.config.js')
const normal = await loadConfig('vite.config.js')

const report = {
  offline: summarize(offline, 'vite.offline.config.js'),
  normal: summarize(normal, 'vite.config.js'),
}
console.log(JSON.stringify(report, null, 2))
