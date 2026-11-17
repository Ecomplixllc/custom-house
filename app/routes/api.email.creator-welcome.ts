import type { ActionFunctionArgs } from "react-router";
import {
  creatorWelcomeEmailMethodNotAllowed,
  deliverCreatorWelcomeEmail,
} from "../services/creator-welcome-email-endpoint.server.ts";

export async function loader() {
  return creatorWelcomeEmailMethodNotAllowed();
}

export async function action({ request }: ActionFunctionArgs) {
  return deliverCreatorWelcomeEmail(request);
}
