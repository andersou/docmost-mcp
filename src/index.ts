import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import FormData from "form-data";
import axios, { AxiosInstance } from "axios";
import { z } from "zod";
import {
  filterWorkspace,
  filterSpace,
  filterGroup,
  filterPage,
  filterComment,
  filterSearchResult,
} from "./lib/filters.js";
import { convertProseMirrorToMarkdown } from "./lib/markdown-converter.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { updatePageContentRealtime } from "./lib/collaboration.js";
import { applyCommentMark } from "./lib/yjs-comment.js";
import { getCollabToken, performLogin } from "./lib/auth-utils.js";
import {
  extractAndReplaceWithPlaceholders,
  replacePlaceholdersWithUrls,
  uploadAttachments,
} from "./lib/attachments.js";

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

const API_URL = process.env.DOCMOST_API_URL;
const EMAIL = process.env.DOCMOST_EMAIL;
const PASSWORD = process.env.DOCMOST_PASSWORD;
const UPDATE_TYPE = (process.env.DOCMOST_UPDATE_TYPE || "WS") as "WS" | "REST";

if (!API_URL || !EMAIL || !PASSWORD) {
  console.error(
    "Error: DOCMOST_API_URL, DOCMOST_EMAIL, and DOCMOST_PASSWORD environment variables are required.",
  );
  process.exit(1);
}

if (!["WS", "REST"].includes(UPDATE_TYPE)) {
  console.error(
    "Error: DOCMOST_UPDATE_TYPE must be either 'WS' or 'REST'. Default is 'WS'.",
  );
  process.exit(1);
}

class DocmostClient {
  // ... [Client Implementation stays exactly the same] ...
  private client: AxiosInstance;
  private token: string | null = null;

  constructor(baseURL: string) {
    this.client = axios.create({
      baseURL,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  async login() {
    if (!EMAIL || !PASSWORD) {
      throw new Error("Missing Credentials (DOCMOST_EMAIL, DOCMOST_PASSWORD)");
    }
    // baseURL is already set in this.client
    const baseURL = this.client.defaults.baseURL || "";

    // Use shared auth utility
    this.token = await performLogin(baseURL, EMAIL, PASSWORD);
    this.client.defaults.headers.common["Authorization"] =
      `Bearer ${this.token}`;
  }

  async ensureAuthenticated() {
    if (!this.token) {
      await this.login();
    }
  }

  get baseUrl(): string {
    return this.client.defaults.baseURL || "";
  }

  get authToken(): string {
    return this.token || "";
  }

  /**
   * Generic pagination handler for Docmost API endpoints
   * @param endpoint - The API endpoint path (e.g., "/spaces", "/pages/recent")
   * @param basePayload - Base payload object to send with each request
   * @param limit - Items per page (min: 1, max: 100, default: 100)
   * @returns All items collected from all pages
   */
  async paginateAll<T = any>(
    endpoint: string,
    basePayload: Record<string, any> = {},
    limit: number = 100,
  ): Promise<T[]> {
    await this.ensureAuthenticated();

    // Clamp limit between 1 and 100
    const clampedLimit = Math.max(1, Math.min(100, limit));

    let page = 1;
    let allItems: T[] = [];
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await this.client.post(endpoint, {
        ...basePayload,
        limit: clampedLimit,
        page,
      });

      const data = response.data;

      // Handle both direct data.items and data.data.items structures
      const items = data.data?.items || data.items || [];
      const meta = data.data?.meta || data.meta;

      allItems = allItems.concat(items);
      hasNextPage = meta?.hasNextPage || false;
      page++;
    }

    return allItems;
  }

  async getWorkspace() {
    await this.ensureAuthenticated();
    const response = await this.client.post("/workspace/info", {});
    return {
      data: filterWorkspace(response.data.data),
      success: response.data.success,
    };
  }

  async getSpaces() {
    const spaces = await this.paginateAll("/spaces", {});
    return spaces.map((space) => filterSpace(space));
  }

  async getGroups() {
    const groups = await this.paginateAll("/groups", {});
    return groups.map((group) => filterGroup(group));
  }

  async listPages(spaceId?: string) {
    const payload = spaceId ? { spaceId } : {};
    const pages = await this.paginateAll("/pages/recent", payload);
    return pages.map((page) => filterPage(page));
  }

  async listSidebarPages(spaceId: string, pageId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/pages/sidebar-pages", {
      spaceId,
      pageId,
      page: 1,
    });
    return response.data?.data?.items || [];
  }

