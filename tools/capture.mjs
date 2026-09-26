#!/usr/bin/env node
/**
 * capture.mjs — take the §16.5 gallery (v2 slice 16).
 *
 *   npm run capture                 # all fourteen
 *   npm run capture -- --only win   # one, for iterating on a composition
 *   npm run capture -- --out /tmp/x # somewhere other than benchmark/screenshots
 *
 * WHAT IT DOES
 * ------------
 * Starts a Vite dev server on a free port, opens `capture.html` in the
 * chrome-headless-shell already in this machine's Puppeteer cache, and asks the
 * page to take each view in `src/game/capture.js` in turn. For every view it
 * writes `benchmark/screenshots/<id>.png` and records, in
 * `benchmark/captures.json`, what the world actually looked like at that moment.
 *
 * WHY THE REPORT IS PART OF THE OUTPUT
 * ------------------------------------
 * A PNG is a claim with no evidence attached. The report is the evidence: phase,
 * portals shut, hold fraction, creature state, awareness, dusk, the number of
 * banishes — read out of the live world after the last step, not out of the
 * script. When a view is wrong, the report is what says whether the world was
 * wrong or the camera was, and a gallery entry whose JSON says `creature:
 * "telegraph"` next to a filename called `creature-chasing` is a bug the next
 * reader can see without opening anything.
 *
 * WHY IT FAILS LOUDLY
 * -------------------
 * There is no fallback. If the page cannot reach a state, this records the
 * failure, writes no PNG for that id, and exits 1 — a gallery with a hole in it
 * beats a gallery with a plausible wrong picture in it. The same applies to the
 * renderer: if WebGL cannot be created at all, that is written into the report
 * verbatim and the exit code is 1, because "the screenshots are missing" and
 * "the screenshots are of a black rectangle" must never be the same event.
 *
 * THE FLAGS, AND WHY THEY ARE THESE
 * ---------------------------------
 * `--no-sandbox` because the container runs as root; `--use-gl=swiftshader` and
 * `--enable-unsafe-swiftshader` because there is no GPU here and the software
 * rasteriser is the only thing that will give this build a WebGL 2 context.
 * `--disable-gpu` is kept as well: it stops the browser trying to use a
 * hardware path that does not exist and failing late, which is the failure mode
 * that costs a minute per view. The renderer string the page actually got is
 * recorded in the report, so none of this has to be taken on trust.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'
import { CAPTURE_DIR, CAPTURE_IDS, CAPTURE_MIN_LIT, captureView } from '../src/game/capture.js'
import { describeLuma, luma } from './png-luma.mjs'

/** The browser this machine already has. Puppeteer's own download is not needed. */
const CHROME = process.env.CAPTURE_CHROME
  ?? '/work/.cache/puppeteer/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell'

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-dev-shm-usage',
]

/** How long one view may take before the harness calls it a failure. */
const VIEW_TIMEOUT_MS = 90_000

/** The repository root, which every path in this file's arguments is relative to. */
const REPO_ROOT = new URL('..', import.meta.url).pathname

/**
 * fromRepo — a path in this file's arguments, resolved against the repository root.
 *
 * `path.resolve`, not `new URL('../' + arg, import.meta.url)`. The URL form looks
 * right and is wrong in a way that costs an afternoon: URL resolution treats a
 * leading `/` as the root of the *file* scheme, so `--out /tmp/probe` silently
 * became `<repo>/tmp/probe` and wrote a run's captures into the working tree,
 * which is exactly the thing `.gitignore` and the benchmark's "keep unpublished
 * captures out of commits" rule exist to prevent. `path.resolve` honours the
 * leading `/` a person means.
 */
function fromRepo(argument) {
  return path.resolve(REPO_ROOT, argument)
}

