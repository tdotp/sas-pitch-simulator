import { createRoot } from "react-dom/client";
import { ConversationProvider } from "@elevenlabs/react";
import { AuthProvider } from "./auth";
import App from "./App";
import "./styles.css";

// No StrictMode: its double-invoke of mount effects would start/stop the
// ElevenLabs voice session twice and race the connection.
createRoot(document.getElementById("root")!).render(
  <AuthProvider>
    <ConversationProvider>
      <App />
    </ConversationProvider>
  </AuthProvider>
);
