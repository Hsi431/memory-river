export async function resolve(specifier, context, next) {
  if (specifier === 'nodejieba') {
    return {
      url: new URL('./broken-nodejieba.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