  async getPage(pageId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/pages/info", { pageId });
    const resultData = response.data.data; // Assuming data is nested under 'data'

    let content = resultData.content
      ? convertProseMirrorToMarkdown(resultData.content)
      : ""; // Default to empty string

    // Always fetch subpages to provide context to the agent
    let subpages: any[] = [];

    try {
      subpages = await this.listSidebarPages(resultData.spaceId, pageId);
    } catch (e: any) {
      console.warn("Failed to fetch subpages:", e);
    }

    // Resolve subpages if the placeholder exists
    if (content && content.includes("{{SUBPAGES}}")) {
      if (subpages && subpages.length > 0) {
        const list = subpages
          .map((p: any) => `- [${p.title}](page:${p.id})`)
          .join("\n");
        content = content.replace("{{SUBPAGES}}", `### Subpages\n${list}`);
      } else {
        content = content.replace("{{SUBPAGES}}", "");
      }
    }

    return {
      data: filterPage(resultData, content, subpages),
      success: response.data.success,
    };
  }

  /**
   * Create a new page with title and content.
   *
   * Note: As long as Docmost doesn't provide a /pages/create endpoint that allows
   * setting content directly, we must use the /pages/import workaround to create
   * pages with initial content. This method:
   * 1. Creates the page via /pages/import (which supports content)
   * 2. Moves it to the correct parent if specified
   */
  async createPage(
    title: string,
    content: string,
    spaceId: string,
    parentPageId?: string,
    imageRelativeBasePath?: string,
  ) {
    await this.ensureAuthenticated();

    if (parentPageId) {
      try {
        await this.getPage(parentPageId);
      } catch (e) {
        throw new Error(`Parent page with ID ${parentPageId} not found.`);
      }
    }

    // Extract local file paths and replace with placeholders (/to-substitute/{index})
    const { processedMarkdown: markdownWithPlaceholders, files } = extractAndReplaceWithPlaceholders(
      content,
      imageRelativeBasePath,
    );

    console.error(`[CreatePage] Found ${files.length} local attachments`);
    files.forEach((f) => console.error(`[CreatePage]  - ${f.originalPath} -> /to-substitute/${f.index}`));

    // 1. Create content via Import (using multipart/form-data)
    const form = new FormData();
    form.append("spaceId", spaceId);

    const fileContent = Buffer.from(markdownWithPlaceholders, "utf-8");
    form.append("file", fileContent, {
      filename: `${title || "import"}.md`,
      contentType: "text/markdown",
    });

    const headers = {
      ...form.getHeaders(),
      Authorization: `Bearer ${this.token}`,
    };

    // Use raw axios call for FormData handling
    const response = await axios.post(`${API_URL}/pages/import`, form, {
      headers,
    });
    const newPageId = response.data.data.id;

    // 2. Move to parent if needed
    if (parentPageId) {
      await this.movePage(newPageId, parentPageId);
    }

    // 3. Upload attachments if any
    let attachmentUploads: any[] = [];
    if (files.length > 0) {
      attachmentUploads = await uploadAttachments(
        newPageId,
        files,
        this.token!,
        API_URL!,
      );

      // 4. Replace placeholders with real URLs and update page
      const successfulUploads = attachmentUploads.filter((u) => u.success);
      if (successfulUploads.length > 0) {
        const finalMarkdown = replacePlaceholdersWithUrls(
          markdownWithPlaceholders,
          successfulUploads,
        );

        console.error(`[CreatePage] Updating page with real attachment URLs`);

        try {
          await this.client.post("/pages/update", {
            pageId: newPageId,
            content: finalMarkdown,
            operation: "replace",
            format: "markdown",
          });
        } catch (e: any) {
          console.error(`[CreatePage] Failed to update page with URLs:`, e.message);
        }
      }
    }

    // Return the final page object with attachment uploads info
    const page = await this.getPage(newPageId);
    return {
      ...page,
      attachmentUploads,
    };
  }

