import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { parse } from '@babel/parser'
import { dictionaries } from '../locales/admin/index.js'
import { auditVocabulary } from './audit.js'
import { adminErrorVocabulary } from './admin-errors.js'

// Static source keys plus the dynamic server-code vocabularies: a key missing from
// every pack must fail just as a translation missing from one pack does.
const keys = new Set([...auditVocabulary, ...adminErrorVocabulary])
const strings = node => {
  if (!node) return
  if (node.type === 'StringLiteral') keys.add(node.value)
  if (node.type === 'ConditionalExpression') { strings(node.consequent); strings(node.alternate) }
}
for (const name of ['Admin', 'AdminCoach', 'AdminSecurity', 'AdminSignIn', 'AdminAccess']) {
  const ast = parse(fs.readFileSync(new URL(`../views/${name}.jsx`, import.meta.url), 'utf8'), { sourceType: 'module', plugins: ['jsx'] })
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression' && ['t', 'setMessage', 'setError', 'setLoadError'].includes(node.callee?.name)) strings(node.arguments[0])
    // The two small maps feed t(variable); their values are user-facing copy.
    if (node.type === 'VariableDeclarator' && ['credentialLabel', 'failureTitle'].includes(node.id?.name)) {
      const collect = n => { if (!n || typeof n !== 'object') return; if (n.type === 'ObjectProperty') strings(n.value); for (const v of Object.values(n)) if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === 'object') collect(v) }
      collect(node.init)
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value)
  }
  visit(ast)
}
keys.delete('')
describe('admin translation readiness', () => {
  for (const [locale, dictionary] of Object.entries(dictionaries)) {
    it(`${locale} covers every static key and known audit/error message`, () => {
      expect([...keys].filter(key => !dictionary[key]?.trim())).toEqual([])
    })
    it(`${locale} preserves interpolation placeholders`, () => {
      const placeholders = value => (value.match(/\{\d+\}/g) || []).sort()
      for (const [key, value] of Object.entries(dictionary)) expect(placeholders(value), key).toEqual(placeholders(key))
    })
  }
})
