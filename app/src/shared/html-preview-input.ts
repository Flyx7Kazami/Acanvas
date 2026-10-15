// Bootstrap runs before document scripts and keeps its input port private.
export function installHtmlInputBridge(instanceId: string, parentOrigin: string) {
  const channel = new MessageChannel(), input = channel.port1;
  const send = input.postMessage.bind(input), close = input.close.bind(input);
  const sendParent = parent.postMessage.bind(parent);
  const getter = (prototype: object, key: string) => Function.prototype.call.bind(Object.getOwnPropertyDescriptor(prototype, key)!.get!) as (event: Event) => any;
  const data = getter(MessageEvent.prototype, 'data');
  const clientX = getter(MouseEvent.prototype, 'clientX'), clientY = getter(MouseEvent.prototype, 'clientY');
  const ctrlKey = getter(MouseEvent.prototype, 'ctrlKey'), metaKey = getter(MouseEvent.prototype, 'metaKey');
  const relatedTarget = getter(MouseEvent.prototype, 'relatedTarget');
  const deltaX = getter(WheelEvent.prototype, 'deltaX'), deltaY = getter(WheelEvent.prototype, 'deltaY'), deltaMode = getter(WheelEvent.prototype, 'deltaMode');
  const preventDefault = Function.prototype.call.bind(Event.prototype.preventDefault);
  const stopImmediate = Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);
  let enabled = false;
  input.onmessage = event => { const value = data(event); if (value?.type === 'acanvas:preview-wheel-mode' && typeof value.enabled === 'boolean') enabled = value.enabled; };
  window.addEventListener('pointerover', event => {
    if (event.isTrusted && relatedTarget(event) === null) send({ type: 'acanvas:preview-engaged', instanceId, x: clientX(event) / innerWidth, y: clientY(event) / innerHeight });
  }, { capture: true });
  window.addEventListener('pointerout', event => {
    if (event.isTrusted && relatedTarget(event) === null) send({ type: 'acanvas:preview-left', instanceId });
  }, { capture: true });
  window.addEventListener('focusin', event => {
    if (event.isTrusted) send({ type: 'acanvas:preview-focus', instanceId });
  }, { capture: true });
  window.addEventListener('wheel', event => {
    if (!enabled || !event.isTrusted || innerWidth <= 0 || innerHeight <= 0) return;
    preventDefault(event); stopImmediate(event);
    send({ type: 'acanvas:preview-wheel', instanceId, x: clientX(event) / innerWidth, y: clientY(event) / innerHeight, deltaX: deltaX(event), deltaY: deltaY(event), deltaMode: deltaMode(event), ctrlKey: ctrlKey(event), metaKey: metaKey(event) });
  }, { capture: true, passive: false });
  window.addEventListener('pagehide', close, { once: true });
  sendParent({ type: 'acanvas:preview-input', instanceId }, parentOrigin, [channel.port2]);
}
