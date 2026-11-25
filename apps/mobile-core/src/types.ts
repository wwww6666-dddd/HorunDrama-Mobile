/** 接口形状：前端与核心共用一套字段名，避免两边各写一份转换。 */

export interface Drama {
  seriesId: string;
  title: string;
  /** 已经换成免签 JPEG 的封面地址 */
  cover: string;
  intro: string;
  episodeCount: number;
  finished: boolean;
  heatText: string;
  tags: string[];
}

export interface HomeSection {
  tabType: string;
  tabName: string;
  items: Drama[];
}

export interface Paged<T> {
  items: T[];
  page: number;
  hasMore: boolean;
}

export interface RankBoard {
  id: string;
  name: string;
}

export interface RankGroup {
  id: string;
  name: string;
  boards: RankBoard[];
}

export type RankEntry =
  | { kind: 'series'; rank: number; score: string; drama: Drama }
  | {
      kind: 'actor';
      rank: number;
      score: string;
      userId: string;
      name: string;
      avatar: string;
      intro: string;
    };

export interface RankPage {
  content: string;
  board: string;
  groups: RankGroup[];
  items: RankEntry[];
  hasMore: boolean;
  cursor: string;
}

export interface FilterOption {
  name: string;
  value: string;
}

export interface FilterRow {
  key: string;
  name: string;
  options: FilterOption[];
}
