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
import { CircleSlash, MoreHorizontal, PenLine, Plus, ShoppingBag, Megaphone, Search as SearchIcon, Truck } from "lucide-react";

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

export default function ManageClients() {
  const [selectedClient, setSelectedClient] = React.useState<Client | null>(null);
  return (
    <Page
      title="Manage Clients"
      description="Add clients, manage integrations, and control team access"
      actions={<AddClientDialog />}
    >
      <Card>
        <CardHeader>
          <CardTitle>Clients</CardTitle>
          <CardDescription>{CLIENTS.length} clients in your workspace</CardDescription>
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
                {CLIENTS.map((c) => (
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
                        {c.integrations.map((i) => {
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
                          <DropdownMenuItem>
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
                  <div className="flex items-center gap-1.5">
                    {client.integrations.map((i) => {
                      const Icon = INTEGRATION_ICON[i];
                      return (
                        <span key={i} className="flex items-center gap-1 rounded-md bg-bg-subtle px-2 py-1 text-[11px] font-medium capitalize text-text-secondary">
                          <Icon className="size-3.5" />
                          {i}
                        </span>
                      );
                    })}
                  </div>
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

function AddClientDialog() {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
            <Input placeholder="e.g. Studio Nine Apparel" />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text-secondary">Category</label>
            <Input placeholder="e.g. Fashion & Apparel" />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text-secondary">Owner / point of contact</label>
            <Input placeholder="e.g. Riya Kapoor" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => setOpen(false)}>Create client</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
