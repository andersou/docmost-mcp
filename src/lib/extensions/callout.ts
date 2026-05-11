import { Node, mergeAttributes } from "@tiptap/core";

/**
 * TipTap extension for Docmost callout blocks.
 * 
 * HTML representation: <div data-callout data-type="warning">...</div>
 * Markdown representation: :::warning\n...\n:::
 */
export const Callout = Node.create({
  name: "callout",

  group: "block",
  content: "block+",

  addAttributes() {
    return {
      type: {
        default: "info",
        parseHTML: (element) =>
          element.getAttribute("data-type") || "info",
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-callout]",
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-callout": "",
        "data-type": node.attrs.type,
      }),
      0,
    ];
  },
});
