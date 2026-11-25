/** 推荐页 DOM 体检：结构、尺寸、定位链，一次性打印。 */
import path from 'node:path';
import { Browser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5881';
const b = await Browser.launch({ port: 9335, width: 420, height: 900, userDataDir: path.resolve('.tmp/cdp-profile-mobile') });
try {
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await b.goto(`${BASE}/#/feed`);
  await sleep(9000);
  const out = await b.eval(`(() => {
    const lines = [];
    const slide = document.querySelector('.feedv__slide');
    const frame = document.querySelector('.feedv__frame');
    const info = document.querySelector('.feedv__info');
    lines.push('SLIDE_CLASS=' + (slide ? slide.className : 'none'));
    if (slide) lines.push('SLIDE_HTML=' + slide.outerHTML.slice(0, 1200));
    for (const sel of ['.feedv', '.feedv__stage', '.feedv__slide', '.feedv__frame', '.feedv__frame .xgplayer', '.feedv__frame video', '.feedv__info']) {
      const el = document.querySelector(sel);
      if (!el) { lines.push(sel + ' -> MISSING'); continue; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      lines.push(sel + ' rect=' + [r.x|0, r.y|0, r.width|0, r.height|0].join(',') + ' pos=' + cs.position + ' h=' + cs.height + ' of=' + cs.objectFit + ' z=' + cs.zIndex);
    }
    // 谁在页面上部画了那行大字
    const tops = [...document.querySelectorAll('.feedv *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 18 && r.width > 200 && r.top < 200 && r.top > -40 && getComputedStyle(el).position !== 'static';
    }).slice(0, 8).map((el) => el.className + '|' + [el.getBoundingClientRect().top|0, el.getBoundingClientRect().height|0].join(','));
    lines.push('TOP_LAYERS=' + JSON.stringify(tops));
    return lines.join('\\n');
  })()`);
  console.log(out);
} finally {
  await b.close();
}
