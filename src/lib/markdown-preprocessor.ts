/**
 * Preprocesses Pandoc-style admonition/callout syntax in markdown
 * before passing to marked.parse().
 * 
 * Converts:
 *   :::warning
 *   Some text
 *   :::
 * 
 * To:
 *   <div data-callout data-type="warning">
 *   <p>Some text</p>
 *   </div>
 * 
 * Supported types: info, warning, danger, success, tip, note, important, caution
 */
export function preprocessCallouts(markdown: string): string {
  // Regex to match :::type blocks (multiline, non-greedy)
  // Matches:
  //   :::type
  //   content
  //   :::
  const calloutRegex = /^:::(\w+)(?:\s+.*)?\n([\s\S]*?)\n:::\s*$/gm;

  return markdown.replace(calloutRegex, (match, type, content) => {
    // Clean up the type
    const calloutType = type.toLowerCase().trim();
    
    // Trim content and wrap in div
    // We preserve the inner markdown - marked will process it later
    const trimmedContent = content.trim();
    
    // Wrap in HTML that the Callout extension will recognize
    // The inner content will be processed by marked as markdown
    return `<div data-callout data-type="${calloutType}">\n\n${trimmedContent}\n\n</div>`;
  });
}

/**
 * Preprocesses custom <status> tags in markdown before passing to marked.parse().
 * 
 * Converts:
 *   <status color="green">STATUS: EM APROVAÇÃO</status>
 *   <status color="blue">DATA: 2026-07-22</status>
 *   <status>STATUS: DEFAULT</status>              (color defaults to "gray")
 * 
 * To:
 *   <span data-type="status" data-color="green">STATUS: EM APROVAÇÃO</span>
 * 
 * This allows status nodes to be created via markdown when using the
 * WebSocket collaboration update path (markdown → HTML → generateJSON → Yjs).
 * 
 * Supported colors: gray, blue, green, yellow, red, purple
 */
export function preprocessStatusTags(markdown: string): string {
  // Match: <status ...>content</status>
  // Attribute groups: capture color="..." or color='...'
  const statusRegex = /<status(?:\s+(?:color\s*=\s*["'](\w+)["']))?\s*>([\s\S]*?)<\/status>/gi;

  return markdown.replace(statusRegex, (match, color, content) => {
    const statusColor = (color || "gray").toLowerCase().trim();
    const trimmedContent = content.trim() || "";
    return `<span data-type="status" data-color="${statusColor}">${trimmedContent}</span>`;
  });
}
