export function findDuplicateApps(promptText, apps) {
  const lower = promptText.toLowerCase()
  return apps
    .map((app) => ({
      ...app,
      hits: app.keywords.filter((kw) => lower.includes(kw.toLowerCase())).length,
    }))
    .filter((app) => app.hits >= 2)
    .sort((a, b) => b.hits - a.hits)
}
