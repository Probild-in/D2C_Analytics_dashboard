import * as React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowRight,
  Banknote,
  IndianRupee,
  Package,
  PercentCircle,
  ShoppingCart,
  Sparkles,
  Target,
  TrendingDown,
  TriangleAlert,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { Page } from "@/components/layout/app-shell";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { ChartTooltip } from "@/components/dashboard/chart-tooltip";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { NameAvatar } from "@/components/ui/avatar";
import { useApp } from "@/store/app-context";
import { usePeriodData, deriveMetrics } from "@/hooks/use-period-data";
import { percentDelta } from "@/lib/date-range";
import { formatCurrencyCompact, formatNumber, formatPercent } from "@/lib/utils";
import { getTasks } from "@/data/mock";
import type { Client, SalesPoint } from "@/data/types";

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

export default function Dashboard() {
  const { client, clients, isAllClients } = useApp();
  const { current, currentSum, previousSum } = usePeriodData();
  const metrics = deriveMetrics(currentSum);
  const prevMetrics = deriveMetrics(previousSum);
  const [chartMetric, setChartMetric] = React.useState<"sales" | "orders" | "spend">("sales");

  const attentionClients = clients.filter((c) => c.status !== "healthy");
  const tasks = getTasks(isAllClients ? undefined : client?.id).filter((t) => t.status !== "Completed").slice(0, 4);

  const chartData = current.map((p) => ({
    date: dateFmt.format(new Date(p.date)),
    Sales: p.netSales,
    Orders: p.orders,
    Spend: p.adSpend,
  }));

  const metricKey = chartMetric === "sales" ? "Sales" : chartMetric === "orders" ? "Orders" : "Spend";
  const metricColor = chartMetric === "sales" ? "var(--color-chart-1)" : chartMetric === "orders" ? "var(--color-chart-2)" : "var(--color-chart-5)";

  return (
    <Page
      title="Dashboard"
      description={isAllClients ? "Agency-wide performance across all clients" : `${client?.name} — performance overview`}
    >
      {/* KPI Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        <KpiCard
          label="Net Sales"
          value={formatCurrencyCompact(currentSum.netSales)}
          delta={percentDelta(currentSum.netSales, previousSum.netSales)}
          icon={<IndianRupee />}
          accent="brand"
        />
        <KpiCard
          label="Total Orders"
          value={formatNumber(currentSum.orders)}
          delta={percentDelta(currentSum.orders, previousSum.orders)}
          icon={<ShoppingCart />}
          accent="cyan"
        />
        <KpiCard
          label="AOV"
          value={formatCurrencyCompact(metrics.aov)}
          delta={percentDelta(metrics.aov, prevMetrics.aov)}
          icon={<Wallet />}
          accent="violet"
        />
        <KpiCard
          label="Blended ROAS"
          value={`${metrics.blendedRoas.toFixed(2)}x`}
          delta={percentDelta(metrics.blendedRoas, prevMetrics.blendedRoas)}
          icon={<Target />}
          accent="positive"
        />
        <KpiCard
          label="Ad Spend"
          value={formatCurrencyCompact(currentSum.adSpend)}
          delta={percentDelta(currentSum.adSpend, previousSum.adSpend)}
          invertColor
          icon={<Banknote />}
          accent="warning"
        />
        <KpiCard
          label="RTO %"
          value={formatPercent(metrics.rtoPercent)}
          delta={percentDelta(metrics.rtoPercent, prevMetrics.rtoPercent)}
          invertColor
          icon={<PercentCircle />}
          accent="warning"
        />
      </div>

      {/* Main grid */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="items-center">
            <div>
              <CardTitle>Performance trend</CardTitle>
              <CardDescription>Net sales, orders and ad spend over the selected period</CardDescription>
            </div>
            <Tabs value={chartMetric} onValueChange={(v) => setChartMetric(v as typeof chartMetric)}>
              <TabsList>
                <TabsTrigger value="sales">Sales</TabsTrigger>
                <TabsTrigger value="orders">Orders</TabsTrigger>
                <TabsTrigger value="spend">Spend</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="pl-1 pr-3">
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="metricFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={metricColor} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={metricColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: "var(--color-text-tertiary)" }}
                  minTickGap={28}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: "var(--color-text-tertiary)" }}
                  width={44}
                  tickFormatter={(v) => (chartMetric === "orders" ? formatNumber(v) : formatCurrencyCompact(v))}
                />
                <Tooltip
                  cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }}
                  content={
                    <ChartTooltip
                      formatter={(v) => (chartMetric === "orders" ? formatNumber(v) : formatCurrencyCompact(v))}
                    />
                  }
                />
                <Area type="monotone" dataKey={metricKey} stroke={metricColor} strokeWidth={2} fill="url(#metricFill)" dot={false} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <DailySummaryCard yesterday={current[current.length - 1]} />
          <AttentionCard clients={attentionClients} />
        </div>
      </div>

      {/* Secondary row */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Payment split</CardTitle>
            <CardDescription>COD vs Prepaid orders</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <SplitBar label="Prepaid" percent={metrics.prepaidPercent} colorClass="bg-brand" />
            <SplitBar label="COD" percent={metrics.codPercent} colorClass="bg-accent-cyan" />
            <div className="grid grid-cols-2 gap-3 pt-1">
              <MiniStat label="Cancellation %" value={formatPercent(metrics.cancellationPercent)} tone={metrics.cancellationPercent > 8 ? "negative" : "neutral"} />
              <MiniStat label="Cost / Order" value={formatCurrencyCompact(metrics.costPerOrder)} tone="neutral" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Customers</CardTitle>
            <CardDescription>New vs returning</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <SplitBar
              label="New Customers"
              percent={(currentSum.newCustomers / (currentSum.newCustomers + currentSum.returningCustomers)) * 100}
              colorClass="bg-positive"
              icon={<UserPlus className="size-3.5" />}
              value={formatNumber(currentSum.newCustomers)}
            />
            <SplitBar
              label="Returning Customers"
              percent={(currentSum.returningCustomers / (currentSum.newCustomers + currentSum.returningCustomers)) * 100}
              colorClass="bg-accent-violet"
              icon={<Users className="size-3.5" />}
              value={formatNumber(currentSum.returningCustomers)}
            />
            <div className="grid grid-cols-2 gap-3 pt-1">
              <MiniStat label="Blended CAC" value={formatCurrencyCompact(metrics.blendedCac)} tone="neutral" />
              <MiniStat label="Gross Sales" value={formatCurrencyCompact(currentSum.grossSales)} tone="neutral" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Your tasks</CardTitle>
            <CardDescription>Pending items across {isAllClients ? "all clients" : client?.name}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {tasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2.5 rounded-[var(--radius-md)] px-1.5 py-1.5 transition-colors hover:bg-surface-hover">
                <NameAvatar name={t.assignee} className="size-6" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-text-primary">{t.title}</p>
                  <p className="text-[11px] text-text-tertiary">{t.assignee}</p>
                </div>
                <PriorityDot priority={t.priority} />
              </div>
            ))}
            <Button variant="ghost" size="sm" className="mt-1 w-full justify-center text-[12px] text-text-secondary">
              View all tasks <ArrowRight className="size-3.5" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}

