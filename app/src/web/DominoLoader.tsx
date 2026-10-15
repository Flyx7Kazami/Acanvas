import { DOMINO_BOUNDS, DOMINO_PATH, DOMINO_TRANSFORMS, DOMINO_VIEWBOX } from './domino-loader.generated';
import './domino-loader.generated.css';

/** Decorative motion; the surrounding loading state supplies its stable status. */
export function DominoLoader({ size = 48, className = '' }: { size?: number; className?: string }) {
  return <svg className={`domino-loader ${className}`.trim()} width={size} height={size} viewBox={DOMINO_VIEWBOX} fill="none" stroke="none" aria-hidden="true" focusable="false">
    <foreignObject width={DOMINO_BOUNDS[0]} height={DOMINO_BOUNDS[1]}><div {...{ xmlns: 'http://www.w3.org/1999/xhtml' }} className="domino-stage">
      {DOMINO_TRANSFORMS.map((_, index) => <div key={index} className={`domino-layer domino-card-${index}`}><svg width="1" height="1" viewBox="0 0 1 1"><path d={DOMINO_PATH}/></svg></div>)}
    </div></foreignObject>
  </svg>;
}
