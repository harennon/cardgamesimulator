/**
 * Pure formatting helpers for feedback.mjs.
 * Extracted so they can be unit-tested without running the I/O script.
 */

/**
 * Formats a single feedback row into the human-readable lines printed by
 * the default (non-JSON) CLI output. Returns an array of line strings
 * (without a trailing newline entry); the caller adds the blank separator.
 *
 * @param {object} row - An AdminFeedbackEntry as returned by GET /feedback.
 * @returns {string[]}
 */
export function formatEntry(row) {
  const date = new Date(row.createdAt).toLocaleString();
  const meta = row.metadata;
  const route = meta?.route ?? "—";
  const userType = meta?.userType ?? "—";

  const lines = [
    `  [${row.category}]  ${date}`,
    `  ${row.description}`,
    `  route: ${route}  user: ${userType}  id: ${row.id}`,
  ];

  if (row.attachments?.length) {
    for (const url of row.attachments) {
      lines.push(`  attachment: ${url}`);
    }
  }

  return lines;
}
