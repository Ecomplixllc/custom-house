import { redirect } from "react-router";

export async function loader() {
  return redirect("/app/creators");
}

export async function action() {
  return redirect("/app/creators");
}
