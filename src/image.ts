/**
 * Image input: getting a pasted image in front of the model.
 *
 * M365 does not take image bytes on the chat socket. The web client uploads the
 * image over HTTP first, gets a `docId` back, and the chat frame points at it with an
 * `ImageFile` message annotation. That flow is measured to work with the plain chat
 * token, with or without the declarative agent, and without any GPT-V `optionsSets`
 * on the turn itself (cramt/m365-copilot-proxy, hypotheses §33 F86).
 */

import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./translate.js";
import { createLogger } from "./log.js";

const log = createLogger("image");

export interface ImageAnnotation {
  id: string;
  messageAnnotationType: "ImageFile";
  messageAnnotationMetadata: {
    "@type": "File";
    annotationType: "File";
    fileType: string;
    fileName: string;
  };
}

export interface UploadOptions {
  /** The chat token; the upload endpoint takes it as a bearer header. */
  token: string;
  /** The image is scoped to the conversation the turn will run in. */
  conversationId: string;
  /** `https://substrate.office.com`, or a stub's origin in tests. */
  origin: string;
  signal?: AbortSignal;
}

/**
 * The image URLs in the messages from `fromIndex` on.
 *
 * Only what the turn carries: M365 keeps its own context, so an image from an earlier
 * turn is already there, and uploading it again would show it to the model twice.
 */
export function collectImages(messages: readonly ChatMessage[], fromIndex: number): string[] {
  const urls: string[] = [];
  for (const message of messages.slice(fromIndex)) {
    if (message.role === "system" || message.role === "developer") continue;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "image_url") continue;
      const raw = (part as { image_url?: unknown }).image_url;
      const url = typeof raw === "string" ? raw : (raw as { url?: unknown } | undefined)?.url;
      if (typeof url === "string" && url !== "") urls.push(url);
    }
  }
  return urls;
}

/** `png`, `jpg`, `svg`… for a base64 image data URL; null for anything else. */
export function imageFileType(url: string): string | null {
  const match = /^data:image\/([a-z0-9.+-]+);base64,/i.exec(url);
  if (!match) return null;
  const subtype = match[1]!.toLowerCase().replace(/\+.*$/, "");
  return subtype === "jpeg" ? "jpg" : subtype;
}

/** Upload one image and return the annotation that points a chat turn at it. */
export async function uploadImage(dataUrl: string, options: UploadOptions): Promise<ImageAnnotation> {
  const fileType = imageFileType(dataUrl);
  if (!fileType) throw new Error("only base64 image data URLs can be uploaded");

  const form = new URLSearchParams();
  form.append("scenario", "UploadImage");
  form.append("conversationId", options.conversationId);
  form.append("FileBase64", dataUrl);
  form.append("optionsSets", "cwcgptvsan");
  form.append("optionsSets", "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch");

  const response = await fetch(`${options.origin}/m365Copilot/UploadFile`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Scenario": "OfficeWebIncludedCopilot",
      "X-Variants": "feature.EnableImageSupportInUploadFile",
      Origin: "https://m365.cloud.microsoft",
      Referer: "https://m365.cloud.microsoft/",
    },
    body: form.toString(),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const body = await response.text();
  if (!response.ok) throw new Error(`image upload failed: HTTP ${response.status}`);

  let docId: unknown;
  try {
    docId = JSON.parse(body)?.docId;
  } catch {
    /* reported below */
  }
  if (typeof docId !== "string" || docId === "") throw new Error("image upload returned no docId");

  log.info("uploaded image", { fileType, chars: dataUrl.length, docId });
  return {
    id: docId,
    messageAnnotationType: "ImageFile",
    messageAnnotationMetadata: {
      "@type": "File",
      annotationType: "File",
      fileType,
      fileName: `image-${randomUUID().slice(0, 8)}.${fileType}`,
    },
  };
}
