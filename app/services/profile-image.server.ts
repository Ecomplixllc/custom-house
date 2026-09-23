import { DomainError } from "./domain.ts";
import { validateProfileImage } from "./creator-application.ts";
import type { ShopifyGraphqlClient } from "./shopify-graphql.server";
import { throwUserErrors } from "./shopify-graphql.server.ts";

type UserError = { message: string };
type ProfileImageMedia = {
  id: string;
  fileStatus: string;
  image?: { url: string } | null;
};

async function profileImageUrl(
  mediaId: string,
  client: ShopifyGraphqlClient,
) {
  const result = await client.request<{
    profileImage: ProfileImageMedia | null;
  }>(
    `#graphql query ProfileImageUrl($id: ID!) {
      profileImage: node(id: $id) {
        ... on MediaImage {
          id
          fileStatus
          image { url }
        }
      }
    }`,
    { id: mediaId },
  );
  return result.profileImage?.image?.url || null;
}

async function waitForProfileImageUrl(
  mediaId: string,
  client: ShopifyGraphqlClient,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const imageUrl = await profileImageUrl(mediaId, client);
    if (imageUrl) return imageUrl;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return null;
}

export async function uploadProfileImage(file: File, client: ShopifyGraphqlClient) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateProfileImage(bytes, file.type, file.size);
  const staged = await client.request<{ stagedUploadsCreate: { stagedTargets: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>; userErrors: UserError[] } }>(
    `#graphql mutation ProfileImageTarget($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } } }`,
    { input: [{ resource: "IMAGE", filename: file.name.slice(0, 120), mimeType: file.type, fileSize: String(file.size), httpMethod: "POST" }] },
  );
  throwUserErrors(staged.stagedUploadsCreate.userErrors, "Profile image upload preparation");
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new DomainError("UPLOAD_FAILED", "Profile image upload could not be prepared.", 502);
  const form = new FormData();
  for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
  form.append("file", new Blob([bytes], { type: file.type }), file.name);
  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) throw new DomainError("UPLOAD_FAILED", "Profile image upload failed.", 502);
  const created = await client.request<{
    fileCreate: { files: ProfileImageMedia[]; userErrors: UserError[] };
  }>(
    `#graphql mutation ProfileImageCreate($files: [FileCreateInput!]!) {
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
    { files: [{ originalSource: target.resourceUrl, contentType: "IMAGE", alt: "Creator profile image" }] },
  );
  throwUserErrors(created.fileCreate.userErrors, "Profile image creation");
  const media = created.fileCreate.files[0];
  if (!media) throw new DomainError("UPLOAD_FAILED", "Shopify did not create the profile image.", 502);
  return {
    profileImageId: media.id,
    profileImageUrl:
      media.image?.url || (await waitForProfileImageUrl(media.id, client)),
    status: media.fileStatus,
  };
}
