import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { MobileApp } from './mobile/MobileApp.tsx';
import './design/tokens.css';
import './design/glass.css';
import './design/content.css';
import './design/detail.css';
import './design/play.css';
import './design/danmaku.css';
import './design/feed.css';
import './design/newreleases.css';
import './design/library.css';
import './design/downloads.css';
import './design/mini.css';
import './design/motion.css';
import './design/share.css';
import './styles.css';
import './design/v2.css';
// 旧手机覆盖层：只给播放器/推荐页用，新界面不依赖它
import './design/mobile.css';
// 全新手机界面（m-*）：最后加载，独立于桌面端样式
import './mobile/mobile.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root 不存在');

// 小窗（?mini=1）：整页黑底、无滚动，避免出现白边
if (location.search.includes('mini=1')) document.documentElement.classList.add('mini-mode');

/**
 * 手机端走全新界面（m-*），桌面宽度仍用原界面。
 * 不能只看 max-width：横屏冷启动时 Android WebView 宽度会超过 900，
 * 会被误判成桌面端而渲染旧界面。原生桥/Android UA 优先级最高。
 */
const isPhone =
  Boolean(window.HorunAndroid) ||
  /Android/i.test(navigator.userAgent) ||
  window.matchMedia('(max-width: 900px)').matches ||
  window.matchMedia('(pointer: coarse)').matches;
if (isPhone) document.documentElement.classList.add('m-mode');

createRoot(root).render(<StrictMode>{isPhone ? <MobileApp /> : <App />}</StrictMode>);
