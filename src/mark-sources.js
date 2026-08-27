// @ts-check
/**
 * Source marking: every NATIVE element of a `.vue` template gets an attribute
 * holding its address in the code — `data-constructor="src/screen/x.vue:74:6"`.
 *
 * This is the only thing tying a pixel on the screen to a line in a file, and it
 * exists in development only: a production build carries no marking, and should
 * not.
 *
 * Components are deliberately left unmarked. An attribute set on a component
 * falls through to its root element and overrides that element's own marking —
 * the address would then point at the call site instead of the markup itself.
 */
import { createRequire } from 'node:module'
import path from 'node:path'

/** @type {((source: string, options: any) => any) | null} */
let cachedParse = null

/**
 * The compiler is taken from the CONSUMER's node_modules rather than our own:
 * the Vue version has to match the one building the project, otherwise template
 * parsing drifts away from what actually gets compiled.
 * @param {string} resolveFrom
 */
function loadParse(resolveFrom) {
  if (cachedParse) return cachedParse
  const require = createRequire(path.join(resolveFrom, 'noop.js'))
  let mod
  try {
    mod = require('vue/compiler-sfc')
  } catch {
    mod = require('@vue/compiler-sfc')
  }
  cachedParse = mod.parse
  return cachedParse
}

const NODE_ELEMENT = 1
const NODE_ATTRIBUTE = 6
const TAG_NATIVE = 0

/**
 * @param {any} node
 * @param {(el: any) => void} visit
 */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (node.type === NODE_ELEMENT) visit(node)
  const children = node.children
  if (Array.isArray(children)) {
    for (const child of children) walk(child, visit)
  }
}

/**
 * @param {string} code source of the `.vue` file
 * @param {string} filename absolute path of the file
 * @param {{ resolveFrom: string, sourceRoot: string, attr: string }} options
 * @returns {string | null} marked source, or null when there is nothing to mark
 */
export function markSources(code, filename, options) {
  const parse = loadParse(options.resolveFrom)
  let descriptor
  try {
    ;({ descriptor } = parse(code, { filename, sourceMap: false }))
  } catch {
    // A file being edited may not parse for a moment. Skip it quietly and let
    // plugin-vue report the failure in its own words.
    return null
  }

  const ast = descriptor?.template?.ast
  if (!ast) return null

  // The SFC parser reads the whole file, so node offsets and lines are absolute
  // to the file. Nothing needs recalculating.
  const rel = path.relative(options.sourceRoot, filename).split(path.sep).join('/')

  /** @type {{ offset: number, text: string }[]} */
  const inserts = []

  walk(ast, (el) => {
    if (el.tagType !== TAG_NATIVE) return
    const already = el.props?.some(
      /** @param {any} p */ (p) => p.type === NODE_ATTRIBUTE && p.name === options.attr,
    )
    if (already) return
    const { line, column, offset } = el.loc.start
    inserts.push({
      // right after the tag name: `<div` → `<div data-constructor="…"`
      offset: offset + 1 + el.tag.length,
      text: ` ${options.attr}="${rel}:${line}:${column}"`,
    })
  })

  if (inserts.length === 0) return null

  // Apply from the end, so offsets computed earlier stay valid.
  inserts.sort((a, b) => b.offset - a.offset)
  let out = code
  for (const ins of inserts) {
    out = out.slice(0, ins.offset) + ins.text + out.slice(ins.offset)
  }
  return out
}
