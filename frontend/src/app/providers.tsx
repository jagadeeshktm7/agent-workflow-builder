"use client";

import { NhostProvider, useAccessToken } from "@nhost/react";
import { Provider } from "urql";
import {
  createClient,
  cacheExchange,
  fetchExchange,
  subscriptionExchange,
} from "@urql/core";
import { createClient as createWSClient } from "graphql-ws";
import { useMemo, type ReactNode } from "react";
import { nhost, graphqlHttpUrl, graphqlWsUrl } from "@/lib/nhost";

function UrqlClientLayer({ children }: { children: ReactNode }) {
  const accessToken = useAccessToken();

  const client = useMemo(() => {
    const url = graphqlHttpUrl();
    const auth: Record<string, string> =
      accessToken != null ? { Authorization: `Bearer ${accessToken}` } : {};

    const wsClient = createWSClient({
      url: graphqlWsUrl(),
      connectionParams: () => ({
        headers: auth,
      }),
    });

    return createClient({
      url,
      exchanges: [
        cacheExchange,
        subscriptionExchange({
          forwardSubscription: (operation) => ({
            subscribe: (sink) => ({
              unsubscribe: wsClient.subscribe(
                {
                  query: String(operation.query),
                  variables: operation.variables,
                  operationName: operation.operationName,
                  extensions: operation.extensions,
                },
                sink
              ),
            }),
          }),
        }),
        fetchExchange,
      ],
      fetchOptions: { headers: auth },
    });
  }, [accessToken]);

  return <Provider value={client}>{children}</Provider>;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <NhostProvider nhost={nhost}>
      <UrqlClientLayer>{children}</UrqlClientLayer>
    </NhostProvider>
  );
}