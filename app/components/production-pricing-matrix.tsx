import { useEffect, useMemo, useState } from "react";
import { Form, useNavigation } from "react-router";
import {
  productionPricingMatrixColumns,
  productionPricingMatrixRows,
  type ProductionPricingMatrixCell,
  type ProductionPricingMatrixProduct,
} from "../services/production-pricing-admin";
import type {
  ProductProductionConfiguration,
  ProductionMethodDefinition,
} from "../services/production-method-pricing.server";

type MatrixActionData = {
  ok: boolean;
  intent: string;
  message: string;
  details: string[];
} | undefined;

type Props = {
  products: ProductionPricingMatrixProduct[];
  configurationByProduct: Record<string, ProductProductionConfiguration>;
  methodDefinitions: ProductionMethodDefinition[];
  actionData: MatrixActionData;
};

function suggestedMethodCode(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function MatrixCell({
  cell,
  fieldName,
  currency,
  frozen,
  onDirty,
}: {
  cell: ProductionPricingMatrixCell;
  fieldName: string;
  currency: string;
  frozen: boolean;
  onDirty: () => void;
}) {
  const [enabled, setEnabled] = useState(cell.enabled);
  const [price, setPrice] = useState(cell.surcharge);

  useEffect(() => {
    setEnabled(cell.enabled);
    setPrice(cell.surcharge);
  }, [cell.enabled, cell.surcharge]);

  return (
    <>
      <td className="production-pricing-cell production-pricing-cell--enabled">
        <label className="production-pricing-cell-toggle">
          <input
            type="checkbox"
            name={`${fieldName}.enabled`}
            checked={enabled}
            disabled={frozen}
            onChange={(event) => {
              setEnabled(event.currentTarget.checked);
              onDirty();
            }}
          />
          <span>{enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </td>
      <td className="production-pricing-cell production-pricing-cell--price">
        <label className="production-pricing-cell-price">
          <span className="sr-only">{cell.groupLabel} {cell.label} price</span>
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            name={`${fieldName}.surcharge`}
            value={price}
            disabled={frozen || !enabled}
            onChange={(event) => {
              setPrice(event.currentTarget.value);
              onDirty();
            }}
            aria-label={`${cell.groupLabel} ${cell.label} price in ${currency}`}
          />
          {!enabled ? (
            <input type="hidden" name={`${fieldName}.surcharge`} value={price} />
          ) : null}
          <small>{currency}</small>
        </label>
      </td>
    </>
  );
}

export function ProductionPricingMatrix({
  products,
  configurationByProduct,
  methodDefinitions,
  actionData,
}: Props) {
  const navigation = useNavigation();
  const [dirty, setDirty] = useState(false);
  const [showMethodDialog, setShowMethodDialog] = useState(false);
  const [methodName, setMethodName] = useState("");
  const [methodCode, setMethodCode] = useState("");
  const [methodCodeEdited, setMethodCodeEdited] = useState(false);
  const columns = useMemo(
    () => productionPricingMatrixColumns(methodDefinitions),
    [methodDefinitions],
  );
  const rows = useMemo(
    () => productionPricingMatrixRows(products, configurationByProduct, columns),
    [products, configurationByProduct, columns],
  );
  const columnGroups = useMemo(() => {
    const groups: Array<{ label: string; count: number }> = [];
    for (const column of columns) {
      const previous = groups.at(-1);
      if (previous?.label === column.groupLabel) previous.count += 1;
      else groups.push({ label: column.groupLabel, count: 1 });
    }
    return groups;
  }, [columns]);
  const saving = navigation.state !== "idle";

  useEffect(() => {
    if (actionData?.ok && actionData.intent === "save-production-pricing-batch") {
      setDirty(false);
    }
    if (actionData?.ok && actionData.intent === "add-production-method") {
      setShowMethodDialog(false);
      setMethodName("");
      setMethodCode("");
      setMethodCodeEdited(false);
    }
  }, [actionData]);

  return (
    <>
      <section className="settings-card production-pricing-shell">
        <div className="production-pricing-toolbar">
          <div>
            <h2>Product production methods</h2>
            <p>Enable methods and set the surcharge used by both Public and Creator purchases.</p>
          </div>
          <div className="production-pricing-toolbar-actions">
            {dirty ? <span className="production-pricing-unsaved">Unsaved changes</span> : null}
            <button
              type="button"
              className="settings-secondary-button"
              onClick={() => setShowMethodDialog(true)}
            >
              Add Method +
            </button>
          </div>
        </div>

        {actionData ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            <strong>{actionData.message}</strong>
            {actionData.details.length ? <span> {actionData.details.join(" · ")}</span> : null}
          </s-banner>
        ) : null}

        <Form method="post" className="production-pricing-matrix-form">
          <input type="hidden" name="intent" value="save-production-pricing-batch" />
          <input type="hidden" name="productCount" value={rows.length} />
          <div className="production-pricing-matrix-scroll" role="region" aria-label="Product production pricing matrix">
            <table className="production-pricing-matrix">
              <thead>
                <tr>
                  <th className="production-pricing-product-cell" rowSpan={2} scope="col">
                    Product
                  </th>
                  {columnGroups.map((group) => (
                    <th key={group.label} colSpan={group.count * 2} scope="colgroup">
                      {group.label}
                    </th>
                  ))}
                </tr>
                <tr>
                  {columns.flatMap((column) => [
                    <th key={`${column.key}.enabled`} scope="col">{column.label}</th>,
                    <th key={`${column.key}.price`} scope="col">Price</th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, productIndex) => (
                  <tr key={row.id}>
                    <th className="production-pricing-product-cell" scope="row">
                      <strong>{row.title}</strong>
                      <span>{row.basePrice} {row.currency}</span>
                      {row.handle ? <small>{row.handle}</small> : null}
                      <input type="hidden" name={`products.${productIndex}.id`} value={row.id} />
                      <input type="hidden" name={`products.${productIndex}.currency`} value={row.currency} />
                    </th>
                    {row.cells.map((cell) => (
                      <MatrixCell
                        key={cell.key}
                        cell={cell}
                        currency={row.currency}
                        frozen={saving}
                        fieldName={`products.${productIndex}.method.${cell.methodId}${cell.tier ? `.${cell.tier}` : ""}`}
                        onDirty={() => setDirty(true)}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="production-pricing-save-row">
            <button
              type="submit"
              className="settings-primary-button"
              disabled={!dirty || saving}
              aria-busy={saving}
            >
              Save Changes
            </button>
          </div>
        </Form>
      </section>

      {showMethodDialog ? (
        <div className="production-method-modal" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowMethodDialog(false);
        }}>
          <div className="production-method-modal-card" role="dialog" aria-modal="true" aria-labelledby="add-method-title">
            <div className="production-method-modal-heading">
              <div>
                <h2 id="add-method-title">Add production method</h2>
                <p>The new method will be available for every product and starts disabled.</p>
              </div>
              <button type="button" aria-label="Close" onClick={() => setShowMethodDialog(false)}>×</button>
            </div>
            <Form method="post" className="production-method-modal-form">
              <input type="hidden" name="intent" value="add-production-method" />
              <label>
                <span>Method name</span>
                <input
                  required
                  minLength={2}
                  maxLength={80}
                  name="methodName"
                  value={methodName}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setMethodName(value);
                    if (!methodCodeEdited) setMethodCode(suggestedMethodCode(value));
                  }}
                />
              </label>
              <label>
                <span>Stable code</span>
                <input
                  required
                  name="methodCode"
                  pattern="[A-Z0-9_]+"
                  value={methodCode}
                  onChange={(event) => {
                    setMethodCodeEdited(true);
                    setMethodCode(suggestedMethodCode(event.currentTarget.value));
                  }}
                />
                <small>Used internally and cannot duplicate a built-in or existing code.</small>
              </label>
              <label>
                <span>Pricing behavior</span>
                <select name="pricingBehavior" defaultValue="SINGLE">
                  <option value="SINGLE">Single price</option>
                </select>
              </label>
              <div className="production-method-dimensions">
                <label>
                  <span>Max width (cm), optional</span>
                  <input type="number" min="0.01" max="1000" step="0.01" name="maxWidthCm" />
                </label>
                <label>
                  <span>Max height (cm), optional</span>
                  <input type="number" min="0.01" max="1000" step="0.01" name="maxHeightCm" />
                </label>
              </div>
              <div className="production-method-modal-actions">
                <button type="button" className="settings-secondary-button" onClick={() => setShowMethodDialog(false)}>
                  Cancel
                </button>
                <button type="submit" className="settings-primary-button" disabled={saving}>
                  Add method
                </button>
              </div>
            </Form>
          </div>
        </div>
      ) : null}
    </>
  );
}
