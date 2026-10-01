export function AnnotationBubble({ number, size = 20, tone = 'annotation' }: { number?: number; size?: number; tone?: 'neutral' | 'annotation' }) {
  return <svg className="annotation-bubble" data-tone={tone} data-numbered={number !== undefined} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 3h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H9l-5 3V7a4 4 0 0 1 3-4Z"/>
    {number !== undefined && <text x="12.5" y="11" textAnchor="middle" dominantBaseline="central">{number}</text>}
  </svg>;
}
