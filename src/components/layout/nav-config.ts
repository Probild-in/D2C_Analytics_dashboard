import {
  LayoutDashboard,
  Building2,
  ShoppingBag,
  Package,
  MapPin,
  Truck,
  Megaphone,
  Search,
  TrendingUp,
  ListChecks,
  Users,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  badge?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", to: "/", icon: LayoutDashboard },
      { label: "All Clients", to: "/clients", icon: Building2 },
    ],
  },
  {
    label: "Sales & Fulfilment",
    items: [
      { label: "Shopify / Sales", to: "/sales", icon: ShoppingBag },
      { label: "Operations & RTO", to: "/operations", icon: Truck },
      { label: "Products", to: "/products", icon: Package },
      { label: "Geography", to: "/geography", icon: MapPin },
    ],
  },
  {
    label: "Marketing",
    items: [
      { label: "Meta Ads", to: "/marketing/meta", icon: Megaphone },
      { label: "Google Ads", to: "/marketing/google", icon: Search },
      { label: "Blended Marketing", to: "/marketing/blended", icon: TrendingUp },
    ],
  },
  {
    label: "Team",
    items: [
      { label: "Tasks", to: "/tasks", icon: ListChecks },
      { label: "Manage Clients", to: "/manage-clients", icon: Users },
    ],
  },
];
