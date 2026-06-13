/**
 * Polls the backend health endpoint until it responds 200.
 * Used as a safety check if webServer startup is slow.
 */
export async function waitForApp(
  baseUrl: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/echo`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `App at ${baseUrl} did not become ready within ${timeoutMs}ms`,
  );
}
