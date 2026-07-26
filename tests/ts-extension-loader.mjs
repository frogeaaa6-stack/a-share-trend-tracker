// Node's type-strip mode intentionally requires explicit extensions. App code
// uses bundler-style imports, so this test-only resolver adds `.ts` for local
// extensionless modules without changing production TypeScript settings.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export const env = {};",
      shortCircuit: true,
    };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
