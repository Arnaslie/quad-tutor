import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Quad Tutor",
    short_name: "Quad Tutor",
    description:
      "Peer tutors who already took your course — under your professor.",
    start_url: "/courses",
    display: "standalone",

    background_color: "#ffffff",
    theme_color: "#9e1b32",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },

      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
