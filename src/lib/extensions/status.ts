import { Node } from "@tiptap/core";

/**
 * TipTap extension for Docmost status badges.
 *
 * HTML representation: <span data-type="status" data-color="green">text</span>
 * Preprocessor syntax: <status color="green">text</status>
 *
 * Colors: gray, blue, green, yellow, red, purple
 */
export const Status = Node.create({
  name: "status",

  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (element: HTMLElement) => element.textContent || "",
      },
      color: {
        default: "gray",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-color") || "gray",
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: `span[data-type="${this.name}"]`,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      {
        "data-type": this.name,
        "data-color": HTMLAttributes.color,
      },
      HTMLAttributes.text,
    ];
  },
});