function SplitBar({
  label,
  percent,
  colorClass,
  icon,
  value,
}: {
  label: string;
  percent: number;
  colorClass: string;
  icon?: React.ReactNode;
  value?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="flex items-center gap-1.5 font-medium text-text-secondary">
          {icon}
          {label}
        </span>
        <span className="font-semibold text-text-primary tabular-nums">
          {value ? `${value} · ` : ""}
          {percent.toFixed(1)}%
        </span>
      </div>
      <Progress value={percent} indicatorClassName={colorClass} />
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: "positive" | "negative" | "neutral" }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-bg-subtle p-2.5">
      <p className="text-[11px] text-text-tertiary">{label}</p>
      <p
        className={`mt-0.5 text-[14px] font-semibold tabular-nums ${
          tone === "negative" ? "text-negative" : tone === "positive" ? "text-positive" : "text-text-primary"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function PriorityDot({ priority }: { priority: string }) {
  const map: Record<string, string> = {
    Low: "bg-text-tertiary",
    Medium: "bg-info",
    High: "bg-warning",
    Urgent: "bg-negative",
  };
  return <span className={`size-1.5 shrink-0 rounded-full ${map[priority]}`} />;
}

function DailySummaryCard({ yesterday }: { yesterday?: SalesPoint }) {
  const { client, isAllClients } = useApp();
  const orders = yesterday?.orders ?? 0;
  const netSales = yesterday?.netSales ?? 0;
  const rtoPercent = yesterday && yesterday.orders > 0 ? (yesterday.rtoOrders / yesterday.orders) * 100 : 0;
  const roas = yesterday && yesterday.adSpend > 0 ? yesterday.netSales / yesterday.adSpend : 0;

  return (
    <Card className="relative overflow-hidden bg-gradient-to-br from-brand to-[oklch(0.4_0.15_25)] text-white">
      <div className="absolute -right-6 -top-6 size-32 rounded-full bg-white/10 blur-2xl" />
      <div className="absolute -bottom-8 -left-4 size-28 rounded-full bg-white/10 blur-2xl" />
      <CardContent className="relative space-y-3 p-4">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-white/70">
          <Sparkles className="size-3.5" />
          Daily summary — Yesterday
        </div>
        <p className="text-[13px] font-semibold leading-snug">
          {isAllClients ? "All clients" : client?.name}: {formatNumber(orders)} orders, {formatCurrencyCompact(netSales)} net sales, blended ROAS at {roas.toFixed(2)}x.
        </p>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-white/10 py-1.5">
            <p className="text-[13px] font-bold">{formatNumber(orders)}</p>
            <p className="text-[10px] text-white/70">Orders</p>
          </div>
          <div className="rounded-lg bg-white/10 py-1.5">
            <p className="text-[13px] font-bold">{formatPercent(rtoPercent)}</p>
            <p className="text-[10px] text-white/70">RTO</p>
          </div>
          <div className="rounded-lg bg-white/10 py-1.5">
            <p className="text-[13px] font-bold">{roas.toFixed(2)}x</p>
            <p className="text-[10px] text-white/70">ROAS</p>
          </div>
        </div>
        {rtoPercent > 15 && (
          <div className="flex items-start gap-1.5 rounded-lg bg-black/15 px-2.5 py-2 text-[11.5px] leading-snug">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" />
            <span>RTO is at {formatPercent(rtoPercent)} — higher than usual. Worth a look.</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AttentionCard({ clients }: { clients: Client[] }) {
  return (
    <Card className="flex-1">
      <CardHeader>
        <CardTitle>Needs attention</CardTitle>
        <CardDescription>Clients with anomalies this period</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {clients.map((c) => (
          <div key={c.id} className="flex items-center gap-2.5 rounded-[var(--radius-md)] px-1.5 py-1.5 transition-colors hover:bg-surface-hover">
            <span className={`flex size-7 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white ${c.logoColor}`}>
              {c.logoInitial}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-medium text-text-primary">{c.name}</p>
              <p className="flex items-center gap-1 text-[11px] text-text-tertiary">
                <TrendingDown className="size-3 text-negative" />
                RTO trending up
              </p>
            </div>
            <Badge variant={c.status === "critical" ? "negative" : "warning"}>{c.status}</Badge>
          </div>
        ))}
        {clients.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Package className="size-6 text-text-tertiary" />
            <p className="text-[12px] text-text-tertiary">All clients are performing well.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
