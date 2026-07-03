import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { createTrpcClient, trpc } from "./lib/trpc";

const root = document.getElementById("root");
const queryClient = new QueryClient();
const trpcClient = createTrpcClient();

if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </trpc.Provider>
    </React.StrictMode>,
  );
}
