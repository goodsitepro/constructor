// @ts-check
/**
 * @goodsite/constructor — the build plugin.
 *
 * It puts addresses on elements, and nothing more. The editor itself lives in
 * the browser extension and in the cabinet; this package does not need it.
 * Without addresses an edit is anchored by CSS class, with them by the exact
 * line. That is why this part is open and small.
 *
 * Three duties, all development only (`apply: 'serve'`):
 *  1. mark templates with source addresses (mark-sources.js);
 *  2. announce itself with a meta tag, so the editor knows the page carries
 *     addresses and which format they speak;
 *  3. accept a session: write it next to the project and, when a cabinet is
 *     configured, deliver it there as well.
 *
 * Production builds are untouched: the bundle carries neither attributes nor
 * the meta tag.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { markSources } from './mark-sources.js'

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * The FORMAT version — the contract between this package, the extension and the
 * cabinet: what a session and the marking look like. This is what the three
 * sides check, not package numbers; otherwise all three would have to be
 * upgraded in lockstep, which is misery for everyone.
 *
 * It only rises on an incompatible change. Adding a field keeps it as it is.
 */
const FORMAT = 1

const VERSION = readVersion()

const ENDPOINT = '/__constructor/session'
const DEFAULT_ATTR = 'data-constructor'
const DEFAULT_DIR = '.constructor'

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * @typedef {object} ConstructorOptions
 * @property {string} [project] project name recorded in the session (defaults to the sourceRoot folder name)
 * @property {string} [sourceRoot] what addresses are relative to; defaults to the Vite root
 * @property {string} [outDir] where sessions are stored (relative to sourceRoot)
 * @property {boolean} [local] write the session to disk; on by default
 * @property {string} [attr] name of the marking attribute
 * @property {string | false} [overlay] path to an editor runtime to inject into
 *   the page yourself. Nothing is injected by default: the editor arrives from
 *   the extension. Useful where the extension is not available yet.
 * @property {string} [cabinetUrl] cabinet address; sessions are delivered there too
 * @property {string} [apiKey] cabinet access key
 */

/**
 * @param {ConstructorOptions} [options]
 * @returns {import('vite').Plugin}
 */
export function constructorOverlay(options = {}) {
  const attr = options.attr ?? DEFAULT_ATTR
  const overlayEntry = options.overlay ? path.resolve(options.overlay) : null
  // The cabinet is configured through the environment for a reason: an access
  // key has no place in a build config, and build configs get committed.
  const cabinetUrl = (options.cabinetUrl ?? process.env.CONSTRUCTOR_URL ?? '').replace(/\/$/, '')
  const apiKey = options.apiKey ?? process.env.CONSTRUCTOR_API_KEY ?? ''
  const toCabinet = Boolean(cabinetUrl && apiKey)
  // Writing to disk is the default because it is the safety net: the cabinet can
  // be unreachable, and losing collected work to a network hiccup is the worst
  // outcome this tool can produce. Turn it off once the cabinet is the real
  // destination and session files in the repository are just noise.
  const toDisk = options.local ?? true

  /** @type {string} */
  let viteRoot = process.cwd()
  /** @type {string} */
  let sourceRoot = ''
  /** @type {string} */
  let outDir = ''
  /** @type {string} */
  let project = ''

  return {
    name: 'constructor-overlay',
    apply: 'serve',
    // Ahead of plugin-vue: we mark the raw SFC before anyone compiles it.
    enforce: 'pre',

    configResolved(resolved) {
      // The editor runtime sits outside the project root, so without this the
      // dev server answers 403.
      //
      // The path is APPENDED to the list Vite already computed, rather than
      // returned from our own `config()` hook: the moment anyone sets
      // server.fs.allow, Vite forgets its defaults — and the dev server started
      // answering 403 for the project's own index.html. The plugin took the
      // whole app down instead of simply attaching to it.
      if (!resolved.server.fs.allow.includes(PKG_DIR)) {
        resolved.server.fs.allow.push(PKG_DIR)
      }

      viteRoot = resolved.root
      sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : viteRoot
      outDir = path.resolve(sourceRoot, options.outDir ?? DEFAULT_DIR)
      project = options.project ?? path.basename(sourceRoot)
    },

    transform(code, id) {
      const [file] = id.split('?')
      if (!file.endsWith('.vue')) return null
      if (file.includes('/node_modules/')) return null
      const marked = markSources(code, file, { resolveFrom: viteRoot, sourceRoot, attr })
      // Marking adds no newlines, so the existing source map stays correct and
      // there is nothing for us to generate.
      return marked ? { code: marked, map: null } : null
    },

    transformIndexHtml() {
      const config = {
        project,
        endpoint: ENDPOINT,
        attr,
        version: VERSION,
        format: FORMAT,
        docsUrl: cabinetUrl ? `${cabinetUrl}/docs` : undefined,
        cabinetUrl: cabinetUrl ? `${cabinetUrl}/dashboard` : undefined,
      }

      /**
       * The meta tag is the public contract with whatever comes from outside:
       * from it the editor learns that this page carries addresses, which
       * attribute holds them, and which format they speak.
       */
      const tags = [
        {
          tag: 'meta',
          attrs: {
            name: 'constructor',
            content: `${VERSION}; format=${FORMAT}; attr=${attr}; sink=${ENDPOINT}`,
          },
          injectTo: 'head-prepend',
        },
      ]

      if (overlayEntry) {
        const query = encodeURIComponent(JSON.stringify(config))
        tags.push({
          tag: 'script',
          attrs: { type: 'module', src: `/@fs${overlayEntry}?constructor=${query}` },
          injectTo: 'body',
        })
      }

      return tags
    },

    configureServer(server) {
      if (!toDisk && !toCabinet) {
        // Nothing would keep the session at all — better to hear it now than
        // to find out when the first one disappears.
        server.config.logger.warn(
          '\n  constructor  local: false and no cabinet configured — sessions have nowhere to go\n',
        )
      }

      server.middlewares.use(ENDPOINT, (req, res, next) => {
        if (req.method !== 'POST') return next()

        /** @type {Buffer[]} */
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', async () => {
          try {
            const session = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const saved = toDisk ? writeSession(session, { outDir, sourceRoot, project }) : null
            const delivered = toCabinet
              ? await sendToCabinet(session, { cabinetUrl, apiKey, project })
              : null

            // With no copy on disk, a refused delivery means the session exists
            // nowhere. Say so plainly: the editor keeps what it collected until
            // it hears that the session arrived somewhere.
            const ok = Boolean(saved) || Boolean(delivered?.ok)

            res.statusCode = ok ? 200 : 502
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok, ...(saved ?? {}), cabinet: delivered }))

            const count =
              (Array.isArray(session.notes) ? session.notes.length : 0) +
              (Array.isArray(session.edits) ? session.edits.length : 0)
            const where = saved ? saved.file : 'cabinet'
            const tail = !delivered
              ? ''
              : delivered.ok
                ? saved
                  ? ' → cabinet'
                  : ''
                : ` → cabinet refused it: ${delivered.error}`
            server.config.logger[ok ? 'info' : 'error'](
              `\n  constructor  ${ok ? 'session saved' : 'session LOST'}: ${where}` +
                ` (${count} ${plural(count)})${tail}\n`,
            )
          } catch (error) {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String(error) }))
          }
        })
      })
    },
  }
}

