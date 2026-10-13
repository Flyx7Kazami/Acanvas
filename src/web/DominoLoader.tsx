import { DOMINO_PATH, DOMINO_TRANSFORMS, DOMINO_VIEWBOX } from './domino-loader.generated';
import './domino-loader.generated.css';

/** Decorative motion; the surrounding loading state supplies its stable status. */
export function DominoLoader({ size = 48, className = '' }: { size?: number; className?: string }) {
  return <svg className={`domino-loader ${className}`.trim()} width={size} height={size} viewBox={DOMINO_VIEWBOX} fill="none" stroke="currentColor" aria-hidden="true" focusable="false">
    {DOMINO_TRANSFORMS.map((transform, index) => <path key={index} className={`domino-card-${index}`} d={DOMINO_PATH} transform={transform} vectorEffect="non-scaling-stroke"/>)}
  </svg>;
}
