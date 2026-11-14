import type { Metadata, Viewport } from "next";
import { PwaLifecycle } from "@web/components/pwa-lifecycle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Money Coach — Your money, explained",
  description: "Private personal finance coaching, with a separate synthetic S-Bank challenge demonstration.",
  applicationName: "Money Coach",
  appleWebApp: { capable: true, title: "Money Coach", statusBarStyle: "default" },
  icons: { icon: "/icons/icon.svg", apple: "/icons/apple-touch-icon.png" },
};
export const viewport: Viewport = {
  width: "device-width", initialScale: 1,
  themeColor: [{media: "(prefers-color-scheme: light)", color: "#f4f5f4"}, {media: "(prefers-color-scheme: dark)", color: "#0f1512"}],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><a className="skip-link" href="#main">Skip to content</a>{children}<PwaLifecycle /></body></html>;
}
