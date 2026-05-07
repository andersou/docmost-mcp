import { readFileSync, existsSync } from "fs";
import { resolve, basename } from "path";
import FormData from "form-data";
import axios from "axios";

export interface LocalAttachment {
  index: number;
  originalPath: string;
  resolvedPath: string;
  fileName: string;
}

export interface AttachmentUploadResult {
  index: number;
  filePath: string;
  fileId: string;
  fileName: string;
  url: string;
  success: boolean;
  error?: string;
}

/**
 * Regex to match markdown image and link syntax:
 * ![alt](path) or [text](path)
 * Groups: 1=prefix (! or empty), 2=alt/text, 3=path
 */
const MARKDOWN_LINK_REGEX = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Check if a path is a local filesystem path (not http, https, or /api/files/)
 */
function isLocalPath(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed.startsWith("http://")) return false;
  if (trimmed.startsWith("https://")) return false;
  if (trimmed.startsWith("/api/files/")) return false;
  return true;
}

/**
 * Extract local file paths from markdown and replace them with placeholder paths.
 * Placeholder format: /to-substitute/{index}
 *
 * This allows creating/updating the page immediately, then uploading files
 * and replacing placeholders with actual URLs afterward.
 *
 * @param markdown - The markdown content
 * @param basePath - Optional base directory for resolving relative paths
 * @returns Object with processed markdown and list of local attachments
 */
export function extractAndReplaceWithPlaceholders(
  markdown: string,
  basePath?: string,
): { processedMarkdown: string; files: LocalAttachment[] } {
  const files: LocalAttachment[] = [];
  let index = 0;

  const processedMarkdown = markdown.replace(
    MARKDOWN_LINK_REGEX,
    (match: string, bang: string, altOrText: string, path: string) => {
      const trimmedPath = path.trim();

      if (!isLocalPath(trimmedPath)) {
        return match; // Keep as-is (already a URL or /api/files/)
      }

      // Resolve path (absolute or relative)
      const resolvedPath = resolve(basePath || process.cwd(), trimmedPath);

      const attachment: LocalAttachment = {
        index,
        originalPath: trimmedPath,
        resolvedPath,
        fileName: basename(resolvedPath),
      };

      files.push(attachment);
      index++;

      // Return placeholder path that looks like a real path
      return `${bang}[${altOrText}](/to-substitute/${attachment.index})`;
    },
  );

  return { processedMarkdown, files };
}

/**
 * Replace placeholder paths in markdown with actual attachment URLs.
 *
 * @param markdown - The markdown content with /to-substitute/{index} placeholders
 * @param uploads - Array of upload results with fileId and url
 * @returns Markdown with placeholders replaced by actual URLs
 */
export function replacePlaceholdersWithUrls(
  markdown: string,
  uploads: AttachmentUploadResult[],
): string {
  let result = markdown;

  for (const upload of uploads) {
    if (!upload.success) continue;

    const placeholder = `/to-substitute/${upload.index}`;

    // Replace all occurrences of this placeholder
    result = result.split(placeholder).join(upload.url);
  }

  return result;
}

/**
 * Upload a single attachment file to Docmost.
 * Does NOT send attachmentId - lets the server generate one automatically.
 *
 * @param pageId - The page ID to associate the attachment with
 * @param filePath - Absolute path to the file
 * @param index - Index for tracking in the results
 * @param token - Auth token
 * @param apiUrl - Docmost API base URL
 * @returns Upload result with the real fileId from server
 */
export async function uploadAttachment(
  pageId: string,
  filePath: string,
  index: number,
  token: string,
  apiUrl: string,
): Promise<AttachmentUploadResult> {
  const fileName = basename(filePath);

  // Check if file exists
  if (!existsSync(filePath)) {
    const errorMessage = `File not found: ${filePath}`;
    console.error(`[Attachment Upload] ${errorMessage}`);
    return {
      index,
      filePath,
      fileId: "",
      fileName,
      url: "",
      success: false,
      error: errorMessage,
    };
  }

  try {
    console.error(`[Attachment Upload] Uploading file: ${filePath}`);

    // Read file
    const fileBuffer = readFileSync(filePath);

    // Build form data - NO attachmentId (server generates it)
    const form = new FormData();
    form.append("file", fileBuffer, {
      filename: fileName,
      contentType: getMimeType(fileName),
    });
    form.append("pageId", pageId);
    // attachmentId is intentionally omitted - server generates UUID v7

    // Upload (Docmost has global prefix 'api' - avoid duplicating if apiUrl already ends with /api)
    const uploadUrl = apiUrl.endsWith('/api') ? `${apiUrl}/files/upload` : `${apiUrl}/api/files/upload`;
    const response = await axios.post(uploadUrl, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${token}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    // Extract the real fileId from server response
    const fileId = response.data?.id || "";
    const returnedFileName = response.data?.fileName || fileName;
    const url = `/api/files/${fileId}/${returnedFileName}`;

    console.error(`[Attachment Upload] Success: ${returnedFileName} (id: ${fileId})`);

    return {
      index,
      filePath,
      fileId,
      fileName: returnedFileName,
      url,
      success: true,
    };
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.message;
    console.error(`[Attachment Upload] Failed: ${fileName} - ${errorMessage}`);
    return {
      index,
      filePath,
      fileId: "",
      fileName,
      url: "",
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Upload multiple attachments to a page.
 *
 * @param pageId - The page ID
 * @param files - List of local attachments with index and resolvedPath
 * @param token - Auth token
 * @param apiUrl - Docmost API base URL
 * @returns Array of upload results with real fileIds
 */
export async function uploadAttachments(
  pageId: string,
  files: LocalAttachment[],
  token: string,
  apiUrl: string,
): Promise<AttachmentUploadResult[]> {
  const results: AttachmentUploadResult[] = [];

  for (const file of files) {
    const result = await uploadAttachment(
      pageId,
      file.resolvedPath,
      file.index,
      token,
      apiUrl,
    );
    results.push(result);
  }

  return results;
}

/**
 * Simple MIME type detection based on file extension
 */
function getMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop();
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    zip: "application/zip",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
  };

  return mimeTypes[ext || ""] || "application/octet-stream";
}
