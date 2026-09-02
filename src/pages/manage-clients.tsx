import * as React from "react";
import { Page } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NameAvatar } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CLIENTS, TEAM } from "@/data/mock";
import type { Client } from "@/data/types";
import { cn } from "@/lib/utils";
import { CircleSlash, MoreHorizontal, PenLine, Plus, ShoppingBag, Megaphone, Search as SearchIcon, Truck, CheckCircle2, XCircle, X } from "lucide-react";
import { useClientResource } from "@/hooks/use-client-resource";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/store/app-context";

const statusMeta: Record<string, { label: string; variant: "positive" | "warning" | "negative" }> = {
  healthy: { label: "Healthy", variant: "positive" },
  attention: { label: "Needs attention", variant: "warning" },
  critical: { label: "Critical", variant: "negative" },
};

const INTEGRATION_ICON: Record<string, React.ElementType> = {
  shopify: ShoppingBag,
  meta: Megaphone,
  google: SearchIcon,
  shipping: Truck,
};

const ROLE_VARIANT: Record<string, "brand" | "info" | "neutral" | "outline"> = {
  Owner: "brand",
  Manager: "info",
  Marketer: "neutral",
  "Team Member": "outline",
};

interface Connection {
  platform: string;
  status: "connected" | "disconnected" | "error";
  externalAccountId: string;
}

const EMPTY_CONNECTIONS: Connection[] = [];

