import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";

export function handleTrpc(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: ({ req: request }) => ({ req: request }),
  });
}
