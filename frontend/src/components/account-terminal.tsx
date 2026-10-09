import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Loader2, RefreshCw, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { usePrivacyStore } from "@/hooks/use-privacy";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export function AccountTerminal({ account }: { account: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  const blurNames = usePrivacyStore((state) => state.blurNames);
  const utils = trpc.useUtils();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) void utils.accounts.list.invalidate();
    }}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="hover:text-primary focus-visible:ring-ring inline-flex max-w-full items-center gap-2 rounded-sm text-left font-medium outline-none focus-visible:ring-2"
          title="Open Claude terminal"
          aria-label={blurNames ? "Open Claude terminal" : `Open Claude terminal for ${account.name}`}
        >
          <span className={cn("truncate", blurNames && "privacy-blur")}>{account.name}</span>
          <TerminalSquare className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
        </button>
      </DialogTrigger>
      <DialogContent
        className="flex h-[85dvh] max-h-[calc(100dvh-2rem)] min-h-0 flex-col overflow-hidden p-4 sm:max-w-6xl sm:p-6"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle className="flex min-w-0 flex-wrap items-center gap-2">
            <TerminalSquare className="size-5 shrink-0" aria-hidden="true" />
            Claude terminal
            <span className={cn("text-muted-foreground truncate text-sm font-normal", blurNames && "privacy-blur")}>{account.name}</span>
          </DialogTitle>
          <DialogDescription>
            Run <code>/login</code> to sign in or <code>/usage</code> to check limits. Open the login link, then paste the code here.
            Closing this window ends the terminal; saved login stays with this account.
          </DialogDescription>
        </DialogHeader>
        {open ? <TerminalSession accountId={account.id} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function openTerminalLink(_event: MouseEvent, text: string) {
  try {
    const url = new URL(text);
    if (url.protocol === "https:" || url.protocol === "http:") {
      window.open(url.href, "_blank", "noopener,noreferrer");
    }
  } catch {
    // Ignore non-URL links emitted by the terminal.
  }
}

function TerminalSession({ accountId }: { accountId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"connecting" | "connected" | "closed">("connecting");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!container.current) return;
    setStatus("connecting");
    setMessage("");
    const terminal = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 14,
      scrollback: 5_000,
      screenReaderMode: true,
      theme: { background: "#101214", foreground: "#e6e6e6", cursor: "#e6e6e6" },
      linkHandler: { activate: openTerminalLink },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon(openTerminalLink));
    terminal.open(container.current);
    fit.fit();

    const path = `/api/accounts/${encodeURIComponent(accountId)}/terminal`;
    const url = new URL(path, window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket | undefined;
    let disposed = false;
    const diagnostic = new AbortController();
    const send = (data: object) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
    };
    const input = terminal.onData((data) => {
      // Keep large pastes below the server's 16 KiB limit without splitting Unicode characters.
      const characters = Array.from(data);
      for (let offset = 0; offset < characters.length; offset += 4096) {
        send({ type: "input", data: characters.slice(offset, offset + 4096).join("") });
      }
    });
    const resize = terminal.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => fit.fit());
    });
    observer.observe(container.current);

    // Defer connection until mounted: React StrictMode immediately disposes its first effect.
    const connectFrame = requestAnimationFrame(() => {
      terminal.focus();
      const connection = new WebSocket(url);
      socket = connection;
      let opened = false;
      connection.onopen = () => {
        opened = true;
        send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
        terminal.focus();
      };
      connection.onmessage = (event) => {
        if (disposed) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === "ready" || (data.type === "output" && typeof data.data === "string")) {
            terminal.options.disableStdin = false;
            setStatus("connected");
            if (data.type === "output") terminal.write(data.data);
          } else if (data.type === "exit") {
            terminal.options.disableStdin = true;
            setStatus("closed");
            setMessage(`Claude exited${typeof data.code === "number" ? ` (code ${data.code})` : ""}. Reconnect to start a new terminal.`);
          } else if (data.type === "error" && typeof data.message === "string") {
            terminal.options.disableStdin = true;
            setStatus("closed");
            setMessage(data.message);
          }
        } catch {
          setMessage("The terminal received an invalid response. Reconnect to try again.");
          connection.close();
        }
      };
      connection.onerror = async () => {
        if (disposed) return;
        setMessage((current) => current || "Could not connect. Check your connection and dashboard sign-in, then reconnect.");
        if (opened) return;
        try {
          // Browsers hide failed WebSocket response bodies; this read-only request explains busy accounts.
          const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: diagnostic.signal });
          const detail = await response.json();
          if (disposed) return;
          if (response.status === 401) {
            setMessage("Dashboard sign-in expired. Reload the page to sign in, then reopen the terminal.");
          } else if (response.status !== 426 && typeof detail.message === "string") {
            setMessage(detail.message);
          }
        } catch {
          // Keep the connection error if the diagnostic request is unavailable.
        }
      };
      connection.onclose = () => {
        if (disposed) return;
        terminal.options.disableStdin = true;
        setStatus("closed");
        setMessage((current) => current || "Connection closed. Reconnect to start a new terminal.");
      };
    });

    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(connectFrame);
      diagnostic.abort();
      input.dispose();
      resize.dispose();
      if (socket) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
      }
      terminal.dispose();
    };
  }, [accountId, attempt]);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-[#101214] p-2">
        <div ref={container} className="h-full w-full" aria-label="Interactive Claude terminal" />
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 text-xs">
        <p role="status" className="text-muted-foreground flex items-center gap-2">
          {status === "connecting" ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : null}
          {message || (status === "connecting" ? "Starting Claude…" : "Connected · Escape and Ctrl+C are sent to Claude.")}
        </p>
        {status === "closed" ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((current) => current + 1)}>
            <RefreshCw className="size-3.5" />
            Reconnect
          </Button>
        ) : null}
      </div>
    </>
  );
}