  /**
   * Update a page's content and optionally its title.
   *
   * Supports two update modes:
   * - 'WS' (default): WebSocket real-time collaboration. Preserves Page ID and history.
   *   Note: Docmost has a ~10s debounce before content is persisted. History versions
   *   appear after a 1-5 minute delay (Docmost queues history snapshot jobs).
   * - 'REST': REST API for instant persistence. History is generated immediately.
   *   Docmost handles Markdown-to-ProseMirror conversion server-side.
   */
  async updatePage(
    pageId: string,
    content: string,
    title?: string,
    imageRelativeBasePath?: string,
  ) {
    await this.ensureAuthenticated();

    const t0 = Date.now();

    // Skip attachment extraction when no base path — avoids scanning entire
    // markdown for local files that would be resolved from process.cwd()
    let finalMarkdown = content;
    let attachmentUploads: any[] = [];

    if (imageRelativeBasePath) {
      const { processedMarkdown: markdownWithPlaceholders, files } = extractAndReplaceWithPlaceholders(
        content,
        imageRelativeBasePath,
      );

      console.error(`[UpdatePage] Found ${files.length} local attachments`);
      files.forEach((f) => console.error(`[UpdatePage]  - ${f.originalPath} -> /to-substitute/${f.index}`));

      // Upload attachments FIRST (page already exists, so we can upload before updating)
      if (files.length > 0) {
        attachmentUploads = await uploadAttachments(
          pageId,
          files,
          this.token!,
          API_URL!,
        );
      }

      // Replace placeholders with real URLs
      const successfulUploads = attachmentUploads.filter((u) => u.success);
      if (successfulUploads.length > 0) {
        finalMarkdown = replacePlaceholdersWithUrls(
          markdownWithPlaceholders,
          successfulUploads,
        );
        console.error(`[UpdatePage] Replaced ${successfulUploads.length} placeholders with real URLs`);
      }
    }

    const tExtract = Date.now();
    console.error(`[UpdatePage] Extraction took ${tExtract - t0}ms`);

    if (UPDATE_TYPE === "REST") {
      // REST API update - instant persistence, immediate history
      // Combine title + content into a single request to halve round-trips
      const updatePayload: any = {
        pageId,
        content: finalMarkdown,
        operation: "replace",
        format: "markdown",
      };

      if (title) {
        updatePayload.title = title;
      }

      const tApiStart = Date.now();
      await this.client.post("/pages/update", updatePayload);
      console.error(`[UpdatePage] REST API call took ${Date.now() - tApiStart}ms`);

      return {
        success: true,
        modified: true,
        message: "Page updated successfully via REST API.",
        pageId: pageId,
        attachmentUploads,
      };
    }

    // WebSocket update - real-time collaboration
    // 1. Update Title via REST API if provided
    if (title) {
      await this.client.post("/pages/update", { pageId, title });
    }

    // 2. Update Content via WebSocket
    let collabToken = "";
    const baseURL = this.client.defaults.baseURL || "";
    try {
      collabToken = await getCollabToken(baseURL, this.token!);
      await updatePageContentRealtime(pageId, finalMarkdown, collabToken, baseURL);
    } catch (error: any) {
      console.error(
        "Failed to update page content via realtime collaboration:",
        error,
      );
      const tokenPreview = collabToken
        ? collabToken.substring(0, 15) + "..."
        : "null";
      throw new Error(
        `Failed to update page content: ${error.message} (Token: ${tokenPreview})`,
      );
    }

    return {
      success: true,
      modified: true,
      message: "Page updated successfully via WebSocket.",
      pageId: pageId,
      attachmentUploads,
    };
  }

