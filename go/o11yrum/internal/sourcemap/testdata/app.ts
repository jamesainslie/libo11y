function computeTotal(items: number[]): number {
  return items.reduce((sum, n) => sum + n, 0);
}

export function checkout(items: number[]): number {
  if (items.length === 0) {
    throw new Error("empty cart");
  }
  return computeTotal(items);
}
