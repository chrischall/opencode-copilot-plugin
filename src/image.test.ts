import { afterEach, describe, expect, it } from "vitest";
import { startStubCopilot, type StubServer } from "../test/stub-copilot.js";
import { collectImages, imageFileType, uploadImage } from "./image.js";
import type { ChatMessage } from "./translate.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPEG = "data:image/jpeg;base64,/9j/4AAQ";

let stub: StubServer | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe("collectImages", () => {
  const history: ChatMessage[] = [
    { role: "system", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,c3lz" } }] },
    { role: "user", content: [{ type: "text", text: "old" }, { type: "image_url", image_url: { url: JPEG } }] },
    { role: "assistant", content: "seen it" },
    { role: "user", content: [{ type: "text", text: "and this?" }, { type: "image_url", image_url: { url: PNG } }] },
  ];

  it("takes the image_url parts of the messages a turn carries", () => {
    expect(collectImages(history, 0)).toEqual([JPEG, PNG]);
  });

  it("skips what M365 already has, so a delta turn does not re-upload old images", () => {
    expect(collectImages(history, 3)).toEqual([PNG]);
  });

  it("accepts the bare-string image_url form some clients send", () => {
    expect(collectImages([{ role: "user", content: [{ type: "image_url", image_url: PNG }] }], 0)).toEqual([PNG]);
  });

  it("ignores string content and parts with no usable url", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "just text" },
      { role: "user", content: [{ type: "image_url", image_url: {} }, { type: "text", text: "x" }] },
    ];
    expect(collectImages(messages, 0)).toEqual([]);
  });
});

describe("imageFileType", () => {
  it("names the file type M365 expects, from the data URL", () => {
    expect(imageFileType(PNG)).toBe("png");
    expect(imageFileType(JPEG)).toBe("jpg");
    expect(imageFileType("data:image/svg+xml;base64,PHN2Zz4=")).toBe("svg");
    expect(imageFileType("data:image/webp;base64,UklGRg==")).toBe("webp");
  });

  it("refuses anything that is not a base64 image data URL", () => {
    expect(imageFileType("https://example.com/cat.png")).toBeNull();
    expect(imageFileType("data:application/pdf;base64,JVBER")).toBeNull();
    expect(imageFileType("data:image/png,raw")).toBeNull();
  });
});

describe("uploadImage", () => {
  const options = (server: StubServer) => ({
    token: "the-token",
    conversationId: "conv-1",
    origin: server.origin.replace(/^ws/, "http"),
  });

  it("posts the image the way the web client does and returns an annotation for the docId", async () => {
    stub = await startStubCopilot({ upload: () => ({ status: 200, body: { docId: "doc-abc" } }) });
    const annotation = await uploadImage(PNG, options(stub));

    const [upload] = stub.uploads;
    expect(upload?.path).toBe("/m365Copilot/UploadFile");
    expect(upload?.headers.authorization).toBe("Bearer the-token");
    expect(upload?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(upload?.headers["x-scenario"]).toBe("OfficeWebIncludedCopilot");
    expect(upload?.headers["x-variants"]).toBe("feature.EnableImageSupportInUploadFile");
    expect(upload?.headers.origin).toBe("https://m365.cloud.microsoft");
    expect(upload?.form.get("scenario")).toBe("UploadImage");
    expect(upload?.form.get("conversationId")).toBe("conv-1");
    expect(upload?.form.get("FileBase64")).toBe(PNG);
    expect(upload?.form.getAll("optionsSets")).toEqual([
      "cwcgptvsan",
      "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
    ]);

    expect(annotation).toMatchObject({
      id: "doc-abc",
      messageAnnotationType: "ImageFile",
      messageAnnotationMetadata: { "@type": "File", annotationType: "File", fileType: "png" },
    });
    expect(annotation.messageAnnotationMetadata.fileName).toMatch(/\.png$/);
  });

  it("fails loudly on an HTTP error rather than pointing the turn at nothing", async () => {
    stub = await startStubCopilot({ upload: () => ({ status: 413, body: { error: "too big" } }) });
    await expect(uploadImage(PNG, options(stub))).rejects.toThrow(/413/);
  });

  it("fails when the reply carries no docId", async () => {
    stub = await startStubCopilot({ upload: () => ({ status: 200, body: { ok: true } }) });
    await expect(uploadImage(PNG, options(stub))).rejects.toThrow(/docId/);
  });

  it("refuses a URL it cannot upload without touching the network", async () => {
    stub = await startStubCopilot();
    await expect(uploadImage("https://example.com/cat.png", options(stub))).rejects.toThrow(/data URL/);
    expect(stub.uploads).toHaveLength(0);
  });
});