  async search(query: string, spaceId?: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/search", {
      query,
      spaceId,
    });

    // Filter search results (data is directly an array)
    const items = response.data?.data || [];
    const filteredItems = items.map((item: any) => filterSearchResult(item));

    return {
      items: filteredItems,
      success: response.data?.success || false,
    };
  }

  async movePage(
    pageId: string,
    parentPageId: string | null,
    position?: string,
  ) {
    await this.ensureAuthenticated();
    // Docmost requires position >= 5 chars.
    const validPosition = position || "a00000";

    return this.client
      .post("/pages/move", {
        pageId,
        parentPageId,
        position: validPosition,
      })
      .then((res) => res.data);
  }

  async deletePage(pageId: string) {
    await this.ensureAuthenticated();
    return this.client
      .post("/pages/delete", { pageId })
      .then((res) => res.data);
  }

  async deletePages(pageIds: string[]) {
    await this.ensureAuthenticated();
    const promises = pageIds.map((id) =>
      this.client
        .post("/pages/delete", { pageId: id })
        .then(() => ({ id, success: true }))
        .catch((err: any) => ({ id, success: false, error: err.message })),
    );
    return Promise.all(promises);
  }

  // ── Comments ───────────────────────────────────────────────

  async createComment(pageId: string, content: string, selection?: string, parentCommentId?: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/comments/create", {
      pageId,
      content,
      ...(selection !== undefined && { selection, type: "inline" }),
      ...(parentCommentId !== undefined && { parentCommentId }),
    });
    return {
      data: filterComment(response.data.data),
      success: response.data.success,
    };
  }

  async listPageComments(pageId: string, limit: number = 20, cursor?: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/comments", {
      pageId,
      limit,
      ...(cursor !== undefined && { cursor }),
    });
    const data = response.data.data;
    return {
      items: (data?.items || []).map((item: any) => filterComment(item)),
      meta: data?.meta || null,
      success: response.data.success,
    };
  }

  async getComment(commentId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/comments/info", { commentId });
    return {
      data: filterComment(response.data.data),
      success: response.data.success,
    };
  }

  async updateComment(commentId: string, content: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/comments/update", {
      commentId,
      content,
    });
    return {
      data: filterComment(response.data.data),
      success: response.data.success,
    };
  }

  async deleteComment(commentId: string) {
    await this.ensureAuthenticated();
    const response = await this.client.post("/comments/delete", { commentId });
    return {
      success: response.data.success,
    };
  }
}

const docmostClient = new DocmostClient(API_URL);

// --- Modern McpServer Implementation ---

const server = new McpServer({
  name: "docmost-mcp",
  version: VERSION,
});

// Helper to format JSON responses
const jsonContent = (data: any) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

// Tool: list_workspaces
server.registerTool(
  "get_workspace",
  {
    description: "Get the current Docmost workspace",
  },
  async () => {
    const workspace = await docmostClient.getWorkspace();
    return jsonContent(workspace);
  },
);

// Tool: list_spaces
server.registerTool(
  "list_spaces",
  {
    description: "List all available spaces in Docmost",
  },
  async () => {
    const spaces = await docmostClient.getSpaces();
    return jsonContent(spaces);
  },
);

// Tool: list_groups
server.registerTool(
  "list_groups",
  {
    description: "List all available groups in Docmost",
  },
  async () => {
    const groups = await docmostClient.getGroups();
    return jsonContent(groups);
  },
);

// Tool: list_pages
server.registerTool(
  "list_pages",
  {
    description: "List pages in a space ordered by updatedAt (descending).",
    inputSchema: {
      spaceId: z.string().optional(),
    },
  },
  async ({ spaceId }) => {
    const result = await docmostClient.listPages(spaceId);
    return jsonContent(result);
  },
);

// Tool: get_page
server.registerTool(
  "get_page",
  {
    description: "Get details and content of a specific page by ID",
    inputSchema: {
      pageId: z.string(),
    },
  },
  async ({ pageId }) => {
    const page = await docmostClient.getPage(pageId);
    return jsonContent(page);
  },
);

