import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok" | "degraded" | "unreachable";
  apiUrl: string;
  checkedAt: string;
};

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");

  if (loading) return <div>Checking Knowledge API...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <strong>Knowledge Mesh</strong>
      <div>
        {data?.status === "ok" ? "✓" : "✗"} Knowledge API {data?.status ?? "unknown"} (
        {data?.apiUrl ?? "?"})
      </div>
      <div>Checked: {data?.checkedAt ?? "never"}</div>
    </div>
  );
}
