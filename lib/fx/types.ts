export type FxSource = 'live' | 'snapshot';

export interface RatesResponse {
  base: 'PLN';
  date: string; // ISO date of the rates
  source: FxSource;
  stale: boolean; // true when snapshot fallback served
  snapshotId: string; // stable id per rate set (e.g. `${source}:${date}`)
  ratesToPLN: Record<string, number>; // PLN value of ONE MAJOR unit of each currency; ratesToPLN['PLN']===1
}
