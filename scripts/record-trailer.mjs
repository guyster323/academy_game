/**
 * record-trailer.mjs — capture CURSOR SLUG attract mode and cut a fast montage.
 *
 * Pipeline:
 *   1. serve the repo on :8073 (python http.server)
 *   2. Playwright records index.html?demo=1 to webm while the in-game demo bot
 *      plays title -> 3 stages -> 3 bosses -> ending, polling window.__demo for
 *      stage / boss / tank-ride timestamps
 *   3. ffmpeg cuts ~8 highlight clips (~4s each) of distinct game moments and
 *      joins them with 0.5s wipe transitions -> montage MP4, then a looping
 *      GIF of the same montage, plus a poster frame
 *
 * Requires: ffmpeg on PATH, Playwright chromium (installed under the global
 * record-demo skill's vendored pagecast). Outputs to assets/trailer/.
 *
 *   node scripts/record-trailer.mjs
 */
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { mkdir, rm, rename, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire('C:/Users/iamji/.claude/skills/record-demo/vendor/pagecast/');
const { chromium } = require('playwright');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'assets', 'trailer');
const WORK = join(ROOT, 'scripts', '.rec');
const PORT = 8073;
const URL = `http://localhost:${PORT}/index.html?demo=1`;
const HARD_TIMEOUT_MS = 240_000;
const WIPE = 0.5;                                   // transition length between clips

const sh = (cmd, args, opts = {}) => new Promise((res, rej) => {
  execFile(cmd, args, { maxBuffer: 1 << 26, ...opts }, (e, so, se) => e ? rej(new Error((se || e.message).toString().slice(0, 4000))) : res({ so, se }));
});
const ff = (args) => sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

async function main() {
  await sh('ffmpeg', ['-version']).catch(() => { throw new Error('ffmpeg not found on PATH'); });
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  await mkdir(OUT, { recursive: true });

  // 1. static server
  const server = spawn('python', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  const stopAll = () => { try { server.kill(); } catch {} };
  process.on('exit', stopAll);
  await new Promise(r => setTimeout(r, 1500));

  // 2. record
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--force-color-profile=srgb', '--hide-scrollbars'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: WORK, size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message)));

  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'load' });
  const navMs = Date.now() - t0;            // video started ~when ctx made, before goto
  const clk = () => (Date.now() - t0 + navMs / 2) / 1000;

  const mark = {};                          // event -> seconds into video
  const seen = s => mark[s] === undefined && (mark[s] = +clk().toFixed(2));
  let bossPhase = 0;

  const deadline = Date.now() + HARD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    const d = await page.evaluate(() => window.__demo && {
      scene: window.__demo.scene, stage: window.__demo.stage, boss: window.__demo.boss, riding: window.__demo.riding,
    }).catch(() => null);
    if (!d) continue;
    if (d.scene === 'PLAY' && d.stage >= 1) seen('s' + d.stage + 'Start');
    if (d.riding) seen('tankRide');
    if (d.boss && d.boss.active && !d.boss.dying && bossPhase !== d.stage) {
      bossPhase = d.stage; seen('boss' + d.stage + 'Start');
    }
    if (bossPhase && (!d.boss || d.boss.dying || d.scene === 'STAGECLEAR')) {
      seen('boss' + bossPhase + 'Dead'); bossPhase = 0;
    }
    if (d.scene === 'ENDING') { seen('ending'); break; }
  }
  seen('ending');
  await new Promise(r => setTimeout(r, 4200));            // tail of ending screen

  const webm = join(WORK, 'raw.webm');
  await page.video().path().then(p => ctx.close().then(() => rename(p, webm)));
  await browser.close();
  stopAll();

  if (errs.length) console.warn('page errors:', errs.slice(0, 5));
  console.log('marks:', mark);

  // 3. cut. define distinct game moments -> [startSec, lenSec]
  const M = (k, def) => (mark[k] ?? def);
  const s1 = M('s1Start', 2), s2 = M('s2Start', 45), s3 = M('s3Start', 90);
  const events = [
    ['stage1-run',   s1 + 0.3,                     4.0],   // SANDBOX DESERT banner + run & gun
    ['weapon-fx',    s1 + 13.0,                    4.0],   // spread / flame / rockets mid-stage
    ['boss1',        M('boss1Start', 30) + 0.8,    4.0],   // NULL POINTER GATE
    ['stage2-cave',  s2 + 3.0,                     4.0],   // MEMORY CAVERN traversal
    ['boss2',        M('boss2Start', 70) + 0.8,    4.0],   // MEMORY LEAK HYDRA
    ['tank',         M('tankRide', s3 + 16) + 0.4, 4.0],   // riding "the slug"
    ['boss3',        M('boss3Start', 120) + 0.8,   4.0],   // HALLUCINATION
    ['ending',       M('ending', 140) + 0.5,       2.6],   // MISSION ACCOMPLISHED
  ];

  // normalise each clip to identical params so xfade can chain them
  const clips = [], lens = [];
  for (const [name, start, len] of events) {
    const p = join(WORK, `clip-${name}.mp4`);
    await ff(['-ss', start.toFixed(2), '-t', len.toFixed(2), '-i', webm,
      '-vf', 'scale=1280:720:flags=lanczos,setsar=1,fps=30,format=yuv420p',
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', p]);
    clips.push(p); lens.push(len);
  }

  // build the wipe-transition filtergraph: progressive xfade across all clips
  const fc = [];
  let prev = '[0:v]', run = lens[0];
  for (let k = 1; k < clips.length; k++) {
    const out = k === clips.length - 1 ? '[v]' : `[x${k}]`;
    fc.push(`${prev}[${k}:v]xfade=transition=wipeleft:duration=${WIPE}:offset=${(run - WIPE).toFixed(3)}${out}`);
    prev = out;
    run += lens[k] - WIPE;
  }
  const trailer = join(OUT, 'cursor-slug-trailer.mp4');
  const inArgs = clips.flatMap(c => ['-i', c]);
  await ff([...inArgs, '-filter_complex', fc.join(';'), '-map', '[v]', '-r', '30',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', trailer]);
  console.log(`montage: ${run.toFixed(1)}s -> ${((await stat(trailer)).size / 1048576).toFixed(2)} MB`);

  // poster
  const poster = join(OUT, 'poster.png');
  await ff(['-ss', String(M('boss1Start', 30) + 2.2), '-i', webm, '-frames:v', '1', '-vf', 'scale=1280:720', poster]);

  // Fallback teaser GIF (~first 18s of the montage) for clients that don't render
  // the <video> embed. Two-pass palette; drop a size if it comes out over ~8 MB.
  const gif = join(OUT, 'cursor-slug-hero.gif');
  const pal = join(WORK, 'pal.png');
  for (const [w, fps] of [[480, 10], [440, 10], [420, 9]]) {
    const vf = `fps=${fps},scale=${w}:-1:flags=lanczos`;
    await ff(['-t', '18', '-i', trailer, '-vf', `${vf},palettegen=stats_mode=diff`, pal]);
    await ff(['-t', '18', '-i', trailer, '-i', pal,
      '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, gif]);
    const mb = (await stat(gif)).size / 1048576;
    console.log(`teaser gif ${w}px ${fps}fps 18s -> ${mb.toFixed(2)} MB`);
    if (mb <= 8) break;
  }

  for (const f of [trailer, gif, poster]) console.log('  \u2713', f, ((await stat(f)).size / 1048576).toFixed(2), 'MB');
  console.log('\ndone. keep scripts/.rec/raw.webm for re-cuts, or delete it.');
}

main().catch(e => { console.error(e); process.exit(1); });
