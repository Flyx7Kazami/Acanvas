export function filesFromTransfer(data: Pick<DataTransfer, 'files' | 'items'>): File[] {
  const items = Array.from(data.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => file !== null);
  return items.length ? items : Array.from(data.files || []);
}
