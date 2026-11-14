import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/", name: "Money Coach — Personal Economic Trainer", short_name: "Money Coach",
    description: "Your money, explained. Synthetic financial coaching demo.",
    start_url: "/", scope: "/", display: "standalone", lang: "en",
    background_color: "#f4f5f4", theme_color: "#00814a",
    icons: [
      {src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any"},
      {src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any"},
      {src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable"},
    ],
  };
}
