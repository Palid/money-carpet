import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CANDIDATES } from '@/lib/config/constants';
import { getCurrency } from '@/lib/currency/dataset';
import { loadSnapshot } from '@/lib/fx/fetch';

import {
  buildPackRequest,
  createDebouncer,
  isStale,
} from '@/lib/state/recompute';

describe('buildPackRequest', () => {
  const rates = loadSnapshot();

  it('builds the exact PackRequest for PLN / 4.0 m2 / cheapest / excludeNonIssued', () => {
    const state = {
      currencyCode: 'PLN',
      areaTenths: 40,
      mode: 'cheapest' as const,
      excludeNonIssued: true,
    };

    const req = buildPackRequest(state, rates);

    expect(req).toEqual({
      currencyCode: 'PLN',
      areaTenths: 40,
      mode: 'cheapest',
      excludeNonIssued: true,
      plnPerMinor: 0.01, // 1 PLN per major unit / 10^2 minor digits
      fxSnapshotId: rates.snapshotId,
      fxStale: rates.stale,
      candidateCount: DEFAULT_CANDIDATES,
    });
  });

  it('computes plnPerMinor for a non-PLN currency from the given rates', () => {
    const eur = getCurrency('EUR');
    const req = buildPackRequest(
      {
        currencyCode: 'EUR',
        areaTenths: 55,
        mode: 'densest',
        excludeNonIssued: false,
      },
      rates,
    );

    expect(req.plnPerMinor).toBeCloseTo(
      rates.ratesToPLN['EUR'] / 10 ** eur.minorDigits,
      12,
    );
    expect(req.areaTenths).toBe(55);
    expect(req.mode).toBe('densest');
    expect(req.excludeNonIssued).toBe(false);
    expect(req.fxSnapshotId).toBe(rates.snapshotId);
    expect(req.fxStale).toBe(rates.stale);
    expect(req.candidateCount).toBe(DEFAULT_CANDIDATES);
  });

  it('always stamps candidateCount with DEFAULT_CANDIDATES', () => {
    const req = buildPackRequest(
      {
        currencyCode: 'JPY',
        areaTenths: 10,
        mode: 'fewest',
        excludeNonIssued: true,
      },
      rates,
    );
    expect(req.candidateCount).toBe(DEFAULT_CANDIDATES);
  });
});

describe('isStale', () => {
  it('is stale when the response id no longer matches the latest dispatched id', () => {
    expect(isStale(1, 2)).toBe(true);
  });

  it('is not stale when ids match', () => {
    expect(isStale(5, 5)).toBe(false);
  });
});

describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid schedule() calls into a single trailing invocation', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(fn);

    debouncer.schedule(200);
    vi.advanceTimersByTime(100);
    debouncer.schedule(200); // reschedules — resets the 200ms window
    vi.advanceTimersByTime(199);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a zero-ms schedule still goes through the timer queue (macrotask)', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(fn);

    debouncer.schedule(0);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel() prevents a pending invocation', () => {
    const fn = vi.fn();
    const debouncer = createDebouncer(fn);

    debouncer.schedule(200);
    debouncer.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
