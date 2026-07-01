'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Mode } from '@/lib/packer/types';

export interface ModeButtonsProps {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
}

const MODES: Array<{ mode: Mode; label: string; description: string }> = [
  {
    mode: 'cheapest',
    label: 'Cheapest carpet',
    description: 'Picks a layout that minimizes total PLN value per m².',
  },
  {
    mode: 'densest',
    label: 'Densest storage',
    description: 'Maximizes the fraction of floor area covered by pieces.',
  },
  {
    mode: 'fewest',
    label: 'Fewest pieces',
    description: 'Minimizes the number of individual notes/coins used.',
  },
];

/**
 * Mode picker for the packing objective. Three mutually-exclusive buttons;
 * the active mode is rendered with the solid/default variant, inactive
 * modes with the outline variant.
 */
export function ModeButtons({ mode, onModeChange }: ModeButtonsProps) {
  return (
    <div
      role="group"
      aria-label="Packing objective"
      className="flex flex-wrap gap-2"
    >
      {MODES.map(({ mode: m, label, description }) => {
        const active = m === mode;
        return (
          <Button
            key={m}
            type="button"
            variant={active ? 'default' : 'outline'}
            aria-pressed={active}
            title={description}
            onClick={() => onModeChange(m)}
            className={cn(active && 'shadow-sm')}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}

export default ModeButtons;
