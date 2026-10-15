export const scenePaintMethods = ['save', 'restore', 'setTransform', 'translate', 'scale', 'transform', 'beginPath', 'roundRect', 'rect', 'arc', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect', 'fillText', 'setLineDash', 'drawImage'] as const;
export const scenePaintStrings = ['font', 'fillStyle', 'strokeStyle', 'textBaseline', 'textAlign', 'direction', 'fontKerning', 'letterSpacing', 'lineCap', 'lineJoin'] as const;
export const scenePaintNumbers = ['globalAlpha', 'lineWidth'] as const;
export type ScenePaintMethod = typeof scenePaintMethods[number];
export type ScenePaintProperty = typeof scenePaintStrings[number] | typeof scenePaintNumbers[number];
export type ScenePaintArgument = string | number | number[] | Path2D | CanvasImageSource;
export type ScenePaintCommand = { op: 'set'; property: ScenePaintProperty; value: string | number }
  | { op: 'call'; method: ScenePaintMethod; args: ScenePaintArgument[] };

/** A finite drawing vocabulary keeps the private destination inside its frame owner. */
export function replayScenePaint(context: CanvasRenderingContext2D, commands: ScenePaintCommand[]): void {
  for (const command of commands) {
    if (command.op === 'set') {
      if ((scenePaintStrings as readonly string[]).includes(command.property)) { if (typeof command.value !== 'string') throw new TypeError('Scene paint values must be strings.'); }
      else if ((scenePaintNumbers as readonly string[]).includes(command.property)) { if (typeof command.value !== 'number' || !Number.isFinite(command.value)) throw new TypeError('Scene drawing values must be finite numbers.'); }
      else throw new TypeError('Use a supported scene paint property.');
      Reflect.set(context, command.property, command.value);
    } else if (command.op === 'call' && (scenePaintMethods as readonly string[]).includes(command.method)) {
      for (const [index, value] of command.args.entries()) {
        if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Scene drawing coordinates must be finite numbers.'); }
        else if (typeof value === 'string') { if (command.method !== 'fillText' || index !== 0) throw new TypeError('Use text at the scene text position.'); }
        else if (Array.isArray(value)) { if (command.method !== 'setLineDash' || index !== 0 || value.some(number => typeof number !== 'number' || !Number.isFinite(number))) throw new TypeError('Scene line dashes must be finite numbers.'); }
        else if (command.method === 'drawImage' && index === 0 && value && typeof value === 'object') { /* Canvas validates the native image source. */ }
        else if (['fill', 'stroke', 'clip'].includes(command.method) && index === 0 && value instanceof Path2D) { /* Paths are consumed synchronously. */ }
        else throw new TypeError('Use a supported scene drawing argument.');
      }
      Reflect.apply(context[command.method], context, command.args);
    } else throw new TypeError('Use a supported scene drawing command.');
  }
}
