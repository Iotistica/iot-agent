export function mergePinnedDataExplorerPoints<T extends { key: string }>(
  points: T[],
  pinnedKeys: readonly string[],
  cachedPoints: ReadonlyMap<string, T>,
): T[] {
  const merged = [...points]
  const present = new Set(points.map(point => point.key))
  for (const key of pinnedKeys) {
    const cached = cachedPoints.get(key)
    if (cached && !present.has(key)) {
      merged.push(cached)
      present.add(key)
    }
  }
  return merged
}
