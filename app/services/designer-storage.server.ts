import { DomainError } from "./domain";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { throwUserErrors } from "./shopify-graphql.server";

type StagedTarget = {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
};

type StoredFile = {
  id: string;
  fileStatus: string;
  image?: { url: string } | null;
};

function safeFileName(value: string) {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-100);
  return cleaned || "custom-house-design.png";
}

async function waitForPublicUrl(
  client: ShopifyGraphqlClient,
  fileId: string,
  first?: StoredFile,
) {
  if (first?.image?.url) return first.image.url;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    const result = await client.request<{
      node: StoredFile | null;
    }>(
      `#graphql query DesignerFileStatus($id: ID!) {
        node(id: $id) {
          ... on MediaImage {
            id
            fileStatus
            image { url }
          }
        }
      }`,
      { id: fileId },
    );
    if (result.node?.image?.url) return result.node.image.url;
    if (result.node?.fileStatus === "FAILED") break;
  }
  throw new DomainError(
    "DESIGN_STORAGE_PROCESSING",
    "The image is still processing. Please try again.",
    503,
  );
}

export async function storeDesignerImage(
  client: ShopifyGraphqlClient,
  input: {
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
    alt: string;
  },
) {
  const fileName = safeFileName(input.fileName);
  const staged = await client.request<{
    stagedUploadsCreate: {
      stagedTargets: StagedTarget[];
      userErrors: Array<{ message: string }>;
    };
  }>(
    `#graphql mutation DesignerUploadTarget($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { message }
      }
    }`,
    {
      input: [
        {
          resource: "IMAGE",
          filename: fileName,
          mimeType: input.mimeType,
          fileSize: String(input.bytes.byteLength),
          httpMethod: "POST",
        },
      ],
    },
  );
  throwUserErrors(staged.stagedUploadsCreate.userErrors, "Design upload preparation");
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) {
    throw new DomainError(
      "DESIGN_UPLOAD_FAILED",
      "The design image could not be uploaded.",
      502,
    );
  }
  const payload = new FormData();
  for (const parameter of target.parameters) {
    payload.append(parameter.name, parameter.value);
  }
  payload.append(
    "file",
    new Blob(
      [
        input.bytes.buffer.slice(
          input.bytes.byteOffset,
          input.bytes.byteOffset + input.bytes.byteLength,
        ) as ArrayBuffer,
      ],
      { type: input.mimeType },
    ),
    fileName,
  );
  const uploaded = await fetch(target.url, { method: "POST", body: payload });
  if (!uploaded.ok) {
    throw new DomainError(
      "DESIGN_UPLOAD_FAILED",
      "The design image could not be uploaded.",
      502,
    );
  }
  const created = await client.request<{
    fileCreate: {
      files: StoredFile[];
      userErrors: Array<{ message: string }>;
    };
  }>(
    `#graphql mutation DesignerFileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          ... on MediaImage {
            id
            fileStatus
            image { url }
          }
        }
        userErrors { message }
      }
    }`,
    {
      files: [
        {
          originalSource: target.resourceUrl,
          contentType: "IMAGE",
          alt: input.alt.slice(0, 255),
        },
      ],
    },
  );
  throwUserErrors(created.fileCreate.userErrors, "Design file creation");
  const file = created.fileCreate.files[0];
  if (!file?.id) {
    throw new DomainError(
      "DESIGN_UPLOAD_FAILED",
      "The design image could not be uploaded.",
      502,
    );
  }
  return {
    fileId: file.id,
    url: await waitForPublicUrl(client, file.id, file),
  };
}
