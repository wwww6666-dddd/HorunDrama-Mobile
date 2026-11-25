/**
 * 福利页：对齐官方 7.4.5.32「福利」。
 *
 * 官方是金币/现金收益 + 今日待办 + 看短剧得福利 + 追剧挑战赛 + 日常福利。
 * 这里是**本地演示**：金币只存在浏览器 localStorage，不兑换现金、不上传；
 * 待办用真实的本机数据判定（收藏 1 部 / 追剧 1 部 / 看过 1 部），
 * 七天签到按自然日累积，断签从第 1 天重新算。
 */
import { useState, type JSX } from 'react';
import { api } from '../../api.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { useNav } from '../nav.tsx';
import { Icon } from '../ui.tsx';

const KEY = 'horun-welfare-v1';
/** 连续 7 天的签到金币（第 7 天最多，之后循环回第 1 天） */
const REWARDS = [10, 10, 15, 15, 20, 20, 30];
/** 三项待办全部完成后的额外金币 */
const BONUS = 30;

interface WelfareState {
  coins: number;
  /** 已签到的自然日，YYYY-MM-DD */
  days: string[];
  /** 已领过「今日待办」奖励的日期 */
  bonusDays: string[];
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function load(): WelfareState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<WelfareState> | null;
    return {
      coins: typeof raw?.coins === 'number' && raw.coins >= 0 ? raw.coins : 0,
      days: Array.isArray(raw?.days) ? raw.days.filter((x): x is string => typeof x === 'string') : [],
      bonusDays: Array.isArray(raw?.bonusDays) ? raw.bonusDays.filter((x): x is string => typeof x === 'string') : [],
    };
  } catch {
    return { coins: 0, days: [], bonusDays: [] };
  }
}

function save(state: WelfareState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式/配额满：本次仍然按内存里的状态走 */
  }
}

/** 连续签到天数；今天没签但昨天签了，也算连续（今天还能续上） */
function streakOf(days: string[]): number {
  const set = new Set(days);
  const d = new Date();
  if (!set.has(todayKey())) {
    d.setDate(d.getDate() - 1);
    if (!set.has(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)) return 0;
  }
  let n = 0;
  for (let i = 0; i < 400; i += 1) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!set.has(key)) break;
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

/** 底栏小红点：今天还没签到就亮 */
export function welfareUnclaimed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return !load().days.includes(todayKey());
}

