export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string; // base64-encoded image bytes
  mimeType: string; // e.g. "image/png"
}

export type ToolContent = TextContent | ImageContent;

export interface ToolResult {
  [key: string]: unknown;
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
