import './domino-loader.css';

/** Instances share one vector animation document; the surrounding state supplies its status. */
export function DominoLoader({ size = 48, className = '' }: { size?: number; className?: string }) {
  return <picture className={`domino-loader ${className}`.trim()} aria-hidden="true">
    <source media="(prefers-reduced-motion: reduce)" srcSet="/domino-loader-still.svg"/>
    <img src="/domino-loader.svg" width={size} height={size} style={{ width: size, height: size, maxWidth: 'none', maxHeight: 'none', objectFit: 'fill', borderRadius: 0, background: 'transparent' }} alt="" draggable={false}/>
  </picture>;
}
