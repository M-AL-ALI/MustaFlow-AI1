export default function SettingsPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto w-full">
      <h1 className="text-3xl font-bold tracking-tight mb-8">Settings</h1>
      <div className="space-y-6">
        <div className="border border-border rounded-lg p-6 bg-card">
          <h2 className="text-xl font-semibold mb-4">Account</h2>
          <p className="text-muted-foreground">Manage your account settings and preferences.</p>
        </div>
        <div className="border border-border rounded-lg p-6 bg-card">
          <h2 className="text-xl font-semibold mb-4">Appearance</h2>
          <p className="text-muted-foreground">Customize the look and feel of MustaFlow AI.</p>
        </div>
      </div>
    </div>
  );
}