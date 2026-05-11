# Docmost Markdown Formatting Reference

When creating or updating pages in Docmost, use the following formatting features to ensure proper rendering.

## Callouts (Admonitions)

Use Pandoc-style admonition blocks to highlight important information. These render as styled callout blocks with icons and colors.

**Syntax:**
```markdown
:::info
Useful information and additional context.
:::

:::warning
Alerts that require the reader's attention.
:::

:::danger
Critical warnings or irreversible actions.
:::

:::success
Confirmations and positive messages.
:::

:::tip
Practical tips and suggestions.
:::
```

**Supported types:** info, warning, danger, success, tip, note, important, caution

## Tables (GitHub Flavored Markdown)

Use standard GFM tables — they are rendered correctly in Docmost.

**Syntax:**
```markdown
| Column A | Column B | Column C |
|----------|----------|----------|
| Value 1  | Value 2  | Value 3  |
| Value 4  | Value 5  | Value 6  |
```

## Other Supported Features

- **Headings:** #, ##, ###, ####, #####, ######
- **Lists:** Ordered (1. 2. 3.) and unordered (-, *, +)
- **Task lists:** - [ ] and - [x]
- **Code blocks:** Fenced with syntax highlighting (e.g., ```typescript)
- **Blockquotes:** > Quote text
- **Links:** [text](url)
- **Images:** ![alt](url)
- **Bold:** **text**
- **Italic:** *text*
- **Strikethrough:** ~~text~~
- **Inline code:** `code`
- **Horizontal rule:** ---

## What to Avoid

- **Raw HTML:** May not be converted correctly
- **Non-standard Markdown extensions:** Use only standard GFM + callout syntax
- **Nested callouts:** Not supported — keep callouts at the top level

## Quick Copy-Paste Templates

**Info callout:**
```markdown
:::info
Your info text here.
:::
```

**Warning callout:**
```markdown
:::warning
Your warning text here.
:::
```

**GFM Table:**
```markdown
| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
```
