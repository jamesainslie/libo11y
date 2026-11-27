/** URL query policy (design, Privacy): a query parameter is kept only when the app allows it. */
export function stripQuery(href: string, allow: ReadonlySet<string>): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  url.hash = "";
  if (url.search !== "") {
    const kept = new URLSearchParams();
    for (const [k, v] of url.searchParams) if (allow.has(k)) kept.append(k, v);
    url.search = kept.toString();
  }
  return url.href;
}
