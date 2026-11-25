/**
 * 六档视口 + 四个 Tab 的批量截图（阶段 A 验收用）。
 *
 * 视口口径严格按开发文档 §8.5：320×568 / 360×640 / 360×800 / 375×667 / 390×844 / 412×915。
 * 和 shot.mjs 的区别：这里逐个改视口跑，专门看窄屏 320 和大屏有没有破版；
 * 顺手查 document.scrollWidth > innerWidth（横向溢出），推荐流会先晃鼠标把顶栏唤出来再拍。
 *
 * 用法：node scripts/shot-views.mjs [baseUrl]
 * 输出：.tmp/shots/views/<宽>x<高>-<页面>.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { Browser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5881';
const SIZES = [
  [320, 568],
  [360, 640],
  [360, 800],
  [375, 667],
  [390, 844],
  [412, 915],
];
const VIEWS = ['theater', 'feed', 'welfare', 'library', 'me'];
const OUT = path.resolve('.tmp/shots/views');

fs.mkdirSync(OUT, { recursive: true });

const b = await Browser.launch({ port: 9335, width: 960, height: 960, userDataDir: path.resolve('.tmp/cdp-profile-views') });
let overflows = 0;
try {
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await b.goto(`${BASE}/`);
  await b.eval(`localStorage.setItem('horun-theme','dark'); localStorage.setItem('horun-accent','ember')`);
  await b.send('Page.reload');
  await sleep(1200);

  // 预热剧场与推荐流：首个视口往往是冷启动，否则 320×568 会截到骨架屏
  await b.goto(`${BASE}/#/`);
  await sleep(3200);
  await b.goto(`${BASE}/#/feed`);
  await sleep(3000);

  for (const [width, height] of SIZES) {
    await b.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: true,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });

    for (const view of VIEWS) {
      const hash = view === 'theater' ? '#/' : `#/${view}`;
      await b.goto(`${BASE}/${hash}`);
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width / 2, y: 160 });
      await sleep(view === 'feed' ? 3200 : 2200);
      if (view === 'feed') {
        // 再晃一次，确保顶栏（汉堡/搜索）在快门按下时是显示的
        await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width / 2, y: 220 });
        await sleep(180);
      }
      const file = path.join(OUT, `${width}x${height}-${view}.png`);
      await b.shot(file);
      const overflow = await b.eval('document.documentElement.scrollWidth > window.innerWidth');
      if (overflow) overflows += 1;
      console.log('shot', file, overflow ? '横向溢出!' : 'ok');
    }
  }
} finally {
  await b.close();
}

console.log(overflows === 0 ? '\n六档无横向溢出' : `\n${overflows} 张出现横向溢出`);
process.exit(overflows === 0 ? 0 : 1);

