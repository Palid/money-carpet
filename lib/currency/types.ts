export type PieceKind = 'note' | 'coin';
export type CoinShape = 'circle' | 'polygon';
export type LegalStatus = 'circulating' | 'legalTenderNotIssued';

export interface NoteSpec {
  kind: 'note';
  minorValue: number; // integer minor units (10 zł -> 1000 when minorDigits=2)
  widthMm: number; // horizontal extent
  heightMm: number; // vertical extent
  color: string; // hex fill
  label: string; // e.g. "10 zł", "$100"
  series?: string;
  sourceUrl?: string;
  status?: LegalStatus; // default 'circulating'
}
export interface CoinSpec {
  kind: 'coin';
  minorValue: number;
  diameterMm: number; // across-corners for polygons
  shape: CoinShape;
  sides?: number; // polygon side count
  color: string;
  label: string;
  series?: string;
  sourceUrl?: string;
  status?: LegalStatus;
}
export type Denomination = NoteSpec | CoinSpec;
export interface Currency {
  code: string; // ISO 4217, e.g. 'PLN'
  name: string;
  flag: string; // ISO 3166-1 alpha-2 lowercase for flag-icons, e.g. 'pl'
  minorDigits: number; // 2 for PLN, 0 for JPY
  denominations: Denomination[];
}
export interface Dataset {
  version: number;
  currencies: Currency[];
}
