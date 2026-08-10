import { NhostClient } from "@nhost/nextjs";

// Phase 0: single nhost client shared by the whole app.
// subdomain/region are public by design (Vercel env vars).
export const nhost = new NhostClient({
  subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN ?? "",
  region: process.env.NEXT_PUBLIC_NHOST_REGION ?? "",
});

// The browser-facing Hasura GraphQL endpoints for this project.
// e.g. https://<sub>.graphql.us-east-1.nhost.run/v1/graphql
export const graphqlHttpUrl = () => nhost.graphql.httpUrl;
export const graphqlWsUrl = () => nhost.graphql.wsUrl;

// Type helper for env availability
export const nhostConfigured =
  Boolean(process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN) &&
  Boolean(process.env.NEXT_PUBLIC_NHOST_REGION);