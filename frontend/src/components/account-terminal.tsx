import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Download, Loader2, RefreshCw, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
        className="flex h-[85dvh] max-h-[calc(100dvh-2rem)] min-h-0 flex-col overflow-hidden p-4 sm:max-w-[min(96vw,100rem)] sm:p-6"
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
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [traffic, setTraffic] = useState<TerminalTraffic | null>(null);
  const [trafficError, setTrafficError] = useState("");
  const [showTraffic, setShowTraffic] = useState(true);
  // Recording points Claude Code at a local API URL, which changes its traffic,
  // so it is opt-in per terminal and never remembered.
  const [record, setRecord] = useState(false);
  const restarting = useRef(false);
  const capturePath = captureId
    ? `/api/accounts/${encodeURIComponent(accountId)}/terminal/traffic/${encodeURIComponent(captureId)}`
    : null;

  useEffect(() => {
    if (!capturePath) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    let ended = false;
    const poll = async () => {
      try {
        const response = await fetch(capturePath, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          throw new Error(response.status === 401
            ? "Dashboard sign-in expired. Reload to view traffic."
            : `Could not load traffic (HTTP ${response.status}). Retrying…`);
        }
        const snapshot: TerminalTraffic = await response.json();
        if (controller.signal.aborted) return;
        setTraffic(snapshot);
        setTrafficError("");
        ended = Boolean(snapshot.endedAt);
      } catch (error) {
        if (!controller.signal.aborted) {
          setTrafficError(error instanceof Error ? error.message : "Could not load traffic. Retrying…");
        }
      } finally {
        if (!controller.signal.aborted && !ended) timeout = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [capturePath]);

  useEffect(() => {
    if (!container.current) return;
    setStatus("connecting");
    setMessage("");
    setCaptureId(null);
    setTraffic(null);
    setTrafficError("");
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
    if (record) url.searchParams.set("record", "1");
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
    const connectFrame = requestAnimationFrame(async () => {
      if (restarting.current) {
        restarting.current = false;
        // Switching recording restarts Claude; wait until the old process releases the account.
        await waitForTerminalRelease(path, diagnostic.signal);
        if (disposed) return;
      }
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
            if (data.type === "ready" && typeof data.captureId === "string") setCaptureId(data.captureId);
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
  }, [accountId, attempt, record]);

  function changeRecording(next: boolean) {
    restarting.current = true;
    setRecord(next);
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Switch id={`record-traffic-${accountId}`} size="sm" checked={record} onCheckedChange={changeRecording} />
          <Label htmlFor={`record-traffic-${accountId}`} className="text-xs">Record API traffic</Label>
          <span className="text-muted-foreground">
            {record
              ? "Claude Code sees a custom API URL, so its traffic differs from a normal session. Prompts and replies are saved; Authorization is redacted."
              : "Off: Claude talks to Anthropic directly. Turning it on restarts the terminal."}
          </span>
        </div>
        {record ? (
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" aria-expanded={showTraffic} onClick={() => setShowTraffic((current) => !current)}>
              {showTraffic ? "Hide traffic" : "Show traffic"}{traffic ? ` (${traffic.entries.length})` : ""}
            </Button>
            {capturePath ? (
              <Button asChild variant="outline" size="sm">
                <a href={`${capturePath}/download`} download>
                  <Download className="size-3.5" aria-hidden="true" />
                  Download session
                </a>
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
        <div className="min-h-0 min-w-0 flex-[3] overflow-hidden rounded-md border bg-[#101214] p-2">
          <div ref={container} className="h-full w-full" aria-label="Interactive Claude terminal" />
        </div>
        {record && showTraffic ? (
          <section aria-label="Session API traffic" className="min-h-0 min-w-0 flex-[2] overflow-auto rounded-md border p-3 text-xs">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Session API traffic</h3>
              <span className="text-muted-foreground">{traffic?.endedAt ? "Recording ended" : captureId ? "Recording" : "Waiting for terminal…"}</span>
            </div>
            <p className="text-muted-foreground mb-3">API requests and replies appear here as you use Claude. OAuth login traffic is not recorded.</p>
            {trafficError ? <p role="alert" className="text-destructive mb-3">{trafficError}</p> : null}
            {traffic?.truncated ? <p role="status" className="mb-3">Capture limit reached. Some traffic is truncated or omitted.</p> : null}
            {captureId && !traffic && !trafficError ? <p role="status" className="text-muted-foreground">Loading traffic…</p> : null}
            {traffic && traffic.entries.length === 0 ? <p className="text-muted-foreground">No API requests captured yet. Send a prompt in the terminal.</p> : null}
            <div className="space-y-2">
              {traffic?.entries.map((entry) => (
                <details key={entry.id} className="rounded-md border">
                  <summary className="cursor-pointer break-all px-3 py-2 font-mono focus-visible:outline-2 focus-visible:outline-offset-2">
                    {entry.responseStatus ?? "Pending"} {entry.method} {entry.url}
                    {!entry.complete && entry.responseStatus !== null ? " · Streaming / in progress" : ""}
                    {entry.truncated ? " · Truncated" : ""}
                  </summary>
                  <div className="space-y-3 border-t p-3">
                    <p className="text-muted-foreground"><time dateTime={entry.timestamp}>{entry.timestamp}</time></p>
                    <TrafficBody title="Request headers" body={JSON.stringify(entry.requestHeaders, null, 2)} />
                    <TrafficBody title="Request body" body={entry.requestBody} />
                    <TrafficBody title="Response headers" body={JSON.stringify(entry.responseHeaders, null, 2)} />
                    <TrafficBody title="Response body" body={entry.responseBody} />
                  </div>
                </details>
              ))}
            </div>
          </section>
        ) : null}
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

/** The read-only terminal GET answers 409 while a previous terminal or usage probe still holds the account. */
async function waitForTerminalRelease(path: string, signal: AbortSignal) {
  for (let tries = 0; tries < 20 && !signal.aborted; tries++) {
    try {
      const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal });
      if (response.status !== 409) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

type TerminalTraffic = {
  endedAt: string | null;
  truncated: boolean;
  entries: {
    id: string;
    timestamp: string;
    method: string;
    url: string;
    requestHeaders: Record<string, string>;
    requestBody: string;
    responseStatus: number | null;
    responseHeaders: Record<string, string>;
    responseBody: string;
    complete: boolean;
    truncated: boolean;
  }[];
};

function TrafficBody({ title, body }: { title: string; body: string }) {
  let formatted = body;
  try {
    formatted = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Keep text and server-sent events exactly as captured.
  }
  return (
    <div>
      <h4 className="text-muted-foreground mb-1 font-medium">{title}</h4>
      <pre className="bg-muted max-h-72 overflow-auto whitespace-pre-wrap break-all rounded p-2 font-mono text-[11px]">{formatted || "(empty)"}</pre>
    </div>
  );
}
