/**
 * 手机视口截图：用系统 Edge（无头）开 390×844、触摸、DPR2，
 * 逐页截图到 D:\红果短剧手机端\.tmp\shots，供肉眼核对手机布局。
 *
 * 用法：node scripts/shot.mjs [baseUrl] [view1 view2 ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Browser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5881';
const VIEWS = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ['theater', 'feed', 'library', 'me', 'rank', 'search', 'category', 'newreleases', 'downloads'];
const OUT = path.resolve('.tmp/shots');
fs.mkdirSync(OUT, { recursive: true });

const b = await Browser.launch({ port: 9334, width: 420, height: 900, userDataDir: path.resolve('.tmp/cdp-profile-mobile') });
try {
  await b.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 },
  });
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await b.send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l',
  });

  // 固定成深色主题再截图：手机端首装默认深色
  await b.goto(`${BASE}/`);
  await b.eval(`localStorage.setItem('horun-theme','dark'); localStorage.setItem('horun-accent','ember')`);
  await b.send('Page.reload');
  await sleep(1500);

  for (const view of VIEWS) {
    const hash = view.startsWith('#') ? view : view === 'theater' ? '#/' : `#/${view}`;
    await b.goto(`${BASE}/${hash}`);
    await sleep(view.startsWith('#/play') || view === 'feed' ? 9000 : 8000);
    const name = view.startsWith('#') ? view.replace(/^#\//, '').replace(/[^a-z0-9]+/gi, '-') : view;
    const file = path.join(OUT, `${name}.png`);
    await b.shot(file);
    console.log('shot', file);
  }
} finally {
  await b.close();
}
