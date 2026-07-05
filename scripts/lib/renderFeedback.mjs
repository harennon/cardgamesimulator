/**
 * Pure rendering logic for the feedback CLI.
 * Exported so it can be unit-tested without network or auth.
 *
 * @param {Array} rows - AdminFeedbackEntry objects from GET /feedback
 * @param {{ json: boolean }} opts
 * @returns {string} the text to print (caller passes to console.log / stdout)
 */
export function renderFeedback(rows, { json }) {
  if (rows.length === 0) {
    return "No feedback found.";
  }

  if (json) {
    return JSON.stringify(rows, null, 2);
  }

  const lines = [`\n  Feedback (${rows.length} entries)\n`];

  for (const row of rows) {
    const date = new Date(row.createdAt).toLocaleString();
    const meta = row.metadata;
    const route = meta?.route ?? "—";
    const userType = meta?.userType ?? "—";

    lines.push(`  [${row.category}]  ${date}`);
    lines.push(`  ${row.description}`);
    lines.push(`  route: ${route}  user: ${userType}  id: ${row.id}`);
    if (row.attachments?.length) {
      lines.push(`  attachments (${row.attachments.length}):`);
      for (const att of row.attachments) {
        lines.push(`    ${att.url}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
