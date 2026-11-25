/**
 * 深链巡检：把老的分享链接 / 二级页 hash 全部走一遍，确认不 404、落到预期页面。
 *
 * 用法：node scripts/check-hash.mjs [baseUrl]
 * 退出码：只要有任意一条不符就返回 1，方便以后塞进 CI。
 */
import { Browser, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5881';

/** [hash, 期望 data-route, 说明] */
const CASES = [
  ['#/', 'home', '根路径 = 剧场'],
  ['#/theater', 'home', '老「剧场」别名'],
  ['#/settings', 'settings', '设置页（B3 起独立）'],
  ['#/persons', 'rank', '老「演员榜」别名'],
  ['#/rank', 'rank', '榜单（二级页仍在）'],
  ['#/library', 'library', '追剧'],
  ['#/search', 'search', '搜索'],
  ['#/category', 'category', '分类'],
  ['#/newreleases', 'new', '新剧日历'],
  ['#/downloads', 'downloads', '下载'],
  ['#/feed', 'feed', '首页推荐流'],
];

const home = await (await fetch(`${BASE}/api/home`)).json();
const demoSeries = home?.data?.[0]?.items?.[0]?.seriesId ?? '';

const b = await Browser.launch({ port: 9336, width: 420, height: 900, userDataDir: '.tmp/cdp-profile-hash' });
let failures = 0;
try {
  await b.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 },
  });
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await b.goto(`${BASE}/`);
  await sleep(600);

  const snap = () =>
    b.eval(`(() => ({
      route: document.querySelector('.m-app')?.getAttribute('data-route') ?? '',
      title: (document.querySelector('.m-topbar__title')?.textContent ?? '').trim(),
      sheet: document.querySelector('.m-sheet') !== null,
      play: document.querySelector('.m-playwrap') !== null,
    }))()`);

  for (const [hash, expect, note] of CASES) {
    await b.goto(`${BASE}/${hash}`);
    await sleep(450);
    const got = await snap();
    const ok = got.route === expect;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${hash.padEnd(16)} → ${got.route.padEnd(11)} (期望 ${expect})  ${note}`);
  }

  if (demoSeries !== '') {
    await b.goto(`${BASE}/#/series/${demoSeries}`);
    await sleep(900);
    const got = await snap();
    const ok = got.sheet;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  #/series/<id>     → sheet=${got.sheet}（详情抽屉）`);
  }

  await b.goto(`${BASE}/#/play/123456/7654321/1`);
  await sleep(700);
  const play = await snap();
  if (!play.play) failures += 1;
  console.log(`${play.play ? 'PASS' : 'FAIL'}  #/play/...        → playwrap=${play.play}`);

  await b.goto(`${BASE}/#/mini/123456/7654321/1`);
  await sleep(700);
  const mini = await snap();
  console.log(`INFO  #/mini/...       → route=${mini.route || '(空)'}（手机壳不渲染小窗，回落到剧场，不 404）`);
} finally {
  await b.close();
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条不符`);
process.exit(failures === 0 ? 0 : 1);
