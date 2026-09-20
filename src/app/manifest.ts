import type { MetadataRoute } from "next";

/**
 * What an installed copy of this looks like on a phone.
 *
 * There is no native app and there is not going to be one — the decision to
 * ship a single responsive Next.js app rather than a second client is in
 * docs/decisions.md. This is the cheap half of what a native app buys: a
 * home-screen icon and a window without browser chrome, which is most of what
 * makes a student treat it as an app rather than a bookmark.
 *
 * `start_url` is the course picker rather than `/`, because `/` only ever
 * redirects — to sign-in when signed out, to `/courses` when signed in — and
 * launching into a redirect costs a frame of nothing on a cold start.
 *
 * The mark is a placeholder: crimson field, white "QT". It is deliberately not
 * a logo, and it is here so the installed app is not wearing the framework's
 * default icon. Replace `public/icon-*.png` when there is a real one.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Quad Tutor",
    short_name: "Quad Tutor",
    description:
      "Peer tutors who already took your course — under your professor.",
    start_url: "/courses",
    display: "standalone",
    // Matches `--background` in globals.css, so the splash screen does not
    // flash a different colour than the app it is about to show.
    background_color: "#ffffff",
    theme_color: "#9e1b32",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      // Android crops an adaptive icon to whatever shape the launcher uses, so
      // this one keeps the mark inside the safe zone and lets the crimson run
      // to the edge. Without it the icon gets a white ring or a clipped mark.
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
