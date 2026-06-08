/**
 * public-main — bootstrap for the lightweight public entry.
 *
 * Loaded by public.html. Mounts PublicApp which includes only public
 * marketing / content routes without @clerk/react or other auth-shell
 * dependencies, keeping the initial JS well under Google's 2 MB rendering
 * budget.
 */

import { createRoot } from "react-dom/client";
import { PublicApp } from "./PublicApp";
import "./index.css";

createRoot(document.getElementById("root")!).render(<PublicApp />);