/**
 * Delivery to the cabinet. Failures are not raised: the file is already written,
 * and losing collected work because a server was unreachable would be the worst
 * outcome here.
 *
 * @param {any} session
 * @param {{ cabinetUrl: string, apiKey: string, project: string }} ctx
 */
async function sendToCabinet(session, ctx) {
  try {
    const response = await fetch(`${ctx.cabinetUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.apiKey}`,
      },
      body: JSON.stringify({ format: FORMAT, project: ctx.project, ...session }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      return { ok: false, error: payload?.statusMessage || `replied ${response.status}` }
    }
    return { ok: true, sessionId: payload.sessionId, items: payload.items }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * @param {any} session
 * @param {{ outDir: string, sourceRoot: string, project: string }} ctx
 */
function writeSession(session, ctx) {
  fs.mkdirSync(ctx.outDir, { recursive: true })

  const existing = fs
    .readdirSync(ctx.outDir)
    .map((name) => /^session-(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match?.[1]))
  const next = (existing.length ? Math.max(...existing) : 0) + 1
  const name = `session-${String(next).padStart(3, '0')}.json`

  const payload = {
    format: FORMAT,
    project: ctx.project,
    savedAt: new Date().toISOString(),
    // Who collected the session: package version, host and account.
    //
    // The account is recorded as received and NOT verified: this package is
    // open, and any check inside it comes off by deleting a line. The gate is
    // the editor — it does not run without an active account, so there is
    // nothing to post here in the first place. This record serves another
    // purpose: the file itself shows whose work it is.
    producer: {
      plugin: VERSION,
      host: session.host ?? 'vite-dev',
      account: session.account ?? null,
    },
    ...session,
  }
  const body = JSON.stringify(payload, null, 2)

  fs.writeFileSync(path.join(ctx.outDir, name), body, 'utf8')
  // latest.json spares the assistant from hunting for the highest number.
  fs.writeFileSync(path.join(ctx.outDir, 'latest.json'), body, 'utf8')

  const rel = path.relative(ctx.sourceRoot, path.join(ctx.outDir, name))
  return { file: rel.split(path.sep).join('/'), index: next }
}

/** @param {number} n */
function plural(n) {
  return n === 1 ? 'item' : 'items'
}

export default constructorOverlay
