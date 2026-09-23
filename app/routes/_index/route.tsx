import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <div className={styles.mark} aria-hidden="true">CH</div>
        <p className={styles.eyebrow}>CUSTOM HOUSE CREATOR</p>
        <h1 className={styles.heading}>Creator marketplace management</h1>
        <p className={styles.text}>
          A secure workspace for creator applications, approvals, collections,
          profiles, and design submissions.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <small>Example: your-store.myshopify.com</small>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li><strong>Creator operations</strong><span>Review applications and manage creator status safely.</span></li>
          <li><strong>Shopify connected</strong><span>Keep creator profiles, customer tags, and collections synchronized.</span></li>
          <li><strong>Production ready</strong><span>Built for secure embedded administration and storefront access.</span></li>
        </ul>
      </div>
    </div>
  );
}
