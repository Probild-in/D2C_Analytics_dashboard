import * as React from "react";
import { Page } from "@/components/layout/app-shell";
import { Card } from "@/components/ui/card";
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
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/store/app-context";
import { useClientResource } from "@/hooks/use-client-resource";
import { supabase } from "@/lib/supabase";
import type { Client, CrmTask, TaskStatus, TeamMember } from "@/data/types";
import { cn } from "@/lib/utils";
import { CalendarDays, MessageCircle, MoreHorizontal, Plus } from "lucide-react";

const COLUMNS: { status: TaskStatus; accent: string }[] = [
  { status: "To Do", accent: "border-t-slate-400" },
  { status: "In Progress", accent: "border-t-info" },
  { status: "Waiting", accent: "border-t-warning" },
  { status: "Completed", accent: "border-t-positive" },
];

const PRIORITY_VARIANT: Record<CrmTask["priority"], "neutral" | "info" | "warning" | "negative"> = {
  Low: "neutral",
  Medium: "info",
  High: "warning",
  Urgent: "negative",
};

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

const EMPTY_TASKS: CrmTask[] = [];
const EMPTY_TEAM: TeamMember[] = [];

export default function Tasks() {
  const { client, isAllClients } = useApp();
  // Keying by client remounts the board (and resets its local task state)
  // whenever the workspace changes, instead of syncing it via an effect.
  return <TasksBoard key={isAllClients ? "all" : client?.id} />;
}

