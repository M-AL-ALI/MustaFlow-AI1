import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { useEffect, useState } from "react";

// Pages
import HomePage from "./pages/home";
import ProjectsPage from "./pages/projects";
import ProjectWorkspacePage from "./pages/projects/[id]";
import KnowledgePage from "./pages/knowledge";
import SettingsPage from "./pages/settings";
import LoginPage from "./pages/login";

// Components
import { AppLayout } from "./components/layout/app-layout";

const queryClient = new QueryClient();

function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      
      <Route path="/">
        <AppLayout>
          <HomePage />
        </AppLayout>
      </Route>
      
      <Route path="/projects">
        <AppLayout>
          <ProjectsPage />
        </AppLayout>
      </Route>
      
      <Route path="/projects/:id">
        <AppLayout>
          <ProjectWorkspacePage />
        </AppLayout>
      </Route>

      <Route path="/knowledge">
        <AppLayout>
          <KnowledgePage />
        </AppLayout>
      </Route>

      <Route path="/settings">
        <AppLayout>
          <SettingsPage />
        </AppLayout>
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AppRoutes />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
