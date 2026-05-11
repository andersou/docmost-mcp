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
