'use client';

import * as React from 'react';

import { Slider } from '@/components/ui/slider';
import { AREA_MAX_M2, AREA_MIN_M2 } from '@/lib/config/constants';

export interface RoomSliderProps {
  /** Room area in 0.1 m^2 units, 10..100 (i.e. 1.0m^2 .. 10.0m^2). */
  areaTenths: number;
  onChange: (tenths: number) => void;
}

const SLIDER_MIN = AREA_MIN_M2 * 10;
const SLIDER_MAX = AREA_MAX_M2 * 10;

const areaFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const sideFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A labelled, accessible slider for the square room's floor area, in
 * 0.1 m^2 steps from 1.0m^2 to 10.0m^2. Displays both the area and the
 * derived side length of the square room (sqrt(area)).
 */
export function RoomSlider({ areaTenths, onChange }: RoomSliderProps) {
  const areaM2 = areaTenths / 10;
  const sideM = Math.sqrt(areaM2);
  const sliderId = React.useId();

  const handleValueChange = React.useCallback(
    (values: number[]) => {
      const next = values[0];
      if (typeof next === 'number') {
        onChange(next);
      }
    },
    [onChange],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <label
          htmlFor={sliderId}
          className="text-sm font-medium text-foreground"
        >
          Room floor area
        </label>
        <span className="text-sm text-muted-foreground">
          {areaFormatter.format(areaM2)}&nbsp;m&sup2; &middot; side{' '}
          {sideFormatter.format(sideM)}&nbsp;m
        </span>
      </div>
      <Slider
        id={sliderId}
        min={SLIDER_MIN}
        max={SLIDER_MAX}
        step={1}
        value={[areaTenths]}
        onValueChange={handleValueChange}
        aria-label="Room floor area"
        aria-valuetext={`${areaFormatter.format(areaM2)} square meters, ${sideFormatter.format(sideM)} meter square side`}
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{AREA_MIN_M2.toFixed(1)}&nbsp;m&sup2;</span>
        <span>{AREA_MAX_M2.toFixed(1)}&nbsp;m&sup2;</span>
      </div>
    </div>
  );
}

export default RoomSlider;
