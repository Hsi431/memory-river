export function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (map.size >= maxSize && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}
