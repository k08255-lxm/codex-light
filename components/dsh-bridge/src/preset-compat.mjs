export async function resolvePreset(registry, id) {
  if (typeof registry.resolveMountable === 'function') return registry.resolveMountable(id);
  const result = await registry.resolve(id);
  if (result.broken !== undefined) throw new Error(`Agent preset ${id} is unavailable: ${JSON.stringify(result.broken)}`);
  return result;
}