// Tool: create_page (Smart)
server.registerTool(
  "create_page",
  {
    description:
      "Create a new page with content (automatically moves it to the correct hierarchy). Local file paths in markdown images/links (e.g., ![alt](./image.png) or [doc](/path/to/file.pdf)) are automatically detected, converted to /api/files/{uuid}/{filename} URLs, and uploaded as attachments to the page. Pass imageRelativeBasePath when using relative paths.",
    inputSchema: {
      title: z.string().describe("Title of the page"),
      content: z.string().describe("Markdown content. Local file paths in images/links will be automatically uploaded as attachments."),
      spaceId: z.string(),
      parentPageId: z
        .string()
        .optional()
        .describe("Optional parent page ID to nest under"),
      imageRelativeBasePath: z
        .string()
        .optional()
        .describe("Optional base directory for resolving relative file paths in markdown (e.g., '/path/to/project'). If not provided, relative paths are resolved from the current working directory."),
    },
  },
  async ({ title, content, spaceId, parentPageId, imageRelativeBasePath }) => {
    const result = await docmostClient.createPage(
      title,
      content,
      spaceId,
      parentPageId,
      imageRelativeBasePath,
    );
    return jsonContent(result);
  },
);

// Tool: update_page
server.registerTool(
  "update_page",
  {
    description:
      "Update a page's content and/or title. The update mode (WebSocket or REST) is configured via the DOCMOST_UPDATE_TYPE environment variable (default: WS). Local file paths in markdown images/links are automatically detected, converted to /api/files/{uuid}/{filename} URLs, and uploaded as attachments to the page. Pass imageRelativeBasePath when using relative paths.",
    inputSchema: {
      pageId: z.string().describe("ID of the page to update"),
      content: z.string().describe("New Markdown content. Local file paths in images/links will be automatically uploaded as attachments."),
      title: z.string().optional().describe("Optional new title"),
      imageRelativeBasePath: z
        .string()
        .optional()
        .describe("Optional base directory for resolving relative file paths in markdown (e.g., '/path/to/project'). If not provided, relative paths are resolved from the current working directory."),
    },
  },
  async ({ pageId, content, title, imageRelativeBasePath }) => {
    const result = await docmostClient.updatePage(pageId, content, title, imageRelativeBasePath);
    return jsonContent(result);
  },
);

// Tool: move_page
server.registerTool(
  "move_page",
  {
    description:
      "Move a page to a new parent (nesting) or root. Essential for organizing pages created via 'import_page'.",
    inputSchema: {
      pageId: z.string(),
      parentPageId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Target parent page ID. Pass 'null' or empty string to move to root.",
        ),
      position: z
        .string()
        .optional()
        .describe(
          "Optional position string (5-12 chars). Defaults to 'a00000' (end) if omitted.",
        ),
    },
  },
  async ({ pageId, parentPageId, position }) => {
    // Ensure parentPageId is null if string "null" or empty is passed, or undefined
    // Note: Zod handles type checking, but we double check for empty strings just in case
    const finalParentId =
      parentPageId === "" || parentPageId === "null" ? null : parentPageId;

    await docmostClient.movePage(pageId, finalParentId || null, position);
    return {
      content: [
        {
          type: "text",
          text: `Successfully moved page ${pageId} to parent ${finalParentId || "root"}`,
        },
      ],
    };
  },
);

// Tool: delete_page
server.registerTool(
  "delete_page",
  {
    description: "Delete a single page by ID.",
    inputSchema: {
      pageId: z.string(),
    },
  },
  async ({ pageId }) => {
    await docmostClient.deletePage(pageId);
    return {
      content: [{ type: "text", text: `Successfully deleted page ${pageId}` }],
    };
  },
);

// Tool: delete_pages
server.registerTool(
  "delete_pages",
  {
    description: "Delete multiple pages at once. Useful for cleanup.",
    inputSchema: {
      pageIds: z.array(z.string()),
    },
  },
  async ({ pageIds }) => {
    const results = await docmostClient.deletePages(pageIds);
    return jsonContent(results);
  },
);

// Tool: search
server.registerTool(
  "search",
  {
    description: "Search for pages and content.",
    inputSchema: {
      query: z.string().describe("Search query"),
      spaceId: z.string().optional().describe("Optional space ID to filter by"),
    },
  },
  async ({ query, spaceId }) => {
    const result = await docmostClient.search(query, spaceId);
    return jsonContent(result);
  },
);

// ── Comment Tools ─────────────────────────────────────────

