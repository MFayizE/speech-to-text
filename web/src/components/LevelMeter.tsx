import { useImperativeHandle, useRef, type Ref } from 'react';

export interface LevelMeterHandle {
  push(level: number): void;
  reset(): void;
}

const BARS = 36;

/**
 * Scrolling input-level strip. Levels arrive every ~100 ms; bars are updated through
 * element styles directly so the mic never triggers React re-renders.
 */
export function LevelMeter({ ref, active }: { ref: Ref<LevelMeterHandle>; active: boolean }) {
  const barsRef = useRef<HTMLSpanElement[]>([]);
  const history = useRef<number[]>(new Array(BARS).fill(0));

  const paint = () => {
    history.current.forEach((v, i) => {
      const bar = barsRef.current[i];
      if (bar) bar.style.transform = `scaleY(${Math.max(0.08, v)})`;
    });
  };

  useImperativeHandle(ref, () => ({
    push(level) {
      history.current.shift();
      history.current.push(Math.min(1, level));
      paint();
    },
    reset() {
      history.current.fill(0);
      paint();
    },
  }));

  return (
    <div className={`meter${active ? ' is-active' : ''}`} aria-hidden>
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            if (el) barsRef.current[i] = el;
          }}
        />
      ))}
    </div>
  );
}
