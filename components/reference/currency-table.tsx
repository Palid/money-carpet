'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { listCurrencies } from '@/lib/currency/dataset';
import { faceValueMajor, footprintM2 } from '@/lib/currency/derived';
import type { Denomination } from '@/lib/currency/types';

interface Row {
  key: string;
  currencyCode: string;
  currencyName: string;
  flag: string;
  label: string;
  kind: Denomination['kind'];
  dims: string;
  dimsSortValue: number;
  footprintCm2: number;
  faceValue: number;
  faceValueDisplay: string;
  notIssued: boolean;
}

type SortColumn =
  | 'currency'
  | 'denomination'
  | 'kind'
  | 'dimensions'
  | 'footprint'
  | 'faceValue';

interface SortState {
  column: SortColumn;
  direction: 'asc' | 'desc';
}

const cm2Formatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const faceValueFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

function dimsLabel(d: Denomination): [string, number] {
  if (d.kind === 'note') {
    return [`${d.widthMm}×${d.heightMm} mm`, d.widthMm * d.heightMm];
  }
  return [`⌀${d.diameterMm} mm`, d.diameterMm];
}

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (const currency of listCurrencies()) {
    for (const denom of currency.denominations) {
      const [dims, dimsSortValue] = dimsLabel(denom);
      const faceValue = faceValueMajor(denom, currency.minorDigits);
      rows.push({
        key: `${currency.code}:${denom.label}`,
        currencyCode: currency.code,
        currencyName: currency.name,
        flag: currency.flag,
        label: denom.label,
        kind: denom.kind,
        dims,
        dimsSortValue,
        footprintCm2: footprintM2(denom) * 1e4,
        faceValue,
        faceValueDisplay: `${faceValueFormatter.format(faceValue)} ${currency.code}`,
        notIssued: denom.status === 'legalTenderNotIssued',
      });
    }
  }
  return rows;
}

function compareRows(a: Row, b: Row, column: SortColumn): number {
  switch (column) {
    case 'currency':
      return a.currencyCode.localeCompare(b.currencyCode);
    case 'denomination':
      return a.label.localeCompare(b.label);
    case 'kind':
      return a.kind.localeCompare(b.kind);
    case 'dimensions':
      return a.dimsSortValue - b.dimsSortValue;
    case 'footprint':
      return a.footprintCm2 - b.footprintCm2;
    case 'faceValue':
      return a.faceValue - b.faceValue;
    default:
      return 0;
  }
}

const COLUMNS: Array<{ column: SortColumn; label: string }> = [
  { column: 'currency', label: 'Currency' },
  { column: 'denomination', label: 'Denomination' },
  { column: 'kind', label: 'Kind' },
  { column: 'dimensions', label: 'Dimensions' },
  { column: 'footprint', label: 'Footprint (cm²)' },
  { column: 'faceValue', label: 'Face value' },
];

/**
 * Collapsible, sortable reference table listing every currency and
 * denomination in the dataset, with physical dimensions and derived
 * footprint. Purely a client-side data view -- reads directly from the
 * currency dataset, no external props.
 */
export function CurrencyTable() {
  const [open, setOpen] = React.useState(false);
  const [sort, setSort] = React.useState<SortState>({
    column: 'currency',
    direction: 'asc',
  });
  const contentId = React.useId();

  const rows = React.useMemo(() => buildRows(), []);

  const sortedRows = React.useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = compareRows(a, b, sort.column);
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort]);

  const handleSort = React.useCallback((column: SortColumn) => {
    setSort((prev) => {
      if (prev.column === column) {
        return {
          column,
          direction: prev.direction === 'asc' ? 'desc' : 'asc',
        };
      }
      return { column, direction: 'asc' };
    });
  }, []);

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium"
      >
        <span>
          Currency &amp; denomination reference
          <span className="ml-2 text-muted-foreground">
            ({rows.length} denominations)
          </span>
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div id={contentId} className="border-t border-border">
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-muted/80 text-xs uppercase text-muted-foreground backdrop-blur">
                <tr>
                  {COLUMNS.map(({ column, label }) => {
                    const active = sort.column === column;
                    return (
                      <th key={column} scope="col" className="px-3 py-2 font-medium">
                        <button
                          type="button"
                          onClick={() => handleSort(column)}
                          className={cn(
                            'flex items-center gap-1 hover:text-foreground',
                            active && 'text-foreground',
                          )}
                          aria-sort={
                            active
                              ? sort.direction === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          {label}
                          {active && (
                            <span aria-hidden="true">
                              {sort.direction === 'asc' ? '↑' : '↓'}
                            </span>
                          )}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => (
                  <tr key={row.key} className="border-t border-border">
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-2">
                        <span
                          className={cn('fi', `fi-${row.flag}`, 'rounded-sm')}
                          aria-hidden="true"
                        />
                        <span className="font-medium">{row.currencyCode}</span>
                        <span className="text-muted-foreground">
                          {row.currencyName}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-2">
                        {row.label}
                        {row.notIssued && (
                          <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                            not issued
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 capitalize">{row.kind}</td>
                    <td className="px-3 py-2 tabular-nums">{row.dims}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {cm2Formatter.format(row.footprintCm2)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {row.faceValueDisplay}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default CurrencyTable;
