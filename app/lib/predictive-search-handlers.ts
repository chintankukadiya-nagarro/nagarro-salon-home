import { createPredictiveSearchServerHandlers, gql } from "@shopify/hydrogen";

import { isHomeVendor } from "~/lib/catalog";

const PRODUCT_VENDOR = gql(`fragment PredictiveSearchProductFragment on Product { vendor }`);

export const predictiveSearchHandlers = createPredictiveSearchServerHandlers({
  types: ["PRODUCT"],
  fragments: { product: PRODUCT_VENDOR },
});

const predictiveSearch = predictiveSearchHandlers.get.bind(predictiveSearchHandlers);
predictiveSearchHandlers.get = (async (context) => {
  const result = await predictiveSearch(context);
  if (result.type !== "json") return result;
  const products = result.data.items.products.filter((product) => isHomeVendor(product.vendor));
  return {
    ...result,
    data: {
      ...result.data,
      items: { ...result.data.items, products },
      total: result.data.total - (result.data.items.products.length - products.length),
    },
  };
}) as typeof predictiveSearchHandlers.get;
