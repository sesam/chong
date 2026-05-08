export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function encRepo(repoRef: string): string {
  // Harness Open Source uses URL-encoded path refs for nested spaces:
  // "your-company/workers/api-gateway" → "your-company%2Fworkers%2Fapi-gateway"
  return encodeURIComponent(repoRef);
}
