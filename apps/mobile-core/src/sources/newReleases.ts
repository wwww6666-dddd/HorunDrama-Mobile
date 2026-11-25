/** 上新日历（新剧）：SDK newReleases 的薄适配。 */
import { getClient, normalizeCover, withRetry } from './client.ts';
import { createLogger } from '../util/log.ts';

const log = createLogger('new-releases');

export interface NewReleaseItem {
  seriesId: string;
  title: string;
  cover: string;
  intro: string;
  episodeCount: number;
  /** true=已上线；false=预告（publishAt 是上线时间） */
  online: boolean;
  publishAt: string;
  categories: string[];
  /** 已上线是「378万热度」，预告是「159.7万人预约」 */
  heat: string;
  note: string;
}

export interface NewReleasePageView {
  date: string;
  dates: string[];
  items: NewReleaseItem[];
  hasMore: boolean;
  cursor: string;
}

export async function newReleasesPage(date = '', cursor = ''): Promise<NewReleasePageView> {
  const client = await getClient();
  const query: { date?: string; cursor?: string } = {};
  if (date !== '') query.date = date;
  if (cursor !== '') query.cursor = cursor;

  const page = await withRetry('上新日历', () => client.newReleases(query));
  log.debug(`上新日历 ${date || '(today)'} 本页 ${page.items?.length ?? 0} 部 hasMore=${String(page.has_more)}`);

  return {
    date: page.date ?? date,
    dates: page.dates ?? [],
    items: (page.items ?? []).map((item) => ({
      seriesId: item.series_id,
      title: item.title,
      cover: normalizeCover(item.cover_url ?? ''),
      intro: item.description ?? '',
      episodeCount: item.episode_count ?? 0,
      online: item.online === true,
      publishAt: item.publish_at ?? '',
      categories: item.categories ?? [],
      heat: item.heat ?? '',
      note: item.note ?? '',
    })),
    hasMore: page.has_more === true,
    cursor: page.cursor ?? '',
  };
}
