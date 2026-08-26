import { useState } from "react";
import { Outlet } from "react-router";
import { Footer } from "./Footer.js";
import { Header } from "./Header.js";
import { SettingsDrawer } from "./SettingsDrawer.js";

/**
 * The shell every route renders inside: header with the always-visible data-age chip, the
 * view, and the footer carrying the §7 obligations. A column layout with the footer
 * pushed down means a short view still puts the disclaimer at the bottom of the viewport
 * rather than floating mid-page.
 */
export function Layout(): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex min-h-dvh flex-col">
      <Header onOpenSettings={() => setSettingsOpen(true)} />
      <main className="mx-auto w-full max-w-[110rem] flex-1 px-4 py-4 sm:px-6">
        <Outlet />
      </main>
      <Footer />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
