// Serialized into the isolated preview before the supplied HTML. Keep this
// function self-contained: it must not close over imports or module constants.
export function installHtmlSnapshotBridge(instanceId: string, parentOrigin: string) {
  const send = parent.postMessage.bind(parent);
  let capturing = false;
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || event.origin !== parentOrigin || !data || data.type !== 'acanvas:preview-snapshot' || data.instanceId !== instanceId || typeof data.requestId !== 'string' || !/^[\w-]{1,80}$/.test(data.requestId) || capturing) return;
    capturing = true;
    try {
      const width = Math.ceil(innerWidth), height = Math.ceil(innerHeight);
      if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000) throw new Error('Preview dimensions are too large for a snapshot.');
      // HTML propagates the root (or otherwise the body's) background across
      // the viewport. foreignObject does not, so paint it separately without
      // enlarging the body and changing flex/grid or percentage layouts.
      const rootStyle = getComputedStyle(document.documentElement);
      const colorProbe = document.createElement('canvas'); colorProbe.width = colorProbe.height = 1;
      const colorContext = colorProbe.getContext('2d')!;
      colorContext.fillStyle = rootStyle.backgroundColor; colorContext.fillRect(0, 0, 1, 1);
      const transparentRoot = colorContext.getImageData(0, 0, 1, 1).data[3] === 0 && rootStyle.backgroundImage === 'none';
      const backgroundSource = transparentRoot && document.body ? document.body : document.documentElement;
      const background = document.createElement('div');
      background.style.cssText = 'all:initial!important;display:block!important;position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;';
      background.style.setProperty('background', getComputedStyle(backgroundSource).background, 'important');
      let nodes = 0, characters = 0;
      const excluded = new Set(['SCRIPT', 'LINK', 'META', 'BASE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE', 'ANIMATE', 'ANIMATEMOTION', 'ANIMATETRANSFORM', 'SET']);
      const clone = (source: Node): Node | null => {
        if (++nodes > 2000) throw new Error('Preview is too complex for a snapshot.');
        if (source.nodeType === Node.TEXT_NODE) { characters += source.textContent?.length ?? 0; return document.createTextNode(source.textContent ?? ''); }
        if (!(source instanceof Element) || excluded.has(source.tagName.toUpperCase())) return null;
        let target: Element;
        if (source instanceof HTMLCanvasElement) {
          if (source.width * source.height > 8_000_000) throw new Error('Canvas is too large for a snapshot.');
          target = document.createElement('img');
        } else target = source.cloneNode(false) as Element;
        for (const attribute of Array.from(target.attributes)) {
          if (/^on/i.test(attribute.name) || ['src', 'srcset', 'href', 'xlink:href', 'action', 'formaction', 'poster', 'autofocus'].includes(attribute.name.toLowerCase())) target.removeAttribute(attribute.name);
        }
        if (source instanceof HTMLCanvasElement) target.setAttribute('src', source.toDataURL('image/png'));
        else if (source instanceof HTMLImageElement && source.currentSrc.startsWith('data:image/')) target.setAttribute('src', source.currentSrc);
        const style = getComputedStyle(source);
        let css = '';
        for (const property of Array.from(style)) css += `${property}:${style.getPropertyValue(property)};`;
        css += 'animation:none!important;transition:none!important;caret-color:transparent!important;';
        if (source === backgroundSource) css += 'background:none!important;';
        target.setAttribute('style', css);
        characters += css.length + target.outerHTML.length;
        if (characters > 6 * 1024 * 1024) throw new Error('Preview snapshot is too large.');
        if (source instanceof HTMLInputElement) {
          target.setAttribute('value', source.type === 'password' ? '' : source.value);
          if (source.checked) target.setAttribute('checked', ''); else target.removeAttribute('checked');
        }
        if (source instanceof HTMLOptionElement) { if (source.selected) target.setAttribute('selected', ''); else target.removeAttribute('selected'); }
        if (source instanceof HTMLTextAreaElement) target.textContent = source.value;
        else if (!(source instanceof HTMLCanvasElement)) for (const child of Array.from(source.childNodes)) { const next = clone(child); if (next) target.appendChild(next); }
        return target;
      };
      const root = clone(document.documentElement) as HTMLElement;
      root.style.setProperty('margin', '0');
      root.style.setProperty('transform', `translate(${-scrollX}px, ${-scrollY}px)`);
      root.style.setProperty('transform-origin', 'top left');
      root.style.setProperty('width', `${width}px`);
      const freeze = document.createElement('style');
      freeze.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
      root.appendChild(freeze);
      const serializer = new XMLSerializer(), serialized = serializer.serializeToString(root);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="${width}" height="${height}">${serializer.serializeToString(background)}</foreignObject><foreignObject width="${width}" height="${height}">${serialized}</foreignObject></svg>`;
      if (new TextEncoder().encode(svg).byteLength > 6 * 1024 * 1024) throw new Error('Preview snapshot is too large.');
      send({ type: 'acanvas:preview-snapshot', instanceId, requestId: data.requestId, svg, width, height }, parentOrigin);
    } catch (error) {
      send({ type: 'acanvas:preview-snapshot-error', instanceId, requestId: data.requestId, error: error instanceof Error ? error.message : 'Snapshot is unavailable.' }, parentOrigin);
    } finally { capturing = false; }
  });
}
