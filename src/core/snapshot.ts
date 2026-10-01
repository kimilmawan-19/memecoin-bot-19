// Domain data is plain structured-cloneable data. Copy before crossing an await
// boundary so updates owned by another caller cannot change a decision's input.
export function immutableSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (item === null || typeof item !== 'object' || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  }
  freeze(copy);
  return copy;
}