function TasksBoard() {
  const { client, clients, isAllClients } = useApp();
  const tasksPath = isAllClients ? "/api/clients/all/tasks" : client ? `/api/clients/${client.id}/tasks` : null;
  const { data: tasks, loading } = useClientResource<CrmTask[]>(tasksPath, EMPTY_TASKS);
  const { data: team } = useClientResource<TeamMember[]>("/api/team-members", EMPTY_TEAM);
  // Overlays on top of the fetched `tasks`, computed at render — not synced via effect —
  // matching meta-ads.tsx's localNotes pattern. A fresh client remounts this whole
  // component (see the `key` on Tasks above), resetting both overlays naturally.
  const [addedTasks, setAddedTasks] = React.useState<CrmTask[]>([]);
  const [statusOverrides, setStatusOverrides] = React.useState<Record<string, TaskStatus>>({});
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null);

  const allTasks = [...tasks, ...addedTasks].map((t) =>
    statusOverrides[t.id] ? { ...t, status: statusOverrides[t.id] } : t,
  );
  const selectedTask = allTasks.find((t) => t.id === selectedTaskId) ?? null;

  const moveTask = async (id: string, status: TaskStatus) => {
    const task = allTasks.find((t) => t.id === id);
    if (!task) return;
    setStatusOverrides((prev) => ({ ...prev, [id]: status }));

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return;
    await fetch(`${import.meta.env.VITE_API_URL}/api/clients/${task.clientId}/tasks/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }).catch(() => {
      // best-effort optimistic update; a background sync/refresh will reconcile on next load
    });
  };

  const addTask = (task: CrmTask) => {
    setAddedTasks((prev) => [...prev, task]);
  };

  return (
    <Page
      title="Tasks"
      description={isAllClients ? "CRM tasks across all clients" : `${client?.name} — team tasks`}
      actions={
        <NewTaskDialog
          isAllClients={isAllClients}
          client={client}
          clients={clients}
          team={team}
          onCreated={addTask}
        />
      }
    >
      {loading && allTasks.length === 0 ? (
        <p className="text-[12px] text-text-tertiary">Loading tasks…</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => {
            const items = allTasks.filter((t) => t.status === col.status);
            return (
              <div key={col.status} className="flex flex-col">
                <div className="mb-2.5 flex items-center justify-between px-0.5">
                  <span className="flex items-center gap-2 text-[12.5px] font-semibold text-text-primary">
                    {col.status}
                    <span className="rounded-full bg-bg-subtle px-1.5 py-0.5 text-[10.5px] font-medium text-text-tertiary">{items.length}</span>
                  </span>
                </div>
                <div className={cn("scrollbar-thin flex min-h-[120px] flex-1 flex-col gap-2 rounded-[var(--radius-lg)] border-t-2 bg-bg-subtle/40 p-2", col.accent)}>
                  {items.map((t) => (
                    <TaskCard key={t.id} task={t} clients={clients} onMove={moveTask} showClient={isAllClients} onOpen={() => setSelectedTaskId(t.id)} />
                  ))}
                  {items.length === 0 && (
                    <div className="flex flex-1 items-center justify-center rounded-[var(--radius-md)] border border-dashed border-border py-6 text-[11.5px] text-text-tertiary">
                      No tasks
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <TaskDetailDialog
        task={selectedTask}
        clients={clients}
        onOpenChange={(open) => !open && setSelectedTaskId(null)}
        onMove={moveTask}
        showClient={isAllClients}
      />
    </Page>
  );
}

function TaskCard({
  task,
  clients,
  onMove,
  showClient,
  onOpen,
}: {
  task: CrmTask;
  clients: Client[];
  onMove: (id: string, status: TaskStatus) => void;
  showClient: boolean;
  onOpen: () => void;
}) {
  const clientMeta = clients.find((c) => c.id === task.clientId);
  const overdue = new Date(task.dueDate) < new Date() && task.status !== "Completed";

  return (
    <Card onClick={onOpen} className="cursor-pointer p-3 transition-shadow hover:shadow-[var(--shadow-md)]">
      <div className="flex items-start justify-between gap-2">
        {showClient && clientMeta && (
          <span className={cn("flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white", clientMeta.logoColor)}>
            {clientMeta.name}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="ml-auto rounded p-0.5 text-text-tertiary hover:bg-surface-hover hover:text-text-primary" onClick={(e) => e.stopPropagation()}>
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {COLUMNS.map((c) => (
              <DropdownMenuItem key={c.status} onSelect={() => onMove(task.id, c.status)}>
                Move to {c.status}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <p className="mt-1.5 text-[12.5px] font-medium leading-snug text-text-primary">{task.title}</p>

      <div className="mt-2.5 flex items-center gap-1.5">
        <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
        {task.tags.map((tag) => (
          <Badge key={tag} variant="outline">
            {tag}
          </Badge>
        ))}
      </div>

      <div className="mt-2.5 flex items-center justify-between">
        <span className={cn("flex items-center gap-1 text-[11px]", overdue ? "font-medium text-negative" : "text-text-tertiary")}>
          <CalendarDays className="size-3" />
          {dateFmt.format(new Date(task.dueDate))}
        </span>
        <div className="flex items-center gap-2">
          {task.comments > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-text-tertiary">
              <MessageCircle className="size-3" />
              {task.comments}
            </span>
          )}
          <NameAvatar name={task.assignee} className="size-6" />
        </div>
      </div>
    </Card>
  );
}

function TaskDetailDialog({
  task,
  clients,
  onOpenChange,
  onMove,
  showClient,
}: {
  task: CrmTask | null;
  clients: Client[];
  onOpenChange: (open: boolean) => void;
  onMove: (id: string, status: TaskStatus) => void;
  showClient: boolean;
}) {
  const clientMeta = task ? clients.find((c) => c.id === task.clientId) : undefined;
  const overdue = task ? new Date(task.dueDate) < new Date() && task.status !== "Completed" : false;

  return (
    <Dialog open={!!task} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {task && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 pr-6">
                {showClient && clientMeta && (
                  <span className={cn("flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white", clientMeta.logoColor)}>
                    {clientMeta.name}
                  </span>
                )}
                <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
              </div>
              <DialogTitle className="mt-1">{task.title}</DialogTitle>
              <DialogDescription>{task.description}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 px-5 pb-5">
              <div className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-[var(--radius-md)] border border-border-subtle bg-bg-subtle/40 p-3 text-[12.5px]">
                <div>
                  <p className="text-[10.5px] text-text-tertiary">Assignee</p>
                  <div className="mt-1 flex items-center gap-1.5 font-medium text-text-primary">
                    <NameAvatar name={task.assignee} className="size-5" />
                    {task.assignee}
                  </div>
                </div>
                <div>
                  <p className="text-[10.5px] text-text-tertiary">Status</p>
                  <p className="mt-1 font-medium text-text-primary">{task.status}</p>
                </div>
                <div>
                  <p className="text-[10.5px] text-text-tertiary">Due date</p>
                  <p className={cn("mt-1 flex items-center gap-1 font-medium", overdue ? "text-negative" : "text-text-primary")}>
                    <CalendarDays className="size-3.5" />
                    {dateFmt.format(new Date(task.dueDate))}
                    {overdue && " (overdue)"}
                  </p>
                </div>
                <div>
                  <p className="text-[10.5px] text-text-tertiary">Comments</p>
                  <p className="mt-1 flex items-center gap-1 font-medium text-text-primary">
                    <MessageCircle className="size-3.5" />
                    {task.comments}
                  </p>
                </div>
              </div>

              {task.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {task.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}

              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">Move to</p>
                <div className="flex flex-wrap gap-1.5">
                  {COLUMNS.map((c) => (
                    <Button
                      key={c.status}
                      size="sm"
                      variant={c.status === task.status ? "primary" : "outline"}
                      disabled={c.status === task.status}
                      onClick={() => onMove(task.id, c.status)}
                    >
                      {c.status}
                    </Button>
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

function NewTaskDialog({
  isAllClients,
  client,
  clients,
  team,
  onCreated,
}: {
  isAllClients: boolean;
  client: Client | null;
  clients: Client[];
  team: TeamMember[];
  onCreated: (task: CrmTask) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [targetClientId, setTargetClientId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [assigneeId, setAssigneeId] = React.useState("");
  const [priority, setPriority] = React.useState<CrmTask["priority"] | "">("");
  const [dueDate, setDueDate] = React.useState("");
  const [tagsInput, setTagsInput] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reset = () => {
    setTargetClientId("");
    setTitle("");
    setDescription("");
    setAssigneeId("");
    setPriority("");
    setDueDate("");
    setTagsInput("");
    setError(null);
  };

  const effectiveClientId = isAllClients ? targetClientId : client?.id ?? "";
  const canSubmit = !!effectiveClientId && !!title.trim() && !!assigneeId && !!priority && !!dueDate;

  const handleCreate = async () => {
    if (!canSubmit) return;
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
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/clients/${effectiveClientId}/tasks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim(), assigneeId, priority, dueDate, tags }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Failed to create task. Please try again.");
        setSubmitting(false);
        return;
      }
      const created = await res.json();
      onCreated(created);
      setSubmitting(false);
      setOpen(false);
      reset();
    } catch {
      setError("Failed to create task. Please check your connection and try again.");
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
          New task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>Assign a task to a team member for a client.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5">
          {isAllClients && (
            <div>
              <label className="mb-1 block text-[12px] font-medium text-text-secondary">Client</label>
              <Select value={targetClientId} onValueChange={setTargetClientId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a client" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text-secondary">Title</label>
            <Input placeholder="e.g. Review creative brief" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text-secondary">Description</label>
            <Input placeholder="Optional details" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-text-secondary">Assignee</label>
              <Select value={assigneeId} onValueChange={setAssigneeId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {team.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-text-secondary">Priority</label>
              <Select value={priority} onValueChange={(v) => setPriority(v as CrmTask["priority"])}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Low">Low</SelectItem>
                  <SelectItem value="Medium">Medium</SelectItem>
                  <SelectItem value="High">High</SelectItem>
                  <SelectItem value="Urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-text-secondary">Due date</label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-text-secondary">Tags</label>
              <Input placeholder="comma, separated" value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} />
            </div>
          </div>
          {error && <p className="text-[11px] text-negative">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={submitting || !canSubmit}>
            {submitting ? "Creating…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
