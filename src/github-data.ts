export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function repositoryName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split("/");
  const [owner, repository] = parts;
  if (
    parts.length === 2 &&
    owner &&
    /^[a-z0-9-]+$/i.test(owner) &&
    repository &&
    /^[a-z0-9_.-]+$/i.test(repository) &&
    repository !== "." &&
    repository !== ".."
  )
    return value.toLowerCase();
  return undefined;
}

export function commitSha(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}
