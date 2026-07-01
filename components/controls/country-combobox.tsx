'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Check, ChevronsUpDown } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { listCurrencies } from '@/lib/currency/dataset';

export interface CountryComboboxProps {
  /** Currently selected currency code, e.g. 'PLN'. */
  value: string;
  onSelect: (code: string) => void;
}

/**
 * A cmdk-powered, filterable currency picker. The trigger button shows the
 * current currency's flag and code; activating it opens a command-palette
 * style dialog listing every currency in the dataset, filterable by code
 * or name.
 */
export function CountryCombobox({ value, onSelect }: CountryComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const currencies = React.useMemo(() => listCurrencies(), []);
  const current = React.useMemo(
    () => currencies.find((c) => c.code === value),
    [currencies, value],
  );

  const handleSelect = React.useCallback(
    (code: string) => {
      onSelect(code);
      setOpen(false);
    },
    [onSelect],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        role="combobox"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Select currency"
        className="w-full justify-between gap-2 sm:w-64"
        onClick={() => setOpen(true)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {current ? (
            <>
              <span
                className={cn('fi', `fi-${current.flag}`, 'shrink-0 rounded-sm')}
                aria-hidden="true"
              />
              <span className="truncate font-medium">{current.code}</span>
              <span className="truncate text-muted-foreground">
                {current.name}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Select currency&hellip;</span>
          )}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
      </Button>

      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Select currency</DialogTitle>
        <CommandPrimitive className="flex h-full w-full flex-col overflow-hidden bg-popover text-popover-foreground">
          <div className="flex items-center border-b border-border px-3">
            <CommandPrimitive.Input
              autoFocus
              placeholder="Search by code or name&hellip;"
              className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <CommandPrimitive.List className="max-h-80 overflow-y-auto overflow-x-hidden p-1">
            <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
              No currency found.
            </CommandPrimitive.Empty>
            {currencies.map((currency) => {
              const selected = currency.code === value;
              return (
                <CommandPrimitive.Item
                  key={currency.code}
                  value={`${currency.code} ${currency.name}`}
                  onSelect={() => handleSelect(currency.code)}
                  className={cn(
                    'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none',
                    'aria-selected:bg-accent aria-selected:text-accent-foreground',
                  )}
                >
                  <span
                    className={cn('fi', `fi-${currency.flag}`, 'shrink-0 rounded-sm')}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{currency.code}</span>
                  <span className="truncate text-muted-foreground">
                    {currency.name}
                  </span>
                  {selected && (
                    <Check className="ml-auto h-4 w-4 shrink-0 text-foreground" />
                  )}
                </CommandPrimitive.Item>
              );
            })}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

export default CountryCombobox;
