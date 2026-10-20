import { useSearchParams } from "react-router-dom";

export default function ShopifyAppError() {
  const [params] = useSearchParams();
  const message = params.get("message") ?? "Something went wrong connecting your store.";
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="max-w-sm rounded-[var(--radius-lg)] border border-border bg-surface p-6 text-center">
        <p className="text-[13px] text-negative">{message}</p>
      </div>
    </div>
  );
}
