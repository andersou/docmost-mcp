import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import WebSocket from "ws";

interface TextNodeRange {
  node: Y.XmlText;
  globalStart: number;
  cleanLength: number;
}

interface SelectionRange {
  node: Y.XmlText;
  fromOffset: number;
  toOffset: number;
}

function collectTextNodes(
  fragment: Y.XmlFragment | Y.XmlElement,
): { ranges: TextNodeRange[]; fullText: string } {
  const ranges: TextNodeRange[] = [];
  let fullText = "";
  let pos = 0;

  function walk(item: Y.XmlFragment | Y.XmlElement) {
    for (let i = 0; i < item.length; i++) {
      const child = item.get(i);
      if (child instanceof Y.XmlText) {
        const deltas = child.toDelta() as any[];
        const text = deltas.map((d: any) => d.insert).join("");
        ranges.push({ node: child, globalStart: pos, cleanLength: text.length });
        fullText += text;
        pos += text.length;
      } else if (child instanceof Y.XmlElement) {
        walk(child);
      }
    }
  }

  walk(fragment);
  return { ranges, fullText };
}

function findSelection(
  fragment: Y.XmlFragment,
  searchText: string,
): SelectionRange[] | null {
  const { ranges, fullText } = collectTextNodes(fragment);
  const matchIndex = fullText.indexOf(searchText);

  if (matchIndex === -1) return null;

  const matchEnd = matchIndex + searchText.length;
  const result: SelectionRange[] = [];

  for (const range of ranges) {
    const nodeEnd = range.globalStart + range.cleanLength;

    if (range.globalStart >= matchEnd) break;
    if (nodeEnd <= matchIndex) continue;

    const fromOffset = Math.max(0, matchIndex - range.globalStart);
    const toOffset = Math.min(range.cleanLength, matchEnd - range.globalStart);

    if (toOffset > fromOffset) {
      result.push({
        node: range.node,
        fromOffset,
        toOffset,
      });
    }
  }

  return result.length > 0 ? result : null;
}

function buildWsUrl(baseUrl: string): string {
  let wsUrl = baseUrl.replace(/^http/, "ws");
  try {
    const urlObj = new URL(wsUrl);
    if (urlObj.pathname.endsWith("/api") || urlObj.pathname.endsWith("/api/")) {
      urlObj.pathname = urlObj.pathname.replace(/\/api\/?$/, "");
    }
    urlObj.pathname = urlObj.pathname.replace(/\/$/, "") + "/collab";
    wsUrl = urlObj.toString();
  } catch {
    if (!wsUrl.endsWith("/collab")) {
      wsUrl = wsUrl.replace(/\/$/, "") + "/collab";
    }
  }
  return wsUrl;
}

export async function applyCommentMark(
  pageId: string,
  selection: string,
  commentId: string,
  collabToken: string,
  baseUrl: string,
): Promise<void> {
  if (!selection || !selection.trim()) return;

  const wsUrl = buildWsUrl(baseUrl);

  return new Promise<void>((resolve, reject) => {
    const ydoc = new Y.Doc();
    let provider: HocuspocusProvider | null = null;

    const timer = setTimeout(() => {
      provider?.destroy();
      reject(new Error("Connection timeout to collaboration server"));
    }, 25000);

    provider = new HocuspocusProvider({
      url: wsUrl,
      name: `page.${pageId}`,
      document: ydoc,
      token: collabToken,
      // @ts-ignore — required in Node.js where WebSocket is not global
      WebSocketPolyfill: WebSocket as any,
      onSynced: () => {
        clearTimeout(timer);
        try {
          const fragment = ydoc.getXmlFragment("default");
          const ranges = findSelection(fragment, selection);

          if (!ranges) {
            console.error(
              `[CommentMark] Selection "${selection.substring(0, 60)}..." not found in page content. Comment ${commentId} created without highlight.`,
            );
            scheduleDestroy(provider, 2_000);
            resolve();
            return;
          }

          ydoc.transact(() => {
            for (const r of ranges) {
              r.node.format(r.fromOffset, r.toOffset - r.fromOffset, {
                comment: { commentId, resolved: false },
              });
            }
          });

          console.error(
            `[CommentMark] Highlight applied for comment ${commentId} (${ranges.length} XmlText range(s))`,
          );
          scheduleDestroy(provider, 15_000);
          resolve();
        } catch (e) {
          provider?.destroy();
          reject(e);
        }
      },
      onAuthenticationFailed: () => {
        clearTimeout(timer);
        provider?.destroy();
        reject(new Error("Authentication failed for collaboration connection"));
      },
    });
  });
}

function scheduleDestroy(
  provider: HocuspocusProvider | null,
  delayMs: number,
) {
  if (!provider) return;
  setTimeout(() => {
    try {
      provider.destroy();
    } catch {
      /* already destroyed */
    }
  }, delayMs);
}
