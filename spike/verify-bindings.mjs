// Verifies every .NET type/field our reader depends on actually exists in the
// game's managed assembly (sts2.dll). This is the binding "gap analysis": any
// MISSING entry is something a reimplementation could not resolve by name.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const DLL = 'C:/Program Files (x86)/Steam/steamapps/common/Slay the Spire 2/data_sts2_windows_x86_64/sts2.dll'
const buf = readFileSync(DLL)
const hay = buf.toString('latin1')

const models = readFileSync('src/main/scry/models.ts', 'utf8')
const fields = [...new Set([...models.matchAll(/this\.(?:object|boolean|number|string|int32|float|uint64|array)\('([^']+)'/g)].map(m => m[1]))]
const classes = [...new Set([...models.matchAll(/ClassName = '([^']+)'/g)].map(m => m[1]))]

// .NET metadata #Strings heap stores names NUL-terminated; match name + \0
const present = (n) => hay.includes(n + '\0')

const fr = fields.map(f => ({ name: f, ok: present(f) }))
// classes are stored as separate namespace + name in metadata
const cr = classes.map(c => {
  const i = c.lastIndexOf('.')
  const ns = c.slice(0, i), nm = c.slice(i + 1)
  return { name: c, ok: present(nm) && present(ns) }
})

const missF = fr.filter(x => !x.ok), missC = cr.filter(x => !x.ok)
const out = {
  assembly: DLL,
  fields: { total: fr.length, resolved: fr.length - missF.length, missing: missF.map(x => x.name) },
  classes: { total: cr.length, resolved: cr.length - missC.length, missing: missC.map(x => x.name) }
}
writeFileSync('spike/binding-report.json', JSON.stringify(out, null, 2))
console.log(`FIELDS  ${out.fields.resolved}/${out.fields.total} resolved`)
if (missF.length) console.log('  MISSING:', missF.map(x => x.name).join(', '))
console.log(`CLASSES ${out.classes.resolved}/${out.classes.total} resolved`)
if (missC.length) console.log('  MISSING:', missC.map(x => x.name).join(', '))