export function Welfare(): JSX.Element {
  const { go } = useNav();
  const [state, setState] = useState<WelfareState>(load);
  const [note, setNote] = useState('');
  const stats = useAsync(async (signal) => {
    const [fav, follow, history] = await Promise.all([
      api.favorites(signal),
      api.follows(signal),
      api.continueWatching(20, signal),
    ]);
    return { fav: fav.length, follow: follow.length, history: history.length };
  }, []);

  const today = todayKey();
  const signed = state.days.includes(today);
  const streak = streakOf(state.days);
  /** 今天签到落在第几天（1..7）；已签则显示今天应得的那一格 */
  const dayIndex = signed ? Math.max(1, Math.min(7, streak)) : Math.min(7, streak + 1);
  const todayReward = REWARDS[dayIndex - 1] ?? REWARDS[0] ?? 10;

  const done = stats.data === null
    ? 0
    : [stats.data.history >= 1, stats.data.fav >= 1, stats.data.follow >= 1].filter(Boolean).length;
  const bonusClaimed = state.bonusDays.includes(today);

  const flash = (text: string): void => {
    setNote(text);
    window.setTimeout(() => setNote((cur) => (cur === text ? '' : cur)), 1800);
  };

  const signIn = (): void => {
    if (signed) return;
    const next: WelfareState = { ...state, coins: state.coins + todayReward, days: [...state.days, today] };
    save(next);
    setState(next);
    flash(`签到成功，金币 +${todayReward}`);
  };

  const claimBonus = (): void => {
    if (done < 3 || bonusClaimed) return;
    const next: WelfareState = { ...state, coins: state.coins + BONUS, bonusDays: [...state.bonusDays, today] };
    save(next);
    setState(next);
    flash(`今日待办完成，金币 +${BONUS}`);
  };

  const tasks = [
    { key: 'watch', title: '看过 1 部短剧', sub: stats.data?.history ? `已看过 ${stats.data.history} 部` : '去首页刷一集', done: (stats.data?.history ?? 0) >= 1, go: () => go('feed') },
    { key: 'fav', title: '收藏 1 部短剧', sub: stats.data?.fav ? `已收藏 ${stats.data.fav} 部` : '在推荐页点收藏', done: (stats.data?.fav ?? 0) >= 1, go: () => go('feed') },
    { key: 'follow', title: '追剧 1 部', sub: stats.data?.follow ? `已追 ${stats.data.follow} 部` : '点作者头像下的「+」', done: (stats.data?.follow ?? 0) >= 1, go: () => go('library') },
  ];

  return (
    <div className="wf">
      <header className="wf-hero">
        <div className="wf-hero__stats">
          <div className="wf-hero__stat">
            <span>金币收益 ›</span>
            <b>{state.coins}</b>
          </div>
          <div className="wf-hero__stat">
            <span>现金收益(元) ›</span>
            <b>0.00</b>
          </div>
        </div>
        <p className="wf-hero__note">金币仅本地记录，用于演示福利流程，不可提现</p>
        <button type="button" className="wf-hero__cta" data-on={signed} onClick={signIn}>
          {signed ? '今日已签到' : `签到领 ${todayReward} 金币`}
        </button>
        {note !== '' && <p className="wf-hero__toast">{note}</p>}
      </header>

      <section className="wf-card">
        <div className="wf-card__head">
          <h3>今日待办 {done}/3</h3>
          <button type="button" className="wf-card__claim" data-on={bonusClaimed} disabled={done < 3 || bonusClaimed} onClick={claimBonus}>
            {bonusClaimed ? '已领取' : `领 ${BONUS} 金币`}
          </button>
        </div>
        <p className="wf-card__sub">三项都完成可领 {BONUS} 金币，用本机真实记录判定</p>
        <ul className="wf-tasks">
          {tasks.map((task) => (
            <li key={task.key} className="wf-task" data-done={task.done}>
              <span className="wf-task__icon">
                <Icon name={task.key === 'fav' ? 'bookmark' : task.key === 'follow' ? 'heart' : 'play'} size={17} />
              </span>
              <span className="wf-task__text">
                <b>{task.title}</b>
                <em>{task.done ? '已完成' : task.sub}</em>
              </span>
              <button type="button" className="wf-task__btn" onClick={task.go}>
                {task.done ? '已完成' : '去完成'}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="wf-card wf-card--warm">
        <div className="wf-card__head">
          <h3>连续签到领金币</h3>
          <span className="wf-card__streak">已连签 {streak} 天</span>
        </div>
        <div className="wf-packets">
          {REWARDS.map((amount, i) => (
            <div className="wf-packet" key={amount + i} data-today={i === dayIndex - 1} data-past={i < dayIndex - 1}>
              <span>第{i + 1}天</span>
              <b>+{amount}</b>
            </div>
          ))}
        </div>
        <p className="wf-card__hint">每天签到一次，第 7 天 +30；断签从第 1 天重新累积</p>
      </section>

      <section className="wf-card">
        <h3>日常福利</h3>
        <ul className="wf-lines">
          <li>看剧每满 10 分钟，可在播放页领 1 次金币</li>
          <li>追完一部剧，次日可领完结奖励</li>
          <li>金币只记在本机，换设备/清缓存会归零</li>
        </ul>
      </section>

      <p className="wf-foot">本页为本地福利演示，不涉及任何提现或支付</p>
    </div>
  );
}
