import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import "aws-amplify/auth/enable-oauth-listener";
import "@fontsource-variable/noto-sans-jp";
import "./index.css";
import { App } from "./app";

const root = document.getElementById("root");
if (!root) throw new Error("#root element was not found");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