function parseArgs(argv) {
  const options = { only: null, out: CAPTURE_DIR, report: 'benchmark/captures.json' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--only') options.only = argv[(index += 1)]
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length)
    else if (arg === '--out') options.out = argv[(index += 1)]
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--report') options.report = argv[(index += 1)]
    else if (arg.startsWith('--report=')) options.report = arg.slice('--report='.length)
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/** The ids to take: all fourteen, or the one that was asked for. */
function idsFor(options) {
  if (!options.only) return [...CAPTURE_IDS]
  const ids = options.only.split(',').map((id) => id.trim()).filter(Boolean)
  for (const id of ids) {
    if (!captureView(id)) throw new Error(`no such capture view: ${id}\nknown: ${CAPTURE_IDS.join(', ')}`)
  }
  return ids
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const ids = idsFor(options)
  const started = Date.now()
  console.log(`capture: ${ids.length} view(s) -> ${options.out}`)

  const server = await createServer({
    root: REPO_ROOT,
    logLevel: 'warn',
    server: { port: 0, strictPort: false, host: '127.0.0.1' },
  })
  await server.listen()
  const origin = server.resolvedUrls.local[0]
  console.log(`capture: dev server ${origin}`)

  const outDir = fromRepo(options.out)
  mkdirSync(outDir, { recursive: true })

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: CHROME_ARGS,
    protocolTimeout: VIEW_TIMEOUT_MS + 30_000,
  })

  const report = {
    tool: 'tools/capture.mjs',
    design: 'GAMEDESIGN.md §16.5',
    module: 'src/game/capture.js',
    seed: 1337,
    // The run's headline floor. Per-view floors are read inside the loop and
    // written into each entry as `minLit`; this is the one every view inherits
    // unless it declares its own, and it is what a reader of the report should
    // assume a frame was measured against.
    lumaFloor: CAPTURE_MIN_LIT,
    viewport: null,
    renderer: null,
    userAgent: null,
    browser: await browser.version(),
    node: process.version,
    started: new Date(started).toISOString(),
    ms: 0,
    captured: 0,
    failed: 0,
    captures: [],
  }

  let exitCode = 0
  try {
    for (const id of ids) {
      const view = captureView(id)
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (error) => pageErrors.push(String(error).split('\n')[0]))
      page.on('console', (message) => {
        if (message.type() === 'error') pageErrors.push(`console: ${message.text().slice(0, 200)}`)
      })
      await page.setViewport({ width: view.viewport.width, height: view.viewport.height })
      // The floor a view is measured against is the street's, except where the
      // view declares its own and says why (see `TITLE_MIN_LIT`). It is read
      // per view rather than once for the run so that an exception cannot
      // spread: a view with no `minLit` is on the same gate as its thirteen
      // neighbours, whatever the others are doing.
      const floor = view.minLit ?? CAPTURE_MIN_LIT
      // `file` is recorded repo-relative on purpose. The report is committed, so
      // an absolute path would publish this machine's checkout layout and stop
      // meaning anything on anyone else's disk. The absolute path is still
      // needed to write the bytes, and that is `target`.
      const target = path.join(outDir, `${id}.png`)
      const entry = {
        id,
        label: view.label,
        viewport: { ...view.viewport },
        file: path.posix.join(options.out.split(path.sep).join('/'), `${id}.png`),
        minLit: floor,
      }
      try {
        await page.goto(`${origin}capture.html`, { waitUntil: 'domcontentloaded', timeout: VIEW_TIMEOUT_MS })
        await page.waitForFunction('window.__captureReady === true', { timeout: VIEW_TIMEOUT_MS })
        // the renderer string is the honest answer to "did this actually render"
        if (!report.renderer) {
          report.renderer = await page.evaluate(() => {
            const canvas = document.querySelector('canvas')
            if (!canvas) return 'no canvas: the world never built'
            const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
            if (!gl) return 'no context: this build cannot create WebGL'
            const debug = gl.getExtension('WEBGL_debug_renderer_info')
            return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
          })
          report.userAgent = await browser.userAgent()
          report.viewport = { ...view.viewport }
        }
        const snapshot = await page.evaluate(
          (wanted) => window.__captureRun(wanted),
          id,
        )
        const shot = Buffer.from(await page.screenshot())
        // The frame is measured before it is kept, and the file is only written
        // once it has passed. Screenshotting straight to a path cannot do this:
        // by the time anybody looked at the bytes, a black rectangle was already
        // sitting in the gallery wearing the id of a view it never showed.
        entry.luma = luma(shot)
        if (entry.luma.lit < floor) {
          throw new Error(
            `the frame is too dark to be evidence: ${describeLuma(entry.luma, Number((floor * 100).toFixed(2)))}`,
          )
        }
        writeFileSync(target, shot)
        entry.status = 'captured'
        entry.state = snapshot
        entry.ms = snapshot.ms
        report.captured += 1
        console.log(
          `  ok    ${id.padEnd(19)} ${snapshot.phase}/${snapshot.creature} ${snapshot.ms} ms  ` +
            `lit ${entry.luma.litPct}% (floor ${(floor * 100).toFixed(2)}%)`,
        )
      } catch (error) {
        entry.status = 'failed'
        entry.error = String(error && error.message ? error.message : error).split('\n')[0]
        entry.pageErrors = pageErrors.slice(0, 5)
        // A failed view must leave nothing behind that a reader could mistake for
        // this run's work. A frame that was too dark to keep is exactly the file
        // most likely to still be sitting there from a previous green run, and it
        // would look like a passing capture to anybody who only opens the folder.
        rmSync(target, { force: true })
        report.failed += 1
        exitCode = 1
        console.log(`  FAIL  ${id.padEnd(19)} ${entry.error}`)
        for (const message of pageErrors.slice(0, 5)) console.log(`        page: ${message}`)
      }
      report.captures.push(entry)
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }

  report.ms = Date.now() - started
  const reportPath = fromRepo(options.report)
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  // The mean of the means, and the darkest frame in the set: the two numbers
  // that tell a reader whether this gallery is a set of photographs of a street.
  //
  // "Darkest" is reported as a *margin* rather than a raw percentage, because the
  // floors are not all the same: the honest question is not "which frame is
  // dimmest" but "which frame came closest to being rejected". A view measured
  // against a lower floor is judged on how close it got to that floor, so the
  // tightest margin in the set is the one number worth printing.
  const measured = report.captures
    .filter((entry) => typeof entry.luma?.litPct === 'number')
    .map((entry) => ({ ...entry, margin: entry.luma.litPct - entry.minLit * 100 }))
  if (measured.length > 0) {
    const mean = measured.reduce((sum, entry) => sum + entry.luma.litPct, 0) / measured.length
    const tightest = measured.reduce((low, entry) => (entry.margin < low.margin ? entry : low))
    report.luma = {
      floor: Number((CAPTURE_MIN_LIT * 100).toFixed(2)),
      mean: Number(mean.toFixed(3)),
      tightest: {
        id: tightest.id,
        litPct: tightest.luma.litPct,
        floor: Number((tightest.minLit * 100).toFixed(2)),
        margin: Number(tightest.margin.toFixed(2)),
      },
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(
      `capture: lit mean ${report.luma.mean}%, tightest ${tightest.id} at ` +
        `${tightest.luma.litPct}% against a ${(tightest.minLit * 100).toFixed(2)}% floor ` +
        `(+${tightest.margin.toFixed(2)})`,
    )
  }
  console.log(`capture: ${report.captured} captured, ${report.failed} failed, ${report.ms} ms`)
  console.log(`capture: report -> ${options.report}`)
  if (report.renderer) console.log(`capture: renderer -> ${report.renderer}`)
  process.exitCode = exitCode
}

main().catch((error) => {
  console.error(`capture: ${error.stack ?? error}`)
  process.exitCode = 1
})
