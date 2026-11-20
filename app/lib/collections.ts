import { gql, type StorefrontApi } from "@shopify/hydrogen";
import type { StorefrontClient } from "@shopify/hydrogen";

import { COLLECTION_CARD_FRAGMENT } from "~/components/CollectionCard";
import { isHomeCollection } from "~/lib/catalog";

export const COLLECTIONS_PAGE_SIZE = 12;

export const COLLECTIONS_QUERY = gql(
  `
    query CollectionsList($first: Int!, $after: String, $query: String!) {
      collections(first: $first, after: $after, query: $query) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ...CollectionCard
        }
      }
    }
  `,
  [COLLECTION_CARD_FRAGMENT],
);

type CollectionsQueryVariables = StorefrontApi.VariablesOf<typeof COLLECTIONS_QUERY>;

export async function loadCollectionsPage({
  storefrontClient,
  request,
}: {
  storefrontClient: StorefrontClient;
  request: Request;
}) {
  const url = new URL(request.url);
  const variables: CollectionsQueryVariables = {
    first: COLLECTIONS_PAGE_SIZE,
    after: url.searchParams.get("after") || null,
    query: "handle:la-roche-posay OR handle:kerastase",
  };

  const { data } = await storefrontClient.graphql(COLLECTIONS_QUERY, { variables });

  const collections = data?.collections ?? {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  };

  return {
    collections: {
      ...collections,
      nodes: collections.nodes.filter((collection) => isHomeCollection(collection.handle)),
    },
    origin: url.origin,
  };
}
