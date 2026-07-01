import { z } from 'zod';

import rawDataset from '@/data/currencies.json';
import type { Currency, Dataset, Denomination } from '@/lib/currency/types';

const legalStatusSchema = z.enum(['circulating', 'legalTenderNotIssued']);

const noteSpecSchema = z.object({
  kind: z.literal('note'),
  minorValue: z.number().int().nonnegative(),
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  color: z.string(),
  label: z.string(),
  series: z.string().optional(),
  sourceUrl: z.string().optional(),
  status: legalStatusSchema.optional(),
});

const coinSpecSchema = z.object({
  kind: z.literal('coin'),
  minorValue: z.number().int().nonnegative(),
  diameterMm: z.number().positive(),
  shape: z.enum(['circle', 'polygon']),
  sides: z.number().int().positive().optional(),
  color: z.string(),
  label: z.string(),
  series: z.string().optional(),
  sourceUrl: z.string().optional(),
  status: legalStatusSchema.optional(),
});

const denominationSchema = z.discriminatedUnion('kind', [
  noteSpecSchema,
  coinSpecSchema,
]);

const currencySchema = z.object({
  code: z.string().length(3),
  name: z.string(),
  flag: z.string(),
  minorDigits: z.number().int().nonnegative(),
  denominations: z.array(denominationSchema).min(1),
});

const datasetSchema = z.object({
  version: z.number().int().positive(),
  currencies: z.array(currencySchema).min(1),
});

// Validate at module load so a malformed dataset fails loudly, immediately,
// rather than surfacing as a confusing downstream error.
const parsed = datasetSchema.safeParse(rawDataset);
if (!parsed.success) {
  throw new Error(
    `Invalid currencies dataset (data/currencies.json): ${parsed.error.message}`,
  );
}

const dataset: Dataset = parsed.data as Dataset;

export function getDataset(): Dataset {
  return dataset;
}

export function getCurrency(code: string): Currency {
  const currency = dataset.currencies.find(
    (c) => c.code.toUpperCase() === code.toUpperCase(),
  );
  if (!currency) {
    throw new Error(`Unknown currency code: ${code}`);
  }
  return currency;
}

export function listCurrencies(): Currency[] {
  return dataset.currencies;
}

export type { Denomination };