// Tool: create_comment
server.registerTool(
  "create_comment",
  {
    description:
      "Create a comment on a page. Can be a top-level comment or a threaded reply when parentCommentId is provided. The content is a ProseMirror document JSON string. When selection is provided, it creates an inline comment with visual highlight. IMPORTANT: selection text must match page content EXACTLY (including whitespace and punctuation). Use get_page first to retrieve the exact text.",
    inputSchema: {
      pageId: z.string().describe("ID of the page to comment on"),
      content: z.string().describe("Comment body as a JSON string (ProseMirror document format)"),
      selection: z.string().optional().describe("Highlighted text for inline comment. Must match EXACTLY the page content (whitespace, punctuation). Use get_page to get the exact text first."),
      parentCommentId: z.string().optional().describe("ID of a parent comment to reply to. Creates a threaded reply when provided."),
    },
  },
  async ({ pageId, content, selection, parentCommentId }) => {
    const result = await docmostClient.createComment(pageId, content, selection, parentCommentId);

    if (selection && result.data?.id) {
      const baseURL = docmostClient.baseUrl;
      getCollabToken(baseURL, docmostClient.authToken)
        .then((collabToken) =>
          applyCommentMark(
            pageId,
            selection,
            result.data.id,
            collabToken,
            baseURL,
          ),
        )
        .catch((err: any) =>
          console.error(
            `[CommentHighlight] Failed (non-critical): ${err.message}`,
          ),
        );
    }

    return jsonContent(result);
  },
);

// Tool: list_page_comments
server.registerTool(
  "list_page_comments",
  {
    description:
      "List comments for a page with cursor-based pagination. Returns comments ordered by creation date with creator user info.",
    inputSchema: {
      pageId: z.string().describe("ID of the page to list comments for"),
      limit: z.number().min(1).max(100).optional().default(20).describe("Items per page (1-100, default: 20)"),
      cursor: z.string().optional().describe("Cursor from a previous response's nextCursor for pagination"),
    },
  },
  async ({ pageId, limit, cursor }) => {
    const result = await docmostClient.listPageComments(pageId, limit, cursor);
    return jsonContent(result);
  },
);

// Tool: get_comment
server.registerTool(
  "get_comment",
  {
    description: "Get a single comment by ID with creator and resolvedBy user info.",
    inputSchema: {
      commentId: z.string().describe("ID of the comment to retrieve"),
    },
  },
  async ({ commentId }) => {
    const result = await docmostClient.getComment(commentId);
    return jsonContent(result);
  },
);

// Tool: update_comment
server.registerTool(
  "update_comment",
  {
    description: "Update a comment's content. Replaces the entire comment body with new ProseMirror JSON.",
    inputSchema: {
      commentId: z.string().describe("ID of the comment to update"),
      content: z.string().describe("New comment body as a JSON string (ProseMirror document format). Replaces the entire comment content."),
    },
  },
  async ({ commentId, content }) => {
    const result = await docmostClient.updateComment(commentId, content);
    return jsonContent(result);
  },
);

// Tool: delete_comment
server.registerTool(
  "delete_comment",
  {
    description: "Delete a comment by ID.",
    inputSchema: {
      commentId: z.string().describe("ID of the comment to delete"),
    },
  },
  async ({ commentId }) => {
    const result = await docmostClient.deleteComment(commentId);
    return jsonContent(result);
  },
);

// Prompt: docmost_markdown_reference
// Reads from an external markdown file for easy maintenance
const promptFilePath = join(__dirname, "prompts", "docmost_markdown_reference.md");
let markdownReferencePrompt: string;
try {
  markdownReferencePrompt = readFileSync(promptFilePath, "utf-8");
} catch (err) {
  console.error(`Failed to read prompt file at ${promptFilePath}:`, err);
  markdownReferencePrompt = "# Docmost Markdown Formatting Reference\n\n(Prompt file not found)";
}

server.registerPrompt(
  "docmost_markdown_reference",
  {
    description:
      "Reference guide for Markdown formatting supported by Docmost. Use this to ensure content renders correctly when creating or updating pages.",
  },
  async () => {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: markdownReferencePrompt,
          },
        },
      ],
    };
  },
);

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