function ConnectionsPanel({ clientId }: { clientId: string }) {
  const { data: connections, loading } = useClientResource<Connection[]>(`/api/clients/${clientId}/connections`, EMPTY_CONNECTIONS);
  const [shopDomain, setShopDomain] = React.useState("");
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const shopify = connections.find((c) => c.platform === "shopify");

  const handleConnect = async () => {
    if (!shopDomain.trim()) return;
    setConnecting(true);
    setError(null);
    // Uses supabase.auth.getSession() — the same official Supabase client method
    // useClientResource (Task 12) and app-context.tsx already use — not a hand-parsed
    // localStorage lookup. See Task 12's plan note (commit 08adb3e) for why that approach
    // is both fragile (undocumented Supabase storage-key format) and unnecessary.
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setConnecting(false);
      setError("You're not signed in. Please log in again.");
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/clients/${clientId}/connections/shopify/authorize`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ shopDomain: shopDomain.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to connect Shopify. Please try again.");
        setConnecting(false);
        return;
      }
      const { authorizeUrl } = await res.json();
      window.location.href = authorizeUrl;
    } catch {
      setError("Failed to connect Shopify. Please check your connection and try again.");
      setConnecting(false);
    }
  };

  if (loading) {
    return <p className="text-[11px] text-text-tertiary">Loading…</p>;
  }

  if (shopify && shopify.status === "connected") {
    return (
      <span className="flex items-center gap-1 rounded-md bg-bg-subtle px-2 py-1 text-[11px] font-medium text-text-secondary">
        <ShoppingBag className="size-3.5" />
        Shopify — {shopify.externalAccountId}
      </span>
    );
  }

  const shopDomainValid = /^[a-z0-9-]+\.myshopify\.com$/.test(shopDomain.trim());

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Input
          value={shopDomain}
          onChange={(e) => {
            setShopDomain(e.target.value);
            setError(null);
          }}
          placeholder="yourstore.myshopify.com"
          className="h-7 max-w-52 text-[11px]"
        />
        <Button size="sm" onClick={handleConnect} disabled={connecting || !shopDomain.trim() || !shopDomainValid}>
          Connect Shopify
        </Button>
      </div>
      {!error && shopDomain.trim() && !shopDomainValid && (
        <p className="mt-1 text-[11px] text-text-tertiary">Must look like yourstore.myshopify.com</p>
      )}
      {error && <p className="mt-1 text-[11px] text-negative">{error}</p>}
    </div>
  );
}

type ConnectionResult = { type: "success" } | { type: "error"; message: string };

function readConnectionResult(): ConnectionResult | null {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf("?");
  if (queryIndex === -1) return null;
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  const connection = params.get("connection");
  if (connection === "success") return { type: "success" };
  if (connection === "error") {
    return { type: "error", message: params.get("message") || "Failed to connect. Please try again." };
  }
  return null;
}

function clearConnectionResultFromUrl() {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf("?");
  if (queryIndex === -1) return;
  const path = hash.slice(0, queryIndex);
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  params.delete("connection");
  params.delete("message");
  const rest = params.toString();
  const newHash = rest ? `${path}?${rest}` : path;
  const url = `${window.location.pathname}${window.location.search}${newHash}`;
  window.history.replaceState(null, "", url);
}

function ConnectionResultBanner() {
  // Lazy-init reads the result once on first render; StrictMode's double effect
  // invocation would otherwise re-read the (already cleared) URL and null out the banner.
  const [result, setResult] = React.useState<ConnectionResult | null>(() => readConnectionResult());
  const cleared = React.useRef(false);

  React.useEffect(() => {
    if (result && !cleared.current) {
      cleared.current = true;
      clearConnectionResultFromUrl();
    }
  }, [result]);

  if (!result) return null;

  const isSuccess = result.type === "success";
  return (
    <div
      className={cn(
        "mb-4 flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2.5 text-[12.5px]",
        isSuccess ? "border-transparent bg-positive-subtle text-positive" : "border-transparent bg-negative-subtle text-negative",
      )}
    >
      {isSuccess ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
      <p className="flex-1">{isSuccess ? "Shopify connected successfully." : result.message}</p>
      <button
        onClick={() => setResult(null)}
        className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export default function ManageClients() {
  const { clients } = useApp();
  const [selectedClient, setSelectedClient] = React.useState<Client | null>(null);
  const [editingClient, setEditingClient] = React.useState<Client | null>(null);
  return (
    <Page
      title="Manage Clients"
      description="Add clients, manage integrations, and control team access"
      actions={<AddClientDialog />}
    >
      <ConnectionResultBanner />
      <Card>
        <CardHeader>
          <CardTitle>Clients</CardTitle>
          <CardDescription>{clients.length} clients in your workspace</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-2.5 font-medium">Client</th>
                  <th className="px-3 py-2.5 font-medium">Integrations</th>
                  <th className="px-3 py-2.5 font-medium">Owner</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelectedClient(c)}
                    className="cursor-pointer border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-hover"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white", c.logoColor)}>
                          {c.logoInitial}
                        </span>
                        <div>
                          <p className="font-medium text-text-primary">{c.name}</p>
                          <p className="text-[11px] text-text-tertiary">{c.category}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {(c.integrations ?? []).map((i) => {
                          const Icon = INTEGRATION_ICON[i];
                          return (
                            <span key={i} className="flex size-6 items-center justify-center rounded-md bg-bg-subtle text-text-secondary" title={i}>
                              <Icon className="size-3.5" />
                            </span>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-text-secondary">{c.owner}</td>
                    <td className="px-3 py-2.5">
                      <Badge variant={statusMeta[c.status].variant} dot>
                        {statusMeta[c.status].label}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            onClick={(e) => e.stopPropagation()}
                            className="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
                          >
                            <MoreHorizontal className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingClient(c);
                            }}
                          >
                            <PenLine className="size-3.5" /> Edit client
                          </DropdownMenuItem>
                          <DropdownMenuItem>Manage integrations</DropdownMenuItem>
                          <DropdownMenuItem>Assign team members</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-negative focus:bg-negative-subtle">
                            <CircleSlash className="size-3.5" /> Disable access
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Team &amp; permissions</CardTitle>
          <CardDescription>{TEAM.length} team members with access to your clients</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full min-w-[680px] border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-2.5 font-medium">Member</th>
                <th className="px-3 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Client access</th>
              </tr>
            </thead>
            <tbody>
              {TEAM.map((m) => (
                <tr key={m.id} className="border-b border-border-subtle last:border-0 hover:bg-surface-hover">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <NameAvatar name={m.name} className="size-7" />
                      <div>
                        <p className="font-medium text-text-primary">{m.name}</p>
                        <p className="text-[11px] text-text-tertiary">{m.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant={ROLE_VARIANT[m.role]}>{m.role}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {m.clients.length === CLIENTS.length ? (
                        <Badge variant="brand">All clients</Badge>
                      ) : (
                        m.clients.map((cid) => {
                          const c = CLIENTS.find((x) => x.id === cid);
                          return (
                            <Badge key={cid} variant="neutral">
                              {c?.name}
                            </Badge>
                          );
                        })
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <ClientDetailDialog client={selectedClient} onOpenChange={(open) => !open && setSelectedClient(null)} />
      <EditClientDialog client={editingClient} onOpenChange={(open) => !open && setEditingClient(null)} />
    </Page>
  );
}

function ClientDetailDialog({ client, onOpenChange }: { client: Client | null; onOpenChange: (open: boolean) => void }) {
  const members = client ? TEAM.filter((m) => m.clients.length === CLIENTS.length || m.clients.includes(client.id)) : [];

  return (
    <Dialog open={!!client} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {client && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2.5 pr-6">
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white", client.logoColor)}>
                  {client.logoInitial}
                </span>
                <div className="min-w-0">
                  <DialogTitle className="truncate">{client.name}</DialogTitle>
                  <DialogDescription>{client.category}</DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-4 px-5 pb-5">
              <div className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-[var(--radius-md)] border border-border-subtle bg-bg-subtle/40 p-3 text-[12.5px]">
                <div>
                  <p className="text-[10.5px] text-text-tertiary">Owner</p>
                  <p className="mt-1 font-medium text-text-primary">{client.owner}</p>
                </div>
                <div>
                  <p className="text-[10.5px] text-text-tertiary">Status</p>
                  <Badge variant={statusMeta[client.status].variant} dot className="mt-1">
                    {statusMeta[client.status].label}
                  </Badge>
                </div>
                <div className="col-span-2">
                  <p className="mb-1.5 text-[10.5px] text-text-tertiary">Connected integrations</p>
                  <ConnectionsPanel clientId={client.id} />
                </div>
              </div>

              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">Team with access</p>
                <div className="space-y-1">
                  {members.map((m) => (
                    <div key={m.id} className="flex items-center gap-2.5 rounded-[var(--radius-md)] px-1.5 py-1.5">
                      <NameAvatar name={m.name} className="size-6" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium text-text-primary">{m.name}</p>
                      </div>
                      <Badge variant={ROLE_VARIANT[m.role]}>{m.role}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditClientDialog({ client, onOpenChange }: { client: Client | null; onOpenChange: (open: boolean) => void }) {
  const { refreshClients } = useApp();
  const [name, setName] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (client) {
      setName(client.name);
      setCategory(client.category);
      setError(null);
    }
  }, [client]);

  const handleSave = async () => {
    if (!client || !name.trim() || !category.trim()) return;
    setSubmitting(true);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setSubmitting(false);
      setError("You're not signed in. Please log in again.");
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/clients/${client.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), category: category.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to update client. Please try again.");
        setSubmitting(false);
        return;
      }
      refreshClients();
      setSubmitting(false);
      onOpenChange(false);
    } catch {
      setError("Failed to update client. Please check your connection and try again.");
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={!!client} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit client</DialogTitle>
          <DialogDescription>Update this client's name and category.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text-secondary">Client / Brand name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text-secondary">Category</label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          {error && <p className="text-[11px] text-negative">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={submitting || !name.trim() || !category.trim()}>
            {submitting ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddClientDialog() {
  const { refreshClients, setClientId } = useApp();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reset = () => {
    setName("");
    setCategory("");
    setError(null);
  };

  const handleCreate = async () => {
    if (!name.trim() || !category.trim()) return;
    setSubmitting(true);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setSubmitting(false);
      setError("You're not signed in. Please log in again.");
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/clients`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), category: category.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to create client. Please try again.");
        setSubmitting(false);
        return;
      }
      const created = await res.json();
      refreshClients();
      setClientId(created.id);
      setSubmitting(false);
      setOpen(false);
      reset();
    } catch {
      setError("Failed to create client. Please check your connection and try again.");
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-3.5" />
          Add client
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a new client</DialogTitle>
          <DialogDescription>Create a client workspace and connect their business accounts.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text-secondary">Client / Brand name</label>
            <Input placeholder="e.g. Studio Nine Apparel" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text-secondary">Category</label>
            <Input placeholder="e.g. Fashion & Apparel" value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          {error && <p className="text-[11px] text-negative">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={submitting || !name.trim() || !category.trim()}>
            {submitting ? "Creating…" : "Create client"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
