import * as React from "react";
import { Page } from "@/components/layout/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NameAvatar } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/store/app-context";
import { getTasks, CLIENTS } from "@/data/mock";
import type { CrmTask, TaskStatus } from "@/data/types";
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

export default function Tasks() {
  const { client, isAllClients } = useApp();
  // Keying by client remounts the board (and resets its local task state)
  // whenever the workspace changes, instead of syncing it via an effect.
  return <TasksBoard key={isAllClients ? "all" : client?.id} />;
}

function TasksBoard() {
  const { client, isAllClients } = useApp();
  const [tasks, setTasks] = React.useState<CrmTask[]>(() => getTasks(isAllClients ? undefined : client?.id));
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null);
  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;

  const moveTask = (id: string, status: TaskStatus) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
  };

  return (
    <Page
      title="Tasks"
      description={isAllClients ? "CRM tasks across all clients" : `${client?.name} — team tasks`}
      actions={
        <Button size="sm">
          <Plus className="size-3.5" />
          New task
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.status);
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
                  <TaskCard key={t.id} task={t} onMove={moveTask} showClient={isAllClients} onOpen={() => setSelectedTaskId(t.id)} />
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

      <TaskDetailDialog
        task={selectedTask}
        onOpenChange={(open) => !open && setSelectedTaskId(null)}
        onMove={moveTask}
        showClient={isAllClients}
      />
    </Page>
  );
}

function TaskCard({
  task,
  onMove,
  showClient,
  onOpen,
}: {
  task: CrmTask;
  onMove: (id: string, status: TaskStatus) => void;
  showClient: boolean;
  onOpen: () => void;
}) {
  const clientMeta = CLIENTS.find((c) => c.id === task.clientId);
  const overdue = new Date(task.dueDate) < new Date("2026-08-21") && task.status !== "Completed";

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
  onOpenChange,
  onMove,
  showClient,
}: {
  task: CrmTask | null;
  onOpenChange: (open: boolean) => void;
  onMove: (id: string, status: TaskStatus) => void;
  showClient: boolean;
}) {
  const clientMeta = task ? CLIENTS.find((c) => c.id === task.clientId) : undefined;
  const overdue = task ? new Date(task.dueDate) < new Date("2026-08-21") && task.status !== "Completed" : false;

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
