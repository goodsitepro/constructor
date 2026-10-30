# @goodsite/constructor

Tags rendered elements with their source file and line, so edits made visually on a live
page can be applied to the exact place in code.

The editor itself is not in this package — it comes from the browser extension. Without
addresses it still works and targets edits by CSS class; with them it targets the exact
line. That is why this part is open and small.

Development only. The plugin takes no part in production builds.

## Install

```bash
npm i -D @goodsite/constructor
```

Until the first npm release, install it from this repository — the import name is the same:

```bash
npm i -D github:goodsitepro/constructor
```

```js
// vite.config.js
import constructor from '@goodsite/constructor'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [constructor({ project: 'my-panel' }), vue()],
})
```

Add `.constructor` to your `.gitignore`.

## What it does

**1. Marks elements.** Every native element in a `.vue` template gets its address:

```html
<div data-constructor="src/screen/employee/form.vue:74:5" class="vfIsland">
```

Components are deliberately left unmarked. An attribute set on a component falls through
to its root element and overrides that element's own address, so the address would point
at the call site instead of the markup. Marking inserts no newlines, so source maps stay
correct.

**2. Announces itself.** A meta tag tells the editor that this page carries addresses,
which attribute holds them, and which format they speak:

```html
<meta name="constructor" content="0.1.0; format=1; attr=data-constructor; sink=/__constructor/session">
```

**3. Accepts sessions.** `POST /__constructor/session` writes what it receives to
`.constructor/session-NNN.json` next to the project (and to `latest.json`). This is the
path for teams whose screens hold customer data that must not leave the machine.

With `CONSTRUCTOR_URL` and `CONSTRUCTOR_API_KEY` set, the session is delivered to the
cabinet as well. The key comes from the environment rather than the build config, because
build configs get committed.

Writing to disk stays on by default even then, because it is the safety net: the cabinet
can be unreachable, and losing collected work to a network hiccup is the worst outcome
this tool can produce. Once the cabinet is the real destination and session files in the
repository are just noise, turn it off with `local: false` — a refused delivery is then
answered with `502`, so the editor keeps what it collected instead of dropping it.

## Options

| Option | Meaning | Default |
|---|---|---|
| `project` | project name recorded in the session | folder name of `sourceRoot` |
| `sourceRoot` | what addresses are relative to | Vite root |
| `outDir` | where sessions are stored | `.constructor` next to `sourceRoot` |
| `local` | write the session to disk | `true` |
| `attr` | marking attribute name | `data-constructor` |
| `overlay` | path to an editor runtime to inject yourself | not injected |
| `cabinetUrl` | cabinet address to forward sessions to | `CONSTRUCTOR_URL` |
| `apiKey` | cabinet access key | `CONSTRUCTOR_API_KEY` |

`overlay` exists for setups where the extension is not available — for instance before it
ships. In normal use the editor comes from the extension and this option stays unset.

## Versioning

What must match across the plugin, the extension and the cabinet is the **format** — the
contract describing the marking and the meta tag — not the package version. The format
only changes when a change is incompatible: adding a field keeps it, changing a meaning
raises it. It is currently `1`.

That way all three sides upgrade independently as long as they speak the same format.

## Limits

- Works with Vite and Vue single-file components. Other bundlers as the need arises — the
  surface here is small and ports easily.
- Addresses exist in development only. They are not present in production builds, and
  should not be.
- Elements rendered through `v-html` or by third-party scripts get no address of their
  own; an edit on them anchors to the nearest marked ancestor.

## License

MIT
