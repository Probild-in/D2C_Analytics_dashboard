export type ClientId = "all" | string;

export interface Client {
  id: string;
  name: string;
  category: string;
  logoColor: string;
  logoInitial: string;
  integrations: ("shopify" | "meta" | "google" | "shipping")[];
  status: "healthy" | "attention" | "critical";
  owner: string;
}

export interface SalesPoint {
  date: string;
  grossSales: number;
  netSales: number;
  orders: number;
  adSpend: number;
  newCustomers: number;
  returningCustomers: number;
  codOrders: number;
  prepaidOrders: number;
  cancelledOrders: number;
  rtoOrders: number;
}

export type OrderStatus =
  | "Dispatched"
  | "In Transit"
  | "Out for Delivery"
  | "Delivered"
  | "NDR"
  | "RTO Initiated"
  | "RTO Delivered"
  | "Cancelled";

export interface Order {
  id: string;
  clientId: string;
  customer: string;
  date: string;
  amount: number;
  status: OrderStatus;
  payment: "COD" | "Prepaid";
  city: string;
  state: string;
  courier: string;
  product: string;
}

export interface Product {
  id: string;
  name: string;
  image: string;
  category: string;
  orders: number;
  sales: number;
  netSales: number;
  rtoPercent: number;
  cancellationPercent: number;
  trend: number[];
}

export interface GeoRow {
  name: string;
  orders: number;
  sales: number;
  delivered: number;
  rto: number;
  rtoPercent: number;
  cancellationPercent: number;
  previousRtoPercent: number;
}

export interface Campaign {
  id: string;
  clientId: string;
  platform: "meta" | "google";
  name: string;
  status: "Active" | "Paused" | "In Review" | "Completed";
  spend: number;
  results: number;
  resultType: string;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  thumbnail: string;
  thumbnailColor: string;
  startDate: string;
}

export interface Creative {
  id: string;
  campaignId: string;
  name: string;
  format: "Image" | "Video" | "Carousel";
  headline: string;
  primaryText: string;
  cta: string;
  thumbnailColor: string;
  status: "Active" | "Paused";
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  results: number;
  roas: number;
  hookRate?: number;
  holdRate?: number;
  launchedDate: string;
}

export interface CampaignActivity {
  id: string;
  campaignId: string;
  type: "note" | "response" | "status" | "creative" | "budget" | "created";
  author: string;
  authorRole: "client" | "marketing" | "system";
  message: string;
  timestamp: string;
}

export type TaskStatus = "To Do" | "In Progress" | "Waiting" | "Completed";
export type TaskPriority = "Low" | "Medium" | "High" | "Urgent";

export interface CrmTask {
  id: string;
  clientId: string;
  title: string;
  description: string;
  assignee: string;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string;
  comments: number;
  tags: string[];
}

export type AlertKind = "rto" | "sales" | "ads" | "roas" | "task" | "campaign" | "system";

export interface AppNotification {
  id: string;
  clientId: string;
  kind: AlertKind;
  title: string;
  description: string;
  timestamp: string;
  read: boolean;
}

export interface TeamMember {
  id: string;
  name: string;
  role: "Owner" | "Manager" | "Marketer" | "Team Member";
  email: string;
  clients: string[];
}
