/**
 * record-trailer.mjs — capture CURSOR SLUG attract mode and cut a trailer.
 *
 * Pipeline:
 *   1. serve the repo on :8073 (python http.server)
 *   2. Playwright records index.html?demo=1 to webm while the in-game demo bot
 *      plays title -> 3 stages -> 3 bosses -> ending
 *   3. ffmpeg cuts a ~45s montage MP4 (opening + each boss + ending) and a
 *      short looping hero GIF, plus a poster frame
 *
 * Requires: ffmpeg on PATH, Playwright chromium (installed under the global
 * record-demo skill's vendored pagecast). Outputs to assets/trailer/.
 *
 *   node scripts/record-trailer.mjs
 */
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { mkdir, rm, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  let bossPhase = 0;                        // 0 none, 1..3 fighting boss n

  const deadline = Date.now() + HARD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    const d = await page.evaluate(() => window.__demo && {
      scene: window.__demo.scene, stage: window.__demo.stage, boss: window.__demo.boss,
    }).catch(() => null);
    if (!d) continue;
    if (d.scene === 'PLAY' && d.stage >= 1) seen('s' + d.stage + 'Start');
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

  const videoPath = join(WORK, 'raw.webm');
  await page.video().path().then(p => ctx.close().then(() => rename(p, videoPath)));
  await browser.close();
  stopAll();

  if (errs.length) console.warn('page errors:', errs.slice(0, 5));
  console.log('marks:', mark);

  // 3. cut. clamp helper + segment list [start,end]
  const M = (k, def) => (mark[k] ?? def);
  const dur = M('ending', 120) + 5;
  const cl = (a, b) => [Math.max(0, +a.toFixed(2)), Math.min(dur, +b.toFixed(2))];
  const segs = [
    cl(M('s1Start', 1.6) - 0.8, M('s1Start', 1.6) + 6.5),                 // opening run
    cl(M('boss1Start', 22) - 2.0, M('boss1Dead', 32) + 2.8),             // NULL POINTER GATE
    cl(M('boss2Start', 55) - 2.0, M('boss2Dead', 65) + 2.8),            // MEMORY LEAK HYDRA
    cl(M('boss3Start', 95) - 2.0, M('ending', 118) + 3.5),              // HALLUCINATION + ending
  ].filter(([a, b]) => b - a > 1.5);

  // build montage via per-segment extracts + concat (re-encode, safe across cuts)
  const parts = [];
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i];
    const p = join(WORK, `seg${i}.mp4`);
    await ff(['-ss', String(a), '-t', String((b - a).toFixed(2)), '-i', videoPath,
      '-vf', 'scale=1280:720:flags=lanczos,format=yuv420p,fps=30',
      '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', p]);
    parts.push(p);
  }
  const listFile = join(WORK, 'concat.txt');
  await (await import('node:fs/promises')).writeFile(listFile, parts.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const trailer = join(OUT, 'cursor-slug-trailer.mp4');
  await ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-r', '24',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', trailer]);

  // poster from the boss1 moment
  const poster = join(OUT, 'poster.png');
  await ff(['-ss', String(M('boss1Start', 22) + 2.5), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=1280:720', poster]);

  // hero GIF: boss1 fight window, two-pass palette, shrink until < 5 MB
  const gif = join(OUT, 'cursor-slug-hero.gif');
  const pal = join(WORK, 'pal.png');
  const gStart = Math.max(0, M('boss1Start', 22) - 0.6);
  for (const [len, w, fps] of [[8, 680, 13], [7, 620, 12], [6.5, 560, 12], [6, 520, 12], [6, 460, 11]]) {
    const vf = `fps=${fps},scale=${w}:-1:flags=lanczos`;
    await ff(['-ss', String(gStart), '-t', String(len), '-i', videoPath, '-vf', `${vf},palettegen=stats_mode=diff`, pal]);
    await ff(['-ss', String(gStart), '-t', String(len), '-i', videoPath, '-i', pal,
      '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, gif]);
    const mb = (await stat(gif)).size / 1048576;
    console.log(`hero gif ${w}px ${fps}fps ${len}s -> ${mb.toFixed(2)} MB`);
    if (mb <= 5) break;
  }

  for (const f of [trailer, gif, poster]) console.log('  ✓', f, ((await stat(f)).size / 1048576).toFixed(2), 'MB');
  console.log('\ndone. keep scripts/.rec/raw.webm for re-cuts, or delete it.');
}

main().catch(e => { console.error(e); process.exit(1); });
